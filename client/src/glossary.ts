/*
 * "Explain this value": every OAuth value the lab shows can be clicked to open
 * this explanation. Each entry names the real code that creates or checks the
 * value (verified by client/tests/glossary.test.ts).
 */
import type { SourceRef } from "../../server/src/timeline";

export interface GlossaryEntry {
  term: string;
  what: string;
  createdBy: string;
  consumedBy: string;
  travels: string;
  secret: "Public" | "Secret" | "Sensitive" | "Short-lived credential";
  lifetime: string;
  protects: string;
  ifModified: string;
  /** For authorization request parameters. */
  required?: "Required" | "Optional" | "Required by SMART" | "Required with PKCE";
  source: SourceRef[];
}

const OAUTH = "server/src/oauth.ts";
const AUTH = "server/src/routes/auth.ts";

export const GLOSSARY: Record<string, GlossaryEntry> = {
  response_type: {
    term: "response_type",
    what: "Which OAuth flow is being used. \"code\" asks for an authorization code (the Authorization Code grant).",
    createdBy: "Node OAuth client",
    consumedBy: "Authorization server",
    travels: "Front channel: in the authorization URL",
    secret: "Public",
    lifetime: "One authorization request",
    protects: "Choosing the code flow keeps tokens off the front channel (unlike the deprecated implicit flow).",
    ifModified: "\"token\" (implicit) would put an access token in the URL; most servers now refuse it.",
    required: "Required",
    source: [{ file: OAUTH, symbol: "startAuthorization" }],
  },
  client_id: {
    term: "client_id",
    what: "The public identifier of this application, registered with the authorization server.",
    createdBy: "The authorization server, at registration (configured as CLIENT_ID)",
    consumedBy: "Authorization server (at /authorize and /token)",
    travels: "Front channel (authorization URL) and back channel (token request)",
    secret: "Public",
    lifetime: "As long as the registration",
    protects: "Lets the server apply this app's registered redirect URIs, scopes and consent screen.",
    ifModified: "An unknown client_id is refused; another app's client_id fails redirect-URI and PKCE checks.",
    required: "Required",
    source: [
      { file: "server/src/config.ts", symbol: "config" },
      { file: OAUTH, symbol: "authorizationCodeParams" },
    ],
  },
  redirect_uri: {
    term: "redirect_uri",
    what: "Where the authorization server sends the browser back, with the code. Must be pre-registered.",
    createdBy: "Configuration (REDIRECT_URI)",
    consumedBy: "Authorization server: compared with the registered value, and again at the token endpoint",
    travels: "Front channel (authorization URL) and back channel (token request)",
    secret: "Public",
    lifetime: "As long as the registration",
    protects: "Stops an attacker from having the code delivered to a URL they control.",
    ifModified: "A strict server refuses the request; the token endpoint refuses a redirect_uri that differs from the authorization request.",
    required: "Required",
    source: [
      { file: OAUTH, symbol: "startAuthorization" },
      { file: OAUTH, symbol: "authorizationCodeParams" },
    ],
  },
  scope: {
    term: "scope",
    what: "The permissions requested: identity (openid fhirUser), patient context (launch/patient), resource access (patient/Patient.read …), and a refresh token (offline_access).",
    createdBy: "Configuration (SCOPES)",
    consumedBy: "Authorization server (consent) and FHIR server (enforcement)",
    travels: "Front channel (authorization URL); the granted scope comes back in the token response",
    secret: "Public",
    lifetime: "The grant",
    protects: "Least privilege: the app can only do what was requested AND granted.",
    ifModified: "Broader scopes grant more access than needed; an invalid scope is refused or silently dropped.",
    required: "Required by SMART",
    source: [
      { file: OAUTH, symbol: "startAuthorization" },
      { file: "server/src/scope.ts", symbol: "diffScopes" },
    ],
  },
  state: {
    term: "state",
    what: "A random, unguessable value that binds the callback to the browser session that started the flow.",
    createdBy: "Node OAuth client (32 random bytes)",
    consumedBy: "Node OAuth client, when the callback arrives",
    travels: "Front channel: out in the authorization URL, back in the callback URL",
    secret: "Public",
    lifetime: "One authorization request, at most 10 minutes, single-use",
    protects: "CSRF / login CSRF: a callback this session did not start is rejected before the code is used.",
    ifModified: "The comparison fails (STATE MISMATCH) and the token exchange is never attempted.",
    required: "Required",
    source: [
      { file: "server/src/session.ts", symbol: "generateState" },
      { file: "server/src/session.ts", symbol: "checkState" },
      { file: AUTH, symbol: "GET /callback" },
    ],
  },
  aud: {
    term: "aud",
    what: "The FHIR server the token is meant for (its base URL). SMART requires it so tokens cannot be replayed at another server.",
    createdBy: "Node OAuth client (the FHIR base URL, or the EHR's iss)",
    consumedBy: "Authorization server",
    travels: "Front channel: in the authorization URL",
    secret: "Public",
    lifetime: "One authorization request",
    protects: "Token misuse: a token issued for one FHIR server should not be accepted by another.",
    ifModified: "The server should refuse to issue a token for a resource server it does not protect.",
    required: "Required by SMART",
    source: [{ file: OAUTH, symbol: "startAuthorization" }],
  },
  code_challenge: {
    term: "code_challenge",
    what: "BASE64URL(SHA-256(code_verifier)): a hash that commits this flow to a secret only the Node server knows.",
    createdBy: "Node OAuth client",
    consumedBy: "Authorization server: stored with the code, compared at the token endpoint",
    travels: "Front channel: in the authorization URL (safe, because it is a one-way hash)",
    secret: "Public",
    lifetime: "One authorization request",
    protects: "Authorization-code interception: a stolen code cannot be redeemed without the matching verifier.",
    ifModified: "The later code_verifier no longer hashes to it, so the token exchange fails (invalid_grant).",
    required: "Required with PKCE",
    source: [{ file: "server/src/pkce.ts", symbol: "createCodeChallenge" }],
  },
  code_challenge_method: {
    term: "code_challenge_method",
    what: "How the challenge was derived. S256 = SHA-256. \"plain\" (challenge = verifier) is discouraged.",
    createdBy: "Node OAuth client",
    consumedBy: "Authorization server",
    travels: "Front channel: in the authorization URL",
    secret: "Public",
    lifetime: "One authorization request",
    protects: "S256 means seeing the challenge in a URL reveals nothing about the verifier.",
    ifModified: "\"plain\" makes the server compare the verifier itself with the challenge; with an S256 hash that fails.",
    required: "Required with PKCE",
    source: [{ file: OAUTH, symbol: "startAuthorization" }],
  },
  launch: {
    term: "launch",
    what: "An opaque EHR launch context, passed back to the authorization server so it can link this authorization to the EHR session.",
    createdBy: "The EHR",
    consumedBy: "Authorization server",
    travels: "Front channel: from the EHR to /launch, then in the authorization URL",
    secret: "Sensitive",
    lifetime: "One EHR launch",
    protects: "Binds the app to the patient and user already open in the EHR.",
    ifModified: "The server cannot resolve the context and refuses the launch.",
    required: "Optional",
    source: [{ file: AUTH, symbol: "GET /launch" }],
  },
  code: {
    term: "code",
    what: "The authorization code: a one-time credential the Node server exchanges for tokens.",
    createdBy: "Authorization server, after login and consent",
    consumedBy: "Node OAuth client → token endpoint",
    travels: "Front channel (callback URL), then back channel (token request)",
    secret: "Short-lived credential",
    lifetime: "Minutes (this sandbox: 5), single-use",
    protects: "Keeps tokens off the front channel: only the code passes through the browser.",
    ifModified: "The token endpoint refuses it (invalid_grant). Reused, it must be refused too.",
    source: [
      { file: AUTH, symbol: "GET /callback" },
      { file: OAUTH, symbol: "authorizationCodeParams" },
    ],
  },
  code_verifier: {
    term: "code_verifier",
    what: "The PKCE secret: 64 random characters. Its SHA-256 hash was sent as code_challenge.",
    createdBy: "Node OAuth client",
    consumedBy: "Authorization server, at the token endpoint",
    travels: "Back channel ONLY: in the token request. Never through the browser.",
    secret: "Secret",
    lifetime: "One authorization request, single-use",
    protects: "Proves the client redeeming the code is the one that started the flow.",
    ifModified: "SHA-256(verifier) ≠ code_challenge, so the token exchange fails (invalid_grant).",
    source: [
      { file: "server/src/pkce.ts", symbol: "generateCodeVerifier" },
      { file: OAUTH, symbol: "authorizationCodeParams" },
    ],
  },
  grant_type: {
    term: "grant_type",
    what: "Which grant the token request uses: authorization_code (first exchange) or refresh_token (renewal).",
    createdBy: "Node OAuth client",
    consumedBy: "Token endpoint",
    travels: "Back channel",
    secret: "Public",
    lifetime: "One request",
    protects: "Tells the server which proof to expect (code + verifier, or refresh token).",
    ifModified: "The server validates a different set of parameters and refuses the request.",
    source: [
      { file: OAUTH, symbol: "authorizationCodeParams" },
      { file: OAUTH, symbol: "refreshAccessToken" },
    ],
  },
  access_token: {
    term: "access_token",
    what: "The credential that authorizes FHIR requests (Authorization: Bearer …).",
    createdBy: "Authorization server",
    consumedBy: "FHIR server, on every request",
    travels: "Back channel only: token response → Node session → FHIR requests",
    secret: "Secret",
    lifetime: "expires_in (this sandbox: 60 minutes)",
    protects: "Short lifetime limits the damage if it leaks; keeping it on the server means scripts cannot steal it.",
    ifModified: "The FHIR server answers 401; the backend refreshes once and retries once.",
    source: [
      { file: OAUTH, symbol: "createAuthorizedContext" },
      { file: "server/src/fhir.ts", symbol: "fhirGet" },
    ],
  },
  refresh_token: {
    term: "refresh_token",
    what: "A long-lived credential used to get a new access token without asking the user again.",
    createdBy: "Authorization server (when offline_access is granted)",
    consumedBy: "Token endpoint (grant_type=refresh_token)",
    travels: "Back channel only",
    secret: "Secret",
    lifetime: "Long (hours to months), server-defined; may rotate",
    protects: "Lets access tokens stay short-lived without constant logins.",
    ifModified: "The token endpoint refuses it (invalid_grant) and the user must authorize again.",
    source: [{ file: OAUTH, symbol: "refreshAccessToken" }],
  },
  id_token: {
    term: "id_token",
    what: "An OpenID Connect JWT saying who the user is (sub, fhirUser), for this client (aud), from this issuer (iss).",
    createdBy: "Authorization server (when openid is granted)",
    consumedBy: "Node OAuth client (identity only; never sent to the FHIR server)",
    travels: "Back channel only",
    secret: "Sensitive",
    lifetime: "Its exp claim",
    protects: "Identity, not access. Must be signature-verified before trusting it (this demo does NOT).",
    ifModified: "A tampered token fails signature verification in a real app.",
    source: [{ file: OAUTH, symbol: "decodeJwtPayload" }],
  },
  patient: {
    term: "patient",
    what: "SMART launch context: the ID of the patient the user authorized, returned in the token response.",
    createdBy: "Authorization server",
    consumedBy: "Node OAuth client, for every FHIR request",
    travels: "Back channel: in the token response",
    secret: "Sensitive",
    lifetime: "The grant",
    protects: "Horizontal privilege escalation: the browser cannot choose another patient.",
    ifModified: "The browser cannot modify it: /api/patient?patient=… is ignored.",
    source: [
      { file: OAUTH, symbol: "applyTokenResponse" },
      { file: "server/src/fhir.ts", symbol: "authorizedPatientId" },
    ],
  },
  fhirUser: {
    term: "fhirUser",
    what: "A claim in the ID token naming the FHIR resource of the logged-in user (e.g. Patient/123 or Practitioner/456).",
    createdBy: "Authorization server",
    consumedBy: "Node OAuth client",
    travels: "Back channel: inside the ID token",
    secret: "Sensitive",
    lifetime: "The ID token",
    protects: "Tells the app who is using it, separately from which patient it may read.",
    ifModified: "Only a verified ID token's claims can be trusted.",
    source: [{ file: OAUTH, symbol: "decodeJwtPayload" }],
  },
  smart_demo_sid: {
    term: "smart_demo_sid (session cookie)",
    what: "The only thing the browser holds: a signed session ID. The tokens live in the server session it points to.",
    createdBy: "Node OAuth client (express-session)",
    consumedBy: "Node OAuth client, on every browser request",
    travels: "Browser ↔ Node only, never to the authorization or FHIR server",
    secret: "Sensitive",
    lifetime: "8 hours, or until logout",
    protects: "httpOnly: page scripts cannot read it. SameSite=Lax: other sites cannot send it on background requests.",
    ifModified: "A forged or altered cookie fails the signature check: no session, no data.",
    source: [
      { file: "server/src/session.ts", symbol: "createSessionMiddleware" },
      { file: "server/src/session.ts", symbol: "SESSION_COOKIE_OPTIONS" },
    ],
  },
  Authorization: {
    term: "Authorization (header)",
    what: "\"Bearer <access_token>\" on FHIR requests, or \"Basic …\" client credentials on token requests (confidential clients only).",
    createdBy: "Node OAuth client",
    consumedBy: "FHIR server / token endpoint",
    travels: "Back channel only",
    secret: "Secret",
    lifetime: "Per request",
    protects: "Anyone holding a bearer token can use it, so it only ever travels server to server here.",
    ifModified: "401 Unauthorized.",
    source: [
      { file: "server/src/fhir.ts", symbol: "fhirGet" },
      { file: OAUTH, symbol: "prepareTokenRequest" },
    ],
  },
};

const ALIASES: Record<string, string> = {
  "code_verifier (sent)": "code_verifier",
  Cookie: "smart_demo_sid",
  cookie: "smart_demo_sid",
  authorization: "Authorization",
};

export function glossaryFor(term: string): GlossaryEntry | null {
  return GLOSSARY[term] ?? GLOSSARY[ALIASES[term] ?? ""] ?? null;
}
