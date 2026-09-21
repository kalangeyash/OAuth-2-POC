/*
 * The nine steps of the flow, and the one function that turns raw server state
 * into a sentence a presenter can read out.
 *
 * The step LABELS live here; the step STATUSES come from the server as a
 * positional nine-element array (server/src/session.ts, FLOW_STEP_COUNT = 9).
 * The indices are the contract between the two.
 */
import type { StepStatus, TeachingError } from "./types";

export type ActorId = "browser" | "node" | "auth" | "fhir";

export interface FlowStep {
  /** Full title, used in the rail. */
  title: string;
  /** Condensed title, used where space is tight. */
  shortTitle: string;
  /** Who performs this step. */
  where: string;
  /** Which actor the step belongs to, for colour reinforcement. */
  actor: ActorId;
}

export const FLOW_STEPS: FlowStep[] = [
  { title: "Connect", shortTitle: "Connect", where: "Browser → Node client", actor: "browser" },
  { title: "Redirect to /authorize", shortTitle: "Redirect", where: "Browser → Authorization server", actor: "auth" },
  { title: "Login", shortTitle: "Login", where: "At the authorization server, not visible to this app", actor: "auth" },
  { title: "Consent", shortTitle: "Consent", where: "At the authorization server, not visible to this app", actor: "auth" },
  {
    title: "Redirect back with authorization code",
    shortTitle: "Code returns",
    where: "Authorization server → Browser → Node client",
    actor: "auth",
  },
  { title: "Token exchange", shortTitle: "Token exchange", where: "Node client → Authorization server", actor: "auth" },
  { title: "Token received", shortTitle: "Token received", where: "Authorization server → Node client", actor: "auth" },
  { title: "FHIR API call", shortTitle: "FHIR call", where: "Node client → FHIR server", actor: "fhir" },
  { title: "Data rendered", shortTitle: "Rendered", where: "Node client → Browser", actor: "node" },
];

// Must match FLOW_STEP_COUNT in server/src/session.ts.
if (FLOW_STEPS.length !== 9) throw new Error("FLOW_STEPS must describe exactly nine steps");

export const STATUS_TEXT: Record<StepStatus, string> = {
  done: "done",
  current: "current step",
  pending: "not started",
  failed: "failed",
};

export type FlowPhase =
  | "server-down"
  | "unknown"
  | "idle"
  | "authorizing"
  | "exchanging"
  | "authorized-no-data"
  | "loading-data"
  | "ready"
  | "failed";

export interface FlowNarration {
  phase: FlowPhase;
  /** 1-based step to look at, or null. */
  activeStep: number | null;
  failedStep: number | null;
  /** Short, bold. Four to twelve words. */
  headline: string;
  /** One plain-language sentence, present tense. */
  sentence: string;
  /** Steps completed, for the progress rule. */
  completed: number;
  busy: boolean;
}

export interface FlowInput {
  flow: StepStatus[];
  awaitingAuthorizationServer: boolean;
  authorized: boolean;
  lastError: TeachingError | null;
  serverReachable: boolean;
  /** True once the session poll has answered at least once. */
  sessionLoaded: boolean;
  loadingData: boolean;
  hasData: boolean;
}

/*
 * Order matters and is the design:
 *
 *  - "failed" is tested before "authorizing", because a failed demo leaves a
 *    pendingAuth behind; the other way round, a failure would read as "waiting
 *    at the authorization server" forever.
 *  - "authorizing" is tested before anything reads flow[2] or flow[3]. Login and
 *    consent happen at the authorization server where this app cannot observe
 *    them, so they are never individually marked done. "The browser is over
 *    there" is not derivable from the flow array at all — it is exactly
 *    awaitingAuthorizationServer, and it is a first-class state, not a gap.
 */
export function describeFlow(input: FlowInput): FlowNarration {
  const { flow, authorized, lastError, serverReachable, sessionLoaded } = input;
  const completed = flow.filter((status) => status === "done").length;
  const failedIndex = flow.findIndex((status) => status === "failed");
  const currentIndex = flow.findIndex((status) => status === "current");

  const base = { completed, failedStep: null as number | null, busy: false };

  if (!serverReachable) {
    return {
      ...base,
      phase: "server-down",
      activeStep: null,
      headline: "The Node server is not answering",
      sentence:
        "Nothing can happen until the OAuth client is running. Start it with npm run dev — this page reconnects on its own.",
    };
  }

  if (!sessionLoaded) {
    return {
      ...base,
      phase: "unknown",
      activeStep: null,
      headline: "Checking with the Node server",
      sentence: "Reading the current state of the flow.",
      busy: true,
    };
  }

  if (failedIndex !== -1) {
    const step = FLOW_STEPS[failedIndex];
    return {
      ...base,
      phase: "failed",
      activeStep: failedIndex + 1,
      failedStep: failedIndex + 1,
      headline: `Stopped at step ${failedIndex + 1}: ${step.title}`,
      sentence: lastError?.message ?? "The flow stopped here. The wire log below shows what the server actually received.",
    };
  }

  if (input.awaitingAuthorizationServer) {
    return {
      ...base,
      phase: "authorizing",
      activeStep: 3,
      headline: "Your browser is at the authorization server",
      sentence:
        "Logging in and approving happen there, not here. This app never sees the password or the consent screen — it is waiting for the browser to come back with an authorization code.",
      busy: true,
    };
  }

  if (authorized && input.loadingData) {
    return {
      ...base,
      phase: "loading-data",
      activeStep: 8,
      headline: "Calling the FHIR API",
      sentence:
        "The Node server is sending the access token to the FHIR server. Your browser sent only its session cookie — no token, and no patient ID.",
      busy: true,
    };
  }

  if (authorized && input.hasData) {
    return {
      ...base,
      phase: "ready",
      activeStep: 9,
      headline: "All nine steps completed",
      sentence: "Patient data is on screen, and every token stayed on the Node server the whole time.",
    };
  }

  if (authorized) {
    return {
      ...base,
      phase: "authorized-no-data",
      activeStep: 8,
      headline: "Tokens are held by the Node server",
      sentence:
        "The access token never reaches the browser. Load the patient to watch the Node server call the FHIR API with it.",
    };
  }

  if (currentIndex >= 4 && currentIndex <= 6) {
    return {
      ...base,
      phase: "exchanging",
      activeStep: currentIndex + 1,
      headline: "Trading the code for a token",
      sentence:
        "The browser is back with an authorization code. The Node server is calling the token endpoint directly — back channel, browser not involved.",
      busy: true,
    };
  }

  return {
    ...base,
    phase: "idle",
    activeStep: 1,
    headline: "Nothing has started yet",
    sentence:
      "Click Connect. The Node server builds an authorization request, then sends your browser to the sandbox to log in.",
  };
}
