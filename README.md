# SMART on FHIR OAuth 2.0: teaching demo

> **DEMO / SYNTHETIC DATA**
> This application uses a public sandbox containing synthetic healthcare data. Do not use real patient information.

> **Not production software.** This is a teaching implementation. Its shortcuts are listed in [Production differences](#h-production-differences).

**Further documentation:**
- [OAUTH-GUIDE.md](OAUTH-GUIDE.md): every OAuth 2.0 and SMART on FHIR concept in this app, how each one is implemented, and how the sandbox actually behaves.
- [RUN-AND-DEMO.md](RUN-AND-DEMO.md): installing, running and checking the app, plus a click-by-click presenter script for all six failure demos.

---

## A. What this is

A runnable, projector-friendly demonstration of the SMART App Launch flow: OAuth 2.0 Authorization Code with PKCE (S256), run against a public FHIR sandbox.

- The **Node/Express server is the OAuth client.** It discovers the SMART endpoints, builds the authorization request, validates `state`, exchanges the code, keeps the tokens and calls the FHIR server.
- The **React UI never receives a token.** It shows the flow from safe metadata and redacted events.
- The UI is an **OAuth Protocol Lab**: a debugger for the flow, not a dashboard. Every step the Node server takes is recorded as a structured, redacted event and streamed live to the page (Server-Sent Events). From that one stream the lab draws a **live protocol canvas** (a sequence diagram across five lifelines: Browser, React UI, Node BFF, Authorization server, FHIR server), a **message inspector** (request, response, why it exists, security, the real source file), a DevTools-style **traffic monitor**, a **21-step timeline**, a **protocol state machine** that shows exactly where a flow stopped, and panels for the **authorization request**, **PKCE**, **state/CSRF**, **what the browser can see**, **tokens** and **patient context**.
- A **protocol debugger** can hold the real flow before each stage (`Step through every stage` / `Pause at every message`): the server shows the exact request it is about to send and waits for **Next step**. At a breakpoint the presenter can inject one controlled change (tamper with the returned state, alter the PKCE verifier, corrupt the refresh token…) and watch the real server's real response.
- Light and dark themes, both projector-legible. The toggle is in the header.
- A **Failure lab** runs ten scenarios (nine real, one labelled illustration) and explains each from the real events: what changed, the request actually sent, the response, and where the flow stopped.

The OAuth implementation is deliberately hand-written and flat, so it can be explained line by line. There is no OAuth library.

## B. Security warning

This demo is **not production-ready**. Among other things, it:

- keeps sessions in memory
- runs over plain HTTP on localhost
- decodes the ID token **without verifying its signature**
- keeps one global event log (and one debugger) that any browser on the machine can read or drive (it is redacted, but it still shows `state` values, previews and synthetic patient IDs)
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
| `npm test` | Unit tests: PKCE, state, scope comparison, wire-log redaction |
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
| [server/src/redaction.ts](server/src/redaction.ts) | The one redaction helper, shared by server logs, the event stream and the React UI |
| [server/src/wireLog.ts](server/src/wireLog.ts) | `record()`: the one place events are created. Redacts, stores and publishes each event |
| [server/src/eventStream.ts](server/src/eventStream.ts) | `GET /api/events`: the live Server-Sent Events stream |
| [server/src/timeline.ts](server/src/timeline.ts) | Shared by server and UI: the event shape, the 21 steps (with their real source files), debugger modes and injections |
| [server/src/safeView.ts](server/src/safeView.ts) | Previews and fingerprints, so the UI can show two values match without showing either |
| [server/src/lab.ts](server/src/lab.ts) | The protocol debugger: breakpoints that hold the real request, and failure injection |
| [client/src/model.ts](client/src/model.ts) | The one reducer that turns events into the timeline, state machine and every panel |
| [server/src/routes/demo.ts](server/src/routes/demo.ts) | The six failure demonstrations |
| [client/src/flow.ts](client/src/flow.ts) | "What is happening right now?": the latest event, breakpoint or replay in one sentence |
| [client/src/styles.css](client/src/styles.css) | The design tokens and both themes |

## F. Ten-minute presenter script

The full, click-by-click script is in [RUN-AND-DEMO.md §9](RUN-AND-DEMO.md#9-the-presentation-script). In short:

1. **Reset all**, leave **Essentials** on, keep *Login in a popup window* ticked (the lab stays on screen while you log in).
2. Choose **Step through every stage** and press **▶ Run scenario**. The backend holds each stage: inspect the **BEFORE SEND** request, then press **→**. Discovery, state, PKCE verifier and challenge, session storage, the authorization URL (**Request builder** tab), the 302.
3. Log in and approve in the popup. The canvas shows *Login + consent — not visible to this app*.
4. State validation (**State / CSRF** tab: **MATCH**), then the token request's **BEFORE SEND** parameter table. **Run to the end**.
5. **Tokens** and **Browser view** tabs: token metadata only; this browser's real storage holds no token.
6. **App → Load patient and labs**, then **Patient context → GET /api/patient?patient=123** (ignored).
7. **Failure lab**: *Invalid state* (stops at step 12, no token request). Then **PKCE → Step through and alter the verifier** (real rejection). Then **Tokens → Force token expiry** and **Simulate refresh failure**.

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
