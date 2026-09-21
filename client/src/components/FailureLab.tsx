import { ACTORS } from "../../../server/src/timeline";
import { actorsOf, demoEvidence, evidenceFor, modificationOf, providerError, shortPath, type DemoEvidence, type FlowModel } from "../model";
import { usePresenter } from "../presenter";
import { SCENARIOS, type Scenario } from "../scenarios";
import type { DemoId, DemoResult, SessionInfo, WireEntry } from "../types";
import { PanelHead } from "./bits";

/*
 * THE FAILURE LAB. Ten scenarios; nine run real requests against the real sandbox.
 * Each result answers eight questions from the real events, never from a script:
 * what changed, what should have happened, the modified request, the request
 * actually sent, the response, where the flow stopped, why it matters, and the concept.
 *
 * A refusal by the party that should refuse is the control WORKING: green.
 * Amber is an acceptance the specification says should not have happened.
 */

type Tone = "defended" | "accepted" | "recovered" | "failed";

const VERDICTS: Partial<Record<DemoId, { rejected: [string, Tone]; accepted: [string, Tone] }>> = {
  "redirect-mismatch": {
    rejected: ["✓ The mismatch was refused, as the specification requires", "defended"],
    accepted: ["! The provider allowed the mismatch — and that is the problem", "accepted"],
  },
  "tamper-state": {
    rejected: ["✓ Our server stopped the flow before using the code", "defended"],
    accepted: ["! The mismatch was not caught — and that is the problem", "accepted"],
  },
  "replay-code": {
    rejected: ["✓ The code was refused the second time, as the RFC requires", "defended"],
    accepted: ["! The sandbox accepted the replay — and that is the problem", "accepted"],
  },
  "no-pkce-verifier": {
    rejected: ["✓ The token endpoint refused it, as PKCE requires", "defended"],
    accepted: ["! The code worked without its verifier — and that is the problem", "accepted"],
  },
  "broad-scope": {
    rejected: ["✓ The broad scope was cut down to what was needed", "defended"],
    accepted: ["! Granted in full, exactly as asked — and that is the problem", "accepted"],
  },
  "force-expiry": {
    rejected: ["✕ Could not recover: re-authentication required", "failed"],
    accepted: ["✓ Rejected, then recovered without a new login", "recovered"],
  },
  "refresh-failure": {
    rejected: ["✓ The bad refresh token was refused; the user must reconnect", "defended"],
    accepted: ["! A refresh token the server never issued was accepted", "accepted"],
  },
  "refresh-disabled": {
    rejected: ["✓ No refresh possible: the user must reconnect, as expected", "defended"],
    accepted: ["? Access was renewed without a refresh token", "accepted"],
  },
};

interface Props {
  scenario: Scenario;
  onSelect: (scenario: Scenario) => void;
  onRun: () => void;
  onReset: () => void;
  runDisabledReason: string | null;
  session: SessionInfo | null;
  entries: WireEntry[];
  model: FlowModel;
}

export function FailureLab({ scenario, onSelect, onRun, onReset, runDisabledReason, session, entries, model }: Props) {
  const demo = session?.demo ?? null;
  return (
    <section className="failure-lab" aria-label="Failure lab">
      <PanelHead title="Failure lab" note="Each scenario changes one thing and runs the real protocol. The real servers decide what happens." />
      <div className="scenario-grid">
        <ol className="scenario-list">
          {SCENARIOS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`scenario-card${item.id === scenario.id ? " is-selected" : ""}${demo && item.demo === demo.id ? " is-last-run" : ""}`}
                aria-pressed={item.id === scenario.id}
                onClick={() => onSelect(item)}
              >
                <span className="scenario-n">{item.n}</span>
                <span className="scenario-title">{item.title}</span>
                {item.run.kind === "illustration" && <span className="scenario-tag">illustration</span>}
                {item.needsConnection && <span className="scenario-tag">needs connection</span>}
              </button>
            </li>
          ))}
        </ol>

        <div className="scenario-detail">
          <h3>
            {scenario.n}. {scenario.title}
          </h3>
          <dl className="facts-list">
            <div>
              <dt>Initial conditions</dt>
              <dd>{scenario.initial}</dd>
            </div>
            <div>
              <dt>Modified value or attack</dt>
              <dd>{scenario.attack}</dd>
            </div>
            <div>
              <dt>Expected failure point</dt>
              <dd>{scenario.expectedStop}</dd>
            </div>
            <div>
              <dt>Security concept</dt>
              <dd>{scenario.concept}</dd>
            </div>
            <div>
              <dt>Correct mitigation</dt>
              <dd>{scenario.mitigation}</dd>
            </div>
          </dl>
          <div className="builder-actions">
            <button type="button" className="button primary" onClick={onRun} disabled={runDisabledReason !== null} title={runDisabledReason ?? undefined}>
              {scenario.run.kind === "illustration" ? "Show the comparison" : "▶ Run this scenario"}
            </button>
            <button type="button" className="button" onClick={onReset}>
              ⟲ Reset scenario
            </button>
            {runDisabledReason && <span className="lede">{runDisabledReason}</span>}
          </div>

          <ScenarioResult scenario={scenario} demo={demo} entries={entries} model={model} />
        </div>
      </div>
    </section>
  );
}

