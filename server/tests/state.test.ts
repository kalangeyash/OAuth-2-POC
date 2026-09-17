import assert from "node:assert/strict";
import { test } from "node:test";
import { checkState, STATE_TTL_MS, takePendingAuthorization, type PendingAuthorization } from "../src/session.js";

const CREATED_AT = 1_700_000_000_000;
const STATE = "state-stored-in-this-session";

function pendingAuthorization(): PendingAuthorization {
  return {
    state: STATE,
    codeVerifier: "code-verifier",
    createdAt: CREATED_AT,
    requestedScope: "openid",
    authorizeRedirectUri: "http://localhost:3001/callback",
    fhirBaseUrl: "https://fhir.example.test",
    discovery: {
      fhirBaseUrl: "https://fhir.example.test",
      url: "https://fhir.example.test/.well-known/smart-configuration",
      fetchedAt: "",
      warnings: [],
      document: {},
    },
  };
}

test("valid state is accepted", () => {
  assert.deepEqual(checkState(pendingAuthorization(), STATE, CREATED_AT + 5_000), { ok: true });
});

test("a different or missing state is rejected as a mismatch", () => {
  for (const received of ["state-chosen-by-an-attacker", "", undefined]) {
    const result = checkState(pendingAuthorization(), received, CREATED_AT + 5_000);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "mismatch");
  }
});

test("state older than 10 minutes is rejected as expired", () => {
  assert.equal(checkState(pendingAuthorization(), STATE, CREATED_AT + STATE_TTL_MS).ok, true);
  const result = checkState(pendingAuthorization(), STATE, CREATED_AT + STATE_TTL_MS + 1);
  assert.equal(!result.ok && result.reason, "expired");
});

test("a pending authorization can be consumed only once", () => {
  const session: { pendingAuth?: PendingAuthorization } = { pendingAuth: pendingAuthorization() };

  const first = takePendingAuthorization(session);
  assert.equal(checkState(first, STATE, CREATED_AT + 5_000).ok, true);
  assert.equal(session.pendingAuth, undefined);

  const second = takePendingAuthorization(session);
  const replay = checkState(second, STATE, CREATED_AT + 5_000);
  assert.equal(second, undefined);
  assert.equal(!replay.ok && replay.reason, "missing");
});
