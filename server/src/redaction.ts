/*
 * THE central redaction helper. Nothing else in this project decides what is secret.
 *
 * Used by:
 *   - the server wire log and server console logs (wireLog.ts)
 *   - therefore every wire-log API response (entries are redacted before they are stored)
 *   - the React wire log, which imports this same file and applies it again before
 *     rendering or copying (defence in depth: the browser should never receive a secret anyway)
 *
 * Plain TypeScript with no Node or browser APIs, so the server and the browser run identical code.
 *
 * Rules:
 *   shown in full:  client_id, redirect_uri, scope, state, code_challenge, aud, and any key not listed below
 *   truncated:      code → first 8 characters + "(truncated)"
 *   never shown:    access_token, refresh_token, id_token, code_verifier, client_secret, client_assertion,
 *                   Authorization and Cookie headers → "[REDACTED — n chars]"
 *   inside text:    JWT-shaped strings and ?code= / ?access_token=… URL parameters get the same treatment
 */

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "code_verifier",
  "client_secret",
  "client_assertion",
  "authorization",
  "cookie",
  "set-cookie",
]);

const CODE_KEY = "code";
const CODE_PREFIX_LENGTH = 8;

const ALREADY_REDACTED = /^\[REDACTED — \d+ chars\]$/;
const ALREADY_TRUNCATED = /^[^\s]{0,8}… \(truncated\)$/;
const JWT_IN_TEXT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const SECRET_URL_PARAM =
  /([?&#](?:access_token|refresh_token|id_token|code_verifier|client_secret)=)(?!\[REDACTED)([^&#\s"]+)/g;
const CODE_URL_PARAM = /([?&#]code=)(?![^&#\s"]{0,8}… \(truncated\))([^&#\s"]+)/g;

export function redactSecret(value: unknown): string {
  const length = typeof value === "string" ? value.length : JSON.stringify(value).length;
  return `[REDACTED — ${length} chars]`;
}

export function truncateCode(code: string): string {
  return `${code.slice(0, CODE_PREFIX_LENGTH)}… (truncated)`;
}

/** Returns a deep copy of value with every secret removed. Safe to apply more than once. */
export function redact<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string" && (ALREADY_REDACTED.test(value) || ALREADY_TRUNCATED.test(value))) {
    return value;
  }
  const lowerKey = key?.toLowerCase();
  if (lowerKey && SECRET_KEYS.has(lowerKey) && value !== undefined && value !== null) {
    return redactSecret(value);
  }
  if (typeof value === "string") {
    return lowerKey === CODE_KEY ? truncateCode(value) : redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

function redactText(text: string): string {
  return text
    .replace(CODE_URL_PARAM, (_match, prefix: string, code: string) => prefix + truncateCode(code))
    .replace(SECRET_URL_PARAM, (_match, prefix: string, secret: string) => prefix + redactSecret(secret))
    .replace(JWT_IN_TEXT, (jwt) => redactSecret(jwt));
}
