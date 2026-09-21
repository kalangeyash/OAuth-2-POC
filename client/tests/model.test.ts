import assert from "node:assert/strict";
import { test } from "node:test";
import { channelOf, type StepMark, type WireEntry } from "../../server/src/timeline.js";
import { deriveFlowModel, demoEvidence, type RowStatus } from "../src/model.js";
import type { DemoResult } from "../src/types.js";

/*
 * Event sequences shaped like the ones the server records (server/src/oauth.ts,
 * routes/auth.ts, routes/api.ts, fhir.ts). The reducer must derive the timeline and
 * the panels from these marks alone.
 */

let nextId = 1;
function event(partial: Partial<WireEntry> & Pick<WireEntry, "direction" | "step">): WireEntry {
  return {
    id: nextId++,
    timestamp: new Date(1_700_000_000_000 + nextId * 1000).toISOString(),
    channel: channelOf(partial.direction),
    category: "authorization",
    outcome: "ok",
    ...partial,
  };
}
const mark = (step: StepMark["step"], status: StepMark["status"] = "done"): StepMark => ({ step, status });
const preview = (text: string) => ({ preview: `${text.slice(0, 6)}…`, fingerprint: `fp-${text}`, length: 43 });

function authorizationStart(options: { tamper?: boolean } = {}): WireEntry[] {
  const list = [
    event({ direction: "browser-client", step: "Connect", runStart: true, outcome: "info" }),
    event({ direction: "internal", step: "Endpoints from SMART discovery (cached)", timeline: [mark("discovery")] }),
    event({
      direction: "internal",
      step: "Generate state",
      timeline: [mark("generate-state")],
      detail: { kind: "state-generated", state: preview("original"), bits: 258 },
    }),
    event({
      direction: "internal",
      step: "Generate PKCE code_verifier",
      timeline: [mark("generate-verifier")],
      detail: { kind: "pkce-verifier", length: 64, bits: 384, fingerprint: "ab12cd34" },
    }),
    event({
      direction: "internal",
      step: "Derive PKCE code_challenge (S256)",
      timeline: [mark("generate-challenge")],
      detail: { kind: "pkce-challenge", method: "S256", challenge: "E9Melhoa2Ow", verifierFingerprint: "ab12cd34" },
    }),
    event({ direction: "internal", step: "Store state and code_verifier", timeline: [mark("store-session")] }),
    event({
      direction: "internal",
      step: "Build authorization URL",
      timeline: [mark("build-url")],
      detail: {
        kind: "authorization-url",
        endpoint: "https://auth.example/authorize",
        url: "https://auth.example/authorize?response_type=code",
        params: { response_type: "code", client_id: "demo", state: "original-state", code_challenge: "E9Melhoa2Ow" },
      },
    }),
  ];
  if (options.tamper) {
    list.push(
      event({
        direction: "internal",
        category: "demo",
        step: "DEMO: stored state replaced",
        detail: { kind: "state-tampered", original: preview("original"), replacement: preview("replaced") },
        demo: { id: "tamper-state", modified: { field: "state (stored in session)", original: "origin…", sent: "replac…" } },
        outcome: "info",
      }),
    );
  }
  list.push(
    event({
      direction: "browser-auth",
      step: "Authorization request",
      status: 302,
      timeline: [mark("redirect"), mark("login", "active")],
    }),
  );
  return list;
}

function callbackWithCode(): WireEntry {
  return event({
    direction: "auth-browser",
    step: "Redirect back with authorization code",
    timeline: [mark("login", "inferred"), mark("consent", "inferred"), mark("callback"), mark("receive-code")],
    detail: {
      kind: "callback",
      hasAuthorizationCode: true,
      authorizationCodePreview: "abcd1234… (truncated)",
      authorizationCodeLength: 300,
      returnedState: preview("original"),
      error: null,
      errorDescription: null,
    },
  });
}

function stateMatches(): WireEntry {
  return event({
    direction: "internal",
    category: "state",
    step: "State validation",
    timeline: [mark("validate-state")],
    detail: { kind: "state-check", verdict: "MATCH", returned: preview("original"), stored: preview("original"), ageSeconds: 9, ttlSeconds: 600 },
  });
}

