import {
  BUILDER_MODS,
  INJECTIONS,
  LAB_MODES,
  timelineStep,
  type BuilderModId,
  type InjectionId,
  type LabBreakpoint,
  type LabMode,
  type LabState,
  type Modification,
  type TimelineStepId,
} from "./timeline.js";
import { record, type WireInput } from "./wireLog.js";

/*
 * THE PROTOCOL DEBUGGER.
 *
 * In "run" mode (the default) nothing here pauses, and the app behaves exactly as
 * before. In "step" and "messages" mode, the OAuth code calls gate() before each
 * stage. gate() records a "before send" event (the exact, redacted request that is
 * about to go out), then HOLDS the real HTTP request that is running the flow (the
 * popup's /auth/login or /callback navigation, or React's /api/patient fetch)
 * until the presenter decides:
 *
 *   send   run exactly this one stage, then pause again at the next
 *   run    stop pausing: finish the flow like the normal app
 *   abort  stop the flow here (it ends with a clear "stopped by presenter" error)
 *
 * A decision can carry one injection (tamper with state, drop the PKCE verifier,
 * corrupt the refresh token…). Nothing is simulated: the injected change goes into
 * the real request, and the real server's real answer is what the audience sees.
 *
 * Single presenter, single process: one breakpoint at a time, others queue behind it.
 */

/** A pause left unanswered this long ends the flow instead of holding a request forever. */
const BREAKPOINT_TIMEOUT_MS = 10 * 60 * 1000;

export class LabStoppedError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "LabStoppedError";
  }
}

export interface GateRequest {
  stage: TimelineStepId;
  /** "network": a real message is about to be sent. "internal": a step inside Node is about to run. */
  kind: "network" | "internal";
  /** Short name of what is about to happen. Defaults to the timeline step's title. */
  title?: string;
  /** The request about to be sent, for the "before send" inspector. record() redacts it. */
  preview?: Omit<WireInput, "step" | "outcome">;
  injections?: InjectionId[];
}

export interface GateDecision {
  inject?: InjectionId;
}

type Decision = { action: "send" | "run" | "abort"; inject?: InjectionId };

let mode: LabMode = "run";
let current: { breakpoint: LabBreakpoint; resolve: (decision: Decision) => void } | null = null;
let waiting = 0;
let nextBreakpointId = 1;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(state: LabState) => void>();

export function labState(): LabState {
  return { mode, breakpoint: current?.breakpoint ?? null, queued: waiting };
}

