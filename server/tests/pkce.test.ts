import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodeChallenge, generateCodeVerifier } from "../src/pkce.js";

test("code_verifier is 64 base64url characters and different every time", () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(generateCodeVerifier(), verifier);
});

test("S256 code_challenge is base64url without padding and never the verifier itself", () => {
  const verifier = generateCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(challenge, verifier);
});

test("a known verifier always produces the RFC 7636 Appendix B challenge", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(createCodeChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(createCodeChallenge(verifier), createCodeChallenge(verifier));
});
