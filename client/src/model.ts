/*
 * THE one place the React app interprets wire-log events.
 *
 * deriveFlowModel() folds the redacted event stream into everything the panels
 * show: the 21-step timeline, the request inspector, the state and PKCE chains,
 * the token lifecycle, the patient-context chain and the channel counts. No
 * component reads raw events to decide what happened; they all read this model.
 *
 * Pure (no React, no DOM), so it is unit-tested in client/tests/model.test.ts.
 *
 * Honesty rules:
 *  - A step's status comes only from marks the SERVER put on events. The one
 *    thing concluded here is "not reached": a step that never ran because the
 *    flow had already stopped (or had already moved past it).
 *  - Login and consent are never "done": the server marks them "inferred",
 *    because this app cannot see them.
 */
import {
  CORE_STEP_COUNT,
  DIRECTION_ACTORS,
  TIMELINE,
  timelineStep,
  type ActorId,
  type Channel,
  type DetailOf,
  type EventDetail,
  type StepMarkStatus,
  type TimelineStep,
  type TimelineStepId,
  type WireEntry,
} from "../../server/src/timeline";
import type { DemoResult } from "./types";

export type RowStatus = "pending" | StepMarkStatus;

export interface TimelineRow {
  step: TimelineStep;
  status: RowStatus;
  /** Entries in this run that marked the step, oldest first. */
  entryIds: number[];
  /** Timestamp of the latest mark. */
  at: string | null;
  /** Concluded here, not stated by the server: the flow never got to this step. */
  notReached: boolean;
}

export interface Found<K extends EventDetail["kind"]> {
  entry: WireEntry;
  detail: DetailOf<K>;
}

export type StageStatus = "pending" | "done" | "failed" | "not-needed";

export interface Stage {
  id: string;
  label: string;
  actor: ActorId;
  status: StageStatus;
  entryId: number | null;
  note: string | null;
}

export interface FlowModel {
  /** Entries from the latest run start onwards (or all entries if the log has no run start). */
  run: WireEntry[];
  /** The run without debugger "before send" entries: what actually happened. */
  real: WireEntry[];
  runStart: WireEntry | null;
  /** The run's beginning is not in the log (cleared, or started before it), so earlier steps are unknown. */
  partial: boolean;
  timeline: TimelineRow[];
  completedCore: number;
  coreTotal: number;
  /** The step the most recent completed/failed mark touched. */
  lastTouched: TimelineStepId | null;
  /** Steps currently marked active, e.g. login while the user is at the authorization server. */
  active: TimelineStepId[];
  /** Where the flow stopped, if it did. */
  stoppedAt: { step: TimelineStep; entry: WireEntry } | null;
  inspector: InspectorModel | null;
  state: StateModel;
  pkce: PkceModel;
  tokens: TokenModel;
  patient: PatientModel;
  channels: Record<Channel, number>;
  /** The protocol as an explicit state machine, including where it stopped. */
  machine: MachineState[];
  /** Every deliberate change in this run (failure demo, breakpoint injection, request builder). */
  modifications: WireEntry[];
}

export type MachineStatus = "done" | "current" | "failed" | "not-attempted" | "pending";

export interface MachineState {
  id: string;
  status: MachineStatus;
  step: TimelineStepId;
}

export interface InspectorModel {
  entry: WireEntry;
  endpoint: string;
  url: string;
  params: Record<string, string>;
  modified: { field: string; original: string; sent: string } | null;
}

export interface StateModel {
  generated: Found<"state-generated"> | null;
  tampered: Found<"state-tampered"> | null;
  callback: Found<"callback"> | null;
  check: Found<"state-check"> | null;
  /** The event saying the token exchange was blocked because of the check. */
  blocked: WireEntry | null;
}

export interface PkceModel {
  verifier: Found<"pkce-verifier"> | null;
  challenge: Found<"pkce-challenge"> | null;
  /** The front-channel authorization request that carried code_challenge. */
  authorizationRequest: WireEntry | null;
  callback: Found<"callback"> | null;
  proof: Found<"pkce-proof"> | null;
  /** The token request, and the authorization server's verdict on it. */
  exchange: WireEntry | null;
  verdict: "pending" | "accepted" | "rejected" | "not-reached";
  error: ProviderError | null;
}

export interface ProviderError {
  status: number | string | undefined;
  error: string | null;
  description: string | null;
}

