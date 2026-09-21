import type { Narration } from "../flow";
import type { FlowModel } from "../model";
import { usePresenter } from "../presenter";
import { ActorChip, ChannelBadge } from "./bits";

/*
 * "What is happening right now?" — always on screen, in words a non-expert can
 * follow, with the protocol state machine underneath so the room can see how far
 * the flow got and exactly where it stopped.
 */
export function NowPanel({ narration, model }: { narration: Narration; model: FlowModel }) {
  const { select, setReplayStep, detailLevel } = usePresenter();
  // Essentials: the completed states collapse into one chip; what is current, failed or next stays visible.
  const states = model.machine;
  const firstOpen = states.findIndex((state) => state.status !== "done");
  const condensed = detailLevel === "essentials" && firstOpen > 2;
  const shown = condensed ? states.slice(firstOpen - 1, firstOpen + 3) : states;
  const hiddenDone = condensed ? firstOpen - 1 : 0;
  return (
    <section
      className={`now tone-${narration.tone} mode-${narration.mode}`}
      aria-label="What is happening right now"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="now-main">
        <p className="now-kicker">
          <span>{narration.kicker}</span>
          {narration.stepLabel && <span className="now-step">{narration.stepLabel}</span>}
        </p>
        <p className="now-headline">{narration.headline}</p>
        <p className="now-sentence">{narration.sentence}</p>
      </div>
      <div className="now-foot">
        <p className="now-meta">
          {narration.actor && <ActorChip actor={narration.actor} short />}
          {narration.channel && <ChannelBadge channel={narration.channel} />}
          {narration.entry && (
            <button type="button" className="link-button" onClick={() => select(narration.entry!.id)}>
              inspect #{narration.entry.id}
            </button>
          )}
          {narration.mode === "replay" && (
            <button type="button" className="button small" onClick={() => setReplayStep(null)}>
              Back to live
            </button>
          )}
        </p>
        <ol className="machine" aria-label="Protocol state machine">
        {hiddenDone > 0 && (
          <li className="machine-state is-done is-collapsed">
            ✓ {hiddenDone} state{hiddenDone === 1 ? "" : "s"} complete
          </li>
        )}
        {shown.map((state, index) => (
          <li key={`${state.id}-${index}`} className={`machine-state is-${state.status}`}>
            <span className="visually-hidden">{state.status}: </span>
            {state.id}
          </li>
        ))}
        </ol>
      </div>
    </section>
  );
}
