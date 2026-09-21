import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import type { SessionData } from "express-session";
import { config } from "../config.js";
import { getAuthorizedPatient, ReauthRequiredError } from "../fhir.js";
import { OAuthFlowError, startAuthorization } from "../oauth.js";
import { redact } from "../redaction.js";
import { describeStateTampered } from "../safeView.js";
import { broadenPatientScopes } from "../scope.js";
import { BUILDER_MODS, type BuilderModId } from "../timeline.js";
import { advanceFlow, failFlow, generateState, type DemoId } from "../session.js";
import { nextEntryId, record } from "../wireLog.js";

/*
 * BREAK SOMETHING: failure demonstrations.
 *
 * Nothing here is simulated. Each demo runs the same code as the happy path with one
 * deliberate change, and its explanation is chosen from what the real responses showed.
 * The flows that need a change inside /callback are marked "DEMO" in routes/auth.ts.
 */

export const demoRouter = Router();

/** What actually happened, taken from the real protocol responses. */
export interface DemoFacts {
  stage: "state validation" | "authorization" | "token exchange" | "token replay" | "token issued" | "fhir";
  rejected: boolean;
  status?: number;
  error?: string;
  errorDescription?: string;
  grantedScope?: string;
  trace?: string[];
}

interface DemoDefinition {
  title: string;
  whatWeChanged: () => string;
  /** What the unmodified flow does at the point this demo changes. */
  expected: string;
  concept: string;
  explain: (facts: DemoFacts) => { outcome: string; why: string };
}

const EXACT_REDIRECT =
  "OAuth authorization servers compare redirect URIs exactly. A seemingly harmless difference such as a trailing slash can invalidate the authorization request.";

const PKCE_PROOF =
  "The authorization code alone is not sufficient when PKCE is used. The token endpoint expects proof that the client initiating the exchange possesses the original code verifier.";

