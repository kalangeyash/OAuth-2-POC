import { randomBytes } from "node:crypto";
import axios, { type AxiosResponse } from "axios";
import type { Request, Response } from "express";
import type { SessionData } from "express-session";
import { config } from "./config.js";
import { describeDiscovery, discover, requireOAuthEndpoints } from "./discovery.js";
import { gate, labState, recordInjection } from "./lab.js";
import { createCodeChallenge, generateCodeVerifier } from "./pkce.js";
import {
  describeChallenge,
  describeIdToken,
  describeSessionStored,
  describeStateGenerated,
  describeTokens,
  describeVerifier,
  safeHeaders,
} from "./safeView.js";
import { broadenPatientScopes } from "./scope.js";
import {
  advanceFlow,
  generateState,
  STATE_TTL_MS,
  type AuthorizedContext,
  type DemoId,
  type PendingAuthorization,
  type TeachingError,
} from "./session.js";
import type { BuilderModId, WireEntry } from "./timeline.js";
import { record, startTimer, type WireInput } from "./wireLog.js";

/** A problem starting or finishing the flow, explained for the audience. */
export class OAuthFlowError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export interface AuthorizationOptions {
  /** The FHIR server the token is for: the configured sandbox, or the EHR's iss. Sent as aud. */
  fhirBaseUrl: string;
  scope: string;
  /** EHR launch only: the opaque launch context handed over by the EHR. */
  launch?: string;
  /** Failure demo only: marks the flow so /callback applies the demo's change. */
  demo?: DemoId;
  /** Failure demo only: a different redirect_uri for /authorize. Normally the configured REDIRECT_URI. */
  authorizeRedirectUri?: string;
  /** Failure demo only: runs after the pending authorization is stored, before the browser is redirected. */
  beforeRedirect?: (pending: PendingAuthorization) => void;
  /** Authorization Request Builder: whitelisted changes to the authorization URL. */
  mods?: BuilderModId[];
}

/** Where a changed aud points. A server that is not this FHIR server's authorization server. */
const FOREIGN_AUD = "https://fhir.attacker.example/r4";
const INVALID_SCOPE = "patient/NotAResource.read";

/**
 * Starts EVERY authorization (standalone login, EHR launch, the failure demos and
 * request-builder experiments) and redirects the browser to the discovered
 * authorization endpoint.
 *
 * Each stage calls gate() first. In the normal "run" mode that returns at once; in
 * the protocol debugger it holds this request until the presenter clicks Next.
 */
