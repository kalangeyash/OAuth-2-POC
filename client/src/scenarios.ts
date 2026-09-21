/*
 * The Failure Lab's scenarios. Nine run real requests against the real sandbox;
 * one (browser token exposure) is an illustration and says so.
 */
import type { BuilderModId, DemoId } from "../../server/src/timeline";

export type ScenarioRun =
  | { kind: "connect" }
  | { kind: "redirect-demo"; demo: DemoId }
  | { kind: "post-demo"; demo: DemoId }
  | { kind: "builder"; mods: BuilderModId[] }
  | { kind: "patient-override"; patientId: string }
  | { kind: "illustration" };

export interface Scenario {
  id: string;
  n: number;
  title: string;
  initial: string;
  attack: string;
  concept: string;
  mitigation: string;
  /** Where the flow is expected to stop (it may not, on a lenient sandbox; the lab shows what really happened). */
  expectedStop: string;
  run: ScenarioRun;
  needsConnection?: boolean;
  /** The demo result verdicts, when the scenario is one of the server's failure demos. */
  demo?: DemoId;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    n: 1,
    title: "Successful Authorization Code + PKCE",
    initial: "No session. The app has only its configuration.",
    attack: "None: the complete, valid flow.",
    concept: "Authorization Code grant with PKCE (S256), state, back-channel token exchange, BFF token storage.",
    mitigation: "This is the mitigation: every other scenario breaks one piece of it.",
    expectedStop: "Does not stop: tokens stored, patient context resolved.",
    run: { kind: "connect" },
  },
  {
    id: "invalid-state",
    n: 2,
    title: "Invalid state",
    initial: "A normal authorization request with a fresh state.",
    attack: "The state stored in the session is replaced after the browser leaves, so the returned state no longer matches.",
    concept: "CSRF protection (RFC 6749 §10.12).",
    mitigation: "Validate state against the session BEFORE using the code; make it unguessable and single-use.",
    expectedStop: "Step 12, Validate state. The token exchange is never attempted.",
    run: { kind: "redirect-demo", demo: "tamper-state" },
    demo: "tamper-state",
  },
  {
    id: "missing-pkce",
    n: 3,
    title: "Missing PKCE verifier",
    initial: "A valid authorization code bound to a code_challenge.",
    attack: "The token request is sent without code_verifier.",
    concept: "PKCE proof of possession (RFC 7636).",
    mitigation: "The authorization server must require the verifier for any code issued with a challenge.",
    expectedStop: "Step 13, Token exchange (invalid_grant).",
    run: { kind: "redirect-demo", demo: "no-pkce-verifier" },
    demo: "no-pkce-verifier",
  },
  {
    id: "redirect-mismatch",
    n: 4,
    title: "Redirect URI mismatch",
    initial: "The registered redirect_uri is http://localhost:3001/callback.",
    attack: "The authorization request uses the same URI with a trailing slash.",
    concept: "Exact redirect-URI matching (RFC 9700 §4.1).",
    mitigation: "Compare redirect URIs exactly at /authorize, and again at the token endpoint.",
    expectedStop: "Step 7 (strict server) or step 13 (this sandbox's token endpoint).",
    run: { kind: "redirect-demo", demo: "redirect-mismatch" },
    demo: "redirect-mismatch",
  },
  {
    id: "code-replay",
    n: 5,
    title: "Authorization code replay",
    initial: "A code that was just exchanged successfully.",
    attack: "The same code and verifier are sent to the token endpoint a second time.",
    concept: "Single-use authorization codes (RFC 6749 §4.1.2).",
    mitigation: "The server must record used codes and refuse (and ideally revoke) on reuse.",
    expectedStop: "The replay should be refused. This stateless sandbox accepts it: that is the lesson.",
    run: { kind: "redirect-demo", demo: "replay-code" },
    demo: "replay-code",
  },
  {
    id: "broad-scope",
    n: 6,
    title: "Excessive scope request",
    initial: "The app needs patient/Patient.read and patient/Observation.read.",
    attack: "It requests patient/*.read instead.",
    concept: "Least privilege; requested ≠ granted.",
    mitigation: "Request only what is needed; compare the granted scope; servers should narrow by policy.",
    expectedStop: "Not stopped by this sandbox: the broad grant is issued and the demo discards it.",
    run: { kind: "redirect-demo", demo: "broad-scope" },
    demo: "broad-scope",
  },
  {
    id: "expired-token",
    n: 7,
    title: "Expired access token",
    initial: "Connected, with a valid access token and refresh token.",
    attack: "The stored access token is made invalid, as if it expired.",
    concept: "Token lifecycle: 401 → one refresh → one retry.",
    mitigation: "Short-lived access tokens plus a server-side refresh token, used once, with no retry loops.",
    expectedStop: "Does not stop: the refresh recovers and the request is retried.",
    run: { kind: "post-demo", demo: "force-expiry" },
    needsConnection: true,
    demo: "force-expiry",
  },
  {
    id: "refresh-failure",
    n: 8,
    title: "Refresh token failure",
    initial: "Connected, with a valid access token and refresh token.",
    attack: "The access token is invalidated AND the refresh token is corrupted.",
    concept: "A rejected refresh token ends the session.",
    mitigation: "Discard the tokens and send the user through authorization again; never loop.",
    expectedStop: "Step 20, Refresh (invalid_grant), then re-authentication required.",
    run: { kind: "post-demo", demo: "refresh-failure" },
    needsConnection: true,
    demo: "refresh-failure",
  },
  {
    id: "patient-override",
    n: 9,
    title: "Browser attempts to supply a patient ID",
    initial: "Connected. The token context names one authorized patient.",
    attack: "The browser calls GET /api/patient?patient=123, trying to read a different patient.",
    concept: "Trusted context: the patient comes from the authorization server, not from the browser.",
    mitigation: "The backend ignores any patient ID in the request and uses the one from the token response.",
    expectedStop: "Does not stop: the request succeeds, for the AUTHORIZED patient only.",
    run: { kind: "patient-override", patientId: "123" },
    needsConnection: true,
  },
  {
    id: "spa-exposure",
    n: 10,
    title: "Direct browser token exposure (illustration)",
    initial: "Two architectures: a single-page app that holds tokens, and this app's backend-for-frontend.",
    attack: "Any script running in the page (XSS, a compromised dependency, an extension) reads what the page can read.",
    concept: "Backend-for-frontend (OAuth 2.0 for Browser-Based Apps §6.1).",
    mitigation: "Keep tokens on the server; give the browser only an httpOnly session cookie.",
    expectedStop: "Not executed: this app never exposes tokens. The comparison is illustrative.",
    run: { kind: "illustration" },
  },
];
