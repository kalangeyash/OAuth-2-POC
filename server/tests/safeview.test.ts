import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodeChallenge, generateCodeVerifier } from "../src/pkce.js";
import { redact } from "../src/redaction.js";
import {
  describeCallback,
  describeChallenge,
  describePkceProof,
  describeSessionStored,
  describeStateCheck,
  describeStateGenerated,
  describeStateTampered,
  describeVerifier,
  fingerprint,
  safeHeaders,
  VERIFIER_PURPOSE,
} from "../src/safeView.js";
import { generateState } from "../src/session.js";

/** True if any 8-character run of `secret` appears anywhere in the serialized value. */
function leaks(value: unknown, secret: string): boolean {
  const text = JSON.stringify(value);
  for (let i = 0; i + 8 <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + 8))) return true;
  }
  return false;
}

test("fingerprints are deterministic, 8 hex characters, and separated by purpose", () => {
  const value = generateState();
  assert.match(fingerprint("state", value), /^[0-9a-f]{8}$/);
  assert.equal(fingerprint("state", value), fingerprint("state", value));
  assert.notEqual(fingerprint("state", value), fingerprint("code_verifier", value));
});

test("a verifier's fingerprint is never a prefix of its own code_challenge", () => {
  for (let i = 0; i < 50; i++) {
    const verifier = generateCodeVerifier();
    const challenge = createCodeChallenge(verifier);
    const print = fingerprint(VERIFIER_PURPOSE, verifier);
    assert.ok(!challenge.startsWith(print));
    assert.ok(!Buffer.from(challenge, "base64url").toString("hex").startsWith(print));
  }
});

test("no PKCE or session detail contains any 8-character run of the verifier", () => {
  const verifier = generateCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const details = [
    describeVerifier(verifier),
    describeChallenge(verifier, challenge),
    describeSessionStored(generateState(), verifier, 600),
    describePkceProof(verifier, challenge, true),
    describePkceProof(verifier, challenge, false),
  ];
  for (const detail of details) {
    assert.equal(leaks(detail, verifier), false, `${detail.kind} leaks the verifier`);
    assert.equal(leaks(redact(detail), verifier), false);
  }
});

test("the verifier is described by length, bits and fingerprint only", () => {
  const verifier = generateCodeVerifier();
  assert.deepEqual(Object.keys(describeVerifier(verifier)).sort(), ["bits", "fingerprint", "kind", "length"]);
  assert.equal(describeVerifier(verifier).bits, 384);
});

test("Node's own PKCE check recomputes the challenge, and reports a missing verifier", () => {
  const verifier = generateCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  assert.equal(describePkceProof(verifier, challenge, true).recomputedChallengeMatches, true);
  assert.equal(describePkceProof(verifier, "a-different-challenge", true).recomputedChallengeMatches, false);
  assert.equal(describePkceProof(verifier, challenge, false).verifierSent, false);
});

test("state previews show 6 characters and a fingerprint, never the whole value", () => {
  const state = generateState();
  const { state: view } = describeStateGenerated(state);
  assert.equal(view.preview, `${state.slice(0, 6)}…`);
  assert.equal(view.length, state.length);
  assert.equal(leaks(view, state), false);
});

test("a state check tells MATCH from MISMATCH by fingerprint, without either full value", () => {
  const stored = generateState();
  const forged = generateState();
  const match = describeStateCheck("MATCH", stored, stored, 12, 600);
  const mismatch = describeStateCheck("MISMATCH", forged, stored, 12, 600);
  assert.equal(match.returned?.fingerprint, match.stored?.fingerprint);
  assert.notEqual(mismatch.returned?.fingerprint, mismatch.stored?.fingerprint);
  for (const value of [stored, forged]) assert.equal(leaks([match, mismatch], value), false);

  const tampered = describeStateTampered(stored, forged);
  assert.notEqual(tampered.original.fingerprint, tampered.replacement.fingerprint);
});

test("the callback detail truncates the authorization code and survives redaction unchanged", () => {
  const code = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl";
  const detail = describeCallback(code, generateState(), undefined, undefined);
  assert.equal(detail.authorizationCodePreview, "eyJhbGci… (truncated)");
  assert.equal(detail.authorizationCodeLength, code.length);
  assert.deepEqual(redact(detail), detail);
  assert.equal(JSON.stringify(detail).includes(code), false);
});

test("safeHeaders redacts credentials and keeps only teachable headers", () => {
  const headers = safeHeaders({
    Authorization: "Bearer an-access-token-value",
    Cookie: "smart_demo_sid=s%3Asecret",
    "set-cookie": ["a=b", "c=d"],
    "Content-Type": "application/json",
    "www-authenticate": 'Bearer error="invalid_token"',
    "x-internal-trace": "should not appear",
  });
  assert.match(headers.Authorization, /^\[REDACTED — \d+ chars\]$/);
  assert.match(headers.Cookie, /^\[REDACTED — \d+ chars\]$/);
  assert.match(headers["set-cookie"], /^\[REDACTED — \d+ chars\]$/);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["www-authenticate"], 'Bearer error="invalid_token"');
  assert.equal(headers["x-internal-trace"], undefined);
});

test("safeHeaders truncates a code inside a Location header", () => {
  const headers = safeHeaders({ location: "http://localhost:3001/callback?code=abcdefghijklmnop&state=xyz" });
  assert.equal(headers.location.includes("abcdefghijklmnop"), false);
  assert.match(headers.location, /code=abcdefgh… \(truncated\)/);
});

test("safeHeaders reads axios header objects through toJSON()", () => {
  const axiosLike = { toJSON: () => ({ "content-type": "application/fhir+json", authorization: "Bearer x" }) };
  assert.deepEqual(safeHeaders(axiosLike), { "content-type": "application/fhir+json", authorization: "[REDACTED — 8 chars]" });
});
