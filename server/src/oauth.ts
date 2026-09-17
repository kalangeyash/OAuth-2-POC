import axios, { type AxiosResponse } from "axios";
import type { Request, Response } from "express";
import type { SessionData } from "express-session";
import { config } from "./config.js";
import { discover, requireOAuthEndpoints } from "./discovery.js";
import { createCodeChallenge, generateCodeVerifier } from "./pkce.js";
import {
  advanceFlow,
  generateState,
  type AuthorizedContext,
  type DemoId,
  type PendingAuthorization,
  type TeachingError,
} from "./session.js";
import { record } from "./wireLog.js";

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
}

/**
 * Starts EVERY authorization (standalone login, EHR launch and the failure demos)
 * and redirects the browser to the discovered authorization endpoint.
 */
export async function startAuthorization(req: Request, res: Response, options: AuthorizationOptions): Promise<void> {
  // 1. Discover this FHIR server's endpoints. Nothing is hardcoded.
  const discovery = await discover(options.fhirBaseUrl);
  const { authorizationEndpoint } = requireOAuthEndpoints(discovery);

  // 2. state: an unguessable value that ties the callback to this browser session (CSRF protection).
  const state = generateState();

  // 3. PKCE: the verifier stays on this server. Only its SHA-256 hash travels through the browser.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  const redirectUri = options.authorizeRedirectUri ?? config.redirectUri;

  // 4. Remember what /callback needs, server-side only. A new flow replaces any older pending one.
  const pending: PendingAuthorization = {
    state,
    codeVerifier,
    createdAt: Date.now(),
    requestedScope: options.scope,
    authorizeRedirectUri: redirectUri,
    fhirBaseUrl: options.fhirBaseUrl,
    discovery,
    launch: options.launch,
    demo: options.demo,
  };
  req.session.pendingAuth = pending;
  advanceFlow(req.session, 2);

  // 5. Front channel: the browser carries these parameters, so none of them is a secret.
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: options.scope,
    state,
    aud: options.fhirBaseUrl,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (options.launch) params.launch = options.launch;

  record({
    direction: "browser-auth",
    step: "Authorization request",
    method: "GET",
    endpoint: authorizationEndpoint,
    params,
    status: 302,
    outcome: "ok",
    notes: [
      "The Node server answers the browser with 302 Found; the browser follows it to the authorization server.",
      "Front channel: the browser carries these parameters, so none of them is a secret.",
      "code_challenge = BASE64URL(SHA256(code_verifier)). The code_verifier stays on the Node server.",
      "The authorization endpoint was read from SMART discovery.",
    ],
  });
  options.beforeRedirect?.(pending);

  const url = new URL(authorizationEndpoint);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  res.redirect(url.toString());
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
  notes?: string[];
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

/** Back channel: Node → authorization server. The browser never sees this request or its response. */
export async function postToTokenEndpoint(request: TokenRequest): Promise<TokenEndpointResult> {
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

  // What the wire log shows about the request. record() redacts it before storing or printing.
  const loggedRequest = {
    ...Object.fromEntries(form),
    ...(headers.Authorization ? { Authorization: headers.Authorization } : {}),
  };

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
      direction: "client-auth",
      step: request.step,
      method: "POST",
      endpoint: request.tokenEndpoint,
      params: loggedRequest,
      status: "network error",
      result: { message: (error as Error).message },
      outcome: "error",
      notes: request.notes,
    });
    throw error;
  }

  const body = isObject(response.data) ? response.data : { unexpected_response: String(response.data).slice(0, 500) };
  const ok = response.status === 200 && typeof body.access_token === "string";
  record({
    direction: "client-auth",
    step: request.step,
    method: "POST",
    endpoint: request.tokenEndpoint,
    params: loggedRequest,
    status: response.status,
    result: body,
    outcome: ok ? "ok" : "error",
    notes: request.notes,
  });
  return { ok, status: response.status, body };
}

/** One refresh attempt using the stored refresh token. Returns false if there is none or it fails. */
export async function refreshAccessToken(session: Partial<SessionData>, reason: string): Promise<boolean> {
  const auth = session.auth;
  if (!auth?.refreshToken) {
    record({
      direction: "internal",
      step: "Token refresh",
      outcome: "error",
      notes: [reason, "No refresh token is stored (was offline_access granted?), so the access token cannot be renewed."],
    });
    return false;
  }

  const result = await postToTokenEndpoint({
    tokenEndpoint: auth.tokenEndpoint,
    authMethodsSupported: auth.tokenEndpointAuthMethodsSupported,
    step: "Token refresh",
    params: { grant_type: "refresh_token", refresh_token: auth.refreshToken, client_id: config.clientId },
    notes: [reason, "Back channel: refresh_token → new access token, without involving the user."],
  });
  if (!result.ok) return false;

  applyTokenResponse(auth, result.body);
  return true;
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