export interface TokenModel {
  stored: Found<"tokens"> | null;
  stages: Stage[];
}

export interface PatientModel {
  context: Found<"patient-context"> | null;
  /** The latest browser request for patient data, with any ?patient= it tried. */
  request: Found<"patient-request"> | null;
  stages: Stage[];
}

export function deriveFlowModel(entries: WireEntry[]): FlowModel {
  const startIndex = findLastIndex(entries, (entry) => entry.runStart === true);
  const run = startIndex === -1 ? entries : entries.slice(startIndex);
  const runStart = startIndex === -1 ? null : entries[startIndex];

  const timeline = buildTimeline(run, runStart !== null);
  const rows = new Map(timeline.rows.map((row) => [row.step.id, row]));
  // Breakpoint entries show a request BEFORE it was sent. They mark the timeline
  // (the step is active while paused) but they are not evidence of what happened.
  const real = run.filter((entry) => !entry.breakpoint);

  return {
    run,
    real,
    runStart,
    partial: runStart === null && entries.length > 0,
    timeline: timeline.rows,
    completedCore: timeline.rows.filter(
      (row) => !row.step.optional && (row.status === "done" || row.status === "inferred"),
    ).length,
    coreTotal: CORE_STEP_COUNT,
    lastTouched: timeline.lastTouched,
    active: timeline.rows.filter((row) => row.status === "active").map((row) => row.step.id),
    stoppedAt: timeline.stoppedAt,
    inspector: buildInspector(real),
    state: buildState(real),
    pkce: buildPkce(real, rows),
    tokens: buildTokens(real),
    patient: buildPatient(real),
    channels: countChannels(real),
    machine: buildMachine(rows),
    modifications: real.filter(isModification),
  };
}

// ---------------------------------------------------------------------------
// Protocol state machine
// ---------------------------------------------------------------------------

/*
 * Each state is reached when its timeline step completes. If the step fails, the
 * state takes its failure name and the next state says what was therefore never
 * attempted, e.g. STATE_VALIDATION_FAILED → TOKEN_EXCHANGE_NOT_ATTEMPTED.
 */
const MACHINE: { id: string; step: TimelineStepId; failed: string; notAttempted: string }[] = [
  { id: "DISCOVERY_COMPLETE", step: "discovery", failed: "DISCOVERY_FAILED", notAttempted: "DISCOVERY_NOT_ATTEMPTED" },
  { id: "AUTHORIZATION_CONTEXT_CREATED", step: "store-session", failed: "AUTHORIZATION_CONTEXT_FAILED", notAttempted: "AUTHORIZATION_CONTEXT_NOT_CREATED" },
  { id: "AUTHORIZATION_REQUEST_BUILT", step: "build-url", failed: "AUTHORIZATION_REQUEST_FAILED", notAttempted: "AUTHORIZATION_REQUEST_NOT_BUILT" },
  { id: "BROWSER_REDIRECTED", step: "redirect", failed: "REDIRECT_STOPPED", notAttempted: "REDIRECT_NOT_ATTEMPTED" },
  { id: "USER_AUTHENTICATED", step: "login", failed: "AUTHENTICATION_FAILED", notAttempted: "LOGIN_NOT_REACHED" },
  { id: "CONSENT_GRANTED", step: "consent", failed: "CONSENT_DENIED", notAttempted: "CONSENT_NOT_REACHED" },
  { id: "CALLBACK_RECEIVED", step: "receive-code", failed: "AUTHORIZATION_ERROR_RETURNED", notAttempted: "CALLBACK_NOT_RECEIVED" },
  { id: "STATE_VALIDATED", step: "validate-state", failed: "STATE_VALIDATION_FAILED", notAttempted: "STATE_VALIDATION_NOT_ATTEMPTED" },
  { id: "CODE_EXCHANGED", step: "token-exchange", failed: "TOKEN_EXCHANGE_FAILED", notAttempted: "TOKEN_EXCHANGE_NOT_ATTEMPTED" },
  { id: "TOKENS_STORED", step: "store-tokens", failed: "TOKENS_NOT_STORED", notAttempted: "TOKENS_NOT_STORED" },
  { id: "PATIENT_CONTEXT_RESOLVED", step: "patient-context", failed: "PATIENT_CONTEXT_MISSING", notAttempted: "PATIENT_CONTEXT_NOT_RESOLVED" },
  { id: "FHIR_REQUEST_COMPLETE", step: "request-observations", failed: "FHIR_REQUEST_FAILED", notAttempted: "FHIR_REQUEST_NOT_ATTEMPTED" },
  { id: "DATA_RENDERED", step: "render", failed: "RENDER_FAILED", notAttempted: "DATA_NOT_RENDERED" },
];

