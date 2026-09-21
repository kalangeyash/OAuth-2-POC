// Shapes of the Node server's JSON responses. None of them carries a credential.

// The wire-log event and the timeline vocabulary are shared with the server
// (server/src/timeline.ts), so the two sides cannot drift apart.
export type {
  ActorId,
  BuilderModId,
  Category,
  Channel,
  DemoId,
  DetailOf,
  Direction,
  EventDetail,
  InjectionId,
  LabBreakpoint,
  LabMode,
  LabState,
  Modification,
  SourceRef,
  StepMark,
  StepMarkStatus,
  TimelineStepId,
  ValuePreview,
  WireEntry,
} from "../../server/src/timeline";
import type { DemoId } from "../../server/src/timeline";

export type StepStatus = "pending" | "current" | "done" | "failed";

export interface ScopeRow {
  scope: string;
  requested: boolean;
  granted: boolean;
}

export interface ScopeDiff {
  requested: string[];
  granted: string[];
  rows: ScopeRow[];
  dropped: string[];
  added: string[];
  identical: boolean;
  grantedReported: boolean;
}

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

export interface DemoResult {
  id: DemoId;
  title: string;
  whatWeChanged: string;
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

export interface SessionInfo {
  authorized: boolean;
  scope: string | null;
  requestedScope: string;
  patientId: string | null;
  expiresIn: number | null;
  secondsRemaining: number | null;
  hasRefreshToken: boolean;
  hasIdToken?: boolean;
  fhirBaseUrl: string;
  idTokenClaims: Record<string, unknown> | null;
  scopeDiff: ScopeDiff | null;
  flow: StepStatus[];
  awaitingAuthorizationServer: boolean;
  lastError: TeachingError | null;
  demo?: DemoResult | null;
  scopeComparison?: { narrow: ScopeDiff | null; broad: ScopeDiff | null };
  /**
   * The real session-cookie configuration. Never its value. (Not named "cookie":
   * redact() treats that key as a secret and would hide the whole object.)
   */
  sessionCookie?: {
    name: string;
    httpOnly: boolean;
    sameSite: string;
    secure: boolean;
    maxAgeSeconds: number;
    sentWithThisRequest: boolean;
  };
  tokenStorage?: string;
}

export interface DiscoveryInfo {
  fhirBaseUrl: string;
  url: string;
  fetchedAt: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  scopes_supported: string[] | null;
  code_challenge_methods_supported: string[] | null;
  capabilities: string[] | null;
  warnings: string[];
  requestedScope: string;
  unadvertisedScopes: string[] | null;
  document: Record<string, unknown>;
}

/**
 * A fetched resource in one of its four real states. Panels take one of these so
 * every panel can render empty, loading, success and error — previously the
 * parent gated children on truthiness, so they could not tell the difference.
 */
export type Load<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; error: TeachingError };

export interface PatientSummary {
  id: string;
  name: string | null;
  gender: string | null;
  birthDate: string | null;
}

export interface LabRow {
  id: string | null;
  code: string | null;
  value: string | null;
  unit: string | null;
  date: string | null;
  interpretation: string | null;
}

export interface LabResults {
  rows: LabRow[];
  total: number | null;
  hasMorePages: boolean;
}