const DEMOS: Record<DemoId, DemoDefinition> = {
  "redirect-mismatch": {
    title: "Mismatched redirect URI",
    whatWeChanged: () =>
      `The authorization request sent redirect_uri=${config.redirectUri}/ (one trailing slash added). The token request still sent the registered ${config.redirectUri}.`,
    expected:
      "The authorization request and the token request send the identical, registered redirect_uri. The authorization server redirects back to it and the token endpoint accepts the code.",
    concept: "Redirect URI validation: authorization servers compare redirect URIs exactly.",
    explain(facts) {
      if (facts.stage === "authorization" && facts.rejected) {
        return { outcome: `The authorization server rejected the request: ${providerSaid(facts)}.`, why: EXACT_REDIRECT };
      }
      if (facts.stage === "token exchange" && facts.rejected) {
        return {
          outcome: `The authorization endpoint accepted ${config.redirectUri}/ and sent the browser back with a code. The token endpoint then rejected the exchange: ${providerSaid(facts)}.`,
          why:
            `${EXACT_REDIRECT} This sandbox checks the authorization request by prefix only, so /callback/ got through at /authorize. ` +
            "Its token endpoint requires redirect_uri to be identical to the value in the authorization request (RFC 6749 §4.1.3), so the code could not be redeemed. " +
            "A strict authorization server rejects the authorization request itself and shows an error page instead of redirecting to an unregistered URI.",
        };
      }
      if (facts.stage === "token issued") {
        return {
          outcome: "The provider accepted the mismatched redirect URI at both endpoints and issued tokens.",
          why: `${EXACT_REDIRECT} This provider did not enforce that here. RFC 9700 (OAuth 2.0 Security Best Current Practice) requires exact matching.`,
        };
      }
      return unexpected(facts);
    },
  },

  "tamper-state": {
    title: "Tamper with state",
    whatWeChanged: () =>
      "After sending the browser to /authorize, the server replaced the state stored in its session with a new random value. The browser still carried the original state.",
    expected:
      "The state returned with the code equals the state stored in the session (MATCH), so the backend exchanges the code for tokens.",
    concept: "state is CSRF protection, and it is validated before any token exchange.",
    explain(facts) {
      if (facts.stage === "state validation" && facts.rejected) {
        return {
          outcome: "STATE MISMATCH. Token exchange skipped: the authorization code was never sent to the token endpoint.",
          why:
            "The state that came back with the code did not match the state stored in this browser session, so /callback cannot tell whether the response belongs to a request this session started. " +
            "Without this check an attacker could push their own authorization code into a victim's session (login CSRF). The check runs first, so a forged or mixed-up code is never redeemed.",
        };
      }
      return unexpected(facts);
    },
  },

  "replay-code": {
    title: "Replay authorization code",
    whatWeChanged: () =>
      "After a successful token exchange, the server sent the same authorization code and code_verifier to the token endpoint a second time.",
    expected: "Each authorization code is redeemed exactly once. A second attempt is refused with invalid_grant.",
    concept: "Authorization codes are single-use credentials.",
    explain(facts) {
      if (facts.stage === "token replay" && facts.rejected) {
        return {
          outcome: `The token endpoint rejected the replayed code: ${providerSaid(facts)}.`,
          why:
            "Authorization codes are one-time credentials. After the first exchange the authorization server refuses the same code (RFC 6749 §4.1.2), " +
            "which limits what a code leaked through browser history, logs or a referrer header is worth.",
        };
      }
      if (facts.stage === "token replay") {
        return {
          outcome: `The sandbox ACCEPTED the replayed code: HTTP ${facts.status}, with a new set of tokens. This demo discarded them.`,
          why:
            "This sandbox issues stateless authorization codes (signed JWTs valid for 5 minutes) and does not record whether a code was already used, so it cannot detect the replay. " +
            "RFC 6749 §4.1.2 says an authorization server must not accept a code twice and should revoke tokens already issued from it; production servers typically answer invalid_grant. " +
            "This client's own defence still holds: it deleted its state and code_verifier after the first exchange, so replaying the /callback URL against this app is rejected before any token request.",
        };
      }
      return unexpected(facts);
    },
  },

  "no-pkce-verifier": {
    title: "Remove PKCE verifier",
    whatWeChanged: () =>
      "The token request was sent without code_verifier. The code, redirect_uri and client_id were all correct.",
    expected:
      "The token request carries the code_verifier. The authorization server hashes it, finds it equals the code_challenge from /authorize, and issues tokens.",
    concept: "PKCE: the token request must prove possession of the original code_verifier.",
    explain(facts) {
      if (facts.stage === "token exchange" && facts.rejected) {
        return {
          outcome: `The token endpoint rejected the exchange: ${providerSaid(facts)}.`,
          why:
            `${PKCE_PROOF} The authorization request carried only code_challenge, a SHA-256 hash of the verifier; the verifier itself never left this server. ` +
            "So someone who intercepts the code but not the verifier cannot redeem it. PKCE does not help if an attacker can also read the verifier " +
            "(for example by compromising this server), and it does not stop a malicious app that runs its own complete flow.",
        };
      }
      if (facts.stage === "token issued") {
        return {
          outcome: "The provider issued tokens WITHOUT a code_verifier.",
          why: `${PKCE_PROOF} This provider did not enforce PKCE for this request, so anyone holding the code could redeem it.`,
        };
      }
      return unexpected(facts);
    },
  },

  "broad-scope": {
    title: "Request patient/*.read",
    whatWeChanged: () => `Requested "${broadenPatientScopes(config.scopes)}" instead of "${config.scopes}".`,
    expected: `The app requests only the resource types it needs ("${config.scopes}") and stores the tokens it is granted.`,
    concept: "Least privilege: request only what the app needs, and compare requested with granted scope.",
    explain(facts) {
      if (facts.stage === "authorization" && facts.rejected) {
        return {
          outcome: `The authorization server refused the broad request: ${providerSaid(facts)}.`,
          why: "Authorization servers may refuse scopes the client is not registered for or that the user cannot grant. Asking for more than the app needs can block the launch entirely.",
        };
      }
      if (facts.stage === "token issued") {
        const wildcardGranted = (facts.grantedScope ?? "").split(" ").includes("patient/*.read");
        return {
          outcome: `Granted: ${facts.grantedScope ?? "(the token response had no scope parameter)"}.`,
          why: wildcardGranted
            ? "This sandbox granted the wildcard exactly as requested, and its consent screen offers no scope-by-scope choice, so nothing narrowed the grant. " +
              "That is a sandbox limitation, not a recommendation: in a real EHR the grant is limited by the app's registration, the user's role and the patient's choices. " +
              "This app needs only Patient and Observation, so requesting patient/*.read violates least privilege. The broad tokens were discarded and the existing session is unchanged."
            : "The authorization server did not grant the wildcard as requested: requested permissions are not necessarily granted permissions. The tokens were discarded and the existing session is unchanged.",
        };
      }
      return unexpected(facts);
    },
  },

  "force-expiry": {
    title: "Force token expiry",
    whatWeChanged: () =>
      "Server-side only: the stored access token was replaced with random characters of the same length and marked expired. " +
      "The sandbox issues 60-minute tokens and we cannot move its clock, so the token is made invalid to get a genuine 401 from the FHIR server.",
    expected: "The stored access token is valid, so the FHIR server answers 200 to the first request.",
    concept: "Token lifecycle: 401, then one refresh, then one retry.",
    explain(facts) {
      const trace = (facts.trace ?? []).join(" → ");
      if (!facts.rejected) {
        return {
          outcome: `${trace}. The app is usable again with a new access token.`,
          why:
            "The FHIR server rejected the access token with 401. The central FHIR wrapper used the refresh token once to get a new access token, then retried the original request exactly once. " +
            "The user did not have to log in again. There are no retry loops: had the refresh or the retry failed, the stored tokens would have been cleared and the user asked to reconnect.",
        };
      }
      return {
        outcome: `${trace || "The FHIR request failed"}. Re-authentication required.`,
        why: "The single refresh attempt or the single retry failed, so the wrapper cleared the stored tokens instead of trying again. The user must click Connect.",
      };
    },
  },

  "refresh-failure": {
    title: "Refresh token failure",
    whatWeChanged: () =>
      "Server-side only: the stored access token was invalidated (as in Force token expiry) AND the stored refresh token was replaced with random characters of the same length.",
    expected: "After the 401, the refresh token is accepted, a new access token is issued, and the request is retried successfully.",
    concept: "A rejected refresh token ends the session: the user must authorize again.",
    explain(facts) {
      const trace = (facts.trace ?? []).join(" → ");
      if (facts.rejected) {
        return {
          outcome: `${trace}. The stored tokens were discarded: re-authentication required.`,
          why:
            "The FHIR server answered 401, so the wrapper tried the refresh token once. The authorization server rejected it (a refresh token that is revoked, expired or unknown is refused with invalid_grant). " +
            "The wrapper did not loop or guess: it cleared the tokens and asks the user to Connect again. That is the only safe recovery when the long-lived credential itself is no longer accepted.",
        };
      }
      return {
        outcome: `${trace}. The corrupted refresh token was ACCEPTED.`,
        why: "The authorization server issued a new access token for a refresh token it never issued. A compliant server must refuse it with invalid_grant.",
      };
    },
  },

  "refresh-disabled": {
    title: "Refresh disabled (no refresh token)",
    whatWeChanged: () =>
      "Server-side only: the stored access token was invalidated AND the stored refresh token was deleted, as if offline_access had never been granted.",
    expected: "After the 401, the refresh token renews access without the user noticing.",
    concept: "Without a refresh token (offline_access), an expired access token means a new login.",
    explain(facts) {
      const trace = (facts.trace ?? []).join(" → ");
      return {
        outcome: `${trace || "FHIR request → HTTP 401"}. No refresh was possible: re-authentication required.`,
        why:
          "The FHIR server rejected the access token and there was no refresh token to renew it with, so no token request was even sent. " +
          "Apps that do not request offline_access (or servers that do not grant it) must send the user through the authorization flow again when the access token expires.",
      };
    },
  },
};

