import { createHash, randomBytes } from "node:crypto";

/*
 * PKCE: Proof Key for Code Exchange (RFC 7636), method S256.
 *
 * 1. Before the flow, the client creates a secret: the code_verifier.
 * 2. The authorization request carries only code_challenge = BASE64URL(SHA256(code_verifier)).
 * 3. The token request must present the original code_verifier. The authorization
 *    server hashes it and compares the result with the challenge it saw earlier.
 *
 * Someone who intercepts only the authorization code (for example from a redirect
 * URL) does not have the verifier, so the token endpoint will not redeem the code for them.
 */

/** 48 random bytes from a CSPRNG → exactly 64 base64url characters (RFC 7636 allows 43–128). */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** S256: BASE64URL(SHA256(ASCII(code_verifier))), without padding. */
export function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}