export async function startAuthorization(req: Request, res: Response, options: AuthorizationOptions): Promise<void> {
  const mods = new Set(options.mods ?? []);

  // 1. Discover this FHIR server's endpoints. Nothing is hardcoded.
  //    In the debugger the document is always fetched again, so the audience sees the real request.
  //    A cached document makes no request, so the timeline would silently skip step 1:
  //    record that the cache was used instead.
  const stepping = labState().mode !== "run";
  const before = Date.now();
  const discovery = await discover(options.fhirBaseUrl, {
    force: stepping,
    beforeSend: ({ url, headers }) =>
      gate({
        stage: "discovery",
        kind: "network",
        title: "GET .well-known/smart-configuration",
        preview: { direction: "client-fhir", category: "discovery", method: "GET", endpoint: url, requestHeaders: headers },
      }),
  });
  const { authorizationEndpoint } = requireOAuthEndpoints(discovery);
  if (Date.parse(discovery.fetchedAt) < before) {
    record({
      direction: "internal",
      category: "discovery",
      step: "Endpoints from SMART discovery (cached)",
      timeline: [{ step: "discovery", status: "done" }],
      detail: describeDiscovery(discovery, "cached"),
      result: { authorization_endpoint: discovery.authorizationEndpoint, token_endpoint: discovery.tokenEndpoint },
      outcome: "ok",
      explanation: `The backend already read this FHIR server's SMART configuration at ${discovery.fetchedAt.slice(11, 19)} UTC, so it reuses those endpoints.`,
      notes: [`Fetched from ${discovery.url} at ${discovery.fetchedAt}. Use "Refresh discovery" to fetch it again.`],
    });
  }

  // 2. state: an unguessable value that ties the callback to this browser session (CSRF protection).
  await gate({ stage: "generate-state", kind: "internal" });
  const state = generateState();
  record({
    direction: "internal",
    category: "state",
    step: "Generate state",
    timeline: [{ step: "generate-state", status: "done" }],
    detail: describeStateGenerated(state),
    outcome: "ok",
    security: "32 bytes from a cryptographically secure random generator: an attacker cannot guess it to forge a callback.",
    notes: ["state is public (it travels in the URL) but unguessable, and it is single-use."],
  });

  // 3. PKCE: the verifier stays on this server. Only its SHA-256 hash travels through the browser.
  await gate({ stage: "generate-verifier", kind: "internal" });
  const codeVerifier = generateCodeVerifier();
  record({
    direction: "internal",
    category: "pkce",
    step: "Generate PKCE code_verifier",
    timeline: [{ step: "generate-verifier", status: "done" }],
    detail: describeVerifier(codeVerifier),
    outcome: "ok",
    security: "The verifier is a secret. It is shown here only by its length and a fingerprint, never its value.",
    notes: ["48 random bytes → 64 base64url characters (RFC 7636 allows 43–128)."],
  });

  await gate({ stage: "generate-challenge", kind: "internal" });
  const codeChallenge = createCodeChallenge(codeVerifier);
  record({
    direction: "internal",
    category: "pkce",
    step: "Derive PKCE code_challenge (S256)",
    timeline: [{ step: "generate-challenge", status: "done" }],
    detail: describeChallenge(codeVerifier, codeChallenge),
    result: { code_challenge: codeChallenge, code_challenge_method: "S256" },
    outcome: "ok",
    notes: ["code_challenge = BASE64URL(SHA256(code_verifier)). The hash is public; the verifier cannot be derived from it."],
  });

  // Request-builder changes that affect what is stored (requested scope) are decided here.
  let scope = options.scope;
  if (mods.has("broad-scope")) scope = broadenPatientScopes(scope);
  if (mods.has("invalid-scope")) scope = `${scope} ${INVALID_SCOPE}`;
  const redirectUri = mods.has("change-redirect-uri")
    ? `${config.redirectUri}/`
    : (options.authorizeRedirectUri ?? config.redirectUri);

  // 4. Remember what /callback needs, server-side only. A new flow replaces any older pending one.
  await gate({ stage: "store-session", kind: "internal" });
  const pending: PendingAuthorization = {
    state,
    codeVerifier,
    codeChallenge,
    createdAt: Date.now(),
    requestedScope: scope,
    authorizeRedirectUri: redirectUri,
    fhirBaseUrl: options.fhirBaseUrl,
    discovery,
    launch: options.launch,
    demo: options.demo,
  };
  req.session.pendingAuth = pending;
  advanceFlow(req.session, 2);
  record({
    direction: "internal",
    category: "state",
    step: "Store state and code_verifier in the server session",
    timeline: [{ step: "store-session", status: "done" }],
    detail: describeSessionStored(state, codeVerifier, STATE_TTL_MS / 1000),
    outcome: "ok",
    security:
      "Both values stay in server memory. The browser's cookie is httpOnly (no script can read it) and carries only a signed session ID.",
    notes: [`The pending authorization expires after ${STATE_TTL_MS / 60_000} minutes and can be used only once.`],
  });

  // 5. Front channel: the browser carries these parameters, so none of them is a secret.
  await gate({ stage: "build-url", kind: "internal" });
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    aud: options.fhirBaseUrl,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (options.launch) params.launch = options.launch;
  applyBuilderMods(mods, params, options);

  const url = new URL(authorizationEndpoint);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  // A failure demo changes exactly one parameter. Say which, and what it would have been.
  const modified = options.demo ? demoModification(options, redirectUri) : undefined;
  const demo = options.demo ? { id: options.demo, ...(modified ? { modified } : {}) } : undefined;

  record({
    direction: "internal",
    category: "authorization",
    step: "Build authorization URL",
    timeline: [{ step: "build-url", status: "done" }],
    detail: { kind: "authorization-url", endpoint: authorizationEndpoint, url: url.toString(), params },
    params,
    paramsIn: "query",
    outcome: "ok",
    demo,
    notes: ["The authorization endpoint was read from SMART discovery."],
  });
  options.beforeRedirect?.(pending);

  // 6. The redirect itself is the message: a 302 that sends the browser to the authorization server.
  const redirectPreview = {
    direction: "browser-auth",
    category: "redirect",
    method: "GET",
    endpoint: authorizationEndpoint,
    params,
    paramsIn: "query",
  } as const;
  await gate({ stage: "redirect", kind: "network", title: "302 → authorization endpoint", preview: redirectPreview });

  record({
    ...redirectPreview,
    step: "Authorization request",
    status: 302,
    responseHeaders: { Location: url.toString() },
    timeline: [
      { step: "redirect", status: "done" },
      { step: "login", status: "active" },
    ],
    outcome: "ok",
    demo,
    security:
      "Everything here is visible in the address bar and browser history, so nothing here is secret: state is single-use, and code_challenge is only a hash.",
    notes: [
      "The Node server answers the browser with 302 Found; the browser follows it to the authorization server.",
      "Front channel: the browser carries these parameters, so none of them is a secret.",
      "code_challenge = BASE64URL(SHA256(code_verifier)). The code_verifier stays on the Node server.",
      "After this, the user logs in and consents at the authorization server. This app cannot see either.",
    ],
  });

  res.redirect(url.toString());
}