function tokenExchange(ok: boolean, verifierSent = true): WireEntry[] {
  return [
    event({
      direction: "internal",
      category: verifierSent ? "pkce" : "demo",
      step: verifierSent ? "Attach PKCE code_verifier" : "DEMO: code_verifier removed",
      timeline: [mark("token-exchange", "active")],
      detail: { kind: "pkce-proof", method: "S256", verifierSent, verifierFingerprint: "ab12cd34", recomputedChallengeMatches: true },
      demo: verifierSent ? undefined : { id: "no-pkce-verifier", modified: { field: "code_verifier", original: "sent", sent: "(omitted)" } },
    }),
    event({
      direction: "client-auth",
      category: "token",
      step: "Token exchange",
      method: "POST",
      endpoint: "https://auth.example/auth/token",
      status: ok ? 200 : 400,
      durationMs: 120,
      timeline: [mark("token-exchange", ok ? "done" : "failed")],
      result: ok
        ? { access_token: "[REDACTED — 900 chars]", patient: "p-1" }
        : { error: "invalid_grant", error_description: "Invalid code_verifier" },
      outcome: ok ? "ok" : "error",
    }),
  ];
}

function tokensStored(): WireEntry[] {
  return [
    event({
      direction: "internal",
      category: "token",
      step: "Tokens stored in the server session",
      timeline: [mark("store-tokens")],
      detail: {
        kind: "tokens",
        hasAccessToken: true,
        hasRefreshToken: true,
        hasIdToken: true,
        tokenType: "Bearer",
        expiresIn: 3600,
        grantedScope: "openid patient/Patient.read",
        hasPatientContext: true,
        storage: "server-side session",
        browserExposure: "none",
        discarded: false,
      },
    }),
    event({ direction: "internal", category: "id-token", step: "ID token decoded", timeline: [mark("decode-id-token")] }),
    event({
      direction: "internal",
      category: "patient-context",
      step: "Patient context extracted",
      timeline: [mark("patient-context")],
      detail: { kind: "patient-context", patientId: "p-1", source: "token response" },
    }),
  ];
}

function loadData(browserSupplied: string | null = null): WireEntry[] {
  return [
    event({
      direction: "react-client",
      category: "patient-context",
      step: "Request patient",
      timeline: [mark("request-patient", "active")],
      detail: { kind: "patient-request", resource: "Patient", browserSupplied, used: "p-1", ignored: browserSupplied !== null },
      outcome: "info",
    }),
    event({
      direction: "client-fhir",
      category: "fhir",
      step: "FHIR API call: Patient",
      endpoint: "https://fhir.example/fhir/Patient/p-1",
      status: 200,
      timeline: [mark("request-patient")],
    }),
    event({
      direction: "react-client",
      category: "patient-context",
      step: "Request laboratory results",
      timeline: [mark("request-observations", "active")],
      detail: { kind: "patient-request", resource: "Observation", browserSupplied: null, used: "p-1", ignored: false },
      outcome: "info",
    }),
    event({
      direction: "client-fhir",
      category: "fhir",
      step: "FHIR API call: laboratory Observations",
      endpoint: "https://fhir.example/fhir/Observation",
      status: 200,
      timeline: [mark("request-observations")],
    }),
    event({ direction: "react-client", category: "fhir", step: "Patient and labs rendered", timeline: [mark("render")] }),
  ];
}

function happyPath(): WireEntry[] {
  return [...authorizationStart(), callbackWithCode(), stateMatches(), ...tokenExchange(true), ...tokensStored(), ...loadData()];
}

function statuses(entries: WireEntry[]): Record<string, RowStatus> {
  return Object.fromEntries(deriveFlowModel(entries).timeline.map((row) => [row.step.id, row.status]));
}

