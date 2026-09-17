import type { StepStatus } from "../types";

const STEPS = [
  { title: "Connect", where: "Browser → Node client" },
  { title: "Redirect to /authorize", where: "Browser → Authorization server" },
  { title: "Login", where: "At the authorization server, not visible to this app" },
  { title: "Consent", where: "At the authorization server, not visible to this app" },
  { title: "Redirect back with authorization code", where: "Authorization server → Browser → Node client" },
  { title: "Token exchange", where: "Node client → Authorization server" },
  { title: "Token received", where: "Authorization server → Node client" },
  { title: "FHIR API call", where: "Node client → FHIR server" },
  { title: "Data rendered", where: "Node client → Browser" },
];

const STATUS_TEXT: Record<StepStatus, string> = {
  done: "done",
  current: "current step",
  pending: "not started",
  failed: "failed",
};

interface Props {
  steps: StepStatus[];
  awaitingAuthorizationServer: boolean;
}

export function FlowStepper({ steps, awaitingAuthorizationServer }: Props) {
  const renderStep = (index: number) => {
    const status = steps[index] ?? "pending";
    const marker = status === "done" ? "✓" : status === "failed" ? "✕" : String(index + 1);
    return (
      <li key={index} className={`step ${status}`} aria-current={status === "current" ? "step" : undefined}>
        <span className="step-marker" aria-hidden="true">
          {marker}
        </span>
        <span>
          <span className="step-title">
            {index + 1}. {STEPS[index].title}
            <span className="visually-hidden"> ({STATUS_TEXT[status]})</span>
          </span>
          <span className="step-where">{STEPS[index].where}</span>
        </span>
      </li>
    );
  };

  return (
    <nav aria-label="OAuth flow progress">
      <h2 className="pane-title">OAuth flow</h2>
      {awaitingAuthorizationServer && (
        <p className="stepper-note">An authorization request is waiting for the browser to come back.</p>
      )}
      <ol className="steps">
        {[0, 1, 2, 3, 4].map(renderStep)}
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