function ScenarioResult({ scenario, demo, entries, model }: { scenario: Scenario; demo: DemoResult | null; entries: WireEntry[]; model: FlowModel }) {
  if (scenario.run.kind === "illustration") return <SpaVersusBff />;

  if (scenario.demo) {
    if (!demo || demo.id !== scenario.demo) return <p className="absent">Not run yet. Press Run: the result appears here from the real events.</p>;
    const evidence = demoEvidence(entries, demo);
    const catalogue = VERDICTS[demo.id];
    const verdict =
      demo.status === "running" || !catalogue
        ? (["… Running — waiting for the real responses", "running"] as const)
        : demo.rejected
          ? catalogue.rejected
          : catalogue.accepted;
    return (
      <EightParts
        tone={verdict[1]}
        verdictText={verdict[0]}
        changed={demo.whatWeChanged}
        expected={demo.expected}
        evidence={evidence}
        outcome={demo.outcome}
        why={demo.status === "running" ? WAITING : (demo.why ?? "")}
        concept={demo.concept}
        mitigation={scenario.mitigation}
      />
    );
  }

  if (scenario.run.kind === "patient-override") {
    const request = model.patient.request;
    if (!request || request.detail.browserSupplied === null) return <p className="absent">Not run yet.</p>;
    const fhirCall = model.real.find(
      (entry) => entry.id > request.entry.id && entry.direction === "client-fhir" && entry.timeline?.some((mark) => mark.step === "request-patient"),
    );
    const evidence: DemoEvidence = { entries: [], modified: request.entry, modifications: [request.entry], request: fhirCall ?? null, response: fhirCall ?? null, stoppedAt: null };
    return (
      <EightParts
        tone="defended"
        verdictText={`✓ Ignored: the backend read patient ${request.detail.used ?? "?"} from the token context`}
        changed={`The browser added ?patient=${request.detail.browserSupplied} to its request.`}
        modifiedOverride={{ field: "patient (query parameter)", original: "(none: the patient comes from the token)", sent: request.detail.browserSupplied }}
        expected="The backend requests only the patient named in the token response."
        evidence={evidence}
        outcome={fhirCall ? `The FHIR request went to ${shortPath(fhirCall.endpoint)} (the authorized patient), HTTP ${fhirCall.status}.` : null}
        why="If the backend trusted a patient ID from the browser, any user could read any patient's record by editing a URL (horizontal privilege escalation)."
        concept={scenario.concept}
        mitigation={scenario.mitigation}
      />
    );
  }

  // Connect, the request builder or breakpoint injections: judge this run by its own events.
  if (!model.runStart) return <p className="absent">Not run yet.</p>;
  const evidence = evidenceFor(model.run);
  const stopped = model.stoppedAt;
  return (
    <EightParts
      tone={stopped ? (model.modifications.length ? "defended" : "failed") : "recovered"}
      verdictText={stopped ? `Stopped at step ${stopped.step.n}: ${stopped.step.title}` : "✓ Completed without stopping"}
      changed={
        model.modifications.length
          ? model.modifications.map((entry) => modificationOf(entry)?.field).join(", ")
          : "Nothing: the unmodified protocol."
      }
      expected="Every step succeeds and the tokens stay on the server."
      evidence={evidence}
      outcome={null}
      why={stopped ? stopped.step.why : "Every security check passed, so every step ran."}
      concept={stopped ? stopped.step.concept : scenario.concept}
      mitigation={scenario.mitigation}
    />
  );
}

const WAITING =
  "Waiting for the browser to come back from the authorization server. If it shows an error page instead of redirecting back, that page is the result: a server must not redirect to a URI it cannot verify.";

