# SMART on FHIR OAuth 2.0: teaching demo

> **DEMO / SYNTHETIC DATA**
> This application uses a public sandbox containing synthetic healthcare data. Do not use real patient information.

> **Not production software.** This is a teaching implementation. Its shortcuts are listed in [Production differences](#h-production-differences).

---

## A. What this is

A runnable, projector-friendly demonstration of the SMART App Launch flow: OAuth 2.0 Authorization Code with PKCE (S256), run against a public FHIR sandbox.

- The **Node/Express server is the OAuth client.** It discovers the SMART endpoints, builds the authorization request, validates `state`, exchanges the code, keeps the tokens and calls the FHIR server.
- The **React UI never receives a token.** It shows the flow from safe metadata and a redacted wire log.
- The screen has three panes: an **OAuth flow stepper** driven by real server events, an **application view** (discovery, patient, requested vs granted scope, labs, decoded ID token) and a **wire log** drawn as a live sequence diagram across four columns: Browser, Node client, Authorization server, FHIR server.
- A **BREAK SOMETHING** panel runs six real failures on the server and shows the provider's actual response.

The OAuth implementation is deliberately hand-written and flat, so it can be explained line by line. There is no OAuth library.

## B. Security warning

This demo is **not production-ready**. Among other things, it:

- keeps sessions in memory
- runs over plain HTTP on localhost
- decodes the ID token **without verifying its signature**
- keeps one global wire log that any browser on the machine can read (it is redacted, but it still shows `state` values and synthetic patient IDs)
- trusts any `https` `iss` for an EHR launch

Read [Production differences](#h-production-differences) before copying any of it.

## C. Synthetic data warning

The default profile uses `launch.smarthealthit.org`, a public sandbox with **synthetic** patients. Never connect this app to a system with real patient information, and never type real patient details into the sandbox.

## D. Setup

Requires Node.js 20.19 or newer and internet access.

```bash
npm install
cp .env.example .env
npm run dev
```

Open **http://localhost:5173**. Use `localhost`, not `127.0.0.1`: the session cookie is scoped to the host name, and the redirect URI uses `localhost`.

| Command | What it does |
|---|---|
| `npm run dev` | Starts the Node OAuth client on :3001 and the Vite UI on :5173 |
| `npm run dev:server` / `npm run dev:client` | Starts one of them |
| `npm test` | Unit tests: PKCE, state, scope comparison |
| `npm run build` | Type-checks both projects and builds `dist/` |
| `npm start` | Runs the build on :3001 only (set `CLIENT_URL=http://localhost:3001` first) |

## E. Architecture

```text
Browser (React UI, http://localhost:5173)
   │  httpOnly session cookie only. No tokens, no patient ID.
   ▼
Node OAuth client (Express, http://localhost:3001)
   │  Authorization Code + PKCE (S256), state, server-side session
   ▼
Authorization server (discovered from .well-known/smart-configuration)
   │  access token, refresh token, ID token, patient context (back channel)
   ▼
FHIR server (called only by Node, with the access token)
```

In development the browser talks to Vite, which forwards `/auth`, `/api`, `/demo` and `/launch` to Node. The authorization server redirects the browser straight to `http://localhost:3001/callback`.

**Where to look in the code:**

| File | Concept |
|---|---|
| [server/src/discovery.ts](server/src/discovery.ts) | SMART discovery: endpoints are read, never hardcoded |
| [server/src/pkce.ts](server/src/pkce.ts) | `code_verifier` and the S256 `code_challenge` |
| [server/src/oauth.ts](server/src/oauth.ts) | The one authorization redirect, the token exchange, the refresh, ID token decoding |
| [server/src/routes/auth.ts](server/src/routes/auth.ts) | `/auth/login`, `/launch`, `/callback` (state checked first), `/auth/logout` |
| [server/src/session.ts](server/src/session.ts) | Session cookie settings, state validation, one-time consumption |
| [server/src/fhir.ts](server/src/fhir.ts) | The one FHIR wrapper: 401 → one refresh → one retry |
| [server/src/redaction.ts](server/src/redaction.ts) | The one redaction helper, shared by server logs, the wire log API and the React wire log |
| [server/src/routes/demo.ts](server/src/routes/demo.ts) | The six failure demonstrations |

## F. Ten-minute presenter script

**Before you start:** run `npm run dev`, open http://localhost:5173 full screen, and click **Clear log**.

1. **0:00 · Explain the architecture.** Point at the yellow synthetic-data banner and the three panes. In the wire log, the four columns are the four actors. Dashed arrows are browser redirects (front channel). Solid arrows are direct HTTP calls, including Node talking to the authorization and FHIR servers (back channel).
2. **1:00 · Show discovery.** In *SMART discovery*, the client learned `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported: S256` and `capabilities` from `.well-known/smart-configuration`. Nothing is hardcoded. Note that `scopes_supported` does not list `patient/Patient.read`; the list does not have to be complete.
3. **2:00 · Click Connect.** The wire log shows *Connect* and then *Authorization request* (a dashed arrow to the authorization server). Stepper steps 1 and 2 turn done.
4. **3:00 · Explain the authorization request.** Expand the entry and walk through `state` (CSRF protection), `code_challenge` (PKCE: only the hash is sent), `aud`, `scope` and `redirect_uri`. Everything in it is visible to the browser, so none of it is secret. On the sandbox's login page, choose a patient with labs (for example *Abdul Koepp*), type any password, then click **Approve** on the consent page.
5. **4:00 · Explain the callback and the code.** The code arrives through the browser, so the log shows only its first 8 characters. The next entry is *State validation: STATE MATCHES*, which runs **before** any token request.
6. **5:00 · Explain the back-channel token exchange.** *Token exchange* is a solid arrow from Node to the authorization server. `code_verifier` and every token are shown only as `[REDACTED — n chars]`. *Token received* says the tokens live in the server-side session; the browser holds only a cookie.
7. **6:00 · Show the granted scopes and the ID token.** In *Requested vs granted scope*, requested is not necessarily granted; here they match. In the ID token view, `fhirUser` is shown, the payload is **decoded**, and the signature is **not verified**.
8. **7:00 · Fetch the patient and labs.** Click **Load patient and labs**. Node calls the FHIR server with the bearer token (redacted in the log). The patient ID comes from the token response, not from the browser. Steps 8 and 9 turn done.
9. **8:00 · Demonstrate a state failure.** Click **Tamper with state** and log in again. The result is *STATE MISMATCH, token exchange skipped*, with no call to the token endpoint in the log.
10. **9:00 · Demonstrate code replay.** Click **Replay authorization code**. Be candid: this sandbox **accepts** the replay (HTTP 200), because its codes are stateless. The panel explains what RFC 6749 requires, and that this client's own state and verifier were already consumed.
11. **10:00 · Demonstrate token refresh.** Click **Force token expiry**. Follow *FHIR → 401*, then *Token refresh → 200*, then *FHIR retry → 200*.

**If there is time:** *Mismatched redirect URI*, *Remove PKCE verifier*, *Request patient/\*.read* (compares narrow and broad grants), and *Log out*.

## G. OAuth concept mapping

| Demo feature | OAuth / SMART concept |
|---|---|
| Discovery | SMART configuration |
| state | CSRF protection |
| PKCE | Authorization-code protection |
| Authorization code | Short-lived credential |
| Token exchange | Back-channel communication |
| Scope comparison | Least privilege / consent |
| ID token | OpenID Connect |
| Patient context | SMART launch context |
| 401 → refresh | Token lifecycle |
| Code replay | Single-use authorization codes |

## H. Production differences

A production SMART app would differ in at least these ways:

- **Session storage:** persistent, distributed session storage instead of the in-memory store, so sessions survive restarts and work across instances.
- **HTTPS and cookies:** HTTPS everywhere, with `secure` cookies.
- **Session management:** regenerate the session ID after login, and use idle and absolute timeouts.
- **JWT verification:** verify the ID token's signature against the issuer's JWKS, plus `iss`, `aud`, `exp` and `nonce`. This demo only decodes it.
- **Secrets:** real secret management for `CLIENT_SECRET` and `SESSION_SECRET`, or asymmetric client authentication (`private_key_jwt`).
- **Logging:** structured logging and audit logging of access to patient data, with no teaching wire log exposed to browsers.
- **Monitoring and alerting.**
- **CSRF protection** suited to the deployment for state-changing API routes. SameSite=Lax is only a baseline.
- **Error handling:** do not show provider error details to end users.
- **Tokens:** a token rotation and revocation strategy, including revocation at logout.
- **Multiple instances:** design for more than one server instance.
- **FHIR data:** follow pagination `next` links (this demo shows the first page only), validate FHIR resources, and handle every value type.
- **SMART launch validation:** an allowlist of trusted `iss` values, and checks on the launch context.
- **Access control:** real authorization inside the app. This sandbox's FHIR proxy allows anonymous reads and does not enforce scopes (see findings), so never rely on a server behaving like this sandbox.

---

## Sandbox compatibility findings

Checked against `launch.smarthealthit.org` on 2026-09-14, using live requests and the launcher's open-source code ([smart-on-fhir/smart-launcher-v2](https://github.com/smart-on-fhir/smart-launcher-v2)). Every result below was also reproduced through this app.

| What happened | What this app does |
|---|---|
| **A standalone authorization request against `https://launch.smarthealthit.org/v/r4/fhir` is rejected:** `error=invalid_request`, `Invalid launch options: SyntaxError: Unexpected end of JSON input`. The launcher reads standalone-launch settings from a base64url `sim` segment in the URL. | `.env.example` uses a `sim` URL ([decoded below](#the-sim-url)). Discovery still runs against it, so nothing is hardcoded. The plain URL still works as the `iss` of an EHR launch. |
| The configured scope string is accepted and granted **exactly as requested**. `scopes_supported` lists `patient/*.*` but not `patient/Patient.read`. | No scope is substituted. The discovery panel lists the unlisted scopes for information only. |
| **Replaying an authorization code succeeds (HTTP 200, new tokens).** Codes are stateless 5-minute JWTs, and nothing records that one was used. | *Replay authorization code* shows the real 200, discards the tokens and explains RFC 6749 §4.1.2. Replaying the `/callback` URL against this app is rejected (`NO PENDING AUTHORIZATION`, no token request). |
| The token endpoint rejects a request without `code_verifier`: `400 invalid_request "Missing code_verifier parameter"`. | *Remove PKCE verifier* shows it as is. |
| **The redirect URI is prefix-matched at `/authorize`** (`/callback/` is accepted, a different URI is rejected), but **compared exactly at `/token`**: `401 invalid_request "Invalid redirect_uri parameter"`. | *Mismatched redirect URI* changes only the authorization request, so the real rejection comes from the token endpoint. The panel explains that stricter servers reject at `/authorize`. |
| `patient/*.read` is granted exactly as requested, and the consent screen offers no choice per scope. | *Request patient/\*.read* shows the real grant next to the narrow one and explains the limitation. |
| **The FHIR proxy answers requests without any token (200)** and does not enforce scopes. It rejects only an *invalid* token (`401 Invalid token`). | The app enforces the patient restriction itself, using the token's patient context. *Force token expiry* makes the stored token invalid to get a genuine 401, because marking it expired only on our side would never produce one (sandbox tokens last 60 minutes). |
| Authorization codes are JWTs, so their first 8 characters are always `eyJhbGci`. | Truncated codes all look the same. That prefix is just the JWT header. |
| Refresh requests with the stored refresh token succeed. An invalid refresh token returns `401 invalid_grant`. | The FHIR wrapper refreshes once, retries once, and otherwise clears the tokens and asks the user to reconnect. |

### The sim URL

The `sim` segment in `.env.example` decodes to:

```json
[3, "", "", "NONE", 0, 0, 0, "", "http://localhost:3001/callback", "oauth-demo-app", "", "", "", "", 0, 2, ""]
```

In the launcher's own format these fields are: launch type (`3` = patient standalone), patient, provider, encounter, skip login, skip consent, simulate EHR, allowed scopes, registered `redirect_uris`, `client_id`, client secret, simulated error, `jwks_url`, `jwks`, client type (`0` = public), PKCE (`2` = always required) and FHIR server.

If you change `PORT` or `REDIRECT_URI`, generate a new segment:

```bash
node -e 'console.log(Buffer.from(JSON.stringify([3,"","","NONE",0,0,0,"","http://localhost:3001/callback","oauth-demo-app","","","","",0,2,""])).toString("base64url"))'
```

### EHR launch

`GET /launch?iss=…&launch=…` runs discovery against `iss`, adds the `launch` scope, sends `aud=iss` and uses the same authorization code as Connect. It was verified against `iss=https://launch.smarthealthit.org/v/r4/fhir`, using a `launch` value in the launcher's own format. To try it from the launcher website, choose a provider EHR launch and set the app launch URL to `http://localhost:3001/launch`.

## Epic profile (environment variables only)

The same code runs against Epic's sandbox. **This profile has not been verified by us**, because that needs a registered Epic client. Epic's discovery document was checked on 2026-09-14: it advertises `code_challenge_methods_supported: ["S256"]`, `client_secret_basic`/`client_secret_post`, and `scopes_supported` of only `epic.scanning.dmsusername fhirUser launch openid profile`.

- **Where to register:** https://fhir.epic.com. Sign in, open *Build Apps* and create an app. For this demo's standalone patient flow, register a patient-facing app and select the Patient and laboratory Observation read APIs (R4). Check the exact API names in Epic's UI. A new non-production client ID can take some time to become usable in the sandbox.
- **Redirect URI:** exactly `http://localhost:3001/callback`.
- **Scopes:** keep `openid fhirUser launch/patient` and the FHIR read scopes. Epic decides the grant from the app registration, so the scope comparison panel matters here. `offline_access` and refresh tokens depend on the registration; without a refresh token, *Force token expiry* ends in re-authentication.
- **PKCE:** S256 is advertised, and this app always sends it. Whether your registration *requires* it was not verified.
- **Client secret:** not needed for a public client. For a confidential registration set `CLIENT_SECRET`; the Node server sends it with `client_secret_basic`, and it never reaches the browser.
- **Environment variables to change:**

  ```env
  FHIR_BASE_URL=https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4
  CLIENT_ID=your-epic-non-production-client-id
  CLIENT_SECRET=            # only for a confidential registration
  REDIRECT_URI=http://localhost:3001/callback
  SCOPES=openid fhirUser launch/patient patient/Patient.read patient/Observation.read offline_access
  ```

- **Test patients:** use the sandbox test patients and MyChart credentials listed in Epic's documentation.
- **Expect different demo results:** a strict server may reject *Mismatched redirect URI* at `/authorize` with an error page (use Back to return), and may answer *Replay authorization code* with `invalid_grant`. The demo panels show whatever Epic actually returns.

## Troubleshooting

- **"NO PENDING AUTHORIZATION" right after logging in:** the UI was opened on `127.0.0.1` instead of `localhost`, or the Node server restarted during the login (sessions are in memory). Open http://localhost:5173 and connect again.
- **"Node server unreachable":** `npm run dev` is not running, or port 3001 or 5173 is taken.
- **Changed the port:** update `REDIRECT_URI` and regenerate the `sim` segment (see [The sim URL](#the-sim-url)).
