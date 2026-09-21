import { randomBytes, timingSafeEqual } from "node:crypto";
import session from "express-session";
import type { Discovery } from "./discovery.js";
import type { ScopeDiff } from "./scope.js";
import type { DemoId } from "./timeline.js";

export type { DemoId } from "./timeline.js";

/** A failure demonstration and what really happened when it ran. */
export interface DemoResult {
  id: DemoId;
  title: string;
  whatWeChanged: string;
  /** What the unmodified flow would have done at this point. */
  expected: string;
  concept: string;
  status: "running" | "completed";
  firstEntryId: number;
  lastEntryId: number | null;
  outcome: string | null;
  why: string | null;
  rejected: boolean | null;
  startedAt: string;
}

export const SESSION_COOKIE_NAME = "smart_demo_sid";

/** An authorization request (its state and code_verifier) expires after 10 minutes. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/** Everything /callback needs to finish one authorization request. Server-side only. */
export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
  /** The code_challenge sent to /authorize. Public; kept so Node can show its own PKCE check. */
  codeChallenge?: string;
  createdAt: number;
  requestedScope: string;
  /** The redirect_uri that was sent to /authorize. */
  authorizeRedirectUri: string;
  /** The FHIR server this authorization is for (sent as aud). */
  fhirBaseUrl: string;
  discovery: Discovery;
  launch?: string;
  /** Set when this flow is a failure demonstration. */
  demo?: DemoId;
}

/** The result of a successful token exchange. Token values never leave the server. */
export interface AuthorizedContext {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  idToken?: string;
  /** Decoded (NOT verified) ID token claims, for teaching only. */
  idTokenClaims?: Record<string, unknown>;
  requestedScope: string;
  /** undefined when the token response had no scope parameter. */
  grantedScope?: string;
  /** SMART launch context: the patient the authorization server says this token is for. */
  patientId?: string;
  expiresIn?: number;
  expiresAt?: number;
  fhirBaseUrl: string;
  tokenEndpoint: string;
  tokenEndpointAuthMethodsSupported?: string[];
}

/** A protocol failure explained for the audience. Contains no credentials. */
export interface TeachingError {
  step: string;
  message: string;
  endpoint?: string;
  status?: number;
  error?: string;
  error_description?: string;
  concept?: string;
  reauthRequired?: boolean;
}

/** Status of each of the nine steps in the UI stepper. Set only by real server events. */
export type StepStatus = "pending" | "current" | "done" | "failed";
export const FLOW_STEP_COUNT = 9;

declare module "express-session" {
  interface SessionData {
    pendingAuth: PendingAuthorization;
    auth: AuthorizedContext;
    lastError: TeachingError;
    flow: StepStatus[];
    demo: DemoResult;
    /** Requested vs granted scope of the last normal authorization, and of the broad-scope demo. */
    narrowScope: ScopeDiff;
    broadScope: ScopeDiff;
  }
}

export function initialFlow(): StepStatus[] {
  return Array.from({ length: FLOW_STEP_COUNT }, (_, index) => (index === 0 ? "current" : "pending"));
}

/** Steps 1…completedThrough are done; the next step is current. */
export function advanceFlow(store: { flow?: StepStatus[] }, completedThrough: number): void {
  store.flow = Array.from({ length: FLOW_STEP_COUNT }, (_, index) => {
    const step = index + 1;
    if (step <= completedThrough) return "done";
    return step === completedThrough + 1 ? "current" : "pending";
  });
}

/** Steps before failedStep are done; failedStep failed. */
export function failFlow(store: { flow?: StepStatus[] }, failedStep: number): void {
  store.flow = Array.from({ length: FLOW_STEP_COUNT }, (_, index) => {
    const step = index + 1;
    if (step < failedStep) return "done";
    return step === failedStep ? "failed" : "pending";
  });
}

/**
 * The session cookie's attributes. Exported so /api/session can report the real
 * configuration to the "What can the browser see?" panel instead of a hardcoded claim.
 */
export const SESSION_COOKIE_OPTIONS = {
  // The cookie carries only a signed session ID. Tokens stay in the server-side session.
  httpOnly: true,
  // SameSite=Lax, not Strict. The return trip from the authorization server to
  // /callback is a cross-site, top-level GET navigation. Lax still sends the
  // session cookie on it. Strict would not, so /callback would find no stored
  // state or code_verifier and fail with a confusing state/session error.
  sameSite: "lax",
  // Plain HTTP on localhost. In production: HTTPS and secure: true.
  secure: false,
  maxAge: 8 * 60 * 60 * 1000,
} as const;

export function createSessionMiddleware(secret: string) {
  return session({
    name: SESSION_COOKIE_NAME,
    secret,
    resave: false,
    saveUninitialized: false,
    // This in-memory session store is intentionally used for the demo.
    // It is not appropriate for production because sessions disappear when
    // the process restarts and it does not provide durable/shared session
    // storage across multiple application instances.
    store: new session.MemoryStore(),
    cookie: { ...SESSION_COOKIE_OPTIONS },
  });
}

/** state: 32 bytes from a CSPRNG. Unguessable, so an attacker cannot forge a matching callback. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Removes the pending authorization from the session and returns it.
 * It can be taken only once: state and code_verifier are single-use.
 */
export function takePendingAuthorization(store: {
  pendingAuth?: PendingAuthorization;
}): PendingAuthorization | undefined {
  const pending = store.pendingAuth;
  delete store.pendingAuth;
  return pending;
}

export type StateCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "mismatch"; detail: string };

/** Compares the state returned to /callback with the state this session stored. */
export function checkState(
  pending: Pick<PendingAuthorization, "state" | "createdAt"> | undefined,
  receivedState: string | undefined,
  now = Date.now(),
): StateCheck {
  if (!pending) {
    return {
      ok: false,
      reason: "missing",
      detail:
        "This session has no pending authorization request: it was never started here, it was already used, or the session cookie was not sent.",
    };
  }
  if (now - pending.createdAt > STATE_TTL_MS) {
    return {
      ok: false,
      reason: "expired",
      detail: `The authorization request is older than ${STATE_TTL_MS / 60_000} minutes.`,
    };
  }
  if (!receivedState || !constantTimeEqual(receivedState, pending.state)) {
    return {
      ok: false,
      reason: "mismatch",
      detail: "The state returned by the authorization server does not match the state stored in this session.",
    };
  }
  return { ok: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
