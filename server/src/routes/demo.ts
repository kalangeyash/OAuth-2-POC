import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import type { SessionData } from "express-session";
import { config } from "../config.js";
import { getAuthorizedPatient, ReauthRequiredError } from "../fhir.js";
import { OAuthFlowError, startAuthorization } from "../oauth.js";
import { redact } from "../redaction.js";
import { broadenPatientScopes } from "../scope.js";
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
      record({
        direction: "internal",
        step: "DEMO: stored state replaced",
        params: { state_sent_to_authorization_server: original, state_now_stored_in_session: pending.state },
        outcome: "info",
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
  const auth = req.session.auth;
  if (!auth) throw new OAuthFlowError("Force token expiry", "Connect first: this demo needs stored tokens.");
  beginDemo(req, "force-expiry");

  // DEMO (server-side only): make the stored access token unusable and mark it expired.
  auth.accessToken = randomBytes(auth.accessToken.length).toString("base64url").slice(0, auth.accessToken.length);
  auth.expiresAt = Date.now();
  record({
    direction: "internal",
    step: "DEMO: access token invalidated",
    outcome: "info",
    notes: ["The stored access token now holds random characters and is marked expired. The next FHIR request sends it as-is."],
  });

  const trace: string[] = [];
  try {
    await getAuthorizedPatient(req.session, trace);
    advanceFlow(req.session, 8);
    concludeDemo(req.session, "force-expiry", { stage: "fhir", rejected: false, trace });
  } catch (error) {
    concludeDemo(req.session, "force-expiry", { stage: "fhir", rejected: true, trace });
    if (!(error instanceof ReauthRequiredError)) throw error;
    failFlow(req.session, 8);
  }
  res.json(redact({ demo: req.session.demo }));
});

function beginDemo(req: Request, id: DemoId): void {
  const definition = DEMOS[id];
  const demo = {
    id,
    title: definition.title,
    whatWeChanged: definition.whatWeChanged(),
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
  record({
    direction: "browser-client",
    step: `DEMO: ${definition.title}`,
    method: req.method,
    endpoint: req.path,
    outcome: "info",
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