test("happy path: all 19 core steps complete, login and consent only inferred", () => {
  const model = deriveFlowModel(happyPath());
  const status = statuses(happyPath());
  assert.equal(model.completedCore, 19);
  assert.equal(model.coreTotal, 19);
  assert.equal(status.login, "inferred");
  assert.equal(status.consent, "inferred");
  for (const step of ["discovery", "validate-state", "token-exchange", "store-tokens", "request-patient", "render"]) {
    assert.equal(status[step], "done", step);
  }
  assert.equal(status.refresh, "pending");
  assert.equal(status.logout, "pending");
  assert.equal(model.stoppedAt, null);
  assert.equal(model.pkce.verdict, "accepted");
  assert.equal(model.pkce.proof?.detail.verifierSent, true);
  assert.equal(model.state.check?.detail.verdict, "MATCH");
  assert.equal(model.state.blocked, null);
  assert.equal(model.inspector?.params.response_type, "code");
  assert.deepEqual(
    model.tokens.stages.map((stage) => stage.status),
    ["done", "done", "done", "done", "not-needed", "not-needed", "not-needed", "not-needed"],
  );
  assert.ok(model.patient.stages.every((stage) => stage.status === "done"));
});

test("while the user is at the authorization server, login is the active step", () => {
  const model = deriveFlowModel(authorizationStart());
  assert.deepEqual(model.active, ["login"]);
  assert.equal(model.lastTouched, "redirect");
  assert.equal(model.completedCore, 7);
});

test("tampered state: validation fails, the exchange is blocked, and nothing after it runs", () => {
  const entries = [
    ...authorizationStart({ tamper: true }),
    callbackWithCode(),
    event({
      direction: "internal",
      category: "state",
      step: "State validation",
      timeline: [mark("validate-state", "failed")],
      detail: { kind: "state-check", verdict: "MISMATCH", returned: preview("original"), stored: preview("replaced"), ageSeconds: 9, ttlSeconds: 600 },
      outcome: "error",
    }),
    event({
      direction: "internal",
      category: "state",
      step: "Token exchange BLOCKED",
      timeline: ["token-exchange", "store-tokens", "decode-id-token", "patient-context"].map((step) =>
        mark(step as StepMark["step"], "skipped"),
      ),
      outcome: "error",
    }),
  ];
  const model = deriveFlowModel(entries);
  const status = statuses(entries);
  assert.equal(model.stoppedAt?.step.id, "validate-state");
  assert.equal(status["token-exchange"], "skipped");
  assert.equal(status["patient-context"], "skipped");
  const render = model.timeline.find((row) => row.step.id === "render");
  assert.equal(render?.status, "skipped");
  assert.equal(render?.notReached, true);
  assert.equal(model.state.check?.detail.verdict, "MISMATCH");
  assert.notEqual(model.state.check?.detail.returned?.fingerprint, model.state.check?.detail.stored?.fingerprint);
  assert.ok(model.state.tampered);
  assert.ok(model.state.blocked);
  assert.equal(model.pkce.verdict, "not-reached");
  assert.equal(model.pkce.exchange, null);
});

test("PKCE verifier removed: the token endpoint's rejection is surfaced with its exact error", () => {
  const entries = [...authorizationStart(), callbackWithCode(), stateMatches(), ...tokenExchange(false, false)];
  const model = deriveFlowModel(entries);
  assert.equal(model.stoppedAt?.step.id, "token-exchange");
  assert.equal(model.pkce.verdict, "rejected");
  assert.equal(model.pkce.proof?.detail.verifierSent, false);
  assert.deepEqual(model.pkce.error, { status: 400, error: "invalid_grant", description: "Invalid code_verifier" });
  const stored = model.timeline.find((row) => row.step.id === "store-tokens");
  assert.equal(stored?.status, "skipped");
  assert.equal(stored?.notReached, true);
  assert.equal(model.tokens.stages[1].status, "failed");
});

