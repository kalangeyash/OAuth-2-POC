import { Router } from "express";
import type { SessionData } from "express-session";
import { config } from "../config.js";
import { requireOAuthEndpoints } from "../discovery.js";
import {
  authorizationCodeParams,
  createAuthorizedContext,
  OAuthFlowError,
  postToTokenEndpoint,
  recordIdTokenDecoded,
  recordPatientContext,
  recordTokensStored,
  startAuthorization,
  tokenEndpointError,
  tokenRequestPreview,
  type TokenEndpointResult,
  type TokenRequest,
} from "../oauth.js";
import { gate, recordInjection } from "../lab.js";
import {
  describeCallback,
  describePkceProof,
  describeStateCheck,
  describeTokens,
  fingerprint,
  previewValue,
  safeHeaders,
  STATE_PURPOSE,
  VERIFIER_PURPOSE,
} from "../safeView.js";
import { diffScopes, ensureLaunchScope } from "../scope.js";
import {
  advanceFlow,
  checkState,
  failFlow,
  generateState,
  SESSION_COOKIE_NAME,
  STATE_TTL_MS,
  takePendingAuthorization,
} from "../session.js";
import type { InjectionId, StepMark } from "../timeline.js";
import { record } from "../wireLog.js";
import { concludeDemo } from "./demo.js";

export const authRouter = Router();

const STATE_FAILURE_TITLES = {
  missing: "NO PENDING AUTHORIZATION",
  expired: "STATE EXPIRED",
  mismatch: "STATE MISMATCH",
} as const;

/** Standalone launch: the user starts here by clicking Connect. */
authRouter.get("/auth/login", async (req, res) => {
  record({
    direction: "browser-client",
    category: "authorization",
    step: "Connect",
    method: "GET",
    endpoint: "/auth/login",
    requestHeaders: safeHeaders({ Cookie: req.get("cookie") }),
    runStart: true,
    outcome: "info",
    explanation:
      "The presenter clicked Connect. The browser asks our Node server, the OAuth client, to start a new authorization.",
    why: "The flow always starts on the server: only the server can create and keep the secrets the flow needs.",
    notes: ["The presenter clicked Connect. The Node server is the OAuth client and starts the flow."],
  });
  startNewFlow(req.session);
  await startAuthorization(req, res, { fhirBaseUrl: config.fhirBaseUrl, scope: config.scopes });
});

/** EHR launch: the EHR opens /launch?iss={FHIR server}&launch={opaque launch context}. */
authRouter.get("/launch", async (req, res) => {
  const iss = firstString(req.query.iss)?.trim();
  const launch = firstString(req.query.launch)?.trim();
  record({
    direction: "browser-client",
    category: "authorization",
    step: "EHR launch",
    method: "GET",
    endpoint: "/launch",
    params: { iss, launch },
    paramsIn: "query",
    runStart: true,
    outcome: "info",
    explanation: "An EHR opened this app with a launch context. The backend will discover the EHR's own endpoints and start authorization.",
    notes: ["The EHR opened this app. Discovery will run against the iss it supplied, not the configured sandbox."],
  });
  if (!iss || !launch) {
    throw new OAuthFlowError("EHR launch", "An EHR launch requires both the iss and launch query parameters.");
  }
  if (!isHttpsUrl(iss)) {
    throw new OAuthFlowError("EHR launch", `iss must be an https URL (received "${iss}").`);
  }

  startNewFlow(req.session);
  // Discovery runs against the EHR's iss, not the configured sandbox. The iss is also the aud.
  await startAuthorization(req, res, {
    fhirBaseUrl: iss.replace(/\/+$/, ""),
    scope: ensureLaunchScope(config.scopes),
    launch,
  });
});

