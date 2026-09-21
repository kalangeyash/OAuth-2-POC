# Running and demonstrating the SMART on FHIR OAuth demo

> **DEMO / SYNTHETIC DATA.** The sandbox contains synthetic patients only. Never type real patient information into it.

This is the operator's manual: how to install and run the project, how to check it works before an audience sees it, and a click-by-click script for presenting it with the **OAuth Protocol Lab**: stepping through the flow one real message at a time, and all ten failure scenarios, with what each one really does on this sandbox and what to say.

For the concepts behind every step, see [OAUTH-GUIDE.md](OAUTH-GUIDE.md).

**Contents**

1. [Quick start](#1-quick-start)
2. [Prerequisites](#2-prerequisites)
3. [Install and start](#3-install-and-start)
4. [Smoke test before any audience](#4-smoke-test-before-any-audience)
5. [How the pieces connect](#5-how-the-pieces-connect)
6. [Commands and configuration](#6-commands-and-configuration)
7. [Preparing the room](#7-preparing-the-room)
8. [A tour of the Protocol Lab](#8-a-tour-of-the-protocol-lab)
9. [The presentation script](#9-the-presentation-script)
10. [The failure lab: ten scenarios](#10-the-failure-lab-ten-scenarios)
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

Open **http://localhost:5173** — `localhost`, not `127.0.0.1`. Press **▶ Run scenario** (scenario 1), pick a patient on the sandbox login page that opens in a popup (e.g. *Abdul Koepp*), click **Approve**, then open the **App** tab and click **Load patient and labs**.

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

`Ctrl+C` in the terminal stops both processes. All sessions, tokens and the event log are in memory and disappear.

---

## 4. Smoke test before any audience

Run through this once on the machine and network you will present from, ideally shortly before. It takes about three minutes.

- [ ] `npm test` → `tests 67`, `pass 67`, `fail 0`
- [ ] `npm run dev` → the terminal shows `SMART discovery … → 200`
- [ ] http://localhost:5173 loads; the amber **DEMO / SYNTHETIC DATA** banner is at the top; status reads **Not connected**; the toolbar shows **● Live** (the event stream is connected)
- [ ] Click the **Dark** / **Light** toggle once and check the room can read both; leave it on the one you want
- [ ] **App** tab: the **SMART discovery** panel shows an `authorization_endpoint`, a `token_endpoint` and `S256`
- [ ] **▶ Run scenario** (scenario 1) → a popup opens on the sandbox login page, and the canvas shows the redirect *while* it happens. (If your browser blocks popups, allow them for localhost, or untick *View options → Login in a popup window*.)
- [ ] Pick a patient, log in, click **Approve** → the popup closes by itself; status reads **Connected**; the state machine reaches `PATIENT_CONTEXT_RESOLVED`
- [ ] **App** tab → **Load patient and labs** → a patient banner and a lab table appear; the state machine reaches `DATA_RENDERED`
- [ ] **Step through every stage**, then **▶ Run scenario** → the canvas shows an amber *NOT SENT* arrow and the inspector says **BEFORE SEND**; **→** sends one stage at a time; **Run to the end** finishes
- [ ] **Tokens** tab → **Force token expiry** → the chain lights *expires → 401 → refresh → new token → retried*
- [ ] **Reset all** → you are back to a clean start

If all boxes tick, the demo will work in the room — provided the room has the same network access.

---

## 5. How the pieces connect

```
  Your browser ──► http://localhost:5173  (Vite dev server: serves the React UI)
                          │
                          │  proxies /api, /auth, /demo, /lab, /launch
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
| `npm test` | The 15 unit tests: PKCE, state, scope comparison, wire-log redaction and timing |
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
- [ ] Decide which scenarios you will run. The core script uses the debugger plus three failures; all ten scenarios take about 20 minutes.
- [ ] Allow popups for `localhost` in the presenting browser (the login opens in a popup so the lab stays on screen).

### 7.2 Ten minutes before

- [ ] Close other browser tabs; turn on Do Not Disturb.
- [ ] `npm run dev` in a terminal you can reach but that is **not** on the projector.
- [ ] Open http://localhost:5173 in a fresh window. Make it full screen (Chrome on macOS: `Ctrl+Cmd+F`).
- [ ] Press **Reset all** (logs out, releases any pause, clears the log), check the execution mode reads **Run automatically**, and clear any Traffic filters.
- [ ] Leave **Essentials** on; switch to **Everything** only when you want to show the routine internal steps.
- [ ] Set light or dark for the room. The choice is remembered, so do it once.

### 7.3 Projector fit

- The lab fits on one screen at about **1440×900 and above**: canvas and dock on the left, inspector on the right. On shorter or narrower screens (below 760 px tall or 1100 px wide) it becomes one scrolling column instead of squeezing. On a low-resolution projector, zoom out (`Cmd −` / `Ctrl −`), hide the inspector (**I**), or give the dock more room with **▲ Taller**.
- The base font is 19 px, designed to be read from the back of a room. `Cmd +` enlarges everything if the room is large.
- **Pick the theme for the room before you start.** The toggle is in the header, next to the connection status. Dark reads better on a bright projector in a dark room; light is safer on a washed-out screen. The choice is remembered.
- Check the room from the back once. **The layout has only been checked in headless Chrome** (1440×900, 1280×720 and 1280×1100), not on a real projector.

---

## 8. A tour of the Protocol Lab

The screen is organised around the protocol, not around the patient data. Everything on it is drawn from **real events** the Node server records and streams to the page (Server-Sent Events on `/api/events`); nothing is a pre-recorded animation.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ DEMO / SYNTHETIC DATA (amber banner)                                            │
│ SMART on FHIR · OAuth 2.0 Protocol Lab           ● Not connected  [Light]       │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [1. Successful … ▾] [▶ Run scenario]  [Run automatically|Step every stage|Pause │
│ at every message]  [⏸ Pause] [⏭ Next step] [■ Stop]  [⟲ Reset] [Reset all] ●Live│
│ ┄ FRONT  ─ BACK  ┈ LOCAL  ┄ HELD (amber)        [Essentials|Everything] [View ▾]│
├─────────────────────────────────────────────────────────────────────────────────┤
│ RIGHT NOW · Step 13 of 21 · Exchange authorization code for tokens              │
│ Token exchange — one plain sentence about what is happening                     │
│ ✓ 8 states complete → STATE_VALIDATED → CODE_EXCHANGED → …   (state machine)    │
├──────────────────────────────────────────────┬──────────────────────────────────┤
│ LIVE PROTOCOL CANVAS                         │ MESSAGE INSPECTOR                │
│  Browser  React UI  Node BFF  Auth   FHIR    │ #96 Token exchange               │
│     ┊──── GET /callback?code…&state… ──►┊    │ Node BFF → Auth server · BACK    │
│                       ⟲ State validation     │ ▸ What this means                │
│                       ├── POST /auth/token ─►│ ▸ Request (every parameter)      │
│                       │◄── 200 · 312 ms ─────│ ▸ Response (status, body, error) │
├──────────────────────────────────────────────┤ ▸ Why this happens               │
│ Traffic │ Timeline │ Request builder │ PKCE │ │ ▸ Security · preconditions       │
│ State/CSRF │ Browser view │ Tokens │ Patient │ │ ▸ Implementation reference       │
│ context │ Failure lab │ App                  │   (real file + function)         │
└──────────────────────────────────────────────┴──────────────────────────────────┘
```

| Area | What it is, and what to point at |
|---|---|
| **Lab toolbar, row 1** | **Scenario selector + Run scenario** (ten scenarios, §10). **Execution mode**: *Run automatically* (the normal app), *Step through every stage* (the backend pauses before every stage, internal ones included) or *Pause at every message* (it pauses only before real network messages). **Pause / Resume / Next step / Stop** act on the real server. **Reset** releases any pause and clears the log; **Reset all** also logs out. **Live** means the event stream is connected |
| **Lab toolbar, row 2** | The **legend**, always visible: dashed = front channel (through the browser), solid = back channel (server to server), dotted = local application event, amber dashed = a request the debugger is holding and has **not** sent. **Essentials / Everything**: Essentials (default) hides routine steps inside Node such as "generate state" or "store session"; Everything shows every recorded step. **View options** holds the rest: inspector, technical details, security explanations, source-code references, "inspector follows new messages", failure injection, login in a popup, freeze the display |
| **Right now** | One sentence a non-expert can follow, updated by every real event. It says *PAUSED BEFORE SEND* when the debugger holds a request, *REPLAY · recorded 14:03:22 — not live* when you replay a step, and *The user is logging in and consenting* while the browser is at the authorization server. Underneath: the **protocol state machine** (`IDLE → DISCOVERY_COMPLETE → … → DATA_RENDERED`). When a flow fails it names where, and what was therefore never attempted, e.g. `STATE_VALIDATION_FAILED → TOKEN_EXCHANGE_NOT_ATTEMPTED` |
| **Live protocol canvas** | A sequence diagram with five lifelines: **Browser, React UI, Node BFF, Authorization server, FHIR server**. A redirect is two dashed legs (Node ┄302┄► Browser ┄GET┄► Auth server). A back-channel call is a solid request plus a thin response carrying the status and duration. Steps inside Node are small loops. Login and consent appear as a shaded block on the authorization server: *not visible to this app*. Green = succeeded, red = failed, amber = held by the debugger. The left gutter shows the time since the previous message. Only messages that arrive live animate. The canvas follows the newest message unless you scroll up; then a **↓ Jump to latest** button appears. Click any arrow to inspect it |
| **Message inspector** | Everything about the selected message: sender and receiver, channel, the full URL, every parameter, headers, the response status and body (secrets redacted), the provider's `error` and `error_description`, and *what it enables next*. Then *why it exists*, *what would go wrong without it*, the specification, whether the browser can see it, whether it is sensitive, preconditions, possible outcomes, and the **implementation reference**: the real file and function in this repository. Every OAuth value is clickable (*Explain this value*). **← / →** move between messages; **Pin**, **Compare** and **Copy (sanitized)** are here too |
| **Before send** (inspector, when paused) | The request exactly as the server built it but has **not sent**, with a table explaining every parameter, and **Send request ▶**, **Run to the end**, **Stop the flow**. With failure injection on, it offers the controlled changes available at that step, e.g. *Alter code_verifier* |
| **Dock: Traffic** | A DevTools-style network monitor: time, actor, method, URL, channel, status, duration and a security column. It has search, actor, channel and result filters, **pin**, **compare two messages** side by side (differences highlighted) and **Export sanitized trace** (JSON) |
| **Dock: Timeline** | The 21 protocol steps grouped by phase. ✓ done, ✕ failed, ● in progress, ◌ *inferred* (login and consent, which this app cannot see), ⊘ skipped or not reached. Expand a step to read what it does, jump to its events, or **Replay this explanation** |
| **Dock: Request builder** | The authorization URL broken into fields: value, required or optional, what it is, security impact, what happens if it changes. Tick whitelisted changes (remove state, change redirect_uri, remove code_challenge, `plain` method, broader scope, change aud, invalid scope) and press **Generate authorization request** to send the real, modified request |
| **Dock: PKCE** | The real run shown by length and fingerprint only (verifier → SHA-256 → base64url → challenge → sent → verifier sent → Node's own check → the authorization server's verdict). Below it is a clearly labelled **illustrative** workbench that computes SHA-256 in your browser on a *synthetic* verifier, including the RFC 7636 Appendix B example |
| **Dock: State / CSRF** | Generated, stored and returned state side by side (preview and fingerprint), a big **MATCH / MISMATCH**, whether a token exchange was attempted, and the attack narrative drawn from this run's events |
| **Dock: Browser view** | *What can the browser see?* Two lists (visible to the browser / never exposed to page JavaScript), plus a DevTools-style view filled from **real** values: the session cookie's real attributes (value hidden), `document.cookie` as page JavaScript sees it (empty), and the real `localStorage` and `sessionStorage` keys. It also runs a live scan for anything token-like |
| **Dock: Tokens** | Token metadata only (never a value), the three tokens compared (purpose, issuer, recipient, lifetime, storage, whether the browser sees it, whether it goes to FHIR, whether it calls APIs, whether it proves identity), the lifecycle chain lit by real events, and **Force token expiry**, **Disable refresh**, **Simulate refresh failure** and **Compare original and refreshed requests**. The decoded ID token is here (signature **not** verified) |
| **Dock: Patient context** | Where the patient ID came from (the token response), each hop from consent to screen, and a button that sends the real request `GET /api/patient?patient=123` so you can show that it is ignored |
| **Dock: Failure lab** | The ten scenarios with their initial conditions, the attack, the concept and the mitigation, and after a run an **eight-part result** built from the real events: what changed, what should have happened, the modified request, the actual request sent, the response, **where the flow stopped**, why it matters, and the concept and mitigation |
| **Dock: App** | The ordinary application: Connect, the patient banner, lab results, requested vs granted scope and SMART discovery |

**Presenter shortcuts** (press **?** for the list): **Space** pause/resume the backend · **→** next step at a breakpoint, otherwise the next message · **←** previous message · **R** run the selected scenario · **F** failure lab · **T** timeline · **I** inspector · **S** security explanations · **D** technical details · **E** Essentials/Everything · **Esc** leave a replay. Shortcuts are ignored while you type, and **Space** still presses a focused button.

**What "real" means here.** Every arrow, status, error and timing comes from an event the Node server recorded as it happened. Three things are *inferred* and labelled so: login and consent (this app cannot see them; they are inferred when a code arrives), and the authorization server's PKCE hash comparison (you see its verdict, the HTTP response, not the comparison itself). The PKCE workbench's values are illustrative and say so. Scenario 10 (SPA vs BFF) is an illustration and is never executed.

---

## 9. The presentation script

About twelve minutes, then optional extensions. Timings are a guide. **Click** is what you do; **Show** is what appears; **Say** is the point to make.

**Before you start:** `npm run dev`, open http://localhost:5173 full screen, press **Reset all**, leave **Essentials** on, and check that **View options → Login in a popup window** is ticked (it is by default). With the popup, the lab stays on screen while you log in, so the audience sees every step live.

### 0:00 — The setup

**Show:** the clean lab. *Right now* reads *Nothing has happened yet*.

**Say:**
- "A teaching lab against a public sandbox with synthetic patients." *(banner)*
- "Five actors, five lifelines: the browser, our React app, our Node server, the authorization server, and the FHIR server with the data."
- "The key design: **our Node server is the OAuth client.** The browser never holds a token. I'll prove it later."
- "Dashed means through the browser, where anyone can see it. Solid means server to server."
- "And this is not an animation. We can stop the backend before every single step."

### 1:00 — Step through the start of the flow

**Click:** execution mode **Step through every stage**, then **▶ Run scenario** (scenario 1 is selected). The popup opens and stays blank: the backend is holding it.

**Show:** the canvas shows an amber ghost arrow, *GET .well-known/smart-configuration — NOT SENT*. The inspector shows **BEFORE SEND** with the exact request.

**Say:** "The backend has built its first request and is waiting for me. Nothing has gone out yet."

**Click:** **Send request ▶** (or press **→**). The real response lands. Point at *authorization_endpoint* and *token_endpoint* in the response: "Discovered, not hardcoded."

**Click → four more times**, pausing on each:
- **Generate OAuth state**: "32 random bytes. It will come back with the code and must match." *(click the word `state` for its explanation)*
- **Generate PKCE verifier**: "The secret. You only ever see its length and a fingerprint, never its value."
- **Generate PKCE challenge**: "Its SHA-256 hash. Only the hash will travel through the browser." *(PKCE tab)*
- **Store state and verifier in session**: "Both stay on the server. The browser gets an httpOnly cookie with a session ID."

**Click → Build authorization URL**, then open the **Request builder** tab: walk the fields (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `aud`, `code_challenge`, `code_challenge_method`). "All public: this whole URL is about to appear in the address bar."

**Click →** on *302 → authorization endpoint*. The popup moves to the sandbox login page.

### 3:00 — Login and consent

**Show:** *Right now*: *The user is logging in and consenting … This app does not receive the password.* On the canvas, the shaded **Login + consent** block on the authorization server.

**Click (in the popup):** choose a patient with labs (**Abdul Koepp** worked well in testing), any password, log in, **Approve**.

**Say:** "This happens at the authorization server. Our app will only know it happened when a code comes back."

### 4:00 — The callback and state

**Show:** the dashed callback arrow (`/callback?code=…&state=…`), then the backend pauses: *Paused before: Compare the returned state with the stored state*. Open **State / CSRF**.

**Click →.** The verdict reads **MATCH**: the same fingerprint for stored and returned.

**Say:** "Checked *before* the code is used. If it didn't match, the flow would stop right here, and I'll show you that."

### 5:00 — The back-channel token exchange

**Show:** **BEFORE SEND**: `POST /auth/token`, with a table explaining `grant_type`, `code` (first 8 characters), `redirect_uri`, `client_id`, `code_verifier` (`[REDACTED — 64 chars]`).

**Say:** "Server to server. The code *and* the verifier. The authorization server hashes the verifier and compares it with the challenge it saw earlier."

**Click:** **Run to the end** (the debugger switches back to *Run automatically* and finishes).

**Show:** the response: `access_token`, `refresh_token`, `id_token` all `[REDACTED — n chars]`. The state machine reaches `TOKENS_STORED → PATIENT_CONTEXT_RESOLVED`. The popup closes itself.

**Click:** **Tokens** tab, then **Browser view** tab.

**Say:** "Metadata only: there's no button to reveal a token, because the page never received one. And here's this browser's real storage: one cookie JavaScript can't read, and one localStorage key, the theme."

### 7:00 — Use the token

**Click:** **App** tab → **Load patient and labs**.

**Show:** `GET /api/patient` from the React UI to Node (cookie only), then `GET /fhir/Patient/…` from Node to the FHIR server with `Authorization: [REDACTED]`, then the Observations call.

**Click:** **Patient context** tab → **Send GET /api/patient?patient=123**.

**Say:** "The browser asked for patient 123. Look at the FHIR request: it still went to the authorized patient. The patient comes from the token, never from the browser."

### 8:00 — Break it: state

**Click:** **Failure lab** (**F**) → **2. Invalid state** → **Run this scenario**. Log in and approve in the popup.

**Show:** the eight-part result: *STATE MISMATCH*, **where the flow stopped: step 12, Validate state**, **no** token request on the canvas, and the state machine ending `STATE_VALIDATION_FAILED → TOKEN_EXCHANGE_NOT_ATTEMPTED`.

**Say:** "This is what stops an attacker pushing their own code into your session."

### 9:00 — Break it: PKCE, live, at a breakpoint

**Click:** **PKCE** tab → **Step through and alter the verifier at the token breakpoint**. This turns on failure injection and *Pause at every message*, then starts a flow. Send each held message; log in and approve. At *POST token endpoint*, click **Alter code_verifier**.

**Show:** *INJECTED: Alter code_verifier* (the fingerprint changes), Node's own check (*SHA-256(verifier) does NOT equal the challenge*), and the token endpoint's **real** rejection in the PKCE tab.

**Say:** "Same code, one character of the verifier changed. The code can't be redeemed. That's what makes a stolen code worthless."

### 10:00 — Break it: token lifecycle

**Click:** connect normally if you are not connected (scenario 1, *Run automatically*), then **Tokens** → **Force token expiry**.

**Show:** the chain lights up in order: *access token expires → FHIR 401 → refresh token used → new access token → retried*. Click **Compare original and refreshed requests** to show the 401 and the 200 side by side in **Traffic**.

**Then:** **Simulate refresh failure**: the refresh is refused, the tokens are discarded, and the user must reconnect.

### Wrap-up (30 seconds)

**Say:** "Discovery, not hardcoding. State first. PKCE so a stolen code is useless. Tokens on the server only. Request only what you need. A bounded token lifecycle. And every one of those, you just watched happen, and watched fail."

### Extensions

1. **Request builder**: tick *Remove state* or *Change aud* and **Generate**. See where the real server accepts or refuses it.
2. **Replay authorization code** (scenario 5): be candid that this sandbox *accepts* the replay.
3. **Excessive scope** (scenario 6): narrow vs broad grants side by side (run scenario 1 first).
4. **Redirect URI mismatch** (scenario 4): the trailing-slash lesson.
5. **Browser token exposure** (scenario 10): the SPA vs BFF illustration.
6. **Log out**: tokens discarded, not revoked.

---

## 10. The failure lab: ten scenarios

### How scenarios behave

- **Scenarios 2–6 run a real login.** They open the popup (or redirect the page) to the sandbox; **log in and approve each time** (about 20 seconds). Scenarios 7–9 run instantly but **need a connection** (the button says so).
- **Nothing is simulated.** Each scenario makes exactly one deliberate change and runs the same code as the normal flow. The result is read from the real responses. If a run ends somewhere unexpected, the lab reports the facts without interpreting them.
- **Every result has eight parts:** what was changed, original expected behaviour, the modified request, the actual request sent, the server response, where the flow stopped, why it matters, and the security concept and mitigation.
- **They combine with the debugger.** Choose *Step through every stage* first to pause before each stage of any scenario.
- **⟲ Reset scenario** (or **Reset** in the toolbar) forgets the last result and clears the log. Your connection stays unless you press **Reset all**.

| # | Scenario | Login? | What changes | Result on `launch.smarthealthit.org` |
|---|---|---|---|---|
| 1 | Successful Authorization Code + PKCE | yes | nothing | tokens stored, patient context resolved |
| 2 | Invalid state | yes | the server replaces its stored state after the browser leaves | `STATE MISMATCH`: stops at step 12; **no** token request |
| 3 | Missing PKCE verifier | yes | token request without `code_verifier` | `HTTP 400 invalid_request "Missing code_verifier parameter"`: stops at step 13 |
| 4 | Redirect URI mismatch | yes | `redirect_uri` with a trailing slash at `/authorize` | `/authorize` accepts it; the token endpoint rejects: `HTTP 401 invalid_request "Invalid redirect_uri parameter"` |
| 5 | Authorization code replay | yes | the same code is sent twice | first 200; **the replay is also 200** (this sandbox's codes are stateless); replay tokens discarded |
| 6 | Excessive scope | yes | `patient/*.read` instead of the two resource scopes | granted exactly as requested; tokens discarded; narrow vs broad compared |
| 7 | Expired access token | no (connected) | the stored access token is made invalid | `401 → refresh → retry 200` |
| 8 | Refresh token failure | no (connected) | the access token is invalidated **and** the refresh token corrupted | the refresh is refused and the tokens discarded: re-authentication required (expected `invalid_grant`; see note) |
| 9 | Browser supplies a patient ID | no (connected) | `GET /api/patient?patient=123` | the request succeeds **for the authorized patient only**: the ID is ignored |
| 10 | Direct browser token exposure | — | illustration only, never executed | SPA-holds-tokens vs this app's BFF, side by side |

*Rows 2–7 match earlier live runs against this sandbox. Row 8's exact error text was not captured in testing; the lab shows whatever the sandbox actually returns.*

### Breakpoint injections (failure injection)

Turn on **View options → Failure injection at breakpoints**, choose *Step through every stage* or *Pause at every message*, and the **Before send** panel offers the changes that make sense at that point. Each goes into the **real** request.

| Where it pauses | Injection | What really happens next |
|---|---|---|
| Before state validation (step mode only; an internal step) | **Tamper with the returned state** | fingerprints differ → `MISMATCH` → the token exchange is never attempted *(verified in testing)* |
| Before the token request | **Remove code_verifier** | token endpoint refuses (PKCE) |
| Before the token request | **Alter code_verifier** | Node's own check shows the hash no longer matches; the token endpoint refuses |
| Before the token request | **Change redirect_uri** | token endpoint refuses the mismatch |
| Before a FHIR request | **Send an invalid access token** | real `401 → refresh → retry` |
| Before a refresh request | **Corrupt the refresh token** / **Disable refresh** | refresh refused / no refresh possible → re-authentication required |

### Talking points

**Invalid state.** "The state that came back doesn't match the one this session stored, so the server refuses to use the code at all. Look: there's no token request on the canvas." Without this check, an attacker can inject their own authorization code into a victim's session (login CSRF).

**Missing PKCE verifier.** "Correct code, correct client ID, correct redirect URI. Only the verifier is missing, and the code is refused." Caveat if asked: PKCE doesn't help if the attacker can read the verifier (for example by compromising this server), and it doesn't stop a malicious app running its own complete flow.

**Redirect URI mismatch.** "One trailing slash. Authorization servers must compare redirect URIs exactly. This sandbox is lenient at `/authorize` (it matched by prefix), but its token endpoint caught it." A strict production server rejects it immediately and shows an error page, which appears in the popup and is the result. Tip: run scenario 1 first, so this doesn't look like the app is broken.

**Code replay.** "The spec says a code works once. This sandbox accepted it twice, and we show you the real response, not a faked error. Our app's own defence still holds: our state and verifier were already consumed."

**Excessive scope.** Run scenario 1 first so a narrow grant is recorded. "We asked for every resource type and the sandbox granted it. A real EHR narrows by registration and role. Either way, this app needs two resource types, so asking for all of them violates least privilege. We threw those tokens away."

**Expired token / refresh failure.** "One refresh, one retry, no loops. If the long-lived credential itself is refused, the only safe recovery is to send the user through authorization again."

---

## 11. Optional extras that land well

### 11.1 Prove the browser holds no tokens

The **Browser view** tab does this live from the page's own JavaScript. To prove it independently, while connected open DevTools (`Cmd+Option+I` / `F12`):

1. **Application → Cookies → `http://localhost:5173`**: one cookie, `smart_demo_sid`, with **HttpOnly ✓** and **SameSite Lax**. Its value is a signed session ID, not a token.
2. **Console**:
   ```js
   document.cookie              // ""  — HttpOnly hides it from JavaScript
   sessionStorage.length        // 0
   Object.entries(localStorage) // [["smart-demo-theme","dark"]]  — the whole of it
   ```
3. **Network**: click `events` (the live event stream) or `session` → **Response**. There are flags and metadata only, and every credential appears as `[REDACTED — n chars]`.

**Say:** "There is exactly one thing in this browser's storage, and here it is: which theme I picked. If an attacker got JavaScript running on this page, that is the entire haul."

### 11.2 Try to request a different patient

Use **Patient context → Send GET /api/patient?patient=123** (or scenario 9). You can also open a new tab at `http://localhost:5173/api/patient?patient=123`. The response is still the **authorized** patient, and the event reads *Ignored browser-supplied ?patient=123*.

### 11.3 Log out

**Click:** **Log out** (top right). The *Logout* event says the tokens are **discarded, not revoked**. "They're still valid at the authorization server until they expire. A production app should revoke them."

### 11.4 Show the redaction in the terminal

Every event is also printed in the terminal running `npm run dev`, and the tokens are `[REDACTED — n chars]` there too. **One redaction helper** covers the server console, the event stream, the API and the React UI.

---

## 12. Resetting between runs

| Goal | Do this |
|---|---|
| Clean screen, keep the connection | **⟲ Reset** (releases any pause, forgets the last result, clears the log) |
| Clean screen and log out | **Reset all** |
| Start completely fresh (sessions, log, discovery cache) | `Ctrl+C` then `npm run dev`, then reload the browser |
| Re-fetch discovery only | **Fetch again** in the SMART discovery panel |
| Clear a leftover error box | **⟲ Reset**, or run scenario 1: a new flow or a successful login clears the last error |

The event log and the debugger are shared by every browser tab on the machine (single presenter). If you rehearsed in another tab, press **⟲ Reset** before you start.

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
| *Re-authentication required* | The refresh failed | Run scenario 1 again. Explain: one refresh, one retry, then stop — this is the designed behaviour |
| The popup (or the app) spins and nothing happens | The debugger is holding the request: the mode is *Step* or *Pause at every message* | Look for the amber **BEFORE SEND** in the inspector: press **→** (Next step) or **Run to the end**. A pause left for 10 minutes ends the flow by itself |
| **STATE EXPIRED** or an `invalid_grant` after a long pause | You stepped slowly: the pending authorization lasts 10 minutes, and the sandbox's codes about 5 | Run the scenario again, and step a little faster between the callback and the token request |
| Nothing opens when you press Run | The browser blocked the popup | Allow popups for localhost, or untick *View options → Login in a popup window* (the page then redirects instead) |

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

**Force token expiry (or scenarios 7–9) is greyed out**
You're not connected. Run scenario 1 first.

**The canvas shows only some steps**
**Essentials** is on: routine steps inside Node are hidden (the note under the canvas says how many). Press **E** or choose **Everything**.

**The canvas stopped following new messages**
You scrolled up. Press **↓ Jump to latest**, or scroll to the bottom.

**Everything is stacked in one column**
The window is shorter than 760 px or narrower than 1100 px. Zoom out (`Cmd −`) or enlarge the window.

**Fonts look plain**
The fonts load from Google Fonts. Offline or blocked, the app falls back to system fonts; everything still works.

**Refresh token shows "Not issued"**
`offline_access` was removed from `SCOPES`, or the server didn't grant it. **Force token expiry** will then end in *Re-authentication required*, which is correct behaviour. (Scenario *Disable refresh* shows the same thing on purpose.)

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