export function subscribeLab(listener: (state: LabState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLabMode(next: LabMode): LabState {
  if (!(next in LAB_MODES)) throw new Error(`Unknown lab mode: ${next}`);
  mode = next;
  // Switching to "run" releases the current pause: the flow finishes by itself.
  if (next === "run" && current) current.resolve({ action: "run" });
  publish();
  return labState();
}

/**
 * The presenter's answer to the current breakpoint. Returns false if that
 * breakpoint is no longer the current one (already answered, or timed out).
 */
export function decide(breakpointId: number, action: Decision["action"], inject?: InjectionId): boolean {
  if (!current || current.breakpoint.id !== breakpointId) return false;
  if (inject !== undefined && !current.breakpoint.injections.includes(inject)) {
    throw new Error(`"${inject}" cannot be injected at this step.`);
  }
  current.resolve({ action, inject });
  return true;
}

/** Ends any pause (the flow stops) and returns to run mode. Used by "Reset". */
export function resetLab(): void {
  mode = "run";
  current?.resolve({ action: "abort" });
  publish();
}

/**
 * Called by the OAuth code before a stage. Resolves immediately in run mode, or
 * for internal stages in "messages" mode. Otherwise waits for the presenter.
 */
export function gate(request: GateRequest): Promise<GateDecision> {
  if (!shouldPause(request.kind)) return Promise.resolve({});
  // Waiting for its turn until the pause ahead of it (if any) is answered.
  waiting += 1;
  const turn = queue.then(() => {
    waiting -= 1;
    return pause(request);
  });
  queue = turn.catch(() => undefined);
  return turn;
}

function shouldPause(kind: GateRequest["kind"]): boolean {
  return mode === "step" || (mode === "messages" && kind === "network");
}

async function pause(request: GateRequest): Promise<GateDecision> {
  // The mode may have changed to "run" while this pause was queued.
  if (!shouldPause(request.kind)) return {};

  const step = timelineStep(request.stage);
  const title = request.title ?? step.title;
  const id = nextBreakpointId++;
  const injections = request.injections ?? [];
  const { preview } = request;

  const entry = record({
    direction: "internal",
    category: "lab",
    ...preview,
    step: request.kind === "network" ? `⏸ Before send: ${title}` : `⏸ Paused before: ${title}`,
    timeline: [{ step: request.stage, status: "active" }],
    breakpoint: { id, kind: request.kind, stage: request.stage, injections },
    outcome: "info",
    explanation:
      request.kind === "network"
        ? `Paused. The backend has built this request but has NOT sent it. Inspect it, then click Send. (${step.explanation})`
        : `Paused before "${step.title}". Nothing has happened yet. Click Next step to let the backend run it. (${step.explanation})`,
    notes: [
      "Debugger breakpoint: the real HTTP request that is running this flow is being held open until you decide.",
      ...injections.map((injection) => `Can inject: ${INJECTIONS[injection].label}.`),
    ],
  });

  const breakpoint: LabBreakpoint = {
    id,
    stage: request.stage,
    title,
    kind: request.kind,
    entryId: entry.id,
    injections,
    createdAt: entry.timestamp,
  };

  const decision = await new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => resolve({ action: "abort" }), BREAKPOINT_TIMEOUT_MS);
    current = {
      breakpoint,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    };
    publish();
  });
  current = null;
  if (decision.action === "run") mode = "run";
  publish();

  if (decision.action === "abort") {
    record({
      direction: "internal",
      category: "lab",
      step: `Stopped by the presenter before: ${title}`,
      timeline: [{ step: request.stage, status: "failed" }],
      outcome: "error",
      explanation: `The presenter stopped the flow before "${title}". Nothing after this point was sent.`,
      notes: ["Debugger: the held request is released with an error, so the flow ends here."],
    });
    throw new LabStoppedError(title, `Stopped by the presenter before "${title}".`);
  }
  return decision.inject ? { inject: decision.inject } : {};
}

/**
 * Records a deliberate change (a breakpoint injection or a request-builder change)
 * as its own event, so the audience sees exactly what was altered before the real
 * request goes out. Values are previews or descriptions, never the secret itself.
 */
export function recordInjection(id: InjectionId | BuilderModId, modified: Modification): void {
  const injection = id in INJECTIONS ? INJECTIONS[id as InjectionId] : undefined;
  const builder = id in BUILDER_MODS ? BUILDER_MODS[id as BuilderModId] : undefined;
  const label = injection?.label ?? builder?.label ?? id;
  record({
    direction: "internal",
    category: "lab",
    step: `INJECTED: ${label}`,
    injection: { id, label, modified },
    outcome: "info",
    explanation: `Failure injection: ${injection?.effect ?? builder?.effect ?? label}`,
    securityConcept: injection?.concept ?? builder?.expect,
    source: [{ file: "server/src/lab.ts", symbol: "recordInjection" }],
    notes: ["This change goes into the real request. Whatever happens next is the real server's real answer."],
  });
}

function publish(): void {
  const state = labState();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error(`[lab] listener failed: ${(error as Error).message}`);
    }
  }
}

/** Test helper: back to a clean run-mode debugger. */
export function resetLabForTests(): void {
  current?.resolve({ action: "abort" });
  current = null;
  mode = "run";
  waiting = 0;
  queue = Promise.resolve();
}
