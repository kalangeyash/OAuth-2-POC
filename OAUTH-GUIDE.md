# OAuth 2.0 and SMART on FHIR: the complete guide to this application

> **DEMO / SYNTHETIC DATA.** Everything described here runs against a public sandbox containing synthetic patients. Never point this app at real patient data.

This is the reference document for the demo in this repository. It explains the OAuth 2.0 and SMART on FHIR concepts, then shows exactly where and how each one is implemented in the code, with the real parameters, the real responses, and the real behaviour we observed.

For running and presenting it, see [RUN-AND-DEMO.md](RUN-AND-DEMO.md). For a short overview, see [README.md](README.md).

**Contents**

1. [The problem OAuth solves](#1-the-problem-oauth-solves)
2. [The flow, step by step](#2-the-flow-step-by-step)
3. [The security mechanisms](#3-the-security-mechanisms)
4. [Tokens](#4-tokens)
5. [What SMART adds to OAuth](#5-what-smart-adds-to-oauth)
6. [How this codebase implements it](#6-how-this-codebase-implements-it)
7. [Threat model: attack, defence, demo](#7-threat-model-attack-defence-demo)
8. [The six failure demos in detail](#8-the-six-failure-demos-in-detail)
9. [What the sandbox actually does](#9-what-the-sandbox-actually-does)
10. [The gap between this and production](#10-the-gap-between-this-and-production)
11. [Glossary](#11-glossary)
12. [Questions an audience will ask](#12-questions-an-audience-will-ask)
13. [Specifications and further reading](#13-specifications-and-further-reading)

---

## 1. The problem OAuth solves

### 1.1 Delegated access

A patient wants to use a third-party app to look at their lab results. The app needs to read data from the hospital's system. There are three bad ways to do that and one good one.

| Approach | Why it fails |
|---|---|
| The patient gives the app their hospital password | The app can now do anything the patient can do, forever, and the hospital cannot tell the app's traffic from the patient's. Revoking means changing the password. |
| The hospital gives the app a shared API key | The key is not tied to a patient, cannot be scoped to one record, and leaks catastrophically. |
| The app screen-scrapes the portal | Brittle, still needs the password, and indistinguishable from an attack. |
| **OAuth 2.0** | The patient authenticates **at the hospital**, not at the app. The hospital issues the app a **narrow, expiring, revocable token**. The app never sees the password. |

OAuth is an **authorization delegation** protocol. Its one job: let a resource owner grant an application limited access to a resource server without sharing credentials.

OAuth is *not* an authentication protocol. "Log in with X" is **OpenID Connect (OIDC)**, a thin identity layer on top of OAuth that adds the **ID token**. This app uses both: OAuth for access to FHIR data, OIDC (`openid`, `fhirUser` scopes) to learn who the user is.

### 1.2 The four roles

| Role | Who it is here | Notes |
|---|---|---|
| **Resource owner** | The patient (or clinician) logging in | The person who can grant access |
| **Client** | **The Node/Express server** ([server/src/](server/src/)) | The application requesting access. In this demo the **React UI is not the client** — it is just a view |
| **Authorization server (AS)** | The sandbox's `/auth/authorize` and `/auth/token` | Authenticates the user, gets consent, issues tokens |
| **Resource server (RS)** | The sandbox's FHIR endpoint | Serves `Patient` and `Observation` resources, validating the access token |

The authorization server and resource server are often operated by the same organisation (here, both are the SMART launcher) but they are distinct roles with distinct endpoints.

**This is the single most important architectural fact in the demo:** the OAuth client is the *server*, not the browser. The browser holds one `httpOnly` session cookie and nothing else. This is the pattern called **BFF (backend for frontend)**, which the IETF's *OAuth 2.0 for Browser-Based Applications* guidance describes as the most secure architecture for browser apps.

### 1.3 Front channel and back channel

Every OAuth message travels on one of two channels. Understanding the difference explains nearly every design decision in the protocol.

| | **Front channel** | **Back channel** |
|---|---|---|
| Path | Through the user's browser, as URL parameters on redirects | Direct server-to-server HTTP |
| Who can see it | The user, browser history, extensions, referrer headers, proxy logs, anything reading the address bar | Only the two servers (TLS) |
| Can it carry secrets? | **No** | Yes |
| Used for | The authorization request, the redirect back with the code | The token request and response, refresh, FHIR calls |
| In this app | `state`, `code_challenge`, `client_id`, `redirect_uri`, `scope`, `aud`, and the `code` | `code_verifier`, `client_secret`, `access_token`, `refresh_token`, `id_token` |

The wire log in the UI draws front-channel hops as **dashed** arrows and back-channel calls as **solid** arrows, exactly so this distinction is visible.

The authorization **code** is the hinge: it is a short-lived, single-use, low-value credential that is safe*ish* to send through the front channel, and it is only worth anything when combined with something from the back channel (the `code_verifier`, and for confidential clients the `client_secret`).

### 1.4 Why the Authorization Code grant

OAuth 2.0 defined several grant types. Only one is appropriate here.

| Grant | Status | Why |
|---|---|---|
| **Authorization Code + PKCE** | **What this app uses** | Tokens are delivered on the back channel. The code alone is useless without the verifier. |
| Implicit (`response_type=token`) | Removed in OAuth 2.1 | Returned the access token in the URL fragment — front channel, in browser history, in logs |
| Resource Owner Password Credentials | Removed in OAuth 2.1 | The app handles the user's password, which is what OAuth exists to avoid |
| Client Credentials | Valid, different purpose | No user; machine-to-machine. SMART's `system/` scopes and backend services use this |

SMART App Launch requires the authorization code grant, and current SMART versions require PKCE.

### 1.5 Public and confidential clients

| | Public client | Confidential client |
|---|---|---|
| Can it keep a secret? | No (SPA, mobile app, anything shipped to a device) | Yes (a server the developer controls) |
| Authenticates at the token endpoint | No — sends only `client_id` | Yes — `client_secret_basic`, `client_secret_post`, or `private_key_jwt` |
| PKCE | Essential | Still required by current best practice |

This app is **architecturally a confidential client** — it is a server and could hold a secret — but the default sandbox registration is a **public** client, so `CLIENT_SECRET` is empty and the token request carries only `client_id`. The code handles both: see [`postToTokenEndpoint`](server/src/oauth.ts) in [server/src/oauth.ts](server/src/oauth.ts), which picks `client_secret_basic` when a secret is configured and discovery advertises it, `client_secret_post` otherwise, and sends neither when there is no secret.

The important consequence: **PKCE is what makes the flow safe here**, because there is no client secret protecting the token exchange.

### 1.6 SMART on FHIR in one paragraph

**FHIR** is the healthcare data standard (resources like `Patient`, `Observation`, served as JSON over REST). **SMART App Launch** is the specification that says how an app gets an OAuth token for a FHIR server. It is OAuth 2.0 + OIDC plus four healthcare-specific additions:

1. **Discovery** at a well-known URL derived from the FHIR base URL, so an app can work against any compliant server without configuration.
2. **A scope syntax for clinical data** (`patient/Observation.read`, `user/*.read`, `system/*.rs`).
3. **Launch context**: the token response carries *which patient* (and optionally encounter, user) the authorization is for.
4. **Two launch modes**: standalone (the user starts at the app) and EHR launch (the EHR opens the app with `iss` and `launch`).

---

## 2. The flow, step by step

### 2.1 The whole picture

```
  Browser              Node client            Authorization server        FHIR server
 (React UI)          (Express, :3001)          (discovered URL)        (discovered base)
     │                     │                          │                       │
     │                     │  0. GET /.well-known/smart-configuration ───────►│
     │                     │◄──────── endpoints, scopes, PKCE methods ────────│
     │                     │                          │                       │
     │ 1. GET /auth/login ►│                          │                       │
     │                     │ generate state + code_verifier                   │
     │                     │ store both in server-side session                │
     │◄─ 2. 302 to /authorize ?client_id&redirect_uri&scope&state             │
     │        &aud&code_challenge&code_challenge_method=S256                   │
     │ ═══════════ (front channel, dashed) ═══════════►│                       │
     │                     │                          │                       │
     │        3. user logs in  ◄──────────────────────►│                       │
     │        4. user consents ◄──────────────────────►│                       │
     │                     │                          │                       │
     │◄═══ 5. 302 to /callback?code=…&state=… ════════ │                       │
     │ GET /callback ─────►│                          │                       │
     │                     │ CHECK state FIRST (constant time, ≤10 min, once) │
     │                     │                          │                       │
     │                     │ 6. POST /token ─────────►│  grant_type, code,    │
     │                     │    (back channel, solid) │  redirect_uri,        │
     │                     │                          │  client_id,           │
     │                     │                          │  code_verifier        │
     │                     │◄─ 7. access_token, refresh_token, id_token,      │
     │                     │      scope, patient, expires_in ─────────────────│
     │                     │ tokens stored server-side only                   │
     │◄── 302 to the UI ───│                          │                       │
     │                     │                          │                       │
     │ GET /api/patient ──►│ 8. GET Patient/{id} with Bearer token ──────────►│
     │  (cookie only,      │◄──────────────── FHIR JSON ──────────────────────│
     │   no token,         │                          │                       │
     │   no patient id)    │                          │                       │
     │◄─ 9. safe JSON ─────│                          │                       │
```

The nine numbered steps are exactly the nine steps in the UI stepper ([client/src/components/FlowStepper.tsx](client/src/components/FlowStepper.tsx)). Their statuses are set by **real server events**, never by button clicks.

### 2.2 Step 0 — Discovery

**Why:** so no endpoint is ever hardcoded. Point the app at any SMART-compliant FHIR server and it learns where to send people.

**Request:** `GET {FHIR_BASE_URL}/.well-known/smart-configuration`

Implemented in [server/src/discovery.ts](server/src/discovery.ts). It runs once at startup, is cached **per FHIR base URL** (so the configured sandbox and each EHR-launch `iss` get their own entry), and can be forced to refresh from the UI via `POST /api/discovery/refresh`.

The five fields the app highlights:

| Field | What the app does with it |
|---|---|
| `authorization_endpoint` | Where the browser is redirected in step 2. **Required** — without it the flow cannot start |
| `token_endpoint` | Where the back-channel POST goes in step 6. **Required** |
| `code_challenge_methods_supported` | Should contain `S256`. If it is absent or lacks S256, the app **warns and still sends S256** rather than silently downgrading |
| `scopes_supported` | Compared against the requested scopes, for information only — servers may accept scopes they do not advertise (this sandbox does) |
| `capabilities` | Tells you what the server supports: `launch-standalone`, `launch-ehr`, `client-public`, `permission-v1`, `permission-v2`, `permission-offline`, … |

Also read: `token_endpoint_auth_methods_supported`, which decides how a confidential client authenticates.

**Design rule followed here:** absent values are **reported as warnings, never guessed**. Missing `authorization_endpoint` or `token_endpoint` throws a `DiscoveryError` and the UI explains why the flow cannot start.

### 2.3 Steps 1–2 — The authorization request

The browser hits `GET /auth/login`. The server ([server/src/routes/auth.ts](server/src/routes/auth.ts)) calls the single authorization function `startAuthorization()` in [server/src/oauth.ts](server/src/oauth.ts). **Standalone login, EHR launch and all five redirect-based demos share this one function** — there is no second code path that could drift.

What it does, in order:

1. Discover (or reuse cached) endpoints.
2. Generate `state` — 32 random bytes, base64url (43 chars).
3. Generate `code_verifier` — 48 random bytes, base64url (64 chars); derive `code_challenge = BASE64URL(SHA256(ASCII(verifier)))`.
4. Store `{state, codeVerifier, createdAt, requestedScope, authorizeRedirectUri, fhirBaseUrl, discovery, launch?, demo?}` in the **server-side session**.
5. Mark flow step 2 done.
6. Build the query parameters.
7. Record the wire-log entry.
8. `res.redirect()` — a 302 the browser follows.

**The authorization request parameters:**

| Parameter | Example value | Meaning | Secret? |
|---|---|---|---|
| `response_type` | `code` | Asks for the authorization code grant | No |
| `client_id` | `oauth-demo-app` | Which app is asking. An identifier, not a credential | **No** |
| `redirect_uri` | `http://localhost:3001/callback` | Where to send the browser back. Must match what was registered, **exactly** | No |
| `scope` | `openid fhirUser launch/patient patient/Patient.read patient/Observation.read offline_access` | What is being asked for | No |
| `state` | 43 random chars | CSRF protection — ties the callback to this session | No (but unguessable) |
| `aud` | the FHIR base URL | **SMART-specific.** Which FHIR server this token is for | No |
| `code_challenge` | 43 chars | SHA-256 hash of the verifier | No (it is a hash) |
| `code_challenge_method` | `S256` | Never `plain` | No |
| `launch` | opaque string | EHR launch only: the context handed over by the EHR | No |

Everything on this line is visible in the browser's address bar. That is the point of the front channel, and why **no secret appears in this list**.

**Why `aud` matters:** without it, a token minted for FHIR server A could be replayed against FHIR server B. `aud` tells the authorization server which resource server the token is for, so it can refuse to issue a token for a server it does not protect. SMART App Launch requires `aud` on the authorization request.

### 2.4 Steps 3–4 — Login and consent

These happen **at the authorization server**. The app sees nothing, which is the entire point: the user's password never touches this application.

The UI marks these steps "At the authorization server, not visible to this app", and they turn `done` only when the browser returns to `/callback` — they are *inferred* from a real event, not asserted optimistically.

On the SMART sandbox these are a patient-picker page and an approval page. In production they are the hospital's real login (often with MFA) and its real consent screen.

### 2.5 Step 5 — The callback and state validation

The AS redirects the browser to `GET /callback?code=…&state=…` (or `?error=…&error_description=…`).

The order of operations in [server/src/routes/auth.ts](server/src/routes/auth.ts) is deliberate and is the security-critical part of the whole file:

```
1. Record the arrival (the code is truncated to 8 characters in the log)
2. take the pending authorization out of the session  ← removes it; single use
3. validate state  ← FIRST. On failure: STOP. The code is never sent anywhere
4. only then: was there an error parameter instead of a code?
5. only then: exchange the code
```

`checkState()` in [server/src/session.ts](server/src/session.ts) returns one of three named failures, each of which the UI explains differently:

| Reason | Shown as | Means |
|---|---|---|
| `missing` | `NO PENDING AUTHORIZATION` | This session never started an authorization, or it was already used, or the cookie did not arrive |
| `expired` | `STATE EXPIRED` | More than 10 minutes since the authorization request |
| `mismatch` | `STATE MISMATCH` | The returned `state` does not equal the stored one |

The comparison uses `timingSafeEqual` (length check first, then constant-time compare) so that the comparison cannot leak information through timing.

**Single use is enforced structurally**: `takePendingAuthorization()` *deletes* the pending record as it reads it. Replaying a `/callback` URL later therefore hits the `missing` branch and is rejected **before any network call**. This holds even against an authorization server that would happily accept a replayed code — which, as it turns out, this sandbox does (see [§9](#9-what-the-sandbox-actually-does)).

### 2.6 Step 6 — The token exchange (back channel)

`POST {token_endpoint}` with `Content-Type: application/x-www-form-urlencoded`.

| Parameter | Value | Why |
|---|---|---|
| `grant_type` | `authorization_code` | Which grant is being redeemed |
| `code` | the code from the callback | Single-use, short-lived |
| `redirect_uri` | the **registered** URI | RFC 6749 §4.1.3: must be identical to the one in the authorization request. Prevents a redirect-swapping attack |
| `client_id` | `oauth-demo-app` | Identifies the client |
| `code_verifier` | the 64-char secret | **PKCE proof.** The AS hashes it and compares with the stored `code_challenge` |
| `client_secret` / `Authorization: Basic` | only for confidential clients | Client authentication |

This request and its response never touch the browser. In the wire log it is a solid arrow, and `code_verifier`, `Authorization` and every token in the response show as `[REDACTED — n chars]`.

### 2.7 Step 7 — The token response

```jsonc
{
  "access_token":  "eyJ…",        // ~639 chars on this sandbox
  "token_type":    "Bearer",
  "expires_in":    3600,           // seconds
  "scope":         "openid fhirUser launch/patient patient/Patient.read …",
  "refresh_token": "eyJ…",        // only because offline_access was granted
  "id_token":      "eyJ…",        // only because openid was granted
  "patient":       "018f428e-…",  // SMART launch context
  "need_patient_banner": true,
  "smart_style_url": "…"
}
```

What the app does with each field ([`applyTokenResponse`](server/src/oauth.ts)):

| Field | Handling |
|---|---|
| `access_token` | Stored in the server session. **Never** sent to the browser, never logged |
| `scope` | This is the **granted** scope, which may differ from what was requested. Stored and diffed |
| `refresh_token` | Stored. If a *rotated* refresh token comes back on a later refresh, it replaces the old one |
| `id_token` | Stored, and its payload decoded for display. **The signature is not verified** (see [§4.3](#43-the-id-token-decoded-is-not-verified)) |
| `patient` | The authorized patient ID. **This is the only source of patient identity in the app** |
| `expires_in` | Converted to an absolute `expiresAt` for the countdown in the UI |

The UI is then told, through `/api/session`, only *booleans and metadata*: `hasRefreshToken: true`, `secondsRemaining: 3574`, `patientId`, the granted scope string, the decoded ID token claims. Never a token value.

### 2.8 Steps 8–9 — Calling FHIR and rendering

The browser calls `GET /api/patient` and `GET /api/labs` **with nothing but its session cookie**. No token. No patient ID.

```
GET /api/patient        →  server looks up session.auth.patientId
                        →  GET {fhirBase}/Patient/{id}
                           Authorization: Bearer {access_token}

GET /api/labs           →  GET {fhirBase}/Observation?patient={id}&category=laboratory
```

If the browser *does* send `?patient=123`, the server **ignores it and says so in the wire log**: `Ignored browser-supplied ?patient=123. The patient comes from the token context.` This is demonstrable live and is the cleanest illustration of the rule that **authorization context comes from the token, never from the client**.

Lab rows are flattened to `{code, value, unit, date, interpretation}`. Any Observation whose value the app cannot represent (ranges, ratios, components, `dataAbsentReason`) renders as **Missing** — the app never guesses a clinical value. Only the first page of the bundle is shown, with a note when a `next` link exists.

---

## 3. The security mechanisms

### 3.1 PKCE — Proof Key for Code Exchange (RFC 7636)

**The attack it stops.** The authorization code comes back through the browser. On a mobile device a malicious app could register the same custom URL scheme; on the web a code can leak through browser history, a referrer header, a proxy log or an open redirect. If the code alone were enough to get tokens, whoever grabs it wins.

**The mechanism.**

```
1. Client invents a secret:      code_verifier   (48 random bytes → 64 base64url chars)
2. Client hashes it:             code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
3. Authorization request sends:  code_challenge + code_challenge_method=S256   (front channel)
4. AS stores the challenge alongside the code it issues
5. Token request sends:          code_verifier                                 (back channel)
6. AS computes SHA256(verifier) and compares with the stored challenge
```

A hash is one-way, so seeing the challenge tells an attacker nothing about the verifier. An intercepted code is worthless without the verifier, and the verifier never left the server.

**Worked example** (RFC 7636 Appendix B, asserted in [server/tests/pkce.test.ts](server/tests/pkce.test.ts)):

```
code_verifier  = dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
code_challenge = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
```

**Details that matter:**

- `S256`, never `plain`. `plain` sends the verifier itself through the front channel, which defeats the purpose. The app hardcodes `S256` and warns if discovery does not advertise it.
- Length: RFC 7636 allows 43–128 characters. 64 is comfortably inside that.
- It must come from a CSPRNG (`crypto.randomBytes`), not `Math.random()`.
- One verifier per authorization request, used once, then deleted.

**What PKCE does *not* protect against.** Worth saying out loud in a demo:

- It does not help if the attacker can read the verifier — e.g. if they have compromised this server.
- It does not stop a malicious app that simply runs its own complete, legitimate flow and tricks a user into consenting.
- It is not a substitute for `state` (different attack) or for exact redirect URI matching.

### 3.2 `state` — CSRF protection

**The attack it stops (login CSRF / code injection).** An attacker starts their own authorization flow, obtains a code bound to *their* account, and then tricks a victim's browser into visiting `https://app.example/callback?code=ATTACKER_CODE`. Without `state`, the app happily redeems it and the victim's session is now attached to the attacker's identity — anything the victim then writes goes into the attacker's account.

**The mechanism.** The client generates an unguessable value, keeps it in the user's session, sends it on the authorization request, and requires the callback to return the same value. A code arriving without a matching `state` cannot have come from a flow this browser session started.

**How this app hardens it:**

| Property | Implementation |
|---|---|
| Unguessable | 32 bytes from `crypto.randomBytes`, base64url |
| Bound to the session | Stored in the server-side session, keyed by the `httpOnly` cookie |
| Compared safely | `timingSafeEqual` after a length check |
| Time-limited | 10 minutes (`STATE_TTL_MS`), so an abandoned request cannot be completed later |
| Single use | `takePendingAuthorization()` deletes as it reads |
| **Checked first** | Before the error branch, before any token request |

`state` is *not* a place to store application data. Some apps put a return URL in it; the safer pattern (used here) is to keep it purely random and hold everything else in the session.

### 3.3 Exact redirect URI matching

The AS must only send a code to a URI the client registered — otherwise an attacker supplies `redirect_uri=https://evil.example` and receives codes directly.

Two checks exist, and this demo exercises both:

1. **At `/authorize`**: is the requested `redirect_uri` registered? RFC 9700 requires **exact string comparison** (no wildcards, no prefix matching, no "trailing slash is fine").
2. **At `/token`**: does the `redirect_uri` in the token request match the one used in the authorization request? (RFC 6749 §4.1.3.) This stops an attacker mixing the two.

The *Mismatched redirect URI* demo adds a single trailing slash to the authorization request only. On this sandbox, `/authorize` accepts it (it matches by prefix) and `/token` then rejects it with `401 invalid_request "Invalid redirect_uri parameter"`. A stricter server rejects at `/authorize` and shows an error page instead of redirecting anywhere.

### 3.4 Single-use authorization codes

RFC 6749 §4.1.2: an AS **MUST NOT** accept a code twice, and **SHOULD** revoke any tokens already issued from a code that gets replayed. Codes should be short-lived (the spec suggests a maximum of ~10 minutes; this sandbox uses 5).

This sandbox does **not** enforce single use — its codes are stateless signed JWTs and nothing records that one was spent. The demo shows this honestly rather than faking a rejection, and points out that **the client's own defence still holds**: this app deleted its `state` and `code_verifier` after the first exchange, so replaying the callback URL against the app is rejected before any network call.

### 3.5 Scopes and least privilege

A scope is a request. The grant is the answer, and **they are not the same thing** — RFC 6749 §5.1 explicitly allows the AS to return a different `scope` than requested.

This app requests exactly what it needs:

| Scope | Why this app asks for it |
|---|---|
| `openid` | Turns on OIDC, so an ID token is issued |
| `fhirUser` | Adds the `fhirUser` claim, identifying the logged-in user as a FHIR resource |
| `launch/patient` | Asks for patient launch context, so the token response carries `patient` |
| `patient/Patient.read` | Read the one authorized patient's demographics |
| `patient/Observation.read` | Read that patient's observations |
| `offline_access` | Ask for a refresh token |

It deliberately does **not** ask for `patient/*.read`, `user/*.read`, any write scope, or `launch/encounter`.

The UI shows the requested-versus-granted table with dropped scopes struck through and marked **NOT GRANTED**, and scopes the server added marked as such. The *Request `patient/*.read`* demo runs a real second authorization with a wildcard scope and puts the narrow grant next to the broad one.

### 3.6 Token storage: why the server holds everything

Every browser storage option leaks:

| Where | Problem |
|---|---|
| `localStorage` / `sessionStorage` | Readable by any JavaScript on the page — one XSS or one bad dependency and the token is gone |
| A non-`httpOnly` cookie | Same |
| A JS variable | Same, plus it dies on refresh |
| The URL | Browser history, referrer headers, server logs, shoulder-surfing |
| **A server-side session, keyed by an `httpOnly` cookie** | **What this app does.** JavaScript cannot read the cookie; the token never enters the browser at all |

The rules this codebase enforces, and which are checkable live:

- No token in any API response — `/api/session` is built field by field from a whitelist and then passed through `redact()` as a second line of defence.
- No token in the wire log — entries are redacted *before* they are stored, so `GET /api/wirelog` cannot return one even in principle.
- No token in a cookie — the cookie is an opaque signed session ID (`smart_demo_sid`).
- No token in the browser at all — in a real Chrome run, `document.cookie` is empty (the cookie is `httpOnly`), local and session storage are empty, and there are no JWT-shaped strings in the DOM.

### 3.7 The session cookie

```js
{ name: "smart_demo_sid", httpOnly: true, sameSite: "lax", secure: false, maxAge: 8h }
```

| Setting | Why |
|---|---|
| `httpOnly: true` | JavaScript cannot read it. The single most valuable cookie flag |
| `sameSite: "lax"` | **Not `strict`.** The trip back from the authorization server to `/callback` is a cross-site, top-level GET navigation. `Lax` sends the cookie on it; `Strict` would not, and `/callback` would find no stored `state` and fail with a confusing error. `Lax` still blocks the cookie on cross-site POSTs and subresource requests |
| `secure: false` | Only because this demo runs on plain HTTP on localhost. **In production this must be `true`** |
| `maxAge` | An absolute cap on session lifetime |

This is a genuinely instructive trade-off to show an audience: `Strict` is not automatically "more secure" — here it would break the protocol, and people who hit that failure often "fix" it by weakening something that matters more.

### 3.8 Redaction

There is exactly **one** redaction helper: [server/src/redaction.ts](server/src/redaction.ts). It is plain TypeScript with no Node or browser APIs, so the **same file** runs on the server and is imported by the React wire log. Secret-hiding logic is never duplicated, which means it cannot drift.

| Class | Keys | Rendered as |
|---|---|---|
| Never shown | `access_token`, `refresh_token`, `id_token`, `code_verifier`, `client_secret`, `client_assertion`, `authorization`, `cookie`, `set-cookie` | `[REDACTED — 639 chars]` |
| Truncated | `code` | `eyJhbGci… (truncated)` (first 8 characters) |
| Shown in full | `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `aud`, and anything not listed above | as-is |

It also cleans secrets **inside free text**: JWT-shaped strings (`eyJ….….…`), and `?code=` / `?access_token=` style URL parameters. It is **idempotent** — already-redacted and already-truncated values are left alone — which is what makes it safe to apply repeatedly (the server redacts on record, and the browser redacts again before rendering and before copying).

**There is no "reveal" mode.** Not a hidden one, not a config flag. The length is shown so the audience can see something real is there, and that is all.

Why the length is safe to show and the code's first 8 characters are too: the length reveals nothing usable, and 8 characters of a 5-minute single-use code is not enough to redeem it. On this sandbox those 8 characters are always `eyJhbGci`, because the codes are JWTs and that is just the header.

---

## 4. Tokens

### 4.1 The three tokens

| | **Access token** | **Refresh token** | **ID token** |
|---|---|---|---|
| Spec | OAuth 2.0 / RFC 6750 | OAuth 2.0 | OpenID Connect |
| Answers | "May this request read this data?" | "May I have a new access token?" | "Who signed in?" |
| Sent to | The **FHIR server**, as `Authorization: Bearer …` | The **token endpoint**, only | **Nobody** — it is consumed by the client |
| Lifetime here | 3600 s (`expires_in`) | Longer; set by the server and not reported to the client | Not used as a credential; its `exp` claim matters only when verifying it |
| Audience | The FHIR server (`aud`) | The AS | This client |
| Requested via | (implicit) | `offline_access` | `openid` |

A common and costly confusion: **an ID token is not an access token**. Sending an ID token to an API as a bearer credential is a real-world mistake. Its audience is the client; the API has no reason to trust it.

### 4.2 Bearer tokens

"Bearer" means exactly what it says: whoever holds it can use it. There is no proof of possession, no binding to a device or key. Everything else follows from that — TLS everywhere, short lifetimes, never in URLs or logs, never in the browser. (Proof-of-possession alternatives exist — DPoP, mTLS-bound tokens — and are out of scope for this demo.)

### 4.3 The ID token: decoded is not verified

The UI shows the decoded ID token payload with two markers side by side:

```
✓ Payload decoded          ✕ Signature not verified
```

**Decoding** is base64url and `JSON.parse`. Anyone can do it to any JWT; it proves nothing. Any attacker can hand you a JWT with `"fhirUser": "Practitioner/admin"` in it.

**Verifying** means: fetch the issuer's JWKS, check the RS256/ES256 signature against the right key (`kid`), then check `iss`, `aud`, `exp`, `nbf`, and `nonce` if one was sent.

This demo **only decodes**, and says so in the code comment, in the UI, and here. That is acceptable *only* because the app makes no security decision from these claims — the patient ID it actually uses comes from the token response's `patient` field, over the back channel, from a server it authenticated via TLS. A production app must verify. This is on the production-differences list in the README.

### 4.4 The token lifecycle: 401 → refresh → retry

Every outbound FHIR call goes through one wrapper, `fhirGet()` in [server/src/fhir.ts](server/src/fhir.ts). It is small on purpose:

```
FHIR request
  ├─ not 401 → return (or throw on another error status)
  └─ 401 → ONE refresh attempt
            ├─ no refresh token, or refresh failed
            │     → delete session.auth, log "Re-authentication required", throw
            └─ refreshed → retry the original request ONCE
                            ├─ 200 → return
                            └─ 401 → delete session.auth, throw
```

**At most: the original request + one refresh + one retry. No loops.** This matters: a naive retry loop against an AS that is rejecting you is how apps get rate-limited or locked out, and how a transient failure turns into an outage.

The refresh request is itself a back-channel POST:

```
grant_type=refresh_token & refresh_token=… & client_id=…
```

If the AS rotates refresh tokens (issues a new one with each refresh — a recommended practice, because it makes refresh-token theft detectable), `applyTokenResponse` picks up the new value.

### 4.5 Logout

`POST /auth/logout` destroys the server-side session and clears the cookie. The tokens are **discarded, not revoked**, and the wire log says so explicitly.

This is an honest limitation to show: the discovery document here advertises no `revocation_endpoint` (RFC 7009), so there is nothing to call. A production app should revoke both tokens at logout, because a discarded refresh token that is still valid at the AS is still a credential sitting in someone's logs.

---

## 5. What SMART adds to OAuth

### 5.1 The scope grammar

```
{context}/{Resource}.{permission}
```

| Prefix | Meaning |
|---|---|
| `patient/` | Data for the one patient in context |
| `user/` | Everything the logged-in user may see (a clinician's whole panel) |
| `system/` | No user; backend services, via client credentials |

| Permission | Version |
|---|---|
| `.read`, `.write`, `.*` | SMART v1 |
| `.c` `.r` `.u` `.d` `.s` (create, read, update, delete, search), e.g. `patient/Observation.rs` | SMART v2 |

Discovery `capabilities` tells you which the server supports; this sandbox advertises both (`permission-v1`, `permission-v2`).

Plus the context and identity scopes: `launch`, `launch/patient`, `launch/encounter`, `openid`, `fhirUser`, `profile`, `offline_access`, `online_access`.

### 5.2 Launch context

Standard OAuth gives you "a token for some user". Healthcare needs "a token for *this patient*, in *this encounter*". SMART carries that in the **token response**, not in the request and never from the browser:

```json
{ "patient": "018f428e-34f6-4707-8009-5ad742f901e7", "encounter": "…", "need_patient_banner": true }
```

`getAuthorizedPatient()` reads `session.auth.patientId` and nothing else. If it is absent, the app throws `MissingPatientContextError` — HTTP 409, with the message *"The token response contained no patient context (was `launch/patient` granted?). This app will not guess a patient."* **It refuses to guess.** That refusal is the feature.

### 5.3 The two launch modes

| | **Standalone launch** | **EHR launch** |
|---|---|---|
| Starts at | The app ("Connect") | Inside the EHR, which opens the app |
| Extra parameters | none | `iss` (the FHIR base URL) and `launch` (opaque context) |
| How the app knows the FHIR server | Configured `FHIR_BASE_URL` | **From `iss`** — discovery runs against it |
| Extra scope | — | `launch` |
| `aud` | the configured base URL | `iss` |
| Route here | `/auth/login` | `/launch?iss=…&launch=…` |

Both call the same `startAuthorization()`. `/launch` requires both parameters and requires `iss` to be an `https` URL. A production app also needs an **allowlist of trusted issuers** — otherwise anyone can launch your app against a FHIR server they control and harvest whatever the flow produces. That is on the production-differences list.

The `launch` value is opaque to the app. It is a handle the EHR and its authorization server share, saying "the app opened from Dr. Smith's screen while patient X's chart was open".

### 5.4 The FHIR calls

```
GET {base}/Patient/{id}                                    Accept: application/fhir+json
GET {base}/Observation?patient={id}&category=laboratory
```

The second returns a **Bundle** — `total`, an `entry` array, and `link` relations for paging. The app shows the first page, sorts by date descending, and notes when a `next` link exists. The wire log deliberately summarises FHIR responses (`{resourceType: "Bundle", total, entriesReturned, hasNextPage}`) rather than dumping clinical payloads onto a projector.

---

## 6. How this codebase implements it

### 6.1 File map

| File | Responsibility |
|---|---|
| [server/src/config.ts](server/src/config.ts) | Environment variables; fails fast on missing ones; warns on the default `SESSION_SECRET` |
| [server/src/discovery.ts](server/src/discovery.ts) | `.well-known/smart-configuration`, per-URL cache, warnings, `requireOAuthEndpoints` |
| [server/src/pkce.ts](server/src/pkce.ts) | `generateCodeVerifier()`, `createCodeChallenge()` |
| [server/src/session.ts](server/src/session.ts) | Cookie config, session shape, `generateState`, `checkState`, `takePendingAuthorization`, flow stepper state |
| [server/src/oauth.ts](server/src/oauth.ts) | `startAuthorization` (the one redirect), token POST, client auth, refresh, `decodeJwtPayload` |
| [server/src/fhir.ts](server/src/fhir.ts) | The one FHIR wrapper (401 → refresh → retry), patient/labs, observation flattening |
| [server/src/scope.ts](server/src/scope.ts) | `parseScope`, `diffScopes`, `unadvertisedScopes`, `broadenPatientScopes`, `ensureLaunchScope` |
| [server/src/redaction.ts](server/src/redaction.ts) | **The** redaction helper; shared with the client |
| [server/src/wireLog.ts](server/src/wireLog.ts) | Ring buffer of 500 entries; redacts before storing and printing |
| [server/src/routes/auth.ts](server/src/routes/auth.ts) | `/auth/login`, `/launch`, `/callback`, `/auth/logout` |
| [server/src/routes/api.ts](server/src/routes/api.ts) | `/api/session`, `/api/discovery`, `/api/patient`, `/api/labs`, `/api/wirelog` |
| [server/src/routes/demo.ts](server/src/routes/demo.ts) | The six failure demos and their fact-based explanations |
| [server/src/index.ts](server/src/index.ts) | Wiring, static files, the error handler |
| [client/src/](client/src/) | React UI: stepper, discovery, patient, scopes, labs, wire log, demo panel |

### 6.2 HTTP surface

| Route | Method | Purpose |
|---|---|---|
| `/auth/login` | GET | Start a standalone authorization (browser navigation) |
| `/launch` | GET | EHR launch; requires `iss` and `launch` |
| `/callback` | GET | The redirect URI. Validates `state`, exchanges the code |
| `/auth/logout` | POST | Destroy the session |
| `/api/session` | GET | Safe metadata only (see below) |
| `/api/discovery` | GET | The discovery document plus warnings |
| `/api/discovery/refresh` | POST | Force a re-fetch |
| `/api/patient` | GET | The authorized patient. **Ignores any `?patient=`** |
| `/api/labs` | GET | Laboratory observations for the authorized patient |
| `/api/flow/rendered` | POST | The UI reporting that step 9 completed |
| `/api/wirelog` | GET / DELETE | Read (`?since=id`) or clear the log |
| `/demo/{id}` | GET | Five redirect-based failure demos |
| `/demo/force-expiry` | POST | The token-expiry demo |

`/api/session` returns only: `authorized`, `scope`, `requestedScope`, `patientId`, `expiresIn`, `secondsRemaining`, `hasRefreshToken`, `fhirBaseUrl`, `idTokenClaims`, `scopeDiff`, `flow`, `awaitingAuthorizationServer`, `lastError`, `demo`, `scopeComparison`. It is assembled from a whitelist *and* passed through `redact()`.

### 6.3 Session shape

```ts
session.pendingAuth  // state, codeVerifier, createdAt, requestedScope,
                     // authorizeRedirectUri, fhirBaseUrl, discovery, launch?, demo?
session.auth         // accessToken, refreshToken?, idToken?, idTokenClaims?,
                     // requestedScope, grantedScope?, patientId?, expiresAt, …
session.flow         // nine StepStatus values
session.lastError    // a TeachingError: step, message, endpoint?, status?, error?, concept?
session.demo         // the running or completed DemoResult
session.narrowScope / session.broadScope   // ScopeDiff for the comparison table
```

### 6.4 The wire log

Six directions, which map to the four lanes drawn in the UI:

| Direction | Label | Channel |
|---|---|---|
| `browser-client` | Browser → Node client | — |
| `browser-auth` | Browser → Authorization server | front (dashed) |
| `auth-browser` | Authorization server → Browser → Node client | front (dashed) |
| `client-auth` | Node client → Authorization server | **back** (solid) |
| `client-fhir` | Node client → FHIR server | **back** (solid) |
| `internal` | Inside the Node client | — |

`record()` redacts first, then stores, then prints to the server console. Because redaction happens **before storage**, no later code path — API response, copy button, console — can expose a secret it never held.

### 6.5 Error handling

One Express error handler maps typed errors to teaching output:

| Error | HTTP | Meaning |
|---|---|---|
| `DiscoveryError` | 502 | The discovery document is unreachable or unusable |
| `ReauthRequiredError` | 401 | Token rejected and not refreshable; tokens cleared |
| `MissingPatientContextError` | 409 | No patient in the token context; the app will not guess |
| `FhirRequestError` | 502 | The FHIR server returned an error status |
| `OAuthFlowError` | 400 | A bad request to the flow (e.g. `/launch` without `iss`) |
| anything else | 500 | Unexpected |

API calls get JSON (redacted); browser navigations get redirected back to the UI, which shows the error from `/api/session`.

### 6.6 Tests

`npm test` runs 11 assertions with `node:test`, covering exactly what the spec asked for:

- **PKCE** — verifier is 64 base64url chars and differs each time; challenge is unpadded base64url and never equals the verifier; the RFC 7636 Appendix B vector is reproduced exactly.
- **state** — a valid state is accepted; a different or missing one is a mismatch; one older than 10 minutes is expired; a pending authorization can be consumed only once.
- **scope** — identical grants; a granted subset; a dropped scope; a scope added by the server.

---

## 7. Threat model: attack, defence, demo

| Attack | Defence in this app | Demonstrable? |
|---|---|---|
| Stolen authorization code (history, logs, referrer, malicious app) | PKCE S256 — the code is useless without the verifier | **Remove PKCE verifier** |
| Login CSRF / code injection into a victim's session | `state`, checked before anything else | **Tamper with state** |
| Replayed code | AS should refuse (RFC 6749 §4.1.2); this client also deletes `state` + verifier after one use | **Replay authorization code** |
| Attacker-controlled redirect URI | Exact matching at `/authorize` and `/token` | **Mismatched redirect URI** |
| XSS stealing tokens | Tokens never enter the browser; `httpOnly` cookie; no browser storage | Check `document.cookie` and DevTools live |
| Over-broad access | Least-privilege scopes; requested-vs-granted comparison | **Request `patient/*.read`** |
| Token leaking through logs or a screen share | One central redaction helper; redact before store; no reveal mode | Visible in every log entry |
| Expired or rejected token | 401 → one refresh → one retry, then clear and reconnect | **Force token expiry** |
| Client-supplied patient ID (IDOR) | Patient comes only from the token context; `?patient=` is ignored and logged | Add `?patient=123` to `/api/patient` |
| Token replayed against a different FHIR server | `aud` binds the token to the intended server | Visible in the authorization request |
| Cookie stolen by cross-site request | `SameSite=Lax` + `httpOnly` | Visible in DevTools |

---

## 8. The six failure demos in detail

Every demo runs **real code against the real sandbox**. Nothing is simulated, and each explanation is chosen from what the response actually contained — including when the sandbox behaves *worse* than the spec requires.

Each panel shows the same four-part structure: **What we changed → Actual request/response → Why it failed → OAuth concept illustrated.**

### 1. Mismatched redirect URI

- **Changed:** the authorization request sent `http://localhost:3001/callback/` (one trailing slash). The token request still sent the registered value.
- **Real result:** `/authorize` accepted it (this sandbox matches by prefix), the browser came back with a code, and `/token` rejected it: `401 invalid_request "Invalid redirect_uri parameter"`.
- **Concept:** authorization servers compare redirect URIs exactly; RFC 6749 §4.1.3 also requires the token request's URI to match the authorization request's. A stricter server rejects at `/authorize` and shows an error page rather than redirecting to an unregistered URI.

### 2. Tamper with state

- **Changed:** after redirecting the browser, the server replaced the `state` stored in its own session. The browser still carried the original.
- **Real result:** `STATE MISMATCH`. **No token request appears in the wire log at all.**
- **Concept:** `state` is CSRF protection, and it is checked before the code is used. This is the most visually convincing demo: the audience sees the absence of a request.

### 3. Replay authorization code

- **Changed:** after a successful exchange, the same code and verifier were POSTed a second time.
- **Real result:** **this sandbox accepted the replay** (HTTP 200, a fresh set of tokens). The demo discards them and says so.
- **Concept:** RFC 6749 §4.1.2 says a code must not be accepted twice and tokens from a replayed code should be revoked; production servers typically answer `invalid_grant`. The sandbox issues stateless 5-minute JWT codes and keeps no record of use. **The client's own defence still holds** — replaying the `/callback` URL against this app is rejected as `NO PENDING AUTHORIZATION` with no token request.

### 4. Remove PKCE verifier

- **Changed:** the token request omitted `code_verifier`. Everything else was correct.
- **Real result:** `400 invalid_request "Missing code_verifier parameter"`.
- **Concept:** the code alone is not enough. The authorization request carried only the hash; the verifier never left the server.

### 5. Request `patient/*.read`

- **Changed:** a real second authorization requesting the wildcard instead of the two resource scopes.
- **Real result:** granted **exactly as requested** — this sandbox's consent screen offers no per-scope choice. The broad tokens are discarded; the existing session is untouched.
- **Concept:** least privilege. Also an honest lesson about sandboxes: in a real EHR the grant is bounded by the app's registration, the user's role and the patient's choices.

### 6. Force token expiry

- **Changed:** server-side only — the stored access token was replaced with random characters of the same length and marked expired. (The sandbox issues 60-minute tokens and we cannot move its clock; marking it expired only locally would never produce a real 401.)
- **Real result:** `FHIR request → 401` → `Refresh token → new access token` → `FHIR retry → 200`. The user never logs in again.
- **Concept:** the token lifecycle, and bounded retries. If the refresh or the retry fails, the tokens are cleared and the user must reconnect — verified separately against the real sandbox with an invalid refresh token.

---

## 9. What the sandbox actually does

Checked against `launch.smarthealthit.org` on 2026-09-14 with live requests and the launcher's source ([smart-on-fhir/smart-launcher-v2](https://github.com/smart-on-fhir/smart-launcher-v2)), and reproduced through this app. **Where the sandbox differs from the specification, this app shows the real behaviour and explains the discrepancy rather than hiding it.**

| Observed | Consequence |
|---|---|
| A standalone authorization against the plain `/v/r4/fhir` URL fails: `invalid_request — Invalid launch options: SyntaxError: Unexpected end of JSON input`. The launcher reads standalone settings from a base64url `sim` segment in the URL | `.env.example` uses a `sim` URL. This is the smallest compatibility adjustment available, and discovery still runs against it, so **nothing is hardcoded**. The plain URL still works as the `iss` of an EHR launch |
| Codes can be replayed (HTTP 200) — stateless 5-minute JWTs, no record of use | Demo 3 shows the real 200 and explains what the RFC requires |
| Missing `code_verifier` → `400 invalid_request` | Demo 4 works exactly as specified |
| `redirect_uri` is prefix-matched at `/authorize`, compared exactly at `/token` | Demo 1 fails at the token endpoint, not the authorization endpoint |
| Scopes are granted verbatim; `patient/Patient.read` is not in `scopes_supported` but is accepted; `patient/*.read` is granted as asked | The discovery panel flags unadvertised scopes as information only; demo 5 explains the sandbox limitation |
| The FHIR proxy answers with **no token at all** (200) and does not enforce scopes; it rejects only an *invalid* token (`401 Invalid token`) | **The app enforces the patient restriction itself.** Never assume a real server behaves like this |
| Codes are JWTs, so truncated codes always begin `eyJhbGci` | That prefix is the JWT header, nothing more |
| Refresh works; an invalid refresh token returns `401 invalid_grant` | The wrapper clears tokens and asks for re-authentication |
| Epic's discovery document works (S256, `client_secret_basic`/`post`, a short `scopes_supported`) | The Epic profile is documented via environment variables but **has not been verified**, since it needs a registered client |

---

## 10. The gap between this and production

This demo is deliberately small so it can be read line by line. A production SMART app differs in at least these ways:

| Area | This demo | Production |
|---|---|---|
| Sessions | In-memory `MemoryStore` | Durable, shared store; regenerate the session ID after login; idle + absolute timeouts |
| Transport | Plain HTTP on localhost | HTTPS everywhere; `secure` cookies; HSTS |
| ID token | Decoded only | Verify signature against JWKS, plus `iss`, `aud`, `exp`, `nonce` |
| Secrets | `.env`, `SESSION_SECRET=replace-me` | A secret manager, or `private_key_jwt` asymmetric client auth |
| Logging | A teaching wire log any local browser can read | Structured logs, audit logging of PHI access, no protocol dump exposed |
| Tokens at logout | Discarded | Revoked (RFC 7009) |
| EHR launch | Any `https` `iss` accepted | An allowlist of trusted issuers |
| FHIR data | First page only; five value types | Follow `next` links; handle every value type; validate resources |
| Errors | Provider details shown on screen | Generic messages for users, details to logs |
| Access control | Relies on the token's patient context | Real authorization inside the app — never trust the resource server to be strict |
| Scale | One process | Multiple instances, monitoring, alerting |

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Access token** | The credential sent to the FHIR server. Short-lived, bearer |
| **`aud`** | Audience — which FHIR server a token is meant for |
| **Authorization code** | A short-lived, single-use value exchanged for tokens on the back channel |
| **Authorization server (AS)** | Authenticates the user and issues tokens |
| **Back channel** | Direct server-to-server HTTP; safe for secrets |
| **Bearer token** | A credential whose holder is trusted, with no extra proof |
| **BFF** | Backend for frontend — the server holds tokens on the browser's behalf. What this app is |
| **`client_id`** | A public identifier for the app. Not a secret |
| **`client_secret`** | A credential for confidential clients only |
| **`code_challenge` / `code_verifier`** | PKCE's hash and secret |
| **Confidential client** | A client that can keep a secret (a server) |
| **Discovery** | `.well-known/smart-configuration`, telling a client where the endpoints are |
| **`fhirUser`** | An OIDC claim identifying the user as a FHIR resource, e.g. `Patient/123` |
| **Front channel** | Through the browser as URL parameters. Never for secrets |
| **ID token** | An OIDC JWT describing who signed in. Not an API credential |
| **JWKS** | The JSON Web Key Set used to verify a JWT's signature |
| **Launch context** | SMART's "which patient/encounter", delivered in the token response |
| **Least privilege** | Ask for the narrowest scopes that do the job |
| **OIDC** | OpenID Connect — authentication on top of OAuth |
| **PKCE** | Proof Key for Code Exchange (RFC 7636) |
| **Public client** | A client that cannot keep a secret |
| **Redirect URI** | Where the AS sends the browser back. Matched exactly |
| **Refresh token** | Exchanged for a new access token without the user |
| **Resource server (RS)** | The API holding the data — here, the FHIR server |
| **Scope** | A requested permission. The grant may differ |
| **`state`** | An unguessable value tying the callback to this session; CSRF protection |
| **SMART App Launch** | The spec for OAuth against FHIR servers |

---

## 12. Questions an audience will ask

**Why isn't the React app the OAuth client?**
Because then the tokens would be in the browser, and any XSS or malicious dependency would take them. The server holds the tokens; the browser holds an `httpOnly` session cookie. This is the BFF pattern from the IETF's browser-based apps guidance.

**If `code_challenge` is public, what stops an attacker computing the verifier?**
SHA-256 is one-way. There is nothing to compute, and the input space (48 random bytes) is far too large to search.

**Do we still need `state` if we have PKCE?**
In this app, yes. They were designed for different attacks: PKCE stops a stolen code being redeemed; `state` proves the callback belongs to a flow *this browser session* started. RFC 9700 does allow a client to rely on PKCE for CSRF protection *if it has confirmed the authorization server enforces PKCE* — but this sandbox demonstrably does not enforce everything it should (it accepts replayed codes), so checking `state` first is the portable, verifiable choice.

**Why is the authorization code shown at all, even truncated?**
So the audience can see a real value appear in the URL and then see it vanish from the back-channel logs. Eight characters of a single-use, 5-minute code is not usable, and on this sandbox those characters are always the JWT header.

**Can I see the full token, just for teaching?**
No. There is no reveal mode, deliberately — a demo is exactly the situation (projector, screen recording, shared screen) where an "only this once" reveal escapes. The redacted length shows something real is there.

**Why `SameSite=Lax` and not `Strict`?**
`Strict` would not send the cookie on the cross-site redirect back to `/callback`, so the server would find no stored `state` and the flow would fail confusingly. `Lax` sends it on top-level GET navigations while still blocking cross-site POSTs.

**Why does the replay demo succeed?**
Because this sandbox genuinely accepts replayed codes. Faking a rejection would teach the wrong thing. The demo shows the real 200 and explains what RFC 6749 requires — and shows that this client's own single-use defence still works.

**Where does the patient ID come from?**
The token response's `patient` field, over the back channel. Never from the browser. Add `?patient=123` to `/api/patient` and the wire log will say it was ignored.

**Is the ID token trustworthy here?**
It is decoded, not verified. The app makes no decision from it. In production you verify it against the issuer's JWKS before believing a single claim.

**What happens if the refresh fails?**
The tokens are cleared and the UI asks the user to reconnect. One refresh, one retry, then stop — no loops.

---

## 13. Specifications and further reading

| Spec | What it covers |
|---|---|
| [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) | OAuth 2.0 core. §4.1 is the authorization code grant; §4.1.2 single-use codes; §4.1.3 the token request; §5.1 the token response |
| [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) | Bearer token usage |
| [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) | PKCE. Appendix B has the test vector used in the unit tests |
| [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009) | Token revocation |
| [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) | Authorization server metadata (the general form of SMART discovery) |
| [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700) | OAuth 2.0 Security Best Current Practice — exact redirect matching, PKCE everywhere, no implicit grant |
| [OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/) | The BFF pattern this app follows, and why tokens should stay out of the browser |
| [OAuth 2.1 draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) | Consolidation: PKCE required, implicit and password grants removed |
| [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) | ID tokens, claims, `nonce` |
| [SMART App Launch](https://hl7.org/fhir/smart-app-launch/) | Discovery, scopes, launch contexts, the `aud` parameter |
| [FHIR R4](https://hl7.org/fhir/R4/) | `Patient`, `Observation`, `Bundle` |
</content>
