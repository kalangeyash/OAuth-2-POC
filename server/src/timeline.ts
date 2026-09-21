/*
 * The shared vocabulary of the OAuth Protocol Lab: who the actors are, which
 * channel a message travels on, the shape of one wire-log event, the 21 steps the
 * timeline teaches (with the real source files that implement each one), and the
 * debugger's modes, breakpoint injections and authorization-request modifications.
 *
 * Used by:
 *   - the server, which records events, pauses at breakpoints and says which
 *     timeline step each event advances
 *   - the React app, which draws everything from those events
 *
 * Plain TypeScript with no Node or browser APIs (like redaction.ts), so both sides
 * compile the identical file and the ids cannot drift apart.
 */

export type ActorId = "browser" | "react" | "node" | "auth" | "fhir";

/**
 * front: carried by the browser through redirects (visible in the address bar).
 * back:  the Node server talking directly to another server. The browser sees nothing.
 * local: inside this application: a browser or React request to our own Node server,
 *        or a check or change inside Node itself.
 */
export type Channel = "front" | "back" | "local";

export type Direction =
  | "browser-client" // Browser navigation → Node OAuth client (/auth/login, /launch, GET /demo/…, GET /lab/authorize)
  | "react-client" // React fetch → Node OAuth client (/api/…, POST /auth/logout, POST /demo/…)
  | "browser-auth" // Browser → authorization server (front channel)
  | "auth-browser" // Authorization server → browser → Node client (front channel)
  | "client-auth" // Node client → authorization server (back channel)
  | "client-fhir" // Node client → FHIR server (back channel)
  | "internal"; // A check or change inside the Node client

export const DIRECTION_ACTORS: Record<Direction, { from: ActorId; to: ActorId }> = {
  "browser-client": { from: "browser", to: "node" },
  "react-client": { from: "react", to: "node" },
  "browser-auth": { from: "browser", to: "auth" },
  "auth-browser": { from: "auth", to: "node" },
  "client-auth": { from: "node", to: "auth" },
  "client-fhir": { from: "node", to: "fhir" },
  internal: { from: "node", to: "node" },
};

/** The channel follows from the direction, so no caller can mislabel it. */
export function channelOf(direction: Direction): Channel {
  if (direction === "browser-auth" || direction === "auth-browser") return "front";
  if (direction === "client-auth" || direction === "client-fhir") return "back";
  return "local";
}

export const ACTORS: Record<ActorId, { name: string; short: string }> = {
  browser: { name: "Browser", short: "Browser" },
  react: { name: "React application", short: "React UI" },
  node: { name: "Node/Express OAuth client (BFF)", short: "Node BFF" },
  auth: { name: "Authorization server", short: "Auth server" },
  fhir: { name: "FHIR resource server", short: "FHIR server" },
};

export const ACTOR_ORDER: ActorId[] = ["browser", "react", "node", "auth", "fhir"];

export const CHANNELS: Record<Channel, { label: string; description: string }> = {
  front: {
    label: "FRONT CHANNEL",
    description: "Carried by the browser through redirects. Visible in the address bar, so it never carries a secret.",
  },
  back: {
    label: "BACK CHANNEL",
    description: "The Node server talks directly to another server. The browser never sees the request or the response.",
  },
  local: {
    label: "LOCAL APPLICATION EVENT",
    description: "Inside this application: the browser or React calling our own Node server, or a step inside Node.",
  },
};

export type DemoId =
  | "redirect-mismatch"
  | "tamper-state"
  | "replay-code"
  | "no-pkce-verifier"
  | "broad-scope"
  | "force-expiry"
  | "refresh-failure"
  | "refresh-disabled";

/** A real place in this repository. Checked by server/tests/sources.test.ts, so it cannot be invented. */
export interface SourceRef {
  file: string;
  /** A function name, or a route such as "GET /callback". */
  symbol: string;
}

// ---------------------------------------------------------------------------
// The 21 timeline steps
// ---------------------------------------------------------------------------

export type TimelineStepId =
  | "discovery"
  | "generate-state"
  | "generate-verifier"
  | "generate-challenge"
  | "store-session"
  | "build-url"
  | "redirect"
  | "login"
  | "consent"
  | "callback"
  | "receive-code"
  | "validate-state"
  | "token-exchange"
  | "store-tokens"
  | "decode-id-token"
  | "patient-context"
  | "request-patient"
  | "request-observations"
  | "render"
  | "refresh"
  | "logout";

export type StepMarkStatus = "active" | "done" | "failed" | "skipped" | "inferred";

/** An event's claim about one timeline step. Only the server makes these claims. */
export interface StepMark {
  step: TimelineStepId;
  status: StepMarkStatus;
}

export type TimelinePhase = "prepare" | "front" | "back" | "fhir" | "lifecycle";

