import assert from "node:assert/strict";
import { test } from "node:test";
import { clearEntries, listEntries, record, startTimer } from "../src/wireLog.js";

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