demoRouter.get("/demo/redirect-mismatch", async (req, res) => {
  beginDemo(req, "redirect-mismatch");
  await startAuthorization(req, res, {
    fhirBaseUrl: config.fhirBaseUrl,
    scope: config.scopes,
    demo: "redirect-mismatch",
    // DEMO: only the authorization request gets the trailing slash.
    authorizeRedirectUri: `${config.redirectUri}/`,
  });
});

demoRouter.get("/demo/tamper-state", async (req, res) => {
  beginDemo(req, "tamper-state");
  await startAuthorization(req, res, {
    fhirBaseUrl: config.fhirBaseUrl,
    scope: config.scopes,
    demo: "tamper-state",
    beforeRedirect(pending) {
      // DEMO: overwrite the state stored in the session. The browser still carries the original value.
      const original = pending.state;
      pending.state = generateState();
      const detail = describeStateTampered(original, pending.state);
      record({
        direction: "internal",
        category: "demo",
        step: "DEMO: stored state replaced",
        params: {
          state_sent_to_authorization_server: `${detail.original.preview} (fingerprint ${detail.original.fingerprint})`,
          state_now_stored_in_session: `${detail.replacement.preview} (fingerprint ${detail.replacement.fingerprint})`,
        },
        detail,
        demo: {
          id: "tamper-state",
          modified: {
            field: "state (stored in session)",
            original: detail.original.preview,
            sent: detail.replacement.preview,
          },
        },
        outcome: "info",
        explanation:
          "DEMO: the backend overwrote the state in its own session. The browser is still carrying the original state to the authorization server.",
        notes: ["When the browser comes back, /callback compares these two values."],
      });
    },
  });
});