export interface TimelineStep {
  id: TimelineStepId;
  n: number;
  title: string;
  actor: ActorId;
  channel: Channel;
  phase: TimelinePhase;
  /** The security or protocol idea this step demonstrates. */
  concept: string;
  /** Where the idea comes from. */
  spec: string;
  /** For a non-expert audience, present tense: what is happening while this step runs. */
  explanation: string;
  /** Why the step exists at all. */
  why: string;
  /** What would go wrong without it. */
  ifMissing: string;
  /** Can the browser (and so the user, extensions, history) see this step's data? */
  browserVisible: string;
  /** Does it carry anything secret? */
  sensitive: string;
  preconditions: string[];
  /** The possible results, good and bad. */
  outcomes: string[];
  /** What this step enables. */
  next: string;
  source: SourceRef[];
  env: string[];
  /** false: happens where this app cannot see it, so it can only be inferred. */
  observable: boolean;
  /** true: not part of every run (refresh, logout). */
  optional: boolean;
}

export const PHASES: Record<TimelinePhase, string> = {
  prepare: "Prepare the request (inside Node)",
  front: "Front channel (through the browser)",
  back: "Back channel (server to server)",
  fhir: "Use the access token",
  lifecycle: "Token lifecycle",
};

const OAUTH = "server/src/oauth.ts";
const AUTH_ROUTES = "server/src/routes/auth.ts";
const SESSION = "server/src/session.ts";
const FHIR = "server/src/fhir.ts";