function EightParts(props: {
  tone: Tone | "running";
  verdictText: string;
  changed: string;
  expected: string;
  evidence: DemoEvidence;
  outcome: string | null;
  why: string;
  concept: string;
  mitigation: string;
  modifiedOverride?: { field: string; original: string; sent: string };
}) {
  const { select } = usePresenter();
  const { evidence } = props;
  const modified = props.modifiedOverride ?? (evidence.modified ? modificationOf(evidence.modified) : null);
  const response = evidence.response;
  const error = response ? providerError(response) : null;

  const link = (entry: WireEntry | null, text: string) =>
    entry ? (
      <button type="button" className="link-button" onClick={() => select(entry.id)}>
        {text}
      </button>
    ) : (
      <span className="absent">not in the log</span>
    );

  return (
    <div className={`demo-result is-${props.tone}`} aria-live="polite">
      <p className="demo-verdict">{props.verdictText}</p>
      <ol className="eight">
        <li>
          <h4>1 · What was changed</h4>
          <p>{props.changed}</p>
        </li>
        <li>
          <h4>2 · Original expected behaviour</h4>
          <p>{props.expected}</p>
        </li>
        <li>
          <h4>3 · The modified request</h4>
          {modified ? (
            <p>
              <code>{modified.field}</code>: <span className="modified-from">{modified.original}</span> →{" "}
              <span className="modified-to">{modified.sent}</span> {link(evidence.modified, `#${evidence.modified?.id}`)}
            </p>
          ) : (
            <p className="absent">No modified value recorded.</p>
          )}
        </li>
        <li>
          <h4>4 · The actual request sent</h4>
          {evidence.request ? (
            <p>
              <code>
                {evidence.request.method} {shortPath(evidence.request.endpoint)}
              </code>{" "}
              {ACTORS[actorsOf(evidence.request).from].short} → {ACTORS[actorsOf(evidence.request).to].short}{" "}
              {link(evidence.request, `inspect #${evidence.request.id}`)}
            </p>
          ) : (
            <p className="absent">No network request was sent (the flow stopped inside this app, or has not reached it yet).</p>
          )}
        </li>
        <li>
          <h4>5 · The server response</h4>
          {response ? (
            <p>
              {response.status !== undefined ? <strong>HTTP {String(response.status)}</strong> : <strong>{response.step}</strong>}
              {error?.error && <code> {error.error}</code>}
              {error?.description && <span> — “{error.description}”</span>} {link(response, `#${response.id}`)}
            </p>
          ) : (
            <p className="absent">No response yet.</p>
          )}
          {props.outcome && <p className="demo-outcome">{props.outcome}</p>}
        </li>
        <li>
          <h4>6 · Where the flow stopped</h4>
          <p>
            {evidence.stoppedAt ? (
              <>
                <strong>
                  Step {evidence.stoppedAt.step.n}: {evidence.stoppedAt.step.title}
                </strong>{" "}
                {link(evidence.stoppedAt.entry, `#${evidence.stoppedAt.entry.id}`)}
              </>
            ) : (
              "It did not stop: every step it reached succeeded."
            )}
          </p>
        </li>
        <li>
          <h4>7 · Why it matters</h4>
          <p>{props.why}</p>
        </li>
        <li>
          <h4>8 · Security concept and mitigation</h4>
          <p>
            <strong>{props.concept}</strong>
          </p>
          <p>{props.mitigation}</p>
        </li>
      </ol>
    </div>
  );
}

/** Scenario 10: an illustration, never executed. */
function SpaVersusBff() {
  return (
    <div className="spa-vs-bff">
      <p className="illustrative-badge">ILLUSTRATION — not executed. This application never exposes tokens to the browser.</p>
      <div className="two-col">
        <div className="arch arch-unsafe">
          <h4>Single-page app holding tokens (unsafe pattern)</h4>
          <pre>{`Browser JavaScript
├── localStorage.access_token  = eyJhbGciOi…REDACTED
├── localStorage.refresh_token = ••••••••
└── fetch(FHIR, { Authorization: Bearer … })

Any script on the page can read and send these:
XSS, a compromised npm package, a browser extension.`}</pre>
        </div>
        <div className="arch arch-safe">
          <h4>This app: backend-for-frontend (what really runs)</h4>
          <pre>{`Browser JavaScript
├── localStorage   → theme only (check "What can the browser see?")
├── document.cookie → "" (session cookie is httpOnly)
└── fetch("/api/patient")  cookie only

Node server (not reachable by page scripts)
└── session → access, refresh and ID tokens`}</pre>
        </div>
      </div>
      <p className="explainer">
        An injected script in the BFF app can still call <code>/api/patient</code> while the page is open, but it cannot steal a token
        to use elsewhere, and cannot outlive the session. That difference is why OAuth 2.0 for Browser-Based Apps recommends the BFF
        pattern for applications handling sensitive data.
      </p>
    </div>
  );
}