demoRouter.get("/demo/replay-code", async (req, res) => {
  beginDemo(req, "replay-code");
  await startAuthorization(req, res, { fhirBaseUrl: config.fhirBaseUrl, scope: config.scopes, demo: "replay-code" });
});

demoRouter.get("/demo/no-pkce-verifier", async (req, res) => {
  beginDemo(req, "no-pkce-verifier");
  await startAuthorization(req, res, { fhirBaseUrl: config.fhirBaseUrl, scope: config.scopes, demo: "no-pkce-verifier" });
});

demoRouter.get("/demo/broad-scope", async (req, res) => {
  beginDemo(req, "broad-scope");
  await startAuthorization(req, res, {
    fhirBaseUrl: config.fhirBaseUrl,
    scope: broadenPatientScopes(config.scopes),
    demo: "broad-scope",
  });
});

demoRouter.post("/demo/force-expiry", async (req, res) => {
  await runExpiryDemo(req, "force-expiry");
  res.json(redact({ demo: req.session.demo }));
});

/** Scenario: the access token expires AND the refresh token is rejected. */
demoRouter.post("/demo/refresh-failure", async (req, res) => {
  await runExpiryDemo(req, "refresh-failure");
  res.json(redact({ demo: req.session.demo }));
});

/** Scenario: the access token expires and there is no refresh token at all. */
demoRouter.post("/demo/refresh-disabled", async (req, res) => {
  await runExpiryDemo(req, "refresh-disabled");
  res.json(redact({ demo: req.session.demo }));
});

/**
 * Authorization Request Builder: starts a real authorization with the chosen,
 * whitelisted changes to the authorization URL. Unknown values are refused.
 */
demoRouter.get("/lab/authorize", async (req, res) => {
  const requested = String(req.query.mods ?? "")
    .split(",")
    .map((mod) => mod.trim())
    .filter(Boolean);
  const unknown = requested.filter((mod) => !(mod in BUILDER_MODS));
  if (unknown.length > 0) {
    throw new OAuthFlowError("Authorization Request Builder", `Unknown modification: ${unknown.join(", ")}.`);
  }
  const mods = requested as BuilderModId[];
  delete req.session.lastError;
  if (req.session.demo?.status === "running") delete req.session.demo;
  record({
    direction: "browser-client",
    category: "lab",
    step: mods.length > 0 ? "Request builder: authorization with modifications" : "Request builder: unmodified authorization",
    method: "GET",
    endpoint: req.path,
    params: mods.length > 0 ? { mods: mods.join(",") } : undefined,
    paramsIn: "query",
    runStart: true,
    outcome: "info",
    explanation:
      mods.length > 0
        ? `Experiment: a real authorization request with ${mods.map((mod) => BUILDER_MODS[mod].label).join(", ")}. Watch where the real servers accept or refuse it.`
        : "A real, unmodified authorization request, built step by step.",
    notes: mods.map((mod) => `${BUILDER_MODS[mod].label}: ${BUILDER_MODS[mod].expect}`),
  });
  await startAuthorization(req, res, { fhirBaseUrl: config.fhirBaseUrl, scope: config.scopes, mods });
});

/*
 * Force token expiry and its two refresh-failure variants. Each changes only what
 * is stored on the server, then makes one ordinary FHIR request: the 401, the
 * refresh attempt and the retry are all real.
 */