export const TIMELINE: TimelineStep[] = [
  {
    id: "discovery",
    n: 1,
    title: "SMART discovery",
    actor: "node",
    channel: "back",
    phase: "prepare",
    concept: "SMART configuration: endpoints are discovered, never hardcoded.",
    spec: "SMART App Launch 2.x, §Conformance (.well-known/smart-configuration)",
    explanation:
      "The backend reads the FHIR server's .well-known/smart-configuration to learn where to send the user to log in and where to exchange codes for tokens.",
    why: "Every EHR has different endpoints. Discovery lets one app work with any SMART server without hardcoding URLs.",
    ifMissing: "The app would need hardcoded endpoints, and would break (or talk to the wrong server) whenever the EHR changes them.",
    browserVisible: "No. Node fetches it server to server. (It is public metadata anyway.)",
    sensitive: "No credential is sent or received.",
    preconditions: ["FHIR_BASE_URL is configured (or an EHR supplied iss)"],
    outcomes: [
      "200 with authorization_endpoint and token_endpoint → the flow can start",
      "404 / network error → the flow cannot start (DiscoveryError)",
      "Document missing an endpoint → the flow cannot start",
    ],
    next: "Generate state and PKCE values for a new authorization request.",
    source: [
      { file: "server/src/discovery.ts", symbol: "discover" },
      { file: "server/src/discovery.ts", symbol: "requireOAuthEndpoints" },
    ],
    env: ["FHIR_BASE_URL"],
    observable: true,
    optional: false,
  },
  {
    id: "generate-state",
    n: 2,
    title: "Generate OAuth state",
    actor: "node",
    channel: "local",
    phase: "prepare",
    concept: "state: CSRF protection that binds the callback to this browser session.",
    spec: "RFC 6749 §10.12; RFC 9700 §4.7",
    explanation:
      "The backend creates a random, unguessable value called state. It will come back with the authorization code and must match.",
    why: "Without state, an attacker could make your browser deliver THEIR authorization code to this app (login CSRF).",
    ifMissing: "The callback could not tell whether it answers a request this browser started, so a forged callback would be accepted.",
    browserVisible: "Yes, later: it travels in the authorization URL and comes back in the callback URL.",
    sensitive: "Not secret, but unguessable and single-use.",
    preconditions: ["A new authorization request is starting"],
    outcomes: ["32 random bytes from a CSPRNG → 43 base64url characters"],
    next: "Generate the PKCE code_verifier.",
    source: [
      { file: SESSION, symbol: "generateState" },
      { file: OAUTH, symbol: "startAuthorization" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "generate-verifier",
    n: 3,
    title: "Generate PKCE verifier",
    actor: "node",
    channel: "local",
    phase: "prepare",
    concept: "PKCE: a one-time secret that only this server knows.",
    spec: "RFC 7636 §4.1",
    explanation:
      "The backend creates a second random secret, the PKCE code_verifier. It never leaves the Node server until the token request.",
    why: "It lets the token endpoint check that whoever redeems the code is the same client that started the flow.",
    ifMissing: "Anyone who intercepted the authorization code (history, logs, a malicious app) could redeem it for tokens.",
    browserVisible: "Never. It stays in the server-side session.",
    sensitive: "SECRET. Shown here only by length and fingerprint.",
    preconditions: ["A new authorization request is starting"],
    outcomes: ["48 random bytes → 64 base64url characters (RFC 7636 allows 43–128)"],
    next: "Hash it into the code_challenge.",
    source: [
      { file: "server/src/pkce.ts", symbol: "generateCodeVerifier" },
      { file: OAUTH, symbol: "startAuthorization" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "generate-challenge",
    n: 4,
    title: "Generate PKCE challenge",
    actor: "node",
    channel: "local",
    phase: "prepare",
    concept: "PKCE S256: code_challenge = BASE64URL(SHA-256(code_verifier)).",
    spec: "RFC 7636 §4.2",
    explanation:
      "The backend hashes the verifier with SHA-256. Only this hash, the code_challenge, will travel through the browser.",
    why: "A hash cannot be reversed, so seeing the challenge in a URL does not reveal the verifier.",
    ifMissing: "Sending the verifier itself (or method=plain) would let anyone who sees the URL redeem the code.",
    browserVisible: "Yes, in the authorization URL. That is safe: it is only a hash.",
    sensitive: "Public (a one-way hash).",
    preconditions: ["The code_verifier exists"],
    outcomes: ["A 43-character base64url SHA-256 hash, method S256"],
    next: "Store state and the verifier in the server session.",
    source: [{ file: "server/src/pkce.ts", symbol: "createCodeChallenge" }],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "store-session",
    n: 5,
    title: "Store state and verifier in session",
    actor: "node",
    channel: "local",
    phase: "prepare",
    concept: "Server-side session: secrets stay on the server; the browser holds only a session cookie.",
    spec: "OAuth 2.0 for Browser-Based Apps (BFF pattern)",
    explanation:
      "The backend saves state and the verifier in its own session storage. The browser only gets an httpOnly cookie with a session ID.",
    why: "The callback needs both values later, and neither may ever be stored in the browser.",
    ifMissing: "The callback would have nothing to compare state with and no verifier to send: the flow could not complete safely.",
    browserVisible: "Only the session cookie, and JavaScript cannot read it (httpOnly).",
    sensitive: "The stored verifier is secret; the cookie holds only a signed session ID.",
    preconditions: ["state and code_verifier exist"],
    outcomes: ["Pending authorization stored for 10 minutes, single-use"],
    next: "Build the authorization URL.",
    source: [
      { file: OAUTH, symbol: "startAuthorization" },
      { file: SESSION, symbol: "createSessionMiddleware" },
    ],
    env: ["SESSION_SECRET"],
    observable: true,
    optional: false,
  },
  {
    id: "build-url",
    n: 6,
    title: "Build authorization URL",
    actor: "node",
    channel: "local",
    phase: "prepare",
    concept: "The authorization request: every parameter is public because the browser carries it.",
    spec: "RFC 6749 §4.1.1; SMART App Launch §App Asks for Authorization",
    explanation:
      "The backend builds the authorization URL: who the app is, where to come back to, what access it wants, state, and the PKCE challenge.",
    why: "This URL is the whole request the user is asked to approve.",
    ifMissing: "There is no other way to ask the authorization server for the user's approval.",
    browserVisible: "Yes: the whole URL appears in the address bar and history.",
    sensitive: "No secrets: state is single-use and code_challenge is a hash.",
    preconditions: ["Discovery returned authorization_endpoint", "state and code_challenge exist"],
    outcomes: ["A GET URL with response_type, client_id, redirect_uri, scope, state, aud, code_challenge, code_challenge_method"],
    next: "Redirect the browser to it.",
    source: [{ file: OAUTH, symbol: "startAuthorization" }],
    env: ["CLIENT_ID", "REDIRECT_URI", "SCOPES", "FHIR_BASE_URL"],
    observable: true,
    optional: false,
  },
  {
    id: "redirect",
    n: 7,
    title: "Redirect browser to authorization server",
    actor: "browser",
    channel: "front",
    phase: "front",
    concept: "Front channel: the browser carries the request, so it holds nothing secret.",
    spec: "RFC 6749 §4.1.1 (302 redirect to the authorization endpoint)",
    explanation:
      "The backend created an authorization request and is sending the browser to the healthcare authorization server.",
    why: "The user must log in and approve access on the authorization server's own page, not inside this app.",
    ifMissing: "The app would have to collect the user's password itself, which OAuth exists to prevent.",
    browserVisible: "Yes: this is a browser redirect.",
    sensitive: "No secrets.",
    preconditions: ["Authorization URL built", "Pending authorization stored in the session"],
    outcomes: [
      "Authorization server shows login and consent",
      "Authorization server shows an error page (bad client_id / redirect_uri)",
      "Authorization server redirects back with an error",
    ],
    next: "The user logs in and consents at the authorization server.",
    source: [
      { file: OAUTH, symbol: "startAuthorization" },
      { file: AUTH_ROUTES, symbol: "GET /auth/login" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "login",
    n: 8,
    title: "User login",
    actor: "auth",
    channel: "front",
    phase: "front",
    concept: "The app never sees the user's password.",
    spec: "RFC 6749 §4.1 (steps B–C happen at the authorization server)",
    explanation:
      "The user is authenticating directly with the authorization server. Our application does not receive the password.",
    why: "Credentials go only to the party that owns them. This app is trusted with an access token, never a password.",
    ifMissing: "Without authentication, anyone could grant access to anyone's records.",
    browserVisible: "The login page is the authorization server's, not ours.",
    sensitive: "The password goes only to the authorization server.",
    preconditions: ["The browser followed the redirect"],
    outcomes: ["User authenticated (inferred later, when a code arrives)", "User abandons the login"],
    next: "The user is asked to consent.",
    source: [],
    env: [],
    observable: false,
    optional: false,
  },
  {
    id: "consent",
    n: 9,
    title: "User consent",
    actor: "auth",
    channel: "front",
    phase: "front",
    concept: "Consent: the user decides what the app may access.",
    spec: "RFC 6749 §4.1 (authorization decision); SMART scopes",
    explanation:
      "The authorization server shows the user what the app is asking for (the scopes), and the user approves or denies it.",
    why: "Access is granted by the user (or policy), not taken by the app. Requested scopes are not necessarily granted scopes.",
    ifMissing: "The app would receive access the user never agreed to.",
    browserVisible: "The consent page is the authorization server's.",
    sensitive: "No.",
    preconditions: ["User authenticated"],
    outcomes: ["Approved → redirect back with a code", "Denied → redirect back with error=access_denied"],
    next: "The authorization server redirects the browser back to our callback.",
    source: [],
    env: [],
    observable: false,
    optional: false,
  },
  {
    id: "callback",
    n: 10,
    title: "Authorization server redirects back",
    actor: "auth",
    channel: "front",
    phase: "front",
    concept: "Redirect URI: the code is only ever sent to a pre-registered address.",
    spec: "RFC 6749 §4.1.2; §3.1.2 (redirection endpoint)",
    explanation:
      "The authorization server sends the browser back to this app's registered callback URL, carrying the result in the address bar.",
    why: "The browser is the only path between the authorization server and this app at this point.",
    ifMissing: "The app would never learn the outcome of the authorization.",
    browserVisible: "Yes: the callback URL (with code and state) is in the address bar and history.",
    sensitive: "The code is sensitive but short-lived, single-use and PKCE-bound.",
    preconditions: ["Consent given (or an error to report)", "redirect_uri matched a registered one"],
    outcomes: ["?code=…&state=…", "?error=…&state=…"],
    next: "Read the authorization code.",
    source: [{ file: AUTH_ROUTES, symbol: "GET /callback" }],
    env: ["REDIRECT_URI"],
    observable: true,
    optional: false,
  },
  {
    id: "receive-code",
    n: 11,
    title: "Receive authorization code",
    actor: "node",
    channel: "front",
    phase: "front",
    concept: "The authorization code: short-lived, single-use, and useless without the PKCE verifier.",
    spec: "RFC 6749 §4.1.2 (code lifetime ≤ 10 min, single use)",
    explanation:
      "The backend receives a short-lived authorization code. On its own it is not an access token, and it cannot be redeemed without the verifier.",
    why: "Sending a one-time code through the browser, instead of a token, keeps tokens off the front channel.",
    ifMissing: "Without a code there is nothing to exchange; the flow ends.",
    browserVisible: "Yes (URL). Shown here only by its first 8 characters.",
    sensitive: "Yes, briefly: it is a one-time credential.",
    preconditions: ["The callback arrived"],
    outcomes: ["Code present → validate state", "Error instead of code → stop"],
    next: "Validate state before using the code.",
    source: [{ file: AUTH_ROUTES, symbol: "GET /callback" }],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "validate-state",
    n: 12,
    title: "Validate state",
    actor: "node",
    channel: "local",
    phase: "back",
    concept: "CSRF protection and authorization-response binding.",
    spec: "RFC 6749 §10.12; RFC 9700 §4.7.1",
    explanation:
      "The backend compares the state that came back with the state it stored. If they differ, it stops before using the code.",
    why: "It proves this callback answers a request THIS browser session started.",
    ifMissing: "An attacker could inject their own code into a victim's session (login CSRF), linking the victim to the attacker's account or data.",
    browserVisible: "The comparison happens on the server; the browser only carried state.",
    sensitive: "No.",
    preconditions: ["A pending authorization exists in this session", "It is younger than 10 minutes"],
    outcomes: ["MATCH → continue to token exchange", "MISMATCH / MISSING / EXPIRED → stop; the code is never used"],
    next: "Exchange the code (and the verifier) for tokens.",
    source: [
      { file: SESSION, symbol: "checkState" },
      { file: SESSION, symbol: "takePendingAuthorization" },
      { file: AUTH_ROUTES, symbol: "GET /callback" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "token-exchange",
    n: 13,
    title: "Exchange authorization code for tokens",
    actor: "node",
    channel: "back",
    phase: "back",
    concept: "Back channel + PKCE: the code and the verifier go server to server.",
    spec: "RFC 6749 §4.1.3; RFC 7636 §4.5–4.6",
    explanation:
      "The backend is exchanging the authorization code for tokens through a secure server-to-server request.",
    why: "Tokens are issued directly to the server that proves it holds the verifier, never through the browser.",
    ifMissing: "Tokens would have to travel through the browser, where scripts, extensions and history can reach them.",
    browserVisible: "No. Neither the request nor the response passes through the browser.",
    sensitive: "Yes: the verifier goes out; access, refresh and ID tokens come back. All redacted here.",
    preconditions: [
      "Authorization code exists",
      "State has been validated",
      "PKCE verifier is available",
      "redirect_uri matches the authorization request",
    ],
    outcomes: [
      "200 → access, refresh and ID tokens",
      "400 invalid_grant → bad, expired or reused code, or PKCE mismatch",
      "400 invalid_request / invalid_client → malformed request or client authentication failed",
    ],
    next: "Store the tokens in the server session.",
    source: [
      { file: OAUTH, symbol: "authorizationCodeParams" },
      { file: OAUTH, symbol: "prepareTokenRequest" },
      { file: OAUTH, symbol: "postToTokenEndpoint" },
    ],
    env: ["CLIENT_ID", "CLIENT_SECRET", "REDIRECT_URI"],
    observable: true,
    optional: false,
  },
  {
    id: "store-tokens",
    n: 14,
    title: "Store tokens on backend",
    actor: "node",
    channel: "local",
    phase: "back",
    concept: "Backend-for-frontend: tokens live only in the server-side session.",
    spec: "OAuth 2.0 for Browser-Based Apps §6.1 (BFF)",
    explanation:
      "The backend keeps the access, refresh and ID tokens in its session. The browser still holds only a session cookie.",
    why: "A token in the browser can be stolen by any script on the page. A token on the server cannot.",
    ifMissing: "The app would have to put tokens in the browser, where XSS can steal them.",
    browserVisible: "No. React receives metadata only (expiry, scope, patient).",
    sensitive: "Yes: the tokens themselves. They never leave Node.",
    preconditions: ["Token response 200 with access_token"],
    outcomes: ["Tokens stored server-side", "Tokens discarded (broad-scope demo)"],
    next: "Decode the ID token to learn who logged in.",
    source: [
      { file: OAUTH, symbol: "createAuthorizedContext" },
      { file: OAUTH, symbol: "recordTokensStored" },
    ],
    env: ["SESSION_SECRET"],
    observable: true,
    optional: false,
  },
  {
    id: "decode-id-token",
    n: 15,
    title: "Decode ID token",
    actor: "node",
    channel: "local",
    phase: "back",
    concept: "OpenID Connect: the ID token says who the user is (fhirUser).",
    spec: "OpenID Connect Core §2, §3.1.3.7 (validation); SMART fhirUser",
    explanation:
      "The backend decodes the ID token to read who logged in. This teaching demo does NOT verify its signature.",
    why: "The ID token identifies the user. A production app must verify its signature, issuer, audience and expiry.",
    ifMissing: "The app would know what it may access, but not who the user is.",
    browserVisible: "The decoded claims are shown for teaching; the token itself is not.",
    sensitive: "The token is a credential; the claims identify the user.",
    preconditions: ["openid granted", "id_token present in the token response"],
    outcomes: ["Claims decoded (signature NOT verified)", "No ID token returned"],
    next: "Read the patient context.",
    source: [{ file: OAUTH, symbol: "decodeJwtPayload" }],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "patient-context",
    n: 16,
    title: "Extract patient context",
    actor: "node",
    channel: "local",
    phase: "back",
    concept: "SMART launch context: the authorization server says which patient was authorized.",
    spec: "SMART App Launch §Launch context (patient)",
    explanation:
      "The token response names the patient the user authorized. The backend stores that patient ID; the browser never chooses it.",
    why: "The app may only read the patient it was authorized for, so the patient must come from the token, not from a URL.",
    ifMissing: "The app would have to trust a patient ID from the browser, letting a user read any patient.",
    browserVisible: "The patient ID is shown as metadata; the browser cannot change it.",
    sensitive: "Identifies a (synthetic) patient.",
    preconditions: ["launch/patient granted", "Token response contains \"patient\""],
    outcomes: ["Patient ID stored", "No patient context → the app refuses to guess"],
    next: "Request the Patient resource.",
    source: [
      { file: OAUTH, symbol: "applyTokenResponse" },
      { file: FHIR, symbol: "authorizedPatientId" },
    ],
    env: ["SCOPES"],
    observable: true,
    optional: false,
  },
  {
    id: "request-patient",
    n: 17,
    title: "Request Patient resource",
    actor: "node",
    channel: "back",
    phase: "fhir",
    concept: "Bearer token: the access token authorizes the FHIR request.",
    spec: "RFC 6750 §2.1 (Authorization: Bearer)",
    explanation:
      "The backend is using the access token to request healthcare data from the FHIR server: the authorized patient's record.",
    why: "The FHIR server checks the token on every request. The browser asks our server, which adds the token.",
    ifMissing: "Without the token the FHIR server answers 401; without the BFF the browser would need the token.",
    browserVisible: "No. React asks /api/patient with its cookie; Node calls FHIR with the token.",
    sensitive: "Yes: the Authorization header carries the access token (redacted here).",
    preconditions: ["Access token stored", "Patient ID from the token context"],
    outcomes: ["200 Patient", "401 → refresh once, retry once", "403 / 404 → reported"],
    next: "Request the patient's laboratory Observations.",
    source: [
      { file: FHIR, symbol: "getAuthorizedPatient" },
      { file: FHIR, symbol: "fhirGet" },
      { file: "server/src/routes/api.ts", symbol: "GET /api/patient" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "request-observations",
    n: 18,
    title: "Request Observation resources",
    actor: "node",
    channel: "back",
    phase: "fhir",
    concept: "Scopes in action: patient/Observation.read allows exactly this query.",
    spec: "SMART scopes (patient/Observation.read); FHIR search",
    explanation:
      "The backend asks the FHIR server for this patient's laboratory Observations, again with the access token.",
    why: "Each resource type needs its own scope. Asking for more than needed breaks least privilege.",
    ifMissing: "No lab results; or, with a broader scope, more data than the app needs.",
    browserVisible: "No. Only the flattened results reach React.",
    sensitive: "Yes: Authorization header (redacted).",
    preconditions: ["Access token stored", "patient/Observation.read granted"],
    outcomes: ["200 Bundle of Observations", "401 → refresh once, retry once"],
    next: "React renders the patient and labs.",
    source: [
      { file: FHIR, symbol: "getLabs" },
      { file: "server/src/routes/api.ts", symbol: "GET /api/labs" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "render",
    n: 19,
    title: "Render patient and lab data",
    actor: "react",
    channel: "local",
    phase: "fhir",
    concept: "The browser receives data, never credentials.",
    spec: "OAuth 2.0 for Browser-Based Apps §6.1 (BFF)",
    explanation: "React displays the patient and lab results it received from our own server. No token was involved in the browser.",
    why: "The browser only ever needed the data, so that is all it gets.",
    ifMissing: "Nothing to show the user.",
    browserVisible: "Yes: the data (synthetic).",
    sensitive: "Synthetic clinical data only.",
    preconditions: ["Patient and labs loaded"],
    outcomes: ["Data on screen"],
    next: "Keep using the token until it expires; then refresh.",
    source: [
      { file: "client/src/App.tsx", symbol: "loadPatientData" },
      { file: "server/src/routes/api.ts", symbol: "POST /api/flow/rendered" },
    ],
    env: [],
    observable: true,
    optional: false,
  },
  {
    id: "refresh",
    n: 20,
    title: "Refresh expired access token",
    actor: "node",
    channel: "back",
    phase: "lifecycle",
    concept: "Token lifecycle: 401 → one refresh → one retry, without asking the user again.",
    spec: "RFC 6749 §6 (refreshing an access token)",
    explanation:
      "The access token expired, so the backend is using the refresh token to obtain a new access token.",
    why: "Access tokens are short-lived to limit the damage if one leaks. The refresh token renews access without a new login.",
    ifMissing: "Every expiry would force the user to log in again.",
    browserVisible: "No. Server to server.",
    sensitive: "Yes: the refresh token (long-lived) goes out; a new access token comes back.",
    preconditions: ["A FHIR request returned 401", "A refresh token is stored (offline_access)"],
    outcomes: [
      "200 → new access token, retry the request once",
      "400 invalid_grant → tokens discarded, user must reconnect",
      "No refresh token → user must reconnect",
    ],
    next: "Retry the original FHIR request exactly once.",
    source: [
      { file: OAUTH, symbol: "refreshAccessToken" },
      { file: FHIR, symbol: "fhirGet" },
    ],
    env: ["CLIENT_ID", "CLIENT_SECRET"],
    observable: true,
    optional: true,
  },
  {
    id: "logout",
    n: 21,
    title: "Logout and clear session",
    actor: "react",
    channel: "local",
    phase: "lifecycle",
    concept: "Ending the session: the server discards every token it held.",
    spec: "RFC 7009 (revocation, not called by this demo)",
    explanation: "The backend destroys the server-side session and every token in it, and clears the session cookie.",
    why: "Tokens should not outlive the user's intent to use the app. (This demo discards them; it does not revoke them.)",
    ifMissing: "Tokens would stay usable in the session until they expire.",
    browserVisible: "The cookie is cleared.",
    sensitive: "No.",
    preconditions: ["A session exists"],
    outcomes: ["Session destroyed, cookie cleared"],
    next: "Connect again to start a new flow.",
    source: [{ file: AUTH_ROUTES, symbol: "POST /auth/logout" }],
    env: [],
    observable: true,
    optional: true,
  },
];

/** Steps 1–19 make up one complete run; refresh and logout happen only when needed. */
export const CORE_STEP_COUNT = TIMELINE.filter((step) => !step.optional).length;

const BY_ID = new Map(TIMELINE.map((step) => [step.id, step]));

export function timelineStep(id: TimelineStepId): TimelineStep {
  const step = BY_ID.get(id);
  if (!step) throw new Error(`Unknown timeline step: ${id}`);
  return step;
}

// ---------------------------------------------------------------------------
// The debugger: execution modes, breakpoint injections, request-builder changes
// ---------------------------------------------------------------------------

/**
 * run:      no pauses (the normal app).
 * step:     pause before EVERY stage, internal ones included.
 * messages: pause only before each real network message (discovery, redirect, token, FHIR, refresh).
 */
export type LabMode = "run" | "step" | "messages";

export const LAB_MODES: Record<LabMode, { label: string; description: string }> = {
  run: { label: "Run automatically", description: "The flow runs without stopping, like the real app." },
  step: {
    label: "Step through every stage",
    description: "The backend pauses before every stage, internal ones included. Next step runs exactly one.",
  },
  messages: {
    label: "Pause at every message",
    description: "The backend pauses before each real network message, so you can inspect it before it is sent.",
  },
};

/** A controlled change the presenter can make at a breakpoint. Each one produces a real failure path. */
export type InjectionId =
  | "tamper-returned-state"
  | "remove-code-verifier"
  | "alter-code-verifier"
  | "alter-redirect-uri"
  | "invalidate-access-token"
  | "corrupt-refresh-token"
  | "skip-refresh";

export const INJECTIONS: Record<InjectionId, { label: string; effect: string; concept: string }> = {
  "tamper-returned-state": {
    label: "Tamper with the returned state",
    effect: "Replace the state that came back in the callback with a different random value, before it is compared.",
    concept: "CSRF protection: the callback must answer a request this session started.",
  },
  "remove-code-verifier": {
    label: "Remove code_verifier",
    effect: "Send the token request without the PKCE code_verifier.",
    concept: "PKCE proof of possession.",
  },
  "alter-code-verifier": {
    label: "Alter code_verifier",
    effect: "Change one character of the real code_verifier before sending it. Its hash no longer matches the challenge.",
    concept: "PKCE: BASE64URL(SHA256(code_verifier)) must equal code_challenge.",
  },
  "alter-redirect-uri": {
    label: "Change redirect_uri",
    effect: "Send a redirect_uri with a trailing slash, different from the one in the authorization request.",
    concept: "Redirect URI binding: the token request must repeat the exact redirect_uri.",
  },
  "invalidate-access-token": {
    label: "Send an invalid access token",
    effect: "Replace the stored access token with random characters before this FHIR request, forcing a real 401.",
    concept: "Bearer tokens are validated on every request.",
  },
  "corrupt-refresh-token": {
    label: "Corrupt the refresh token",
    effect: "Send random characters instead of the real refresh token.",
    concept: "A rejected refresh token means the user must authorize again.",
  },
  "skip-refresh": {
    label: "Disable refresh",
    effect: "Act as if no refresh token had been issued, so the backend cannot renew access.",
    concept: "Without offline_access (a refresh token), an expired session needs a new login.",
  },
};

/** Authorization Request Builder: controlled, whitelisted changes to the authorization URL. */
export type BuilderModId =
  | "remove-state"
  | "change-redirect-uri"
  | "remove-code-challenge"
  | "plain-challenge-method"
  | "broad-scope"
  | "change-aud"
  | "invalid-scope";

export const BUILDER_MODS: Record<BuilderModId, { label: string; field: string; effect: string; expect: string }> = {
  "remove-state": {
    label: "Remove state",
    field: "state",
    effect: "The authorization URL is sent without state. The session still stores one.",
    expect: "The callback returns no state, so state validation fails and the code is never used.",
  },
  "change-redirect-uri": {
    label: "Change redirect_uri",
    field: "redirect_uri",
    effect: "A trailing slash is added to redirect_uri in the authorization URL only.",
    expect: "A strict server refuses the request; a lenient one accepts it, and the token endpoint then rejects the mismatch.",
  },
  "remove-code-challenge": {
    label: "Remove code_challenge",
    field: "code_challenge",
    effect: "The authorization URL is sent without code_challenge and code_challenge_method.",
    expect: "A server that requires PKCE refuses the request or the later token exchange.",
  },
  "plain-challenge-method": {
    label: "code_challenge_method=plain",
    field: "code_challenge_method",
    effect: "The S256 hash is sent, but labelled as method \"plain\".",
    expect: "The server compares the verifier itself with the challenge, which fails; or it rejects plain outright.",
  },
  "broad-scope": {
    label: "Request broader scopes",
    field: "scope",
    effect: "patient/Patient.read and patient/Observation.read are replaced with patient/*.read.",
    expect: "The server may grant more than the app needs. Least privilege is violated even if it succeeds.",
  },
  "change-aud": {
    label: "Change aud",
    field: "aud",
    effect: "aud names a different FHIR server (https://fhir.attacker.example/r4).",
    expect: "The server should refuse to issue a token for a resource server it does not protect.",
  },
  "invalid-scope": {
    label: "Add an invalid scope",
    field: "scope",
    effect: "A scope that does not exist (patient/NotAResource.read) is added to the request.",
    expect: "The server either refuses with invalid_scope or silently leaves it out of the grant.",
  },
};

export interface LabBreakpoint {
  id: number;
  stage: TimelineStepId;
  title: string;
  kind: "network" | "internal";
  /** The "before send" event recorded for this pause. */
  entryId: number;
  injections: InjectionId[];
  createdAt: string;
}

export interface LabState {
  mode: LabMode;
  breakpoint: LabBreakpoint | null;
  /** Other pauses waiting behind the current one. */
  queued: number;
}

// ---------------------------------------------------------------------------
// One wire-log event
// ---------------------------------------------------------------------------

export type Category =
  | "discovery"
  | "redirect"
  | "authorization"
  | "state"
  | "pkce"
  | "token"
  | "id-token"
  | "patient-context"
  | "fhir"
  | "refresh"
  | "logout"
  | "demo"
  | "lab"
  | "error";

/** A value shown by its first few characters and a fingerprint, never in full. */
export interface ValuePreview {
  preview: string;
  fingerprint: string;
  length: number;
}

/**
 * Safe, structured facts for the panels. Built on the server from values Node
 * already holds (see safeView.ts), and redacted again by record() like everything
 * else. Field names deliberately avoid the keys redact() rewrites ("code", "*_token").
 */
export type EventDetail =
  | {
      kind: "discovery";
      source: "fetched" | "cached";
      fetchedAt: string;
      authorizationEndpoint: string | null;
      tokenEndpoint: string | null;
      codeChallengeMethods: string[] | null;
    }
  | { kind: "state-generated"; state: ValuePreview; bits: number }
  | { kind: "pkce-verifier"; length: number; bits: number; fingerprint: string }
  | { kind: "pkce-challenge"; method: "S256"; challenge: string; verifierFingerprint: string }
  | {
      kind: "session-stored";
      stateFingerprint: string;
      verifierFingerprint: string;
      ttlSeconds: number;
      cookie: string;
    }
  | { kind: "authorization-url"; endpoint: string; url: string; params: Record<string, string> }
  | {
      kind: "callback";
      hasAuthorizationCode: boolean;
      authorizationCodePreview: string | null;
      authorizationCodeLength: number | null;
      returnedState: ValuePreview | null;
      error: string | null;
      errorDescription: string | null;
    }
  | {
      kind: "state-check";
      verdict: "MATCH" | "MISMATCH" | "EXPIRED" | "MISSING";
      returned: ValuePreview | null;
      stored: ValuePreview | null;
      ageSeconds: number | null;
      ttlSeconds: number;
    }
  | { kind: "state-tampered"; original: ValuePreview; replacement: ValuePreview }
  | {
      kind: "pkce-proof";
      method: "S256";
      verifierSent: boolean;
      verifierFingerprint: string;
      /** Node's own check that SHA-256(verifier) equals the challenge it sent. */
      recomputedChallengeMatches: boolean;
    }
  | {
      kind: "tokens";
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      hasIdToken: boolean;
      tokenType: string | null;
      expiresIn: number | null;
      grantedScope: string | null;
      hasPatientContext: boolean;
      storage: string;
      browserExposure: string;
      /** true when the tokens were thrown away instead of stored (broad-scope demo). */
      discarded: boolean;
    }
  | { kind: "id-token"; present: boolean; claims: Record<string, unknown> | null; signatureVerified: false }
  | { kind: "patient-context"; patientId: string | null; source: string }
  | {
      kind: "patient-request";
      resource: "Patient" | "Observation";
      browserSupplied: string | null;
      used: string | null;
      ignored: boolean;
    }
  | { kind: "logout"; hadTokens: boolean; sessionDestroyed: boolean; cookieCleared: string; revoked: false };

export type DetailOf<K extends EventDetail["kind"]> = Extract<EventDetail, { kind: K }>;

/** Something deliberately changed: by a failure demo, a breakpoint injection or the request builder. */
export interface Modification {
  field: string;
  original: string;
  sent: string;
}

export interface WireEntry {
  id: number;
  timestamp: string;
  direction: Direction;
  channel: Channel;
  category: Category;
  step: string;
  method?: string;
  endpoint?: string;
  params?: Record<string, unknown>;
  /** Where params travelled: the URL query or the request body. */
  paramsIn?: "query" | "body";
  requestHeaders?: Record<string, string>;
  status?: number | string;
  responseHeaders?: Record<string, string>;
  /*
   * Wall-clock milliseconds the Node server waited for an outbound HTTP response.
   * Present if and only if this server made a request and waited for it, so a
   * "browser → Node client" hop or an internal check never carries one.
   */
  durationMs?: number;
  result?: unknown;
  notes?: string[];
  outcome: "ok" | "error" | "info";
  /** Which timeline steps this event advances. Declared by the server only. */
  timeline?: StepMark[];
  /** Plain-language sentence for "What is happening right now?". Overrides the step's default. */
  explanation?: string;
  /** "Why this request exists". Overrides the step's default. */
  why?: string;
  /** "Security implications" of this particular event. */
  security?: string;
  securityConcept?: string;
  /** Connect, EHR launch, a redirect demo or a builder experiment: a new authorization run starts here. */
  runStart?: boolean;
  /** Part of a failure demo; `modified` marks the one deliberately changed request. */
  demo?: { id: DemoId; modified?: Modification };
  /** A change made at a breakpoint or in the request builder. */
  injection?: { id: InjectionId | BuilderModId; label: string; modified?: Modification };
  /** The backend paused here, before this stage ran (or before this request was sent). */
  breakpoint?: { id: number; kind: "network" | "internal"; stage: TimelineStepId; injections: InjectionId[] };
  /** Code that produced this event, when it differs from the timeline step's own references. */
  source?: SourceRef[];
  detail?: EventDetail;
}