/** The authorization server sends the browser back here with ?code=…&state=… */
authRouter.get("/callback", async (req, res) => {
  const code = firstString(req.query.code);
  const state = firstString(req.query.state);
  const error = firstString(req.query.error);
  const errorDescription = firstString(req.query.error_description);

  record({
    direction: "auth-browser",
    category: "authorization",
    step: "Redirect back with authorization code",
    method: "GET",
    endpoint: req.path,
    params: withoutUndefined({ code, state, error, error_description: errorDescription }),
    paramsIn: "query",
    // The session cookie arrives on this cross-site redirect because it is SameSite=Lax.
    requestHeaders: safeHeaders({ Cookie: req.get("cookie") }),
    timeline: callbackMarks(code, error),
    detail: describeCallback(code, state, error, errorDescription),
    outcome: error ? "error" : "ok",
    explanation: error
      ? `The authorization server sent the browser back with an error (${error}) instead of an authorization code.`
      : "The authorization server sent the browser back to our callback URL with a one-time authorization code and the state value.",
    security:
      "The code is visible in the address bar and browser history, which is why it is short-lived, single-use and useless without the PKCE verifier. Only its first 8 characters are shown.",
    notes: [
      "Front channel: the authorization code travels through the browser, so only its first 8 characters are logged.",
      code ? "The authorization server issued a code, so the user logged in and consented. This app saw neither." : "",
    ].filter(Boolean),
  });

  // 1. Take the pending authorization out of the session. It is single-use:
  //    replaying this /callback URL later finds nothing and is rejected.
  const pending = takePendingAuthorization(req.session);

  // 2. Validate state FIRST. On failure the code never reaches the token endpoint.
  //    Debugger: the presenter may replace the returned state before it is compared.
  let returnedState = state;
  const { inject: stateInjection } = await gate({
    stage: "validate-state",
    kind: "internal",
    title: "Compare the returned state with the stored state",
    injections: ["tamper-returned-state"],
  });
  if (stateInjection === "tamper-returned-state") {
    returnedState = generateState();
    recordInjection(stateInjection, {
      field: "state (returned in the callback)",
      original: state ? `${state.slice(0, 6)}…` : "(none)",
      sent: `${returnedState.slice(0, 6)}… (a different random value)`,
    });
  }
  const stateCheck = checkState(pending, returnedState);
  const ageSeconds = pending ? Math.round((Date.now() - pending.createdAt) / 1000) : null;
  if (!pending || !stateCheck.ok) {
    const title = stateCheck.ok ? "STATE MISMATCH" : STATE_FAILURE_TITLES[stateCheck.reason];
    const detail = stateCheck.ok ? "" : stateCheck.detail;
    const verdict = stateCheck.ok ? "MISMATCH" : STATE_VERDICTS[stateCheck.reason];
    record({
      direction: "internal",
      category: "state",
      step: "State validation",
      params: statePreviews(returnedState, pending?.state),
      result: { verdict: title },
      timeline: [{ step: "validate-state", status: "failed" }],
      detail: describeStateCheck(verdict, returnedState, pending?.state, ageSeconds, STATE_TTL_MS / 1000),
      demo: pending?.demo ? { id: pending.demo } : undefined,
      outcome: "error",
      explanation: `${title}: the state that came back does not belong to a request this browser session started. The backend refuses to continue.`,
      notes: [detail, "Token exchange skipped. The authorization code was NOT sent to the token endpoint."],
    });
    record({
      direction: "internal",
      category: "state",
      step: "Token exchange BLOCKED",
      timeline: skippedAfterStateCheck(),
      demo: pending?.demo ? { id: pending.demo } : undefined,
      outcome: "error",
      explanation:
        "Because state did not match, the backend never sends the authorization code to the token endpoint. No tokens are requested.",
      securityConcept: "CSRF protection and authorization response binding",
      notes: ["The flow stopped at state validation. The authorization code was discarded unused."],
    });
    req.session.lastError = {
      step: "State validation",
      message: `${title}. Token exchange skipped.`,
      error_description: detail,
      concept: "state is CSRF protection: the callback must belong to an authorization request this browser session started.",
    };
    failFlow(req.session, 5);
    concludeDemo(req.session, pending?.demo, {
      stage: "state validation",
      rejected: true,
      error: title,
      errorDescription: detail,
    });
    return res.redirect(config.clientUrl);
  }

  record({
    direction: "internal",
    category: "state",
    step: "State validation",
    params: statePreviews(state, pending.state),
    result: { verdict: "STATE MATCHES" },
    timeline: [{ step: "validate-state", status: "done" }],
    detail: describeStateCheck("MATCH", state, pending.state, ageSeconds, STATE_TTL_MS / 1000),
    demo: pending.demo ? { id: pending.demo } : undefined,
    outcome: "ok",
    explanation:
      "The state that came back matches the one stored in this session, so this callback answers our own request. The backend may use the code.",
    notes: [
      `Matches the state stored in this session ${ageSeconds} s ago (limit: 10 minutes).`,
      "Validated BEFORE any token request. state and code_verifier are now removed from the session (single use).",
    ],
  });

  // 3. The authorization server redirected back with an error instead of a code.
  if (error || !code) {
    req.session.lastError = {
      step: "Authorization",
      message: error
        ? "The authorization server returned an error instead of an authorization code."
        : "The callback did not include an authorization code.",
      error,
      error_description: errorDescription,
    };
    record({
      direction: "internal",
      category: "authorization",
      step: "Token exchange skipped: no authorization code",
      timeline: skippedAfterStateCheck(),
      demo: pending.demo ? { id: pending.demo } : undefined,
      outcome: "error",
      result: withoutUndefined({ error, error_description: errorDescription }),
      explanation: "There is no authorization code to exchange, so the flow stops here. No token request is made.",
      notes: [error === "access_denied" ? "The user (or policy) denied consent." : "The authorization server did not issue a code."],
    });
    failFlow(req.session, error === "access_denied" ? 4 : 5);
    concludeDemo(req.session, pending.demo, {
      stage: "authorization",
      rejected: true,
      error: error ?? "missing code",
      errorDescription,
    });
    return res.redirect(config.clientUrl);
  }
  advanceFlow(req.session, 5);

  // 4. Back channel: exchange the code plus the PKCE code_verifier for tokens.
  const { tokenEndpoint } = requireOAuthEndpoints(pending.discovery);
  const tokenRequest: TokenRequest = {
    tokenEndpoint,
    params: authorizationCodeParams(pending, code),
    authMethodsSupported: pending.discovery.tokenEndpointAuthMethodsSupported,
    step: "Token exchange",
    timelineStep: "token-exchange",
    demo: pending.demo ? { id: pending.demo } : undefined,
    notes: [
      "Back channel: Node → authorization server. The browser never sees this request or its response.",
      "code_verifier proves this server is the one that sent the code_challenge (PKCE).",
      "The authorization server hashes the verifier and compares it with the challenge it saw earlier. That comparison happens on its side; its verdict is this response.",
    ],
  };
  if (pending.demo === "no-pkce-verifier") {
    // DEMO: leave out the PKCE proof.
    delete tokenRequest.params.code_verifier;
  }

  // Debugger: show the exact token request before it is sent, and allow one injection.
  const { inject: tokenInjection } = await gate({
    stage: "token-exchange",
    kind: "network",
    title: "POST token endpoint (grant_type=authorization_code)",
    preview: tokenRequestPreview(tokenRequest),
    injections: tokenRequest.params.code_verifier
      ? ["remove-code-verifier", "alter-code-verifier", "alter-redirect-uri"]
      : ["alter-redirect-uri"],
  });
  const sentVerifier = applyTokenInjection(tokenRequest, tokenInjection, pending.codeVerifier);

  if (pending.demo === "no-pkce-verifier") {
    const modified = {
      field: "code_verifier",
      original: `sent (fingerprint ${fingerprint(VERIFIER_PURPOSE, pending.codeVerifier)})`,
      sent: "(omitted)",
    };
    tokenRequest.demo = { id: "no-pkce-verifier", modified };
    record({
      direction: "internal",
      category: "demo",
      step: "DEMO: code_verifier removed",
      timeline: [{ step: "token-exchange", status: "active" }],
      detail: describePkceProof(pending.codeVerifier, pending.codeChallenge, false),
      demo: { id: "no-pkce-verifier", modified },
      outcome: "info",
      explanation:
        "DEMO: the backend deliberately leaves the PKCE code_verifier out of the token request. Everything else is correct.",
      notes: ["The token request below is sent without code_verifier."],
    });
  } else {
    const proof = describePkceProof(sentVerifier ?? pending.codeVerifier, pending.codeChallenge, sentVerifier !== undefined);
    record({
      direction: "internal",
      category: "pkce",
      step: sentVerifier === undefined ? "PKCE: token request carries NO code_verifier" : "Attach PKCE code_verifier to the token request",
      timeline: [{ step: "token-exchange", status: "active" }],
      detail: proof,
      demo: pending.demo ? { id: pending.demo } : undefined,
      outcome: proof.verifierSent && proof.recomputedChallengeMatches ? "ok" : "info",
      explanation: !proof.verifierSent
        ? "The token request goes out without the PKCE verifier. The authorization server has nothing to hash and compare."
        : proof.recomputedChallengeMatches
          ? "The backend takes the verifier it stored at the start and adds it to the token request, to prove it is the client that began this flow."
          : "The verifier being sent was altered: Node's own check shows SHA-256(verifier) no longer equals the challenge sent to /authorize.",
      notes: [
        proof.recomputedChallengeMatches
          ? "Node's own check: SHA-256(code_verifier) equals the code_challenge sent to /authorize."
          : "Node's own check: SHA-256(code_verifier) does NOT equal the code_challenge sent to /authorize.",
        "The verifier is shown only by its fingerprint. Compare it with the fingerprint recorded when it was generated.",
      ],
    });
  }

  const result = await postToTokenEndpoint({
    ...tokenRequest,
    explanation:
      pending.demo === "no-pkce-verifier"
        ? "The backend sends the token request WITHOUT the PKCE verifier. Watch whether the authorization server accepts it."
        : undefined,
  });
  if (!result.ok) {
    req.session.lastError = tokenEndpointError("Token exchange", tokenEndpoint, result);
    failFlow(req.session, 6);
    concludeDemo(req.session, pending.demo, { stage: "token exchange", rejected: true, ...responseFacts(result) });
    return res.redirect(config.clientUrl);
  }

  if (pending.demo === "replay-code") {
    // DEMO: send the identical request, with the same authorization code, a second time.
    await gate({
      stage: "token-exchange",
      kind: "network",
      title: "Replay: POST the same authorization code again",
      preview: tokenRequestPreview(tokenRequest),
    });
    const replay = await postToTokenEndpoint({
      ...tokenRequest,
      step: "Replay: same authorization code again",
      timelineStep: undefined,
      demo: {
        id: "replay-code",
        modified: { field: "code", original: "used once (first exchange succeeded)", sent: "the same code, a second time" },
      },
      explanation:
        "DEMO: the backend sends the exact same authorization code to the token endpoint a second time. A compliant server must refuse.",
      notes: ["DEMO: the same code and code_verifier, sent a second time. A compliant authorization server refuses this."],
    });
    if (replay.ok) {
      record({
        direction: "internal",
        category: "demo",
        step: "DEMO: replayed tokens discarded",
        demo: { id: "replay-code" },
        outcome: "info",
        notes: ["The tokens issued for the replayed code are not stored."],
      });
    }
    concludeDemo(req.session, "replay-code", { stage: "token replay", rejected: !replay.ok, ...responseFacts(replay) });
  }

  const grantedScope = typeof result.body.scope === "string" ? result.body.scope : undefined;
  if (pending.demo === "broad-scope") {
    // DEMO: keep the scope comparison, discard the over-broad tokens.
    req.session.broadScope = diffScopes(pending.requestedScope, grantedScope);
    record({
      direction: "internal",
      category: "demo",
      step: "DEMO: broad-scope tokens discarded",
      result: { requested_scope: pending.requestedScope, granted_scope: grantedScope ?? "not provided" },
      timeline: [
        { step: "store-tokens", status: "skipped" },
        { step: "decode-id-token", status: "skipped" },
        { step: "patient-context", status: "skipped" },
      ],
      detail: describeTokens(
        {
          accessToken: typeof result.body.access_token === "string" ? "present" : undefined,
          refreshToken: typeof result.body.refresh_token === "string" ? "present" : undefined,
          idToken: typeof result.body.id_token === "string" ? "present" : undefined,
          grantedScope,
          patientId: typeof result.body.patient === "string" ? "present" : undefined,
        },
        true,
      ),
      demo: { id: "broad-scope" },
      outcome: "info",
      explanation: "DEMO: tokens were issued for the broad scope. The backend throws them away instead of storing them.",
      notes: ["Least privilege: the over-broad tokens are not kept. The existing session is unchanged."],
    });
    advanceFlow(req.session, 7);
    concludeDemo(req.session, "broad-scope", { stage: "token issued", rejected: false, status: result.status, grantedScope });
    return res.redirect(config.clientUrl);
  }

  // 5. Store the tokens server-side. state and code_verifier were already consumed in step 1.
  await gate({ stage: "store-tokens", kind: "internal" });
  const auth = createAuthorizedContext(pending, result.body, tokenEndpoint);
  req.session.auth = auth;
  req.session.narrowScope = diffScopes(auth.requestedScope, auth.grantedScope);
  delete req.session.lastError;
  advanceFlow(req.session, 7);
  recordTokensStored(auth);
  await gate({ stage: "decode-id-token", kind: "internal" });
  recordIdTokenDecoded(auth);
  await gate({ stage: "patient-context", kind: "internal" });
  recordPatientContext(auth);
  concludeDemo(req.session, pending.demo, { stage: "token issued", rejected: false, status: result.status, grantedScope });
  res.redirect(config.clientUrl);
});

