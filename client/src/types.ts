// Shapes of the Node server's JSON responses. None of them carries a credential.

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

export type DemoId =
  | "redirect-mismatch"
  | "tamper-state"
  | "replay-code"
  | "no-pkce-verifier"
  | "broad-scope"
  | "force-expiry";

export interface DemoResult {
  id: DemoId;
  title: string;
  whatWeChanged: string;
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
  fhirBaseUrl: string;
  idTokenClaims: Record<string, unknown> | null;
  scopeDiff: ScopeDiff | null;
  flow: StepStatus[];
  awaitingAuthorizationServer: boolean;
  lastError: TeachingError | null;
  demo?: DemoResult | null;
  scopeComparison?: { narrow: ScopeDiff | null; broad: ScopeDiff | null };
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

export type Direction =
  | "browser-client"
  | "browser-auth"
  | "auth-browser"
  | "client-auth"
  | "client-fhir"
  | "internal";

export interface WireEntry {
  id: number;
  timestamp: string;
  direction: Direction;
  step: string;
  method?: string;
  endpoint?: string;
  params?: Record<string, unknown>;
  status?: number | string;
  /* Milliseconds the Node server waited for an outbound HTTP response. Absent when
   * there was no outbound request (internal checks, browser → Node client hops).
   * Mirrors server/src/wireLog.ts; keep the two in step. */
  durationMs?: number;
  result?: unknown;
  notes?: string[];
  outcome: "ok" | "error" | "info";
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