function buildMachine(rows: Map<TimelineStepId, TimelineRow>): MachineState[] {
  const states: MachineState[] = [{ id: "IDLE", status: "done", step: "discovery" }];
  let stopped = false;
  let currentMarked = false;
  for (const state of MACHINE) {
    const row = rows.get(state.step);
    // The FHIR state also completes on the Patient request alone, and fails if that fails.
    const patientRow = state.step === "request-observations" ? rows.get("request-patient") : undefined;
    const status = patientRow && row?.status === "pending" ? patientRow.status : (row?.status ?? "pending");

    if (stopped) {
      states.push({ id: state.notAttempted, status: "not-attempted", step: state.step });
      break;
    }
    if (status === "failed" || (status === "skipped" && !row?.notReached)) {
      states.push({ id: state.failed, status: "failed", step: state.step });
      stopped = true;
      continue;
    }
    if (status === "done" || status === "inferred") {
      states.push({ id: state.id, status: "done", step: state.step });
      continue;
    }
    if (status === "skipped") {
      states.push({ id: state.notAttempted, status: "not-attempted", step: state.step });
      break;
    }
    states.push({ id: state.id, status: currentMarked ? "pending" : "current", step: state.step });
    currentMarked = true;
  }
  return states;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function buildTimeline(run: WireEntry[], hasRunStart: boolean) {
  const rows = TIMELINE.map<TimelineRow>((step) => ({ step, status: "pending", entryIds: [], at: null, notReached: false }));
  const byId = new Map(rows.map((row) => [row.step.id, row]));
  let lastTouched: TimelineStepId | null = null;
  let firstFailure: { step: TimelineStepId; entry: WireEntry } | null = null;

  for (const entry of run) {
    for (const mark of entry.timeline ?? []) {
      const row = byId.get(mark.step);
      if (!row) continue;
      row.status = mark.status;
      if (!row.entryIds.includes(entry.id)) row.entryIds.push(entry.id);
      row.at = entry.timestamp;
      if (mark.status !== "active") lastTouched = mark.step;
      if (mark.status === "failed" && !firstFailure) firstFailure = { step: mark.step, entry };
    }
  }

  // A failure that was later recovered (for example a FHIR call retried successfully) is not where the flow stopped.
  const failed = firstFailure && byId.get(firstFailure.step)?.status === "failed" ? firstFailure : null;
  const stoppedAt = failed ? { step: timelineStep(failed.step), entry: failed.entry } : null;

  const core = rows.filter((row) => !row.step.optional);
  const furthest = findLastIndex(core, (row) => row.status !== "pending");
  const stopIndex = stoppedAt ? core.findIndex((row) => row.step.id === stoppedAt.step.id) : -1;
  core.forEach((row, index) => {
    if (row.status !== "pending") return;
    // Before the furthest step reached: it was passed over. Only claimable when the run's start is in the log.
    const passedOver = hasRunStart && index < furthest;
    // After the step where the flow stopped: the flow never got here.
    const afterStop = stopIndex !== -1 && index > stopIndex;
    if (passedOver || afterStop) {
      row.status = "skipped";
      row.notReached = true;
    }
  });

  return { rows, lastTouched, stoppedAt };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function buildInspector(run: WireEntry[]): InspectorModel | null {
  const found = lastDetail(run, "authorization-url");
  if (!found) return null;
  const modified =
    found.entry.demo?.modified ??
    run.find((entry) => entry.id >= found.entry.id && entry.direction === "browser-auth")?.demo?.modified ??
    null;
  return { entry: found.entry, endpoint: found.detail.endpoint, url: found.detail.url, params: found.detail.params, modified };
}

function buildState(run: WireEntry[]): StateModel {
  const check = lastDetail(run, "state-check");
  return {
    generated: lastDetail(run, "state-generated"),
    tampered: lastDetail(run, "state-tampered"),
    callback: lastDetail(run, "callback"),
    check,
    blocked:
      check?.detail.verdict !== "MATCH"
        ? findLast(run, (entry) => hasMark(entry, "token-exchange", "skipped") && entry.category === "state") ?? null
        : null,
  };
}

function buildPkce(run: WireEntry[], rows: Map<TimelineStepId, TimelineRow>): PkceModel {
  const exchange = findLast(run, (entry) => entry.direction === "client-auth" && hasMark(entry, "token-exchange")) ?? null;
  const exchangeRow = rows.get("token-exchange");
  let verdict: PkceModel["verdict"] = "pending";
  if (exchange) verdict = exchange.outcome === "ok" ? "accepted" : "rejected";
  else if (exchangeRow?.status === "skipped") verdict = "not-reached";

  return {
    verifier: lastDetail(run, "pkce-verifier"),
    challenge: lastDetail(run, "pkce-challenge"),
    authorizationRequest: findLast(run, (entry) => entry.direction === "browser-auth") ?? null,
    callback: lastDetail(run, "callback"),
    proof: lastDetail(run, "pkce-proof"),
    exchange,
    verdict,
    error: exchange && exchange.outcome !== "ok" ? providerError(exchange) : null,
  };
}

function buildTokens(run: WireEntry[]): TokenModel {
  const callback = lastDetail(run, "callback");
  const exchange = findLast(run, (entry) => entry.direction === "client-auth" && hasMark(entry, "token-exchange"));
  const stored = lastDetail(run, "tokens", (entry) => hasMark(entry, "store-tokens"));
  const fhirCalls = run.filter((entry) => entry.direction === "client-fhir" && entry.category === "fhir");
  const firstUse = fhirCalls[0];

  // The latest expiry: a forced one (demo) or a real 401 from the FHIR server.
  const expiryIndex = findLastIndex(
    run,
    (entry) =>
      (entry.demo?.modified !== undefined && entry.demo.modified.field.startsWith("access_token")) ||
      entry.injection?.id === "invalidate-access-token" ||
      (entry.direction === "client-fhir" && entry.status === 401 && !entry.step.endsWith("(retry)")),
  );
  const expiry = expiryIndex === -1 ? undefined : run[expiryIndex];
  const afterExpiry = expiryIndex === -1 ? [] : run.slice(expiryIndex + 1);
  const refresh = afterExpiry.find((entry) => entry.direction === "client-auth" && entry.category === "refresh");
  const renewed = afterExpiry.find((entry) => entry.category === "refresh" && entry.detail?.kind === "tokens");
  const retry = afterExpiry.find((entry) => entry.direction === "client-fhir" && entry.step.endsWith("(retry)"));
  const refreshFailed = afterExpiry.find((entry) => entry.category === "refresh" && entry.outcome === "error" && entry.direction === "internal");
  const lifecycle = expiry ? "pending" : "not-needed";

  const stages: Stage[] = [
    stage("code", "Authorization code", "auth", callback?.entry, callback ? (callback.detail.hasAuthorizationCode ? "done" : "failed") : "pending",
      callback?.detail.authorizationCodePreview ?? null),
    stage("exchange", "Token exchange", "node", exchange, exchange ? (exchange.outcome === "ok" ? "done" : "failed") : "pending",
      exchange ? `POST token endpoint → ${exchange.status}` : null),
    stage("issued", "Access + refresh + ID tokens", "auth", stored?.entry,
      stored ? (stored.detail.discarded ? "failed" : "done") : "pending",
      stored ? tokenSummary(stored.detail) : null),
    stage("used", "Access token used for the FHIR API", "node", firstUse,
      firstUse ? "done" : "pending", firstUse ? `${shortPath(firstUse.endpoint)} → ${firstUse.status}` : null),
    stage("expired", "Access token expires", "fhir", expiry, expiry ? "done" : "not-needed",
      expiry ? (expiry.direction === "client-fhir" ? "FHIR server answered 401 Unauthorized" : "Forced by the demo") : null),
    stage("refresh", "Refresh token used", "node", refresh ?? refreshFailed,
      refresh ? (refresh.outcome === "ok" ? "done" : "failed") : refreshFailed ? "failed" : lifecycle,
      refresh ? `POST token endpoint (grant_type=refresh_token) → ${refresh.status}` : refreshFailed ? "No refresh token stored" : null),
    stage("renewed", "New access token", "auth", renewed, renewed ? "done" : lifecycle,
      renewed ? "Stored in the server session" : null),
    stage("retried", "FHIR request retried", "node", retry, retry ? (retry.outcome === "ok" ? "done" : "failed") : lifecycle,
      retry ? `${shortPath(retry.endpoint)} → ${retry.status}` : null),
  ];
  return { stored, stages };
}

function buildPatient(run: WireEntry[]): PatientModel {
  const callback = lastDetail(run, "callback");
  const stored = lastDetail(run, "tokens", (entry) => hasMark(entry, "store-tokens"));
  const context = lastDetail(run, "patient-context");
  const request = lastDetail(run, "patient-request", (entry) => entry.detail?.kind === "patient-request" && entry.detail.resource === "Patient");
  const afterRequest = request ? run.filter((entry) => entry.id > request.entry.id) : [];
  const patientCall = findLast(afterRequest, (entry) => entry.direction === "client-fhir" && hasMark(entry, "request-patient"));
  const labsCall = findLast(run, (entry) => entry.direction === "client-fhir" && hasMark(entry, "request-observations"));
  const rendered = findLast(run, (entry) => hasMark(entry, "render"));

  const supplied = request?.detail.browserSupplied ?? null;
  const stages: Stage[] = [
    stage("authorize", "User authorizes access", "auth", callback?.entry,
      callback ? (callback.detail.hasAuthorizationCode ? "done" : "failed") : "pending",
      callback?.detail.hasAuthorizationCode ? "Inferred: the authorization server issued a code" : null),
    stage("token-context", "Token response contains patient context", "auth", stored?.entry,
      stored ? (stored.detail.hasPatientContext ? "done" : "failed") : "pending",
      stored ? (stored.detail.hasPatientContext ? "\"patient\" parameter present (back channel)" : "No \"patient\" parameter") : null),
    stage("extract", "Backend extracts patient ID", "node", context?.entry,
      context ? (context.detail.patientId ? "done" : "failed") : "pending", context?.detail.patientId ?? null),
    stage("browser-request", "Browser requests patient data", "react", request?.entry, request ? "done" : "pending",
      request ? (supplied !== null ? `GET /api/patient?patient=${supplied}` : "GET /api/patient — session cookie only") : null),
    stage("ignore", "Backend ignores browser-supplied patient ID", "node", request?.entry, request ? "done" : "pending",
      request ? (supplied !== null ? `Ignored "${supplied}"; uses ${request.detail.used ?? "the token's patient"}` : "Nothing was supplied, nothing to ignore") : null),
    stage("fhir-patient", "Backend calls FHIR Patient endpoint", "node", patientCall, patientCall ? "done" : "pending",
      patientCall ? `GET ${shortPath(patientCall.endpoint)} · Authorization: Bearer [REDACTED]` : null),
    stage("fhir-returns", "FHIR server returns the authorized patient", "fhir", patientCall,
      patientCall ? (patientCall.outcome === "ok" ? "done" : "failed") : "pending",
      patientCall ? `HTTP ${patientCall.status}` : null),
    stage("observations", "Backend requests Observation resources", "node", labsCall,
      labsCall ? (labsCall.outcome === "ok" ? "done" : "failed") : "pending",
      labsCall ? `GET ${shortPath(labsCall.endpoint)} → ${labsCall.status}` : null),
    stage("rendered", "Results displayed in React", "react", rendered, rendered ? "done" : "pending", null),
  ];
  return { context, request, stages };
}

function countChannels(run: WireEntry[]): Record<Channel, number> {
  const counts: Record<Channel, number> = { front: 0, back: 0, local: 0 };
  for (const entry of run) counts[entry.channel] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Failure demos: the evidence one demo produced
// ---------------------------------------------------------------------------

export interface DemoEvidence {
  entries: WireEntry[];
  /** The first deliberately modified request or value. */
  modified: WireEntry | null;
  /** Every deliberate change in the range. */
  modifications: WireEntry[];
  /** The actual network request sent with the modification (or carrying it). */
  request: WireEntry | null;
  /** The decisive response: the first failure, or the last network response. */
  response: WireEntry | null;
  stoppedAt: { step: TimelineStep; entry: WireEntry } | null;
}

export function demoEvidence(entries: WireEntry[], demo: DemoResult): DemoEvidence {
  return evidenceFor(
    entries.filter((entry) => entry.id >= demo.firstEntryId && (demo.lastEntryId === null || entry.id <= demo.lastEntryId)),
  );
}

/** The same evidence for any stretch of events, e.g. a request-builder or breakpoint-injection run. */
export function evidenceFor(range: WireEntry[]): DemoEvidence {
  const inRange = range.filter((entry) => !entry.breakpoint);
  const modifications = inRange.filter(isModification);
  const modified = modifications[0] ?? null;
  const fromModified = modified ? inRange.filter((entry) => entry.id >= modified.id) : inRange;
  const request =
    fromModified.find((entry) => isNetwork(entry) && isModification(entry)) ??
    fromModified.find((entry) => isNetwork(entry)) ??
    null;
  const response =
    inRange.find((entry) => entry.outcome === "error") ??
    findLast(inRange, (entry) => isNetwork(entry) && entry.status !== undefined) ??
    null;

  let stoppedAt: DemoEvidence["stoppedAt"] = null;
  for (const entry of inRange) {
    const mark = entry.timeline?.find((item) => item.status === "failed");
    if (mark) {
      stoppedAt = { step: timelineStep(mark.step), entry };
      break;
    }
  }
  return { entries: inRange, modified, modifications, request, response, stoppedAt };
}

/** A deliberately changed value, from a failure demo, a breakpoint injection or the request builder. */
export function modificationOf(entry: WireEntry): { field: string; original: string; sent: string } | null {
  return entry.demo?.modified ?? entry.injection?.modified ?? null;
}

function isModification(entry: WireEntry): boolean {
  return modificationOf(entry) !== null;
}

// ---------------------------------------------------------------------------
// Small shared helpers (also used by components)
// ---------------------------------------------------------------------------

export function actorsOf(entry: WireEntry): { from: ActorId; to: ActorId } {
  return DIRECTION_ACTORS[entry.direction];
}

/** The timeline step an event is mainly about: its first non-active mark, else its first mark. */
export function primaryStep(entry: WireEntry): TimelineStep | null {
  const marks = entry.timeline ?? [];
  const mark = marks.find((item) => item.status !== "active") ?? marks[0];
  return mark ? timelineStep(mark.step) : null;
}

/** What the event means, in plain language: its own explanation, else its step's. */
export function explain(entry: WireEntry): string {
  return entry.explanation ?? primaryStep(entry)?.explanation ?? entry.notes?.[0] ?? entry.step;
}

export function providerError(entry: WireEntry): ProviderError {
  const result = isRecord(entry.result) ? entry.result : {};
  return {
    status: entry.status,
    error: typeof result.error === "string" ? result.error : null,
    description: typeof result.error_description === "string" ? result.error_description : null,
  };
}

export function isFailure(entry: WireEntry): boolean {
  return entry.outcome === "error" || (typeof entry.status === "number" && entry.status >= 400);
}

/** "/auth/token" instead of the full sandbox URL. */
export function shortPath(endpoint?: string): string {
  if (!endpoint) return "";
  if (!/^https?:\/\//.test(endpoint)) return endpoint;
  const { pathname } = new URL(endpoint);
  const marker = pathname.search(/\/(auth|fhir)\//i);
  return marker >= 0 ? pathname.slice(marker) : "/" + pathname.split("/").filter(Boolean).slice(-2).join("/");
}

function isNetwork(entry: WireEntry): boolean {
  return entry.direction !== "internal" && entry.direction !== "browser-client" && entry.direction !== "react-client";
}

function hasMark(entry: WireEntry, step: TimelineStepId, status?: StepMarkStatus): boolean {
  return (entry.timeline ?? []).some((mark) => mark.step === step && (status === undefined || mark.status === status));
}

function lastDetail<K extends EventDetail["kind"]>(
  run: WireEntry[],
  kind: K,
  where: (entry: WireEntry) => boolean = () => true,
): Found<K> | null {
  const entry = findLast(run, (item) => item.detail?.kind === kind && where(item));
  return entry ? { entry, detail: entry.detail as DetailOf<K> } : null;
}

function stage(
  id: string,
  label: string,
  actor: ActorId,
  entry: WireEntry | undefined,
  status: StageStatus,
  note: string | null,
): Stage {
  return { id, label, actor, status, entryId: entry?.id ?? null, note };
}

function tokenSummary(detail: DetailOf<"tokens">): string {
  if (detail.discarded) return "Issued, then discarded by the demo";
  const present = [
    detail.hasAccessToken && "access",
    detail.hasRefreshToken && "refresh",
    detail.hasIdToken && "ID",
  ].filter(Boolean);
  return `${present.join(" + ")} token${present.length === 1 ? "" : "s"} · stored server-side`;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return items[i];
  return undefined;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