/**
 * Authorization Request Builder: applies each whitelisted change to the parameters
 * and records it (original → sent) before the URL is built. Scope and redirect_uri
 * were already changed above, because the session stores them.
 */
function applyBuilderMods(mods: Set<BuilderModId>, params: Record<string, string>, options: AuthorizationOptions): void {
  const baseScope = options.scope;
  for (const mod of mods) {
    switch (mod) {
      case "remove-state":
        recordInjection(mod, { field: "state", original: `${params.state.slice(0, 6)}… (random)`, sent: "(omitted)" });
        delete params.state;
        break;
      case "change-redirect-uri":
        recordInjection(mod, { field: "redirect_uri", original: config.redirectUri, sent: params.redirect_uri });
        break;
      case "remove-code-challenge":
        recordInjection(mod, { field: "code_challenge + code_challenge_method", original: "S256 challenge", sent: "(omitted)" });
        delete params.code_challenge;
        delete params.code_challenge_method;
        break;
      case "plain-challenge-method":
        recordInjection(mod, { field: "code_challenge_method", original: "S256", sent: "plain" });
        params.code_challenge_method = "plain";
        break;
      case "broad-scope":
        recordInjection(mod, { field: "scope", original: baseScope, sent: broadenPatientScopes(baseScope) });
        break;
      case "change-aud":
        recordInjection(mod, { field: "aud", original: params.aud, sent: FOREIGN_AUD });
        params.aud = FOREIGN_AUD;
        break;
      case "invalid-scope":
        recordInjection(mod, { field: "scope", original: "(no invalid scope)", sent: `… ${INVALID_SCOPE}` });
        break;
    }
  }
}

function demoModification(options: AuthorizationOptions, redirectUri: string) {
  if (redirectUri !== config.redirectUri) {
    return { field: "redirect_uri", original: config.redirectUri, sent: redirectUri };
  }
  if (options.scope !== config.scopes) {
    return { field: "scope", original: config.scopes, sent: options.scope };
  }
  return undefined;
}

export type TokenResponse = Record<string, unknown>;

