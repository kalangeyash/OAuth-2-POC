import { useState } from "react";
import { PHASES, type TimelinePhase } from "../../../server/src/timeline";
import { clock } from "../flow";
import type { FlowModel, RowStatus, TimelineRow } from "../model";
import { usePresenter } from "../presenter";
import { ActorChip, ChannelBadge, PanelHead, SourceList } from "./bits";

/*
 * The 21 steps. Status comes only from marks the server put on real events;
 * "inferred" (login, consent) and "not reached" are said in words, not just colour.
 */

const MARKER: Record<RowStatus, string> = {
  pending: "",
  active: "●",
  done: "✓",
  failed: "✕",
  skipped: "⊘",
  inferred: "◌",
};

const STATUS_TEXT: Record<RowStatus, string> = {
  pending: "not yet",
  active: "in progress",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  inferred: "inferred (not observable)",
};

export function Timeline({ model }: { model: FlowModel }) {
  const { select, setReplayStep, replayStep, showSource } = usePresenter();
  const [open, setOpen] = useState<string | null>(null);
  const phases = Object.keys(PHASES) as TimelinePhase[];

  return (
    <section className="timeline" aria-label="OAuth flow timeline">
      <PanelHead
        title="Protocol timeline"
        note={`${model.completedCore} of ${model.coreTotal} core steps complete. Statuses come from real server events, never from button clicks.`}
      />
      {model.partial && (
        <p className="lede">This run began before the log's first entry (it was cleared), so earlier steps show as unknown.</p>
      )}
      {phases.map((phase) => (
        <div key={phase} className={`timeline-phase phase-${phase}`}>
          <h3 className="phase-title">{PHASES[phase]}</h3>
          <ol className="timeline-steps">
            {model.timeline
              .filter((row) => row.step.phase === phase)
              .map((row) => (
                <TimelineStepRow
                  key={row.step.id}
                  row={row}
                  open={open === row.step.id}
                  replaying={replayStep === row.step.id}
                  showSource={showSource}
                  onToggle={() => setOpen(open === row.step.id ? null : row.step.id)}
                  onReplay={() => setReplayStep(replayStep === row.step.id ? null : row.step.id)}
                  onSelect={select}
                />
              ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function TimelineStepRow({
  row,
  open,
  replaying,
  showSource,
  onToggle,
  onReplay,
  onSelect,
}: {
  row: TimelineRow;
  open: boolean;
  replaying: boolean;
  showSource: boolean;
  onToggle: () => void;
  onReplay: () => void;
  onSelect: (id: number) => void;
}) {
  const { step, status } = row;
  const statusText = row.notReached ? "not reached" : STATUS_TEXT[status];
  return (
    <li className={`tl-step is-${status}${replaying ? " is-replaying" : ""}`} aria-current={status === "active" ? "step" : undefined}>
      <button type="button" className="tl-summary" aria-expanded={open} onClick={onToggle}>
        <span className="tl-marker" aria-hidden="true">
          {MARKER[status] || step.n}
        </span>
        <span className="tl-title">
          {step.n}. {step.title}
          <span className="tl-status">{statusText}</span>
        </span>
        <span className="tl-time">{row.at ? clock(row.at) : ""}</span>
      </button>
      {open && (
        <div className="tl-details">
          <p className="tl-meta">
            <ActorChip actor={step.actor} short />
            <ChannelBadge channel={step.channel} />
          </p>
          <p>{step.explanation}</p>
          <p className="concept">{step.concept}</p>
          <p className="lede">
            <strong>Why:</strong> {step.why}
          </p>
          {row.entryIds.length > 0 ? (
            <p className="tl-events">
              Events:{" "}
              {row.entryIds.map((id) => (
                <button key={id} type="button" className="link-button" onClick={() => onSelect(id)}>
                  #{id}
                </button>
              ))}
            </p>
          ) : (
            <p className="absent">{step.observable ? "No event in this run yet." : "Happens at the authorization server: this app can only infer it."}</p>
          )}
          {showSource && <SourceList refs={step.source} env={step.env} />}
          <button type="button" className="button small" onClick={onReplay} aria-pressed={replaying}>
            {replaying ? "Back to live" : "Replay this explanation"}
          </button>
        </div>
      )}
    </li>
  );
}
