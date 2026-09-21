import { createHash } from "node:crypto";
import { createCodeChallenge } from "./pkce.js";
import { redact, redactSecret, truncateCode } from "./redaction.js";
import type { DetailOf, ValuePreview } from "./timeline.js";

/*
 * Safe views of protocol values, for the live panels.
 *
 * The panels need to SHOW that two values match (the state that came back vs the
 * state stored; the verifier generated vs the verifier sent) without showing the
 * values. A fingerprint does that: the same value always gives the same 8 hex
 * characters, and 8 characters of a SHA-256 reveal nothing usable about a
 * 256-bit or 384-bit random secret.
 *
 * The purpose string is hashed in, so a verifier's fingerprint is never a prefix
 * of its own code_challenge (which is also a SHA-256 of the verifier).
 */

export function fingerprint(purpose: string, value: string): string {
  return createHash("sha256").update(`${purpose}:${value}`).digest("hex").slice(0, 8);
}

/** First characters + fingerprint. For values that are public anyway (state), shown shortened for legibility. */
export function previewValue(purpose: string, value: string, visible = 6): ValuePreview {
  return { preview: `${value.slice(0, visible)}…`, fingerprint: fingerprint(purpose, value), length: value.length };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Headers worth teaching with. Anything else is left out rather than guessed about. */
const SHOWN_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "cache-control",
  "pragma",
  "www-authenticate",
  "location",
]);
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/**
 * An allowlisted, redacted copy of request or response headers.
 * Authorization, Cookie and Set-Cookie are always replaced by "[REDACTED — n chars]".
 */
export function safeHeaders(headers: unknown): Record<string, string> {
  const plain = toPlainHeaders(headers);
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(plain)) {
    if (value === undefined || value === null) continue;
    const key = name.toLowerCase();
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    if (SECRET_HEADERS.has(key)) safe[name] = redactSecret(text);
    else if (SHOWN_HEADERS.has(key)) safe[name] = redact(text);
  }
  return safe;
}

function toPlainHeaders(headers: unknown): Record<string, unknown> {
  if (typeof headers !== "object" || headers === null) return {};
  // axios returns an AxiosHeaders instance; toJSON() gives its plain name → value map.
  const withToJson = headers as { toJSON?: () => unknown };
  const plain = typeof withToJson.toJSON === "function" ? withToJson.toJSON() : headers;
  return typeof plain === "object" && plain !== null ? (plain as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Event details. Each takes the real value and returns only what is safe to show.
// ---------------------------------------------------------------------------

export const STATE_PURPOSE = "state";
export const VERIFIER_PURPOSE = "code_verifier";

export function describeStateGenerated(state: string): DetailOf<"state-generated"> {
  // base64url carries 6 bits per character.
  return { kind: "state-generated", state: previewValue(STATE_PURPOSE, state), bits: state.length * 6 };
}

/** The verifier is described, never previewed: length, randomness and fingerprint only. */
export function describeVerifier(verifier: string): DetailOf<"pkce-verifier"> {
  return {
    kind: "pkce-verifier",
    length: verifier.length,
    bits: verifier.length * 6,
    fingerprint: fingerprint(VERIFIER_PURPOSE, verifier),
  };
}

export function describeChallenge(verifier: string, challenge: string): DetailOf<"pkce-challenge"> {
  return { kind: "pkce-challenge", method: "S256", challenge, verifierFingerprint: fingerprint(VERIFIER_PURPOSE, verifier) };
}

export function describeSessionStored(state: string, verifier: string, ttlSeconds: number): DetailOf<"session-stored"> {
  return {
    kind: "session-stored",
    stateFingerprint: fingerprint(STATE_PURPOSE, state),
    verifierFingerprint: fingerprint(VERIFIER_PURPOSE, verifier),
    ttlSeconds,
    cookie: "httpOnly; SameSite=Lax — carries only a signed session ID",
  };
}

export function describeCallback(
  code: string | undefined,
  state: string | undefined,
  error: string | undefined,
  errorDescription: string | undefined,
): DetailOf<"callback"> {
  return {
    kind: "callback",
    hasAuthorizationCode: Boolean(code),
    authorizationCodePreview: code ? truncateCode(code) : null,
    authorizationCodeLength: code ? code.length : null,
    returnedState: state ? previewValue(STATE_PURPOSE, state) : null,
    error: error ?? null,
    errorDescription: errorDescription ?? null,
  };
}

export function describeStateCheck(
  verdict: "MATCH" | "MISMATCH" | "EXPIRED" | "MISSING",
  returned: string | undefined,
  stored: string | undefined,
  ageSeconds: number | null,
  ttlSeconds: number,
): DetailOf<"state-check"> {
  return {
    kind: "state-check",
    verdict,
    returned: returned ? previewValue(STATE_PURPOSE, returned) : null,
    stored: stored ? previewValue(STATE_PURPOSE, stored) : null,
    ageSeconds,
    ttlSeconds,
  };
}

export function describeStateTampered(original: string, replacement: string): DetailOf<"state-tampered"> {
  return {
    kind: "state-tampered",
    original: previewValue(STATE_PURPOSE, original),
    replacement: previewValue(STATE_PURPOSE, replacement),
  };
}

/** Node's own PKCE check before the token request. The authorization server's comparison is not observable. */
export function describePkceProof(verifier: string, challengeSent: string | undefined, verifierSent: boolean): DetailOf<"pkce-proof"> {
  return {
    kind: "pkce-proof",
    method: "S256",
    verifierSent,
    verifierFingerprint: fingerprint(VERIFIER_PURPOSE, verifier),
    recomputedChallengeMatches: challengeSent !== undefined && createCodeChallenge(verifier) === challengeSent,
  };
}

/** Presence flags only. No token value, no token length. */
export function describeTokens(
  token: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    tokenType?: string;
    expiresIn?: number;
    grantedScope?: string;
    patientId?: string;
  },
  discarded = false,
): DetailOf<"tokens"> {
  return {
    kind: "tokens",
    hasAccessToken: Boolean(token.accessToken),
    hasRefreshToken: Boolean(token.refreshToken),
    hasIdToken: Boolean(token.idToken),
    tokenType: token.tokenType ?? null,
    expiresIn: token.expiresIn ?? null,
    grantedScope: token.grantedScope ?? null,
    hasPatientContext: Boolean(token.patientId),
    storage: discarded ? "discarded (not stored)" : "server-side session",
    browserExposure: "none",
    discarded,
  };
}

/** Claims that identify, never credentials. The signature is not verified by this demo. */
const SHOWN_CLAIMS = ["iss", "aud", "sub", "fhirUser", "iat", "exp"];

export function describeIdToken(claims: Record<string, unknown> | undefined, present: boolean): DetailOf<"id-token"> {
  const shown = claims
    ? Object.fromEntries(SHOWN_CLAIMS.filter((name) => claims[name] !== undefined).map((name) => [name, claims[name]]))
    : null;
  return { kind: "id-token", present, claims: shown, signatureVerified: false };
}