export interface TokenEndpointResult {
  ok: boolean;
  status: number;
  /** Contains credentials. Never send this to the browser. */
  body: TokenResponse;
}

export interface TokenRequest {
  tokenEndpoint: string;
  params: Record<string, string>;
  authMethodsSupported?: string[];
  /** Protocol step name shown in the wire log. */
  step: string;
  /** The timeline step this request advances. Absent for extra requests (the replay demo). */
  timelineStep?: "token-exchange" | "refresh";
  notes?: string[];
  explanation?: string;
  demo?: WireEntry["demo"];
}

export function authorizationCodeParams(pending: PendingAuthorization, code: string): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code,
    // The client's registered redirect URI. The token endpoint compares it with the authorization request.
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    // PKCE proof: only this server knows the verifier behind the code_challenge.
    code_verifier: pending.codeVerifier,
  };
}

/**
 * The exact headers and form body a token request will carry. Pure: used both to
 * send the request and to show it at a breakpoint before it is sent.
 */
export function prepareTokenRequest(request: TokenRequest): { headers: Record<string, string>; form: URLSearchParams } {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const form = new URLSearchParams(request.params);

  // Confidential clients authenticate. Public clients (no secret) identify themselves with client_id only.
  if (config.clientSecret) {
    if (!request.authMethodsSupported || request.authMethodsSupported.includes("client_secret_basic")) {
      headers.Authorization = basicAuthorizationHeader(config.clientId, config.clientSecret);
    } else {
      form.set("client_secret", config.clientSecret);
    }
  }
  return { headers, form };
}

/** What a token request looks like in the wire log (record() redacts it). */
export function tokenRequestPreview(request: TokenRequest) {
  const { headers, form } = prepareTokenRequest(request);
  return {
    direction: "client-auth",
    category: request.timelineStep === "refresh" ? "refresh" : "token",
    method: "POST",
    endpoint: request.tokenEndpoint,
    params: Object.fromEntries(form),
    paramsIn: "body",
    requestHeaders: safeHeaders(headers),
  } satisfies Omit<WireInput, "step" | "outcome">;
}