async function runExpiryDemo(req: Request, id: "force-expiry" | "refresh-failure" | "refresh-disabled"): Promise<void> {
  const auth = req.session.auth;
  if (!auth) throw new OAuthFlowError(DEMOS[id].title, "Connect first: this demo needs stored tokens.");
  beginDemo(req, id);

  // DEMO (server-side only): make the stored access token unusable and mark it expired.
  auth.accessToken = randomBytes(auth.accessToken.length).toString("base64url").slice(0, auth.accessToken.length);
  auth.expiresAt = Date.now();
  record({
    direction: "internal",
    category: "demo",
    step: "DEMO: access token invalidated",
    demo: {
      id,
      modified: {
        field: "access_token (stored on the server)",
        original: "the valid token issued by the authorization server",
        sent: "random characters of the same length, marked expired",
      },
    },
    outcome: "info",
    explanation:
      "DEMO: the backend made its own stored access token unusable, as if it had expired. The next FHIR request will carry it.",
    notes: ["The stored access token now holds random characters and is marked expired. The next FHIR request sends it as-is."],
  });

  if (id === "refresh-failure" && auth.refreshToken) {
    auth.refreshToken = randomBytes(auth.refreshToken.length).toString("base64url").slice(0, auth.refreshToken.length);
    record({
      direction: "internal",
      category: "demo",
      step: "DEMO: refresh token corrupted",
      demo: {
        id,
        modified: {
          field: "refresh_token (stored on the server)",
          original: "the refresh token issued by the authorization server",
          sent: "random characters of the same length",
        },
      },
      outcome: "info",
      explanation: "DEMO: the stored refresh token was replaced too. When the backend tries to refresh, it will send this.",
    });
  }
  if (id === "refresh-disabled") {
    delete auth.refreshToken;
    record({
      direction: "internal",
      category: "demo",
      step: "DEMO: refresh token removed",
      demo: {
        id,
        modified: { field: "refresh_token (stored on the server)", original: "stored", sent: "(none, as if offline_access was not granted)" },
      },
      outcome: "info",
      explanation: "DEMO: the stored refresh token was deleted. The backend has nothing to renew access with.",
    });
  }

  const trace: string[] = [];
  try {
    await getAuthorizedPatient(req.session, trace);
    advanceFlow(req.session, 8);
    concludeDemo(req.session, id, { stage: "fhir", rejected: false, trace });
  } catch (error) {
    concludeDemo(req.session, id, { stage: "fhir", rejected: true, trace });
    if (!(error instanceof ReauthRequiredError)) throw error;
    failFlow(req.session, 8);
  }
}

function beginDemo(req: Request, id: DemoId): void {
  const definition = DEMOS[id];
  const demo = {
    id,
    title: definition.title,
    whatWeChanged: definition.whatWeChanged(),
    expected: definition.expected,
    concept: definition.concept,
    status: "running" as const,
    firstEntryId: nextEntryId(),
    lastEntryId: null,
    outcome: null,
    why: null,
    rejected: null,
    startedAt: new Date().toISOString(),
  };
  req.session.demo = demo;
  delete req.session.lastError;
  // The redirect demos are browser navigations that start a whole new authorization.
  // Force token expiry is a React fetch inside the current one.
  const navigation = req.method === "GET";
  record({
    direction: navigation ? "browser-client" : "react-client",
    category: "demo",
    step: `DEMO: ${definition.title}`,
    method: req.method,
    endpoint: req.path,
    runStart: navigation || undefined,
    demo: { id },
    outcome: "info",
    explanation: `Failure demo started: ${definition.title}. ${demo.whatWeChanged}`,
    securityConcept: definition.concept,
    notes: [demo.whatWeChanged],
  });
}

/** Called wherever a demo flow ends, with what the real protocol responses showed. */
export function concludeDemo(session: Partial<SessionData>, demoId: DemoId | undefined, facts: DemoFacts): void {
  const demo = session.demo;
  if (!demoId || !demo || demo.id !== demoId || demo.status === "completed") return;
  const { outcome, why } = DEMOS[demoId].explain(facts);
  Object.assign(demo, { status: "completed", outcome, why, rejected: facts.rejected, lastEntryId: nextEntryId() - 1 });
}

function providerSaid(facts: DemoFacts): string {
  const parts = [
    facts.status ? `HTTP ${facts.status}` : "",
    facts.error ?? "",
    facts.errorDescription ? `"${facts.errorDescription}"` : "",
  ];
  return parts.filter(Boolean).join(" ") || "no error details";
}

/** The flow ended somewhere this demo's explanation does not cover: report the facts without interpreting them. */
function unexpected(facts: DemoFacts): { outcome: string; why: string } {
  return {
    outcome: `The flow ended at ${facts.stage} (${facts.rejected ? "rejected" : "accepted"}): ${providerSaid(facts)}.`,
    why: "This run did not reach the step the demo is designed to break. The wire log shows the real requests and responses.",
  };
}