authRouter.post("/auth/logout", async (req, res, next) => {
  await gate({ stage: "logout", kind: "internal" });
  const hadTokens = Boolean(req.session.auth);
  record({
    direction: "react-client",
    category: "logout",
    step: "Logout",
    method: "POST",
    endpoint: "/auth/logout",
    requestHeaders: safeHeaders({ Cookie: req.get("cookie") }),
    timeline: [{ step: "logout", status: "done" }],
    detail: { kind: "logout", hadTokens, sessionDestroyed: true, cookieCleared: SESSION_COOKIE_NAME, revoked: false },
    outcome: "info",
    security:
      "Destroying the session makes the tokens unreachable from this app. They stay valid at the authorization server until they expire, because this demo does not revoke them.",
    notes: [
      hadTokens ? "The server-side session and its tokens are destroyed." : "There were no stored tokens.",
      "Tokens are discarded, not revoked: this demo does not call a revocation endpoint.",
    ],
  });
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

/**
 * Applies a breakpoint injection to the token request. Returns the code_verifier
 * that will actually be sent (undefined if none), so the PKCE event can describe it.
 */
function applyTokenInjection(
  request: TokenRequest,
  injection: InjectionId | undefined,
  storedVerifier: string,
): string | undefined {
  const verifier = request.params.code_verifier;
  switch (injection) {
    case "remove-code-verifier":
      recordInjection(injection, {
        field: "code_verifier",
        original: `sent (fingerprint ${fingerprint(VERIFIER_PURPOSE, storedVerifier)})`,
        sent: "(omitted)",
      });
      delete request.params.code_verifier;
      return undefined;
    case "alter-code-verifier": {
      // Change the last character: same length, still valid base64url, different hash.
      const last = verifier.slice(-1);
      const altered = verifier.slice(0, -1) + (last === "A" ? "B" : "A");
      recordInjection(injection, {
        field: "code_verifier",
        original: `fingerprint ${fingerprint(VERIFIER_PURPOSE, verifier)}`,
        sent: `fingerprint ${fingerprint(VERIFIER_PURPOSE, altered)} (last character changed)`,
      });
      request.params.code_verifier = altered;
      return altered;
    }
    case "alter-redirect-uri":
      recordInjection(injection, {
        field: "redirect_uri",
        original: request.params.redirect_uri,
        sent: `${request.params.redirect_uri}/`,
      });
      request.params.redirect_uri = `${request.params.redirect_uri}/`;
      return verifier;
    default:
      return verifier;
  }
}

/** A new normal flow clears the previous error and any demo still waiting for the browser. */
function startNewFlow(session: Partial<SessionData>): void {
  delete session.lastError;
  if (session.demo?.status === "running") delete session.demo;
}

/*
 * A code proves the user logged in and consented, but this app saw neither: those
 * two steps are marked "inferred", never "done". access_denied means the user got
 * as far as the consent screen and declined.
 */
function callbackMarks(code: string | undefined, error: string | undefined): StepMark[] {
  if (code && !error) {
    return [
      { step: "login", status: "inferred" },
      { step: "consent", status: "inferred" },
      { step: "callback", status: "done" },
      { step: "receive-code", status: "done" },
    ];
  }
  const marks: StepMark[] =
    error === "access_denied"
      ? [
          { step: "login", status: "inferred" },
          { step: "consent", status: "failed" },
        ]
      : [];
  return [...marks, { step: "callback", status: "done" }, { step: "receive-code", status: "failed" }];
}

/** Steps 13–16 never ran: the code was not exchanged, so nothing downstream happened. */
function skippedAfterStateCheck(): StepMark[] {
  return (["token-exchange", "store-tokens", "decode-id-token", "patient-context"] as const).map((step) => ({
    step,
    status: "skipped" as const,
  }));
}

const STATE_VERDICTS = { missing: "MISSING", expired: "EXPIRED", mismatch: "MISMATCH" } as const;

/** state is public, but the wire log shows it shortened, with a fingerprint to compare. */
function statePreviews(received: string | undefined, stored: string | undefined): Record<string, string> {
  const show = (value: string | undefined) => {
    if (!value) return "(none)";
    const view = previewValue(STATE_PURPOSE, value);
    return `${view.preview} (fingerprint ${view.fingerprint})`;
  };
  return { state_received: show(received), state_stored_in_session: show(stored) };
}

function responseFacts(result: TokenEndpointResult) {
  return {
    status: result.status,
    error: typeof result.body.error === "string" ? result.body.error : undefined,
    errorDescription: typeof result.body.error_description === "string" ? result.body.error_description : undefined,
  };
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === "string" ? value : undefined;
}

function withoutUndefined(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string>;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