/** Back channel: Node → authorization server. The browser never sees this request or its response. */
export async function postToTokenEndpoint(request: TokenRequest): Promise<TokenEndpointResult> {
  const { headers, form } = prepareTokenRequest(request);

  // What the wire log shows about the request. record() redacts it before storing or printing:
  // code is truncated; code_verifier, refresh_token, client_secret and Authorization are replaced.
  const logged = {
    ...tokenRequestPreview(request),
    step: request.step,
    notes: request.notes,
    explanation: request.explanation,
    demo: request.demo,
    security:
      request.timelineStep === "refresh"
        ? "The refresh token is a long-lived credential: it only ever travels server to server, and it is never shown here."
        : "The code and the PKCE verifier travel only on this server-to-server request. The tokens in the response never reach the browser.",
  };
  const mark = (status: "done" | "failed") =>
    request.timelineStep ? [{ step: request.timelineStep, status }] : undefined;

  const stop = startTimer();
  let response: AxiosResponse;
  try {
    response = await axios.post(request.tokenEndpoint, form.toString(), {
      headers,
      timeout: 20_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch (error) {
    record({
      ...logged,
      timeline: mark("failed"),
      status: "network error",
      durationMs: stop(),
      result: { message: (error as Error).message },
      outcome: "error",
    });
    throw error;
  }

  const body = isObject(response.data) ? response.data : { unexpected_response: String(response.data).slice(0, 500) };
  const ok = response.status === 200 && typeof body.access_token === "string";
  record({
    ...logged,
    timeline: mark(ok ? "done" : "failed"),
    status: response.status,
    responseHeaders: safeHeaders(response.headers),
    durationMs: stop(),
    result: body,
    outcome: ok ? "ok" : "error",
  });
  return { ok, status: response.status, body };
}

/** One refresh attempt using the stored refresh token. Returns false if there is none or it fails. */
export async function refreshAccessToken(session: Partial<SessionData>, reason: string): Promise<boolean> {
  const auth = session.auth;
  if (!auth?.refreshToken) {
    recordNoRefreshToken(reason, "No refresh token is stored (was offline_access granted?), so the access token cannot be renewed.");
    return false;
  }

  const request: TokenRequest = {
    tokenEndpoint: auth.tokenEndpoint,
    authMethodsSupported: auth.tokenEndpointAuthMethodsSupported,
    step: "Token refresh",
    timelineStep: "refresh",
    params: { grant_type: "refresh_token", refresh_token: auth.refreshToken, client_id: config.clientId },
    notes: [reason, "Back channel: refresh_token → new access token, without involving the user."],
  };

  const { inject } = await gate({
    stage: "refresh",
    kind: "network",
    title: "POST token endpoint (grant_type=refresh_token)",
    preview: tokenRequestPreview(request),
    injections: ["corrupt-refresh-token", "skip-refresh"],
  });
  if (inject === "skip-refresh") {
    recordInjection(inject, { field: "refresh_token", original: "stored on the server", sent: "(treated as never issued)" });
    recordNoRefreshToken(reason, "Refresh was disabled by the presenter, as if offline_access had not been granted.");
    return false;
  }
  if (inject === "corrupt-refresh-token") {
    const corrupted = randomBytes(auth.refreshToken.length).toString("base64url").slice(0, auth.refreshToken.length);
    recordInjection(inject, {
      field: "refresh_token",
      original: `the real refresh token (${auth.refreshToken.length} chars)`,
      sent: `random characters (${corrupted.length} chars)`,
    });
    request.params.refresh_token = corrupted;
  }

  const result = await postToTokenEndpoint(request);
  if (!result.ok) return false;

  applyTokenResponse(auth, result.body);
  record({
    direction: "internal",
    category: "refresh",
    step: "New access token stored",
    timeline: [{ step: "refresh", status: "done" }],
    detail: describeTokens(auth),
    result: describeStoredTokens(auth),
    outcome: "ok",
    explanation: "The backend replaced the expired access token with the new one, in its own session. The user did nothing.",
    notes: [
      typeof result.body.refresh_token === "string"
        ? "The server also issued a new refresh token (rotation); the old one is discarded."
        : "The existing refresh token is kept.",
    ],
  });
  return true;
}

function recordNoRefreshToken(reason: string, detail: string): void {
  record({
    direction: "internal",
    category: "refresh",
    step: "Token refresh",
    timeline: [{ step: "refresh", status: "failed" }],
    outcome: "error",
    explanation: "The access token was rejected, and there is no refresh token to renew it with.",
    notes: [reason, detail],
  });
}

/** Step 14: the tokens are stored server-side. */
export function recordTokensStored(context: AuthorizedContext): void {
  record({
    direction: "internal",
    category: "token",
    step: "Tokens stored in the server session",
    timeline: [{ step: "store-tokens", status: "done" }],
    detail: describeTokens(context),
    result: describeStoredTokens(context),
    outcome: "ok",
    security: "The browser holds a session cookie, never a token. Nothing in the browser can leak what it never received.",
    notes: ["Tokens are stored in the server-side session only. The browser holds a session cookie, never a token."],
  });
}

/** Step 15: the ID token's claims are decoded (NOT verified). */
export function recordIdTokenDecoded(context: AuthorizedContext): void {
  record({
    direction: "internal",
    category: "id-token",
    step: context.idToken ? "ID token decoded (signature NOT verified)" : "No ID token in the token response",
    timeline: [{ step: "decode-id-token", status: context.idToken ? "done" : "skipped" }],
    detail: describeIdToken(context.idTokenClaims, Boolean(context.idToken)),
    outcome: context.idToken ? "ok" : "info",
    explanation: context.idToken
      ? "The backend decoded the ID token to read who logged in (fhirUser). This teaching demo does not verify its signature."
      : "The token response contained no ID token (was openid granted?), so there is no user identity to decode.",
    security:
      "Decoding is not verification. A production app must check the signature, issuer, audience, expiry and nonce before trusting any claim.",
    notes: [
      context.idTokenClaims
        ? "ID token payload decoded for display. Its signature is NOT verified by this teaching demo."
        : "No ID token was returned.",
    ],
  });
}

/** Step 16: the patient comes from the token response, never from the browser. */
export function recordPatientContext(context: AuthorizedContext): void {
  record({
    direction: "internal",
    category: "patient-context",
    step: context.patientId ? "Patient context extracted" : "No patient context in the token response",
    timeline: [{ step: "patient-context", status: context.patientId ? "done" : "failed" }],
    detail: {
      kind: "patient-context",
      patientId: context.patientId ?? null,
      source: "the token response's \"patient\" parameter (back channel)",
    },
    outcome: context.patientId ? "ok" : "error",
    security:
      "The patient comes from the authorization server, over the back channel. No browser request can change which patient this session may read.",
    notes: [
      context.patientId
        ? "Every FHIR request in this session uses this patient ID."
        : "Was launch/patient granted? This app will not guess a patient.",
    ],
  });
}

export function createAuthorizedContext(
  pending: PendingAuthorization,
  token: TokenResponse,
  tokenEndpoint: string,
): AuthorizedContext {
  const context: AuthorizedContext = {
    accessToken: "",
    tokenType: "Bearer",
    requestedScope: pending.requestedScope,
    fhirBaseUrl: pending.fhirBaseUrl,
    tokenEndpoint,
    tokenEndpointAuthMethodsSupported: pending.discovery.tokenEndpointAuthMethodsSupported,
  };
  applyTokenResponse(context, token);
  return context;
}

/** A description of what is stored, without any credential values. */
export function describeStoredTokens(context: AuthorizedContext): Record<string, unknown> {
  return {
    token_type: context.tokenType,
    expires_in: context.expiresIn ?? "not provided",
    granted_scope: context.grantedScope ?? "not provided",
    patient: context.patientId ?? "not provided",
    has_refresh_token: Boolean(context.refreshToken),
    has_id_token: Boolean(context.idToken),
    fhirUser: context.idTokenClaims?.fhirUser ?? "not provided",
  };
}

function applyTokenResponse(context: AuthorizedContext, token: TokenResponse): void {
  context.accessToken = String(token.access_token);
  if (typeof token.token_type === "string") context.tokenType = token.token_type;
  // The granted scope can differ from the requested scope (RFC 6749 §5.1).
  if (typeof token.scope === "string") context.grantedScope = token.scope;
  // Keep a rotated refresh token if the server issued a new one.
  if (typeof token.refresh_token === "string") context.refreshToken = token.refresh_token;
  if (typeof token.id_token === "string") {
    context.idToken = token.id_token;
    context.idTokenClaims = decodeJwtPayload(token.id_token);
  }
  // SMART launch context: the authorization server (not the browser) says which patient is authorized.
  if (typeof token.patient === "string") context.patientId = token.patient;
  const expiresIn = Number(token.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    context.expiresIn = expiresIn;
    context.expiresAt = Date.now() + expiresIn * 1000;
  }
}

/**
 * TEACHING DEMO ONLY. Decodes the ID token payload so the audience can read its claims.
 * The signature is NOT verified, and neither are iss, aud, exp or nonce.
 * Decoding is not verification: never make security decisions from these claims.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

export function tokenEndpointError(step: string, endpoint: string, result: TokenEndpointResult): TeachingError {
  const { body } = result;
  return {
    step,
    endpoint,
    status: result.status,
    error: typeof body.error === "string" ? body.error : undefined,
    error_description: typeof body.error_description === "string" ? body.error_description : undefined,
    message: `The token endpoint rejected the request (HTTP ${result.status}).`,
  };
}

function basicAuthorizationHeader(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1: form-encode both values, then base64("id:secret").
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
