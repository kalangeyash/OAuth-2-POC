import { FLOW_STEPS, STATUS_TEXT } from "../flow";
import type { StepStatus } from "../types";

interface Props {
  steps: StepStatus[];
  /** False until the session poll has answered once: "not started" would be a guess. */
  known: boolean;
}

/**
 * The nine steps, named, with the actor that performs each. Answers "what are the
 * steps"; the flow band answers "where are we now".
 */
export function FlowRail({ steps, known }: Props) {
  const renderStep = (index: number) => {
    const status: StepStatus = steps[index] ?? "pending";
    const step = FLOW_STEPS[index];
    const isLast = index === FLOW_STEPS.length - 1;
    const marker = status === "done" ? "✓" : status === "failed" ? "✕" : String(index + 1);

    return (
      <li
        key={step.title}
        className={["step", status, isLast ? "is-last" : ""].filter(Boolean).join(" ")}
        aria-current={status === "current" ? "step" : undefined}
      >
        <span className="step-marker" aria-hidden="true">
          {marker}
        </span>
        <span>
          <span className="step-title">
            {index + 1}. {step.title}
            <span className="visually-hidden"> ({STATUS_TEXT[status]})</span>
          </span>
          <span className="step-where">{step.where}</span>
        </span>
      </li>
    );
  };

  return (
    <nav aria-label="OAuth flow progress" aria-busy={!known || undefined}>
      <h2 className="pane-title">OAuth flow</h2>
      <ol className={known ? "steps" : "steps is-unknown"}>
        {[0, 1, 2, 3, 4].map(renderStep)}
        {/* Steps 6 and 7 are the back channel: the browser is not involved. The
            group's left edge carries the connector through this block. */}
        <li className="back-channel">
          <span className="group-label">BACK CHANNEL</span>
          <ol className="steps">{[5, 6].map(renderStep)}</ol>
        </li>
        {[7, 8].map(renderStep)}
      </ol>
      <p className="stepper-footnote">Updated from events on the Node server, not from button clicks.</p>
    </nav>
  );
}
