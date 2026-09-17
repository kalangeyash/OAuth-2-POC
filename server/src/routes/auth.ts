import { Router } from "express";
import type { SessionData } from "express-session";
import { config } from "../config.js";
import { requireOAuthEndpoints } from "../discovery.js";
import {
  authorizationCodeParams,
  createAuthorizedContext,
  describeStoredTokens,
  OAuthFlowError,
  postToTokenEndpoint,
  startAuthorization,
  tokenEndpointError,
  type TokenEndpointResult,
  type TokenRequest,
} from "../oauth.js";
import { diffScopes, ensureLaunchScope } from "../scope.js";
import { advanceFlow, checkState, failFlow, SESSION_COOKIE_NAME, takePendingAuthorization } from "../session.js";
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
    step: "Connect",
    method: "GET",
    endpoint: "/auth/login",
    outcome: "info",
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
    step: "EHR launch",
    method: "GET",
    endpoint: "/launch",
    params: { iss, launch },
    outcome: "info",
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
    step: "Redirect back with authorization code",
    method: "GET",
    endpoint: req.path,
    params: withoutUndefined({ code, state, error, error_description: errorDescription }),
    outcome: error ? "error" : "ok",
    notes: [
      "Front channel: the authorization code travels through the browser, so only its first 8 characters are logged.",
    ],
  });

  // 1. Take the pending authorization out of the session. It is single-use:
  //    replaying this /callback URL later finds nothing and is rejected.
  const pending = takePendingAuthorization(req.session);

  // 2. Validate state FIRST. On failure the code never reaches the token endpoint.
  const stateCheck = checkState(pending, state);
  if (!pending || !stateCheck.ok) {
    const title = stateCheck.ok ? "STATE MISMATCH" : STATE_FAILURE_TITLES[stateCheck.reason];
    const detail = stateCheck.ok ? "" : stateCheck.detail;
    record({
      direction: "internal",
      step: "State validation",
      params: { state_received: state ?? "(none)", state_stored_in_session: pending?.state ?? "(none)" },
      result: { verdict: title },
      outcome: "error",
      notes: [detail, "Token exchange skipped. The authorization code was NOT sent to the token endpoint."],
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
    step: "State validation",
    params: { state_received: state, state_stored_in_session: pending.state },
    result: { verdict: "STATE MATCHES" },
    outcome: "ok",
    notes: [
      `Matches the state stored in this session ${Math.round((Date.now() - pending.createdAt) / 1000)} s ago (limit: 10 minutes).`,
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
    notes: [
      "Back channel: Node → authorization server. The browser never sees this request or its response.",
      "code_verifier proves this server is the one that sent the code_challenge (PKCE).",
    ],
  };
  if (pending.demo === "no-pkce-verifier") {
    // DEMO: leave out the PKCE proof.
    delete tokenRequest.params.code_verifier;
    record({
      direction: "internal",
      step: "DEMO: code_verifier removed",
      outcome: "info",
      notes: ["The token request below is sent without code_verifier."],
    });
  }

  const result = await postToTokenEndpoint(tokenRequest);
  if (!result.ok) {
    req.session.lastError = tokenEndpointError("Token exchange", tokenEndpoint, result);
    failFlow(req.session, 6);
    concludeDemo(req.session, pending.demo, { stage: "token exchange", rejected: true, ...responseFacts(result) });
    return res.redirect(config.clientUrl);
  }

  if (pending.demo === "replay-code") {
    // DEMO: send the identical request, with the same authorization code, a second time.
    const replay = await postToTokenEndpoint({
      ...tokenRequest,
      step: "Replay: same authorization code again",
      notes: ["DEMO: the same code and code_verifier, sent a second time. A compliant authorization server refuses this."],
    });
    if (replay.ok) {
      record({
        direction: "internal",
        step: "DEMO: replayed tokens discarded",
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
      step: "DEMO: broad-scope tokens discarded",
      result: { requested_scope: pending.requestedScope, granted_scope: grantedScope ?? "not provided" },
      outcome: "info",
      notes: ["Least privilege: the over-broad tokens are not kept. The existing session is unchanged."],
    });
    advanceFlow(req.session, 7);
    concludeDemo(req.session, "broad-scope", { stage: "token issued", rejected: false, status: result.status, grantedScope });
    return res.redirect(config.clientUrl);
  }

  // 5. Store the tokens server-side. state and code_verifier were already consumed in step 1.
  const auth = createAuthorizedContext(pending, result.body, tokenEndpoint);
  req.session.auth = auth;
  req.session.narrowScope = diffScopes(auth.requestedScope, auth.grantedScope);
  delete req.session.lastError;
  advanceFlow(req.session, 7);
  record({
    direction: "internal",
    step: "Token received",
    result: describeStoredTokens(auth),
    outcome: "ok",
    notes: [
      "Tokens are stored in the server-side session only. The browser holds a session cookie, never a token.",
      auth.idTokenClaims
        ? "ID token payload decoded for display. Its signature is NOT verified by this teaching demo."
        : "No ID token was returned.",
    ],
  });
  concludeDemo(req.session, pending.demo, { stage: "token issued", rejected: false, status: result.status, grantedScope });
  res.redirect(config.clientUrl);
});

authRouter.post("/auth/logout", (req, res, next) => {
  record({
    direction: "browser-client",
    step: "Logout",
    method: "POST",
    endpoint: "/auth/logout",
    outcome: "info",
    notes: [
      req.session.auth ? "The server-side session and its tokens are destroyed." : "There were no stored tokens.",
      "Tokens are discarded, not revoked: this demo does not call a revocation endpoint.",
    ],
  });
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

/** A new normal flow clears the previous error and any demo still waiting for the browser. */
function startNewFlow(session: Partial<SessionData>): void {
  delete session.lastError;
  if (session.demo?.status === "running") delete session.demo;
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
