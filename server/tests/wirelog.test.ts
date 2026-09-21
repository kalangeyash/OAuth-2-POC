import assert from "node:assert/strict";
import { test } from "node:test";
import { describeStateCheck } from "../src/safeView.js";
import { clearEntries, listEntries, record, startTimer, subscribe, type LogEvent } from "../src/wireLog.js";

test("a numeric durationMs survives redaction and is stored as a number", () => {
  clearEntries();
  const entry = record({
    direction: "client-auth",
    step: "Token exchange",
    method: "POST",
    endpoint: "https://example.test/auth/token",
    status: 200,
    durationMs: 412,
    outcome: "ok",
  });
  assert.equal(entry.durationMs, 412);
  assert.equal(typeof entry.durationMs, "number");
});

test("recording still redacts secrets, with or without a duration", () => {
  clearEntries();
  const entry = record({
    direction: "client-auth",
    step: "Token exchange",
    durationMs: 7,
    params: { code_verifier: "s3cret-verifier-value", client_id: "oauth-demo-app" },
    result: { access_token: "an-access-token", token_type: "Bearer" },
    outcome: "ok",
  });
  assert.match(String(entry.params?.code_verifier), /^\[REDACTED — \d+ chars\]$/);
  assert.match(String((entry.result as Record<string, unknown>).access_token), /^\[REDACTED — \d+ chars\]$/);
  // Non-secret values are untouched, so the log stays teachable.
  assert.equal(entry.params?.client_id, "oauth-demo-app");
  assert.equal(entry.durationMs, 7);
});

test("listEntries returns only entries newer than the given id", () => {
  clearEntries();
  const first = record({ direction: "internal", step: "one", outcome: "info" });
  const second = record({ direction: "internal", step: "two", outcome: "info" });
  assert.deepEqual(listEntries(first.id).map((e) => e.step), ["two"]);
  assert.equal(listEntries(second.id).length, 0);
  assert.equal(listEntries(0).length, 2);
});

test("an entry with no outbound request carries no duration", () => {
  clearEntries();
  const entry = record({ direction: "internal", step: "State validation", outcome: "ok" });
  assert.equal(entry.durationMs, undefined);
});

test("the channel is derived from the direction, never taken from the caller", () => {
  clearEntries();
  const channels = (
    ["browser-auth", "auth-browser", "client-auth", "client-fhir", "browser-client", "react-client", "internal"] as const
  ).map((direction) => record({ direction, step: direction, outcome: "info" }).channel);
  assert.deepEqual(channels, ["front", "front", "back", "back", "local", "local", "local"]);
});

test("a missing category gets a default, and an explicit one is kept", () => {
  clearEntries();
  assert.equal(record({ direction: "client-fhir", step: "x", outcome: "ok" }).category, "fhir");
  assert.equal(record({ direction: "internal", category: "pkce", step: "y", outcome: "ok" }).category, "pkce");
});

test("subscribers receive the redacted entry, never the raw one", () => {
  clearEntries();
  const received: LogEvent[] = [];
  const unsubscribe = subscribe((event) => received.push(event));
  record({
    direction: "client-auth",
    step: "Token exchange",
    params: { code: "abcdefghijklmnopqrstuvwxyz", code_verifier: "a-secret-verifier" },
    requestHeaders: { Authorization: "Basic c2VjcmV0" },
    result: { access_token: "an-access-token", refresh_token: "a-refresh-token" },
    outcome: "ok",
  });
  unsubscribe();
  record({ direction: "internal", step: "after unsubscribe", outcome: "info" });

  assert.equal(received.length, 1);
  const event = received[0];
  assert.equal(event.type, "entry");
  const text = JSON.stringify(event);
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "a-secret-verifier", "c2VjcmV0", "an-access-token", "a-refresh-token"]) {
    assert.equal(text.includes(secret), false, `${secret} reached a subscriber`);
  }
});

test("clearing the log notifies subscribers", () => {
  const received: LogEvent[] = [];
  const unsubscribe = subscribe((event) => received.push(event));
  clearEntries();
  unsubscribe();
  assert.deepEqual(received, [{ type: "cleared" }]);
});

test("a throwing subscriber does not stop recording or the other subscribers", () => {
  clearEntries();
  const seen: string[] = [];
  const offBroken = subscribe(() => {
    throw new Error("broken stream");
  });
  const offGood = subscribe((event) => event.type === "entry" && seen.push(event.entry.step));
  const originalError = console.error;
  console.error = () => undefined;
  try {
    record({ direction: "internal", step: "still recorded", outcome: "info" });
  } finally {
    console.error = originalError;
    offBroken();
    offGood();
  }
  assert.deepEqual(seen, ["still recorded"]);
  assert.equal(listEntries().length, 1);
});

test("timeline marks and panel details survive redaction intact", () => {
  clearEntries();
  const detail = describeStateCheck("MATCH", "returned-state-value", "returned-state-value", 3, 600);
  const entry = record({
    direction: "internal",
    step: "State validation",
    timeline: [{ step: "validate-state", status: "done" }],
    detail,
    runStart: true,
    demo: { id: "tamper-state", modified: { field: "state", original: "abc…", sent: "xyz…" } },
    outcome: "ok",
  });
  assert.deepEqual(entry.timeline, [{ step: "validate-state", status: "done" }]);
  assert.deepEqual(entry.detail, detail);
  assert.equal(entry.runStart, true);
  assert.deepEqual(entry.demo, { id: "tamper-state", modified: { field: "state", original: "abc…", sent: "xyz…" } });
});