test("forced expiry: 401, refresh, new token and retry each light up, and the flow does not stop", () => {
  const entries = [
    ...happyPath(),
    event({ direction: "react-client", category: "demo", step: "DEMO: Force token expiry", demo: { id: "force-expiry" }, outcome: "info" }),
    event({
      direction: "internal",
      category: "demo",
      step: "DEMO: access token invalidated",
      demo: { id: "force-expiry", modified: { field: "access_token", original: "valid", sent: "random" } },
      outcome: "info",
    }),
    event({
      direction: "client-fhir",
      category: "fhir",
      step: "FHIR API call: Patient",
      endpoint: "https://fhir.example/fhir/Patient/p-1",
      status: 401,
      timeline: [mark("request-patient", "active"), mark("refresh", "active")],
      outcome: "error",
    }),
    event({
      direction: "client-auth",
      category: "refresh",
      step: "Token refresh",
      status: 200,
      timeline: [mark("refresh")],
    }),
    event({
      direction: "internal",
      category: "refresh",
      step: "New access token stored",
      timeline: [mark("refresh")],
      detail: {
        kind: "tokens",
        hasAccessToken: true,
        hasRefreshToken: true,
        hasIdToken: true,
        tokenType: "Bearer",
        expiresIn: 3600,
        grantedScope: null,
        hasPatientContext: true,
        storage: "server-side session",
        browserExposure: "none",
        discarded: false,
      },
    }),
    event({
      direction: "client-fhir",
      category: "fhir",
      step: "FHIR API call: Patient (retry)",
      endpoint: "https://fhir.example/fhir/Patient/p-1",
      status: 200,
      timeline: [mark("request-patient")],
    }),
  ];
  const model = deriveFlowModel(entries);
  const status = statuses(entries);
  assert.equal(status.refresh, "done");
  assert.equal(status["request-patient"], "done");
  assert.equal(model.stoppedAt, null);
  assert.deepEqual(
    model.tokens.stages.map((stage) => stage.status),
    ["done", "done", "done", "done", "done", "done", "done", "done"],
  );

  const demo: DemoResult = {
    id: "force-expiry",
    title: "Force token expiry",
    whatWeChanged: "",
    expected: "",
    concept: "",
    status: "completed",
    firstEntryId: entries.at(-6)!.id,
    lastEntryId: entries.at(-1)!.id,
    outcome: null,
    why: null,
    rejected: false,
    startedAt: "",
  };
  const evidence = demoEvidence(entries, demo);
  assert.equal(evidence.modified?.step, "DEMO: access token invalidated");
  assert.equal(evidence.request?.status, 401);
  assert.equal(evidence.response?.status, 401);
  assert.equal(evidence.stoppedAt, null);
});

test("a browser-supplied ?patient= is reported as ignored in the patient-context chain", () => {
  const entries = [...happyPath(), ...loadData("123")];
  const model = deriveFlowModel(entries);
  assert.equal(model.patient.request?.detail.browserSupplied, "123");
  assert.equal(model.patient.request?.detail.ignored, true);
  const ignore = model.patient.stages.find((stage) => stage.id === "ignore");
  assert.match(ignore?.note ?? "", /Ignored "123"; uses p-1/);
});

test("a new run start resets the timeline and the panels", () => {
  const entries = [...happyPath(), event({ direction: "browser-client", step: "Connect", runStart: true, outcome: "info" })];
  const model = deriveFlowModel(entries);
  assert.equal(model.run.length, 1);
  assert.equal(model.completedCore, 0);
  assert.equal(model.inspector, null);
  assert.ok(model.timeline.every((row) => row.status === "pending"));
});

test("a log without its run start is partial: earlier steps stay unknown, not 'not reached'", () => {
  const entries = loadData();
  const model = deriveFlowModel(entries);
  assert.equal(model.partial, true);
  assert.equal(model.timeline.find((row) => row.step.id === "discovery")?.status, "pending");
  assert.equal(model.timeline.find((row) => row.step.id === "request-patient")?.status, "done");
});

