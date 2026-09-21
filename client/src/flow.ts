/*
 * "What is happening right now?" — the one function that turns the live event
 * stream (plus the debugger's state) into a sentence a presenter can read out.
 *
 * Everything comes from real events: the latest one, the debugger breakpoint the
 * server is holding, or a completed step the presenter chose to replay (and then
 * it is labelled REPLAY, never passed off as live).
 */
import { ACTORS, CHANNELS, timelineStep, type ActorId, type Channel, type TimelineStep } from "../../server/src/timeline";
import { actorsOf, explain, isFailure, primaryStep, type FlowModel } from "./model";
import type { LabState, TeachingError, TimelineStepId, WireEntry } from "./types";

export type NowMode = "live" | "paused-at-breakpoint" | "replay" | "frozen" | "waiting" | "idle" | "server-down" | "connecting";
export type NowTone = "neutral" | "auth" | "fhir" | "node" | "success" | "danger" | "warning";

export interface Narration {
  mode: NowMode;
  tone: NowTone;
  /** "RIGHT NOW", "PAUSED AT A BREAKPOINT", "REPLAY · recorded 14:03:22 — not live", … */
  kicker: string;
  /** "Step 13 of 21 · Exchange authorization code for tokens" */
  stepLabel: string | null;
  headline: string;
  sentence: string;
  actor: ActorId | null;
  channel: Channel | null;
  entry: WireEntry | null;
}

export interface NowInput {
  entries: WireEntry[];
  model: FlowModel;
  lab: LabState;
  serverReachable: boolean;
  loaded: boolean;
  frozen: boolean;
  bufferedCount: number;
  replayStep: TimelineStepId | null;
  awaitingAuthorizationServer: boolean;
  lastError: TeachingError | null;
}

export function describeNow(input: NowInput): Narration {
  const base = { stepLabel: null, actor: null, channel: null, entry: null } as const;

  if (!input.serverReachable) {
    return {
      ...base,
      mode: "server-down",
      tone: "warning",
      kicker: "NODE SERVER NOT ANSWERING",
      headline: "The OAuth client is not running",
      sentence: "Nothing can happen until the Node server is up. Start it with npm run dev — this page reconnects on its own.",
    };
  }
  if (!input.loaded) {
    return {
      ...base,
      mode: "connecting",
      tone: "neutral",
      kicker: "CONNECTING",
      headline: "Opening the live event stream",
      sentence: "Reading the protocol events the Node server has recorded so far.",
    };
  }

  if (input.replayStep) {
    const step = timelineStep(input.replayStep);
    const row = input.model.timeline.find((item) => item.step.id === input.replayStep);
    const recorded = row?.at ? clock(row.at) : "not recorded in this run";
    return {
      mode: "replay",
      tone: "neutral",
      kicker: `REPLAY · recorded ${recorded} — not live`,
      stepLabel: stepLabel(step),
      headline: step.title,
      sentence: step.explanation,
      actor: step.actor,
      channel: step.channel,
      entry: null,
    };
  }

  const breakpoint = input.lab.breakpoint;
  if (breakpoint) {
    const step = timelineStep(breakpoint.stage);
    const entry = input.entries.find((item) => item.id === breakpoint.entryId) ?? null;
    return {
      mode: "paused-at-breakpoint",
      tone: "warning",
      kicker: breakpoint.kind === "network" ? "PAUSED BEFORE SEND" : "PAUSED BEFORE A STEP",
      stepLabel: stepLabel(step),
      headline: breakpoint.title,
      sentence:
        breakpoint.kind === "network"
          ? `The backend built this request and is holding it. Nothing has been sent. ${step.explanation}`
          : `Nothing has happened yet: the backend is waiting for Next step. ${step.explanation}`,
      actor: step.actor,
      channel: step.channel,
      entry,
    };
  }

  const latest = input.entries.at(-1);
  if (!latest) {
    return {
      ...base,
      mode: "idle",
      tone: "neutral",
      kicker: "RIGHT NOW",
      headline: "Nothing has happened yet",
      sentence:
        "Choose a scenario and press Run. The Node server will build an authorization request, then send the browser to the sandbox to log in.",
    };
  }

  const frozenPrefix = input.frozen
    ? `DISPLAY FROZEN${input.bufferedCount > 0 ? ` · ${input.bufferedCount} new event${input.bufferedCount === 1 ? "" : "s"} waiting` : ""}`
    : null;

  // The browser is at the authorization server: the most important moment this app cannot see.
  const atAuthServer =
    input.awaitingAuthorizationServer && input.model.active.includes("login") && latest.direction === "browser-auth";
  if (atAuthServer) {
    const login = timelineStep("login");
    return {
      mode: "waiting",
      tone: "auth",
      kicker: frozenPrefix ?? "RIGHT NOW · at the authorization server",
      stepLabel: `${stepLabel(login)} and ${stepLabel(timelineStep("consent"))}`,
      headline: "The user is logging in and consenting",
      sentence: `${login.explanation} This app is waiting for the browser to come back with an authorization code.`,
      actor: "auth",
      channel: "front",
      entry: latest,
    };
  }

  const step = primaryStep(latest);
  const { from } = actorsOf(latest);
  return {
    mode: input.frozen ? "frozen" : "live",
    tone: isFailure(latest) ? "danger" : toneFor(latest),
    kicker: frozenPrefix ?? "RIGHT NOW",
    stepLabel: step ? stepLabel(step) : null,
    headline: latest.step,
    sentence: explain(latest),
    actor: from,
    channel: latest.channel,
    entry: latest,
  };
}

export function stepLabel(step: TimelineStep): string {
  return `Step ${step.n} of 21 · ${step.title}`;
}

export function actorName(actor: ActorId): string {
  return ACTORS[actor].name;
}

export function channelLabel(channel: Channel): string {
  return CHANNELS[channel].label;
}

export function clock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function toneFor(entry: WireEntry): NowTone {
  if (entry.direction === "client-fhir") return "fhir";
  if (entry.direction === "client-auth" || entry.channel === "front") return "auth";
  if (entry.outcome === "ok") return "success";
  return "node";
}
