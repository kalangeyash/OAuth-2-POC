import type { FlowNarration } from "../flow";
import { FLOW_STEPS } from "../flow";

interface Props {
  narration: FlowNarration;
}

const PHASE_CLASS: Record<FlowNarration["phase"], string> = {
  "server-down": "is-down",
  unknown: "is-idle",
  idle: "is-idle",
  authorizing: "is-authorizing",
  exchanging: "is-exchanging",
  "authorized-no-data": "is-exchanging",
  "loading-data": "is-loading",
  ready: "is-ready",
  failed: "is-failed",
};

/**
 * Where the flow is right now, in a sentence, always on screen.
 *
 * Deliberately not nine numbered pips: that would be the rail again at a
 * different size. One continuous rule with one travelling marker answers "how far
 * along are we"; the sentence answers "what is happening"; the rail lists the steps.
 */
export function FlowBand({ narration }: Props) {
  const total = FLOW_STEPS.length;
  const progress = Math.round((narration.completed / total) * 100);

  return (
    <div
      className={`flow-band ${PHASE_CLASS[narration.phase]}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={narration.busy || undefined}
    >
      <div>
        <p className="band-headline">{narration.headline}</p>
        <p className="band-sentence">{narration.sentence}</p>
      </div>
      <div className="band-progress">
        <span className="band-count">
          {narration.completed} of {total} steps done
        </span>
        <span
          className="band-rule"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={narration.completed}
          aria-label="OAuth flow progress"
        >
          <span className="band-rule-fill" style={{ ["--progress" as string]: `${progress}%` }} />
        </span>
      </div>
    </div>
  );
}
