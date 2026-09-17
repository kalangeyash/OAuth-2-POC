# Running and demonstrating the SMART on FHIR OAuth demo

> **DEMO / SYNTHETIC DATA.** The sandbox contains synthetic patients only. Never type real patient information into it.

This is the operator's manual: how to install and run the project, how to check it works before an audience sees it, and a click-by-click script for presenting it — including all six failure demos, what each one really does on this sandbox, and what to say.

For the concepts behind every step, see [OAUTH-GUIDE.md](OAUTH-GUIDE.md).

**Contents**

1. [Quick start](#1-quick-start)
2. [Prerequisites](#2-prerequisites)
3. [Install and start](#3-install-and-start)
4. [Smoke test before any audience](#4-smoke-test-before-any-audience)
5. [How the pieces connect](#5-how-the-pieces-connect)
6. [Commands and configuration](#6-commands-and-configuration)
7. [Preparing the room](#7-preparing-the-room)
8. [A tour of the screen](#8-a-tour-of-the-screen)
9. [The presentation script](#9-the-presentation-script)
10. [Running each failure demo](#10-running-each-failure-demo)
11. [Optional extras that land well](#11-optional-extras-that-land-well)
12. [Resetting between runs](#12-resetting-between-runs)
13. [When something goes wrong live](#13-when-something-goes-wrong-live)
14. [Troubleshooting](#14-troubleshooting)
15. [Other ways to run it](#15-other-ways-to-run-it)

---

## 1. Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open **http://localhost:5173** — `localhost`, not `127.0.0.1`. Click **Connect**, pick a patient on the sandbox login page (e.g. *Abdul Koepp*), click **Approve**, then **Load patient and labs**.

---

## 2. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Node.js 20.19 or newer** | Required by the project (`engines` in `package.json`). Developed on v23.9.0 | `node -v` |
| **npm** | Installs dependencies, runs scripts | `npm -v` |
| **Internet access** | Discovery, login, tokens and FHIR data all come from `launch.smarthealthit.org`. **There is no offline mode** | open https://launch.smarthealthit.org |
| **Ports 3001 and 5173 free** | Node OAuth client and Vite UI | `lsof -i :3001 -i :5173` should print nothing |
| **A modern browser** | Chrome was used for verification | — |

No database, no Docker, no accounts, no API keys. The sandbox needs no registration.

---

## 3. Install and start

### 3.1 First time

```bash
cd /path/to/OAuth-2
npm install              # installs Express, React, Vite, TypeScript, etc.
cp .env.example .env     # the defaults work as-is against the SMART sandbox
```

A `.env` already exists in this checkout (copied from `.env.example`), so the copy step is only needed on a fresh clone.

### 3.2 Start

```bash
npm run dev
```

This runs two processes together (with `concurrently`), prefixed in the terminal as `server` (blue) and `client` (magenta). Leave this terminal open for the whole session.

### 3.3 What a healthy start looks like

In the terminal:

```
[client]   VITE v8.3.0  ready in 158 ms
[client]
[client]   ➜  Local:   http://localhost:5173/
[client]   ➜  Network: use --host to expose
[server] SESSION_SECRET is still "replace-me". Fine for a local demo; never in production.
[server]
[server] SMART on FHIR OAuth 2.0 teaching demo. DEMO / SYNTHETIC DATA ONLY. Not production software.
[server] OAuth client (Node/Express) listening on http://localhost:3001
[server] UI: http://localhost:5173
[server]
[server] [wire #1 15:08:07] Node client → FHIR server | SMART discovery | GET https://launch.smarthealthit.org/v/r4/sim/…/fhir/.well-known/smart-configuration → 200
[server] {
[server]   "result": {
[server]     "authorization_endpoint": "https://launch.smarthealthit.org/v/r4/sim/…/auth/authorize",
…
```

The `SESSION_SECRET` warning is expected for a local demo. Wire-log times in the terminal are UTC.

The `[wire #1 …] SMART discovery … → 200` line is the important one: it proves the server reached the sandbox at startup. If it says `SMART discovery failed at startup`, check your internet connection — the UI's **Fetch again** button retries.

**Every wire-log entry is also printed in this terminal, already redacted.** That makes the terminal a useful backup view if the browser misbehaves.

### 3.4 Stop

`Ctrl+C` in the terminal stops both processes. All sessions, tokens and the wire log are in memory and disappear.

---

## 4. Smoke test before any audience

Run through this once on the machine and network you will present from, ideally shortly before. It takes about three minutes.

- [ ] `npm test` → `tests 11`, `pass 11`, `fail 0`
- [ ] `npm run dev` → the terminal shows `SMART discovery … → 200`
- [ ] http://localhost:5173 loads; the yellow **DEMO / SYNTHETIC DATA** banner is at the top; status reads **Not connected**
- [ ] The **SMART discovery** panel shows an `authorization_endpoint`, a `token_endpoint` and `S256`
- [ ] Click **Connect** → the sandbox login page appears
- [ ] Pick a patient, log in, click **Approve** → back at the app; status reads **Connected**
- [ ] Click **Load patient and labs** → a patient banner and a lab table appear
- [ ] The stepper shows all nine steps with ✓
- [ ] Click **Force token expiry** → the result reads `FHIR request → HTTP 401 → Refresh token → new access token → FHIR retry → HTTP 200`
- [ ] Click **Log out**, then **Clear log** → you are back to a clean start

If all boxes tick, the demo will work in the room — provided the room has the same network access.

---

## 5. How the pieces connect

```
  Your browser ──► http://localhost:5173  (Vite dev server: serves the React UI)
                          │
                          │  proxies /api, /auth, /demo, /launch
                          ▼
                   http://localhost:3001  (Node/Express: THE OAuth client)
                          │
                          │  discovery, token requests, FHIR calls
                          ▼
                   https://launch.smarthealthit.org  (authorization server + FHIR server)
```

Three facts that explain most problems:

1. **The browser only ever talks to `localhost:5173`** — except during login, when it goes to the sandbox and is then sent back to **`http://localhost:3001/callback`** directly. That is the registered redirect URI.
2. **The session cookie is scoped to the host name `localhost`, not to the port.** So the cookie set via `:5173` is also sent to `:3001/callback`. This is why you must use `localhost` everywhere: open the UI on `127.0.0.1` and the callback on `localhost` won't see your session, and you'll get `NO PENDING AUTHORIZATION`.
3. **Everything is in memory.** Restarting the server mid-login loses the stored `state` and verifier, so the login that was in progress will fail. Just click **Connect** again.

---

## 6. Commands and configuration

### 6.1 Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the Node OAuth client (:3001, auto-restarts on file changes) and the Vite UI (:5173) together |
| `npm run dev:server` | Only the Node server |
| `npm run dev:client` | Only the Vite UI |
| `npm test` | The 11 unit tests: PKCE, state, scope comparison |
| `npm run build` | Type-check server and client, build the UI into `dist/` |
| `npm start` | Run the built app from `dist/` on one port (see [§15.1](#151-production-build-on-a-single-port)) |

### 6.2 Environment variables (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `FHIR_BASE_URL` | the sandbox `…/v/r4/sim/<segment>/fhir` URL | The FHIR server. Discovery runs against it. See [§14](#14-troubleshooting) about the `sim` segment |
| `CLIENT_ID` | `oauth-demo-app` | Public identifier for the app |
| `CLIENT_SECRET` | empty | Leave empty for the sandbox (public client). Only for a confidential registration |
| `REDIRECT_URI` | `http://localhost:3001/callback` | Must be exactly what is registered |
| `SCOPES` | `openid fhirUser launch/patient patient/Patient.read patient/Observation.read offline_access` | Space-separated |
| `PORT` | `3001` | The Node server port |
| `SESSION_SECRET` | `replace-me` | Signs the session cookie. Fine locally; never in production |
| `CLIENT_URL` | `http://localhost:5173` | Where the server sends the browser after `/callback` |

**If you change `PORT` or `REDIRECT_URI`**, the sandbox will reject the login, because the redirect URI is baked into the `sim` segment of `FHIR_BASE_URL`. Regenerate it:

```bash
node -e 'console.log(Buffer.from(JSON.stringify([3,"","","NONE",0,0,0,"","http://localhost:3001/callback","oauth-demo-app","","","","",0,2,""])).toString("base64url"))'
```

Replace `http://localhost:3001/callback` with your new redirect URI, and put the output between `/sim/` and `/fhir` in `FHIR_BASE_URL`. Restart `npm run dev` after any `.env` change.

---

## 7. Preparing the room

### 7.1 The day before

- [ ] Run the [smoke test](#4-smoke-test-before-any-audience) on the presenting laptop.
- [ ] Confirm the venue network reaches `launch.smarthealthit.org`. Corporate networks sometimes block it. **Have a phone hotspot as a fallback** — there is no offline mode.
- [ ] Read [OAUTH-GUIDE.md §12](OAUTH-GUIDE.md#12-questions-an-audience-will-ask) for the questions people usually ask.
- [ ] Decide which demos you will run. The core script uses three; all six take about 16 minutes.

### 7.2 Ten minutes before

- [ ] Close other browser tabs; turn on Do Not Disturb.
- [ ] `npm run dev` in a terminal you can reach but that is **not** on the projector.
- [ ] Open http://localhost:5173 in a fresh window. Make it full screen (Chrome on macOS: `Ctrl+Cmd+F`).
- [ ] If you were logged in during the smoke test, click **Log out**.
- [ ] Click **Clear log** in the wire log pane.

### 7.3 Projector fit

- The layout is three columns at widths of **1100 px and above**, and stacks into one column below that. On a low-resolution projector, if the panes stack, zoom the browser out (`Cmd −` / `Ctrl −`) until the three columns return.
- The base font is 18 px, designed to be read from the back of a room. `Cmd +` enlarges everything if the room is large.
- Check the room from the back once. **The layout has only been checked in headless Chrome at 1920×1080**, not on a real projector.

---

## 8. A tour of the screen

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  DEMO / SYNTHETIC DATA  (yellow banner)                                        │
├───────────────────────────────────────────────────────────────────────────────┤
│  SMART on FHIR: the OAuth 2.0 authorization code flow   ● Not connected  [Log out]
├──────────────┬──────────────────────────────┬─────────────────────────────────┤
│ OAuth flow   │ Application                  │ Wire log                        │
│              │                              │                                 │
│ 1 Connect    │ Connect / Authorization      │ Browser │ Node │ Auth │ FHIR    │
│ 2 Redirect   │ Patient + ID token           │    ┊────────────►┊              │
│ 3 Login      │ Requested vs granted scope   │         │─────────►│            │
│ 4 Consent    │ Lab results                  │         │──────────────────►│   │
│ 5 Callback   │ SMART discovery              │                                 │
│ ┌BACK CHANNEL│                              │ [Expand all] [Collapse all]     │
│ │6 Token exch│ BREAK SOMETHING              │ [Clear log]                     │
│ │7 Token recv│  six demo buttons + result   │                                 │
│ └────────────│                              │                                 │
│ 8 FHIR call  │                              │                                 │
│ 9 Rendered   │                              │                                 │
└──────────────┴──────────────────────────────┴─────────────────────────────────┘
```

| Pane | What to point at |
|---|---|
| **Banner** | The synthetic-data warning. Mention it once at the start |
| **Status** (top right) | `Not connected` → `Waiting for the authorization server` → `Connected`. Red `Node server unreachable` means `npm run dev` stopped |
| **OAuth flow** (left) | The nine steps. ✓ done, ✕ failed, a number means not reached. Steps 6–7 are grouped as **BACK CHANNEL**. **Updated from server events, not button clicks** — say this, it's what makes the stepper trustworthy |
| **Application** (centre) | Before connecting: the Connect card and SMART discovery. After: authorization facts, patient, ID token, scope comparison, labs. Always at the bottom: **BREAK SOMETHING** |
| **Wire log** (right) | A live sequence diagram. Four lanes: **Browser, Node client, Authorization server, FHIR server**. **Dashed arrows** = browser redirects (front channel). **Solid arrows** = direct HTTP (back channel). Red = error. Click an entry to expand parameters, response and notes. Hatched values are redacted |

---

## 9. The presentation script

A ten-minute core, then optional extensions. Timings are a guide. **Click** is what you do; **Show** is what appears; **Say** is the point to make.

### 0:00 — The setup

**Show:** the whole screen, clean, not connected.

**Say:**
- "This is a teaching demo against a public sandbox with synthetic patients." *(point at the banner)*
- "Four actors, four columns in the wire log: the browser, our Node server, the authorization server, and the FHIR server with the data."
- "The key design decision: **the Node server is the OAuth client, not the browser.** The browser will never hold a token. I'll prove that later."
- "Dashed arrows go through the browser — anyone can see those. Solid arrows are server-to-server."

### 1:00 — Discovery

**Show:** the **SMART discovery** panel and the first wire-log entry, *SMART discovery*. Expand it.

**Say:**
- "Before anything else, the server fetched `.well-known/smart-configuration` from the FHIR server."
- "That's where it learned the **authorization endpoint** and **token endpoint**. Neither is hardcoded — point this at a different FHIR server and it adapts."
- "`code_challenge_methods_supported` includes **S256**, so PKCE is supported."
- *(optional)* "Notice `scopes_supported` doesn't list `patient/Patient.read`, yet we'll ask for it and get it. That list isn't guaranteed to be complete."

### 2:00 — Connect, log in, consent

**Click:** **Connect**.

**Say (as the browser leaves):** "Our server has just done three things: generated a random `state`, generated a PKCE `code_verifier` and hashed it, and stored both **in its own session**. Then it redirected the browser to the authorization endpoint it discovered."

**Click:** on the sandbox login page, choose a patient with labs — **Abdul Koepp** worked well in testing — enter any password, log in, then click **Approve** on the consent page.

**Say:** "This login and consent happen at the authorization server — stepper steps 3 and 4. Our app never sees the password. That's the whole point of OAuth."

### 3:00 — The authorization request

**Show:** back in the app, status **Connected**. In the wire log, the *Authorization request* entry — a **dashed** arrow from Browser to Authorization server. Expand it.

**Say:**
- "This is what our server sent the browser off with. It all travelled in the address bar, so **nothing here is secret**."
- "`state` — random, and we'll check it comes back unchanged. That's CSRF protection."
- "`code_challenge` — a SHA-256 hash. The actual secret, the verifier, never left our server."
- "`aud` — which FHIR server this token is for."
- "`scope` — what we're asking for. Only what the app needs."

### 4:00 — The callback

**Show:** the next entries: *Redirect back with authorization code* (dashed, back to Node), then *State validation* → **STATE MATCHES**.

**Say:**
- "The code came back through the browser, so the log shows only its first 8 characters."
- "**Before** doing anything with that code, the server checked `state`. Matches. If it hadn't, it would stop right here — I'll show you that in a minute."

### 5:00 — The back-channel token exchange

**Show:** *Token exchange*, a **solid** arrow from Node to the Authorization server. Expand it. Then *Token received*.

**Say:**
- "Now it's server to server. The browser never sees this request or its response."
- "We send the code **and the code_verifier**. The authorization server hashes the verifier and checks it against the challenge from earlier. That's PKCE."
- "Look at the response: `access_token`, `refresh_token`, `id_token` — all `REDACTED`, with just their length. There's no button to reveal them. Not even for a demo."
- "*Token received* says it plainly: tokens live in the server-side session. The browser has a cookie and nothing else."
- Point at the stepper: "Steps 6 and 7, the back channel, are done."

### 6:00 — Scopes and the ID token

**Show:** the **Authorization** facts (expiry countdown, refresh token available, patient context), then **Requested vs granted scope**, then the **ID token** box.

**Say:**
- "Requested and granted are two different things — the server can give you less. Here they match, and if anything had been dropped it would be struck through as **NOT GRANTED**."
- "The ID token is OpenID Connect: who signed in. `fhirUser` is shown large."
- "Two markers: **payload decoded**, **signature not verified**. Decoding a JWT proves nothing — anyone can make one. A real app must verify the signature. This demo doesn't, and it makes no decisions from those claims."

### 7:00 — Fetch the data

**Click:** **Load patient and labs**.

**Show:** the patient banner and lab table. Wire log: *Request patient* from the browser, then *FHIR API call: Patient* (solid, Node → FHIR) with `Authorization: [REDACTED]`, then the same for labs. Stepper steps 8 and 9 turn ✓.

**Say:**
- "The browser asked our server for 'the patient'. It sent no token and **no patient ID**."
- "The server knows which patient from the **token response** — the authorization server told it. The browser can't choose a different patient."
- "Any value the app can't read cleanly shows as **Missing**. It never guesses a clinical value."

### 8:00 — Break it: tamper with state

**Click:** **Tamper with state** (in **BREAK SOMETHING**), log in and approve again on the sandbox.

**Show:** the demo result, *STATE MISMATCH. Token exchange skipped*. In the wire log: the authorization request, *DEMO: stored state replaced* (the value sent vs the value now stored), the callback, *State validation* in red — and **no Token exchange entry after it**.

**Say:**
- "The server swapped the state it had stored. The browser came back with the original."
- "Mismatch — so the server **refused to use the code at all**. Look, there's no token request in the log."
- "This is what stops an attacker injecting their own authorization code into your session."

### 9:00 — Break it: replay the code

**Click:** **Replay authorization code**, log in and approve.

**Show:** *Token exchange* (200), then *Replay: same authorization code again* — also **200**. The demo result says the sandbox **accepted** it.

**Say:** *(be candid — this is the interesting part)*
- "The spec says an authorization code must work **once**. A real server answers `invalid_grant` the second time."
- "**This sandbox accepted it.** Its codes are stateless JWTs and it doesn't remember using them. We're showing you the real response, not a faked error."
- "Our app's own defence still holds: we deleted our state and verifier after the first exchange, so replaying the callback URL against *us* is rejected before any request is made."

### 10:00 — Break it: force token expiry

**Click:** **Force token expiry**. No login needed.

**Show:** the result: `FHIR request → HTTP 401 → Refresh token → new access token → FHIR retry → HTTP 200`. In the wire log: a red FHIR call (401), *Token refresh* (200), and the FHIR retry (200).

**Say:**
- "The server replaced its stored access token with garbage, so the FHIR server really rejects it: 401."
- "The one FHIR wrapper tries **one** refresh, then retries **once**. The user never logged in again."
- "No loops. If the refresh had failed, the tokens would be cleared and the user asked to reconnect."

### Wrap-up (30 seconds)

**Say:** "Discovery, not hardcoding. State first. PKCE so a stolen code is useless. Tokens on the server only. Request only what you need. And a clear, bounded lifecycle. That's SMART on FHIR."

### Extensions (about 6 minutes)

Run in any order — see [§10](#10-running-each-failure-demo) for details:

1. **Remove PKCE verifier** — the most direct PKCE proof.
2. **Mismatched redirect URI** — the trailing-slash lesson.
3. **Request `patient/*.read`** — least privilege, narrow vs broad side by side.
4. **Prove there are no tokens in the browser** — [§11.1](#111-prove-the-browser-holds-no-tokens).
5. **Log out** — tokens discarded but not revoked, and why that matters.

---

## 10. Running each failure demo

### How demos behave

- **Five demos run a real login.** Clicking them sends the browser to the sandbox again; you **log in and approve each time** (about 20 seconds). Only **Force token expiry** runs instantly.
- **Force token expiry is disabled until you are connected.** Its hint reads *Connect first: this needs stored tokens.*
- **A demo doesn't break your existing session.** If you were connected, you stay connected. The stepper shows where the demo's flow stopped.
- **Each result has four parts:** *What we changed → Actual request and response → Why it failed* (or *What happened*) → *OAuth concept illustrated*. The middle part lists the actual wire-log entries for that run.
- **Nothing is simulated.** The explanation is chosen from what the sandbox actually returned. If a run ends somewhere unexpected, the panel reports the facts without interpreting them.
- While the browser is away, the panel says it is waiting. If a stricter server shows an error page instead of redirecting back, **use the browser's Back button**.

### The six demos: what to expect on this sandbox

| Button | Needs login? | Expected result on `launch.smarthealthit.org` | Wire-log entries to point at |
|---|---|---|---|
| **Mismatched redirect URI** | yes | `/authorize` **accepts** `…/callback/`; `/token` rejects: `HTTP 401 invalid_request "Invalid redirect_uri parameter"` | *Authorization request* (see `redirect_uri` with trailing `/`), red *Token exchange* |
| **Tamper with state** | yes | `STATE MISMATCH. Token exchange skipped` | *DEMO: stored state replaced* (old vs new), red *State validation*, **no** token exchange |
| **Replay authorization code** | yes | First exchange 200; **replay also 200** (sandbox limitation); replay tokens discarded | *Token exchange*, *Replay: same authorization code again*, *DEMO: replayed tokens discarded* |
| **Remove PKCE verifier** | yes | `HTTP 400 invalid_request "Missing code_verifier parameter"` | *DEMO: code_verifier removed*, red *Token exchange* — expand it and show there is no `code_verifier` |
| **Request patient/\*.read** | yes | Granted **exactly as requested**; tokens discarded; narrow and broad grants shown side by side | *Authorization request* (see `scope`), *DEMO: broad-scope tokens discarded* |
| **Force token expiry** | no (must be connected) | `401 → refresh → retry 200` | *DEMO: access token invalidated*, red FHIR call, *Token refresh*, FHIR retry |

### Talking points per demo

**Mismatched redirect URI**
- "One trailing slash. That's all we changed."
- "Authorization servers must compare redirect URIs **exactly**. This sandbox is lenient at the first step — it matched by prefix — but its token endpoint caught it, because the URI must be identical in both requests."
- "A strict server like a production EHR would reject it immediately and show an error page."
- Tip: run a normal **Connect** first, so this doesn't look like the app is broken.

**Remove PKCE verifier**
- "Correct code, correct client ID, correct redirect URI. Only the verifier is missing — and it's refused."
- "The authorization request only ever carried the **hash**. Someone who steals the code from a URL doesn't have the verifier, so the code is useless to them."
- Honest caveat if asked: PKCE doesn't help if the attacker can read the verifier (e.g. has compromised the server), and doesn't stop a malicious app running its own flow.

**Request patient/\*.read**
- For the best comparison, **run a normal Connect first**, so a *narrow* grant is recorded to compare against.
- "We asked for every resource type for this patient. The sandbox just granted it — its consent screen has no per-scope choices."
- "In a real EHR the grant is limited by the app's registration and the user's role. Either way: this app needs Patient and Observation, so asking for everything violates least privilege. We threw those tokens away."

---

## 11. Optional extras that land well

### 11.1 Prove the browser holds no tokens

While connected, open DevTools (`Cmd+Option+I` / `F12`):

1. **Application → Cookies → `http://localhost:5173`**: one cookie, `smart_demo_sid`, with **HttpOnly ✓** and **SameSite Lax**. Its value is a signed session ID, not a token.
2. **Console**:
   ```js
   document.cookie        // ""  — HttpOnly hides it from JavaScript
   localStorage.length    // 0
   sessionStorage.length  // 0
   ```
3. **Network**: click `session` (the request the UI makes every 2 seconds) → **Response**. Show `hasRefreshToken: true`, `secondsRemaining`, `patientId` — flags and metadata, **no token values**.

**Say:** "If an attacker got JavaScript running on this page, there's nothing here to steal."

*(Verified in a real Chrome run: empty `document.cookie`, empty storage, no JWT-shaped strings anywhere in the page.)*

### 11.2 Try to request a different patient

While connected, open a new tab to:

```
http://localhost:5173/api/patient?patient=123
```

**Show:** the response is still the **authorized** patient. The wire log's *Request patient* entry says: *Ignored browser-supplied ?patient=123. The patient comes from the token context.*

**Say:** "The client can't pick the patient. Authorization context comes from the token, never from the request. This is how you avoid a whole class of 'change the ID in the URL' bugs."

### 11.3 Log out

**Click:** **Log out** (top right).

**Show:** the *Logout* wire-log entry: *Tokens are discarded, not revoked: this demo does not call a revocation endpoint.*

**Say:** "The session is gone, but those tokens are technically still valid at the authorization server until they expire. A production app should revoke them."

### 11.4 Show the redaction in the terminal

Point at (or briefly share) the terminal running `npm run dev`. Every wire-log entry is printed there, and the tokens are `[REDACTED — n chars]` in the server log too. **One redaction helper** handles the server console, the API and the React UI.

---

## 12. Resetting between runs

| Goal | Do this |
|---|---|
| Clean screen, same server | **Log out**, then **Clear log** |
| Start completely fresh (sessions, log, discovery cache) | `Ctrl+C` then `npm run dev`, then reload the browser |
| Re-fetch discovery only | **Fetch again** in the SMART discovery panel |
| Clear a leftover error box | **Log out**, then **Connect** — a new flow or a successful login clears the last error |

The wire log is shared by every browser tab on the machine. If you rehearsed in another tab, **Clear log** before you start.

---

## 13. When something goes wrong live

**Say what's happening — the app is built to make failures explainable.** Almost every failure produces an error box in the centre pane with the step, the HTTP status, the provider's `error` and `error_description`, and the concept involved. Read it out.

| Symptom | Likely cause | Recover |
|---|---|---|
| Red **Node server unreachable** | `npm run dev` crashed or was stopped | Restart it; reload the page; reconnect |
| **NO PENDING AUTHORIZATION** right after logging in | Server restarted mid-login, or the page is on `127.0.0.1` | Use `http://localhost:5173`; click **Connect** again |
| **STATE EXPIRED** | More than 10 minutes on the sandbox login page | Click **Connect** again. *(A nice unplanned demo of state expiry!)* |
| Sandbox page won't load / discovery fails | Network | Switch to the hotspot; **Fetch again** |
| Demo panel stuck on *waiting* | You haven't finished login/approve, or the sandbox showed an error page | Finish the login, or use **Back** |
| *Re-authentication required* | The refresh failed | Click **Connect**. Explain: one refresh, one retry, then stop — this is the designed behaviour |

If the network is completely gone, the terminal output and the concepts in [OAUTH-GUIDE.md](OAUTH-GUIDE.md) are your fallback. There is no offline mode and no recorded replay.

---

## 14. Troubleshooting

**`Missing environment variable FHIR_BASE_URL. Run "cp .env.example .env"`**
There is no `.env`. Run `cp .env.example .env`.

**`Port 5173 is in use` / `EADDRINUSE :3001`**
Another process holds the port — often an earlier `npm run dev`. Find and stop it:
```bash
lsof -i :3001 -i :5173
kill <PID>
```
Don't just change the port: the redirect URI and the sandbox `sim` segment both contain `3001` (see [§6.2](#62-environment-variables-env)).

**The sandbox says `Invalid launch options: SyntaxError: Unexpected end of JSON input`**
`FHIR_BASE_URL` is the plain `https://launch.smarthealthit.org/v/r4/fhir`. The sandbox needs its settings encoded in the URL for a standalone login. Use the `sim` URL from `.env.example`. *(The plain URL is fine as the `iss` of an EHR launch.)*

**The sandbox says `Invalid redirect_uri`**
`REDIRECT_URI` doesn't match what's encoded in the `sim` segment. Regenerate the segment ([§6.2](#62-environment-variables-env)).

**Login works but the patient panel says there's no patient context**
The token response had no `patient`. Make sure `launch/patient` is still in `SCOPES`. The app deliberately refuses to guess a patient.

**The lab table is empty**
The patient you picked may have no laboratory observations. Log in again and pick another (Abdul Koepp returned 34 lab rows in testing).

**Force token expiry is greyed out**
You're not connected. Click **Connect** first.

**The three panes are stacked into one column**
The window is narrower than 1100 px. Zoom out or widen the window.

**Fonts look plain**
The fonts load from Google Fonts. Offline or blocked, the app falls back to system fonts; everything still works.

**Refresh token shows "Not issued"**
`offline_access` was removed from `SCOPES`, or the server didn't grant it. **Force token expiry** will then end in *Re-authentication required* — which is correct behaviour.

---

## 15. Other ways to run it

### 15.1 Production build on a single port

```bash
npm run build
CLIENT_URL=http://localhost:3001 npm start
```

Open **http://localhost:3001**. Express serves the built React app and the OAuth routes from the same port, with no Vite. Keep `PORT=3001` so the redirect URI still matches.

*Verification status:* the build and the served app were checked (the page, `/api/session` and the `/auth/login` redirect all responded correctly). A full sandbox login through the production build was not run — use `npm run dev` for presentations.

### 15.2 EHR launch

In a real EHR, the EHR opens the app instead of the user clicking Connect:

```
http://localhost:3001/launch?iss=https://launch.smarthealthit.org/v/r4/fhir&launch=<opaque value>
```

The app then runs discovery against `iss`, adds the `launch` scope, sends `aud=iss` and continues through the same flow.

To try it from the SMART launcher website (https://launch.smarthealthit.org): choose a **provider EHR launch**, pick a patient and practitioner, and set the app's launch URL to `http://localhost:3001/launch`.

*Verification status:* the `/launch` route was verified end to end against the sandbox with a `launch` value in the launcher's own format (discovery against `iss`, `aud=iss`, `launch` scope added, `fhirUser` a Practitioner). Launching it by clicking through the launcher website was not tested.

### 15.3 Epic sandbox

The same code runs against Epic using only environment variables — see [README.md → Epic profile](README.md#epic-profile-environment-variables-only). You need your own registered non-production client ID from https://fhir.epic.com.

**Not verified:** this profile has never been run, because it needs a registered Epic client. Expect some demos to behave differently (a strict server rejects the mismatched redirect at `/authorize`, and a replayed code with `invalid_grant`). The demo panels will show whatever Epic actually returns.
</content>
