import assert from "node:assert/strict";
import { test } from "node:test";
import { diffScopes } from "../src/scope.js";

const REQUESTED = "openid fhirUser launch/patient patient/Patient.read patient/Observation.read offline_access";

test("identical requested and granted scope", () => {
  const diff = diffScopes(REQUESTED, REQUESTED);
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.dropped, []);
  assert.deepEqual(diff.added, []);
  assert.ok(diff.rows.every((row) => row.requested && row.granted));
});

test("granted scope is a subset of the requested scope", () => {
  const diff = diffScopes(REQUESTED, "openid fhirUser patient/Patient.read");
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.dropped, ["launch/patient", "patient/Observation.read", "offline_access"]);
  assert.deepEqual(diff.added, []);
});

test("a dropped scope is marked as requested but not granted", () => {
  const diff = diffScopes(REQUESTED, "openid fhirUser launch/patient patient/Patient.read patient/Observation.read");
  assert.deepEqual(diff.dropped, ["offline_access"]);
  assert.deepEqual(
    diff.rows.find((row) => row.scope === "offline_access"),
    { scope: "offline_access", requested: true, granted: false },
  );
});

test("a scope granted without being requested is reported as added", () => {
  const diff = diffScopes("openid patient/Patient.read", "openid patient/Patient.read patient/*.read");
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added, ["patient/*.read"]);
  assert.deepEqual(diff.dropped, []);
  assert.deepEqual(diff.rows.at(-1), { scope: "patient/*.read", requested: false, granted: true });
});