test("demo evidence names the modified value, the request that carried it, and where the flow stopped", () => {
  const entries = [...authorizationStart(), callbackWithCode(), stateMatches(), ...tokenExchange(false, false)];
  const demo: DemoResult = {
    id: "no-pkce-verifier",
    title: "Remove PKCE verifier",
    whatWeChanged: "",
    expected: "",
    concept: "",
    status: "completed",
    firstEntryId: entries[0].id,
    lastEntryId: entries.at(-1)!.id,
    outcome: null,
    why: null,
    rejected: true,
    startedAt: "",
  };
  const evidence = demoEvidence(entries, demo);
  assert.equal(evidence.modified?.step, "DEMO: code_verifier removed");
  assert.equal(evidence.request?.step, "Token exchange");
  assert.equal(evidence.response?.status, 400);
  assert.equal(evidence.stoppedAt?.step.id, "token-exchange");
});

test("state machine: a complete run ends at DATA_RENDERED", () => {
  const machine = deriveFlowModel(happyPath()).machine;
  assert.equal(machine.at(-1)?.id, "DATA_RENDERED");
  assert.ok(machine.every((state) => state.status === "done"));
});

test("state machine: while the user is at the authorization server, USER_AUTHENTICATED is current", () => {
  const machine = deriveFlowModel(authorizationStart()).machine;
  assert.deepEqual(
    machine.filter((state) => state.status !== "done").map((state) => [state.id, state.status]),
    [
      ["USER_AUTHENTICATED", "current"],
      ["CONSENT_GRANTED", "pending"],
      ["CALLBACK_RECEIVED", "pending"],
      ["STATE_VALIDATED", "pending"],
      ["CODE_EXCHANGED", "pending"],
      ["TOKENS_STORED", "pending"],
      ["PATIENT_CONTEXT_RESOLVED", "pending"],
      ["FHIR_REQUEST_COMPLETE", "pending"],
      ["DATA_RENDERED", "pending"],
    ],
  );
});

test("state machine: a state failure names what was never attempted", () => {
  const entries = [
    ...authorizationStart(),
    callbackWithCode(),
    event({
      direction: "internal",
      category: "state",
      step: "State validation",
      timeline: [mark("validate-state", "failed")],
      outcome: "error",
    }),
    event({
      direction: "internal",
      category: "state",
      step: "Token exchange BLOCKED",
      timeline: ["token-exchange", "store-tokens", "decode-id-token", "patient-context"].map((step) =>
        mark(step as StepMark["step"], "skipped"),
      ),
      outcome: "error",
    }),
  ];
  const machine = deriveFlowModel(entries).machine;
  assert.deepEqual(machine.slice(-3).map((state) => [state.id, state.status]), [
    ["CALLBACK_RECEIVED", "done"],
    ["STATE_VALIDATION_FAILED", "failed"],
    ["TOKEN_EXCHANGE_NOT_ATTEMPTED", "not-attempted"],
  ]);
});

test("a debugger 'before send' entry marks its step active but is not evidence of a sent request", () => {
  const entries = [
    ...authorizationStart(),
    callbackWithCode(),
    stateMatches(),
    event({
      direction: "client-auth",
      category: "lab",
      step: "⏸ Before send: POST token endpoint",
      timeline: [mark("token-exchange", "active")],
      breakpoint: { id: 1, kind: "network", stage: "token-exchange", injections: ["remove-code-verifier"] },
      outcome: "info",
    }),
  ];
  const model = deriveFlowModel(entries);
  assert.equal(model.timeline.find((row) => row.step.id === "token-exchange")?.status, "active");
  assert.equal(model.pkce.exchange, null);
  assert.equal(model.pkce.verdict, "pending");
  assert.equal(model.real.some((entry) => entry.breakpoint), false);
});

test("breakpoint injections count as modifications in the run's evidence", () => {
  const entries = [
    ...authorizationStart(),
    callbackWithCode(),
    stateMatches(),
    event({
      direction: "internal",
      category: "lab",
      step: "INJECTED: Alter code_verifier",
      injection: {
        id: "alter-code-verifier",
        label: "Alter code_verifier",
        modified: { field: "code_verifier", original: "fingerprint aaaa", sent: "fingerprint bbbb" },
      },
      outcome: "info",
    }),
    ...tokenExchange(false),
  ];
  const model = deriveFlowModel(entries);
  assert.equal(model.modifications.length, 1);
  assert.equal(model.stoppedAt?.step.id, "token-exchange");
});
