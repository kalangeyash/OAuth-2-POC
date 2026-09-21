import { useState, type ReactNode } from "react";
import { ACTORS, INJECTIONS, timelineStep, type InjectionId } from "../../../server/src/timeline";
import { redact } from "../../../server/src/redaction";
import { clock } from "../flow";
import { glossaryFor } from "../glossary";
import { actorsOf, explain, isFailure, modificationOf, primaryStep, providerError } from "../model";
import { usePresenter } from "../presenter";
import type { LabState, WireEntry } from "../types";
import { ActorChip, ChannelBadge, isRecord, KeyValues, SourceList, Term, Value } from "./bits";

/*
 * THE MESSAGE INSPECTOR. Everything about one message:
 *   Request · Response · What it means · Why it exists · Security · Preconditions ·
 *   Possible outcomes · What it enables · Implementation reference
 *
 * When the debugger is holding a request, this becomes the "Before send" view:
 * the exact request (redacted), every parameter explained, and the buttons that
 * send it, send it with a deliberate change, run to the end, or stop the flow.
 */

interface Props {
  entries: WireEntry[];
  lab: LabState;
  onDecide: (action: "send" | "run" | "abort", inject?: InjectionId) => void;
  deciding: boolean;
  onStep: (delta: 1 | -1) => void;
}

export function MessageInspector({ entries, lab, onDecide, deciding, onStep }: Props) {
  const presenter = usePresenter();
  const { selectedId, showDetails, showSecurity, showSource, detailLevel } = presenter;
  const everything = detailLevel === "everything";
  const breakpoint = lab.breakpoint;
  const selected =
    entries.find((entry) => entry.id === selectedId) ??
    (breakpoint ? entries.find((entry) => entry.id === breakpoint.entryId) : undefined) ??
    entries.at(-1);

  if (!selected) {
    return (
      <aside className="inspector" aria-label="Message inspector">
        <h2 className="inspector-empty-title">Message inspector</h2>
        <p className="lede">
          Select any message on the canvas or in the traffic monitor to see exactly what was sent, what came back, and why
          it exists. Every value is clickable.
        </p>
      </aside>
    );
  }

  const entry = redact(selected);
  const held = breakpoint && entry.id === breakpoint.entryId ? breakpoint : null;
  const step = held ? timelineStep(held.stage) : primaryStep(entry);
  const { from, to } = actorsOf(entry);
  const modification = modificationOf(entry);
  const failure = isFailure(entry);
  const error = providerError(entry);

  return (
    <aside className={`inspector${held ? " is-held" : ""}`} aria-label="Message inspector">
      <header className="inspector-head">
        <div className="inspector-nav">
          <button type="button" className="button small" onClick={() => onStep(-1)} aria-label="Previous message (←)">
            ←
          </button>
          <span className="inspector-id">#{entry.id}</span>
          <button type="button" className="button small" onClick={() => onStep(1)} aria-label="Next message (→)">
            →
          </button>
        </div>
        <h2>{entry.step}</h2>
        <p className="inspector-route">
          <ActorChip actor={from} short />
          <span aria-hidden="true">{from === to ? "⟲" : "→"}</span>
          {from !== to && <ActorChip actor={to} short />}
          <ChannelBadge channel={entry.channel} />
          <span className="inspector-time">{clock(entry.timestamp)}</span>
          {typeof entry.durationMs === "number" && <span className="inspector-time">{entry.durationMs} ms</span>}
          {entry.status !== undefined && (
            <span className={`status-pill${failure ? " is-error" : ""}`}>{String(entry.status)}</span>
          )}
        </p>
        {step && (
          <p className="inspector-step">
            Step {step.n} of 21 · {step.title}
            <button type="button" className="link-button" onClick={() => presenter.setReplayStep(step.id)}>
              explain this step
            </button>
          </p>
        )}
        <div className="inspector-actions">
          <button type="button" className="button small" aria-pressed={presenter.pinned.includes(entry.id)} onClick={() => presenter.togglePin(entry.id)}>
            {presenter.pinned.includes(entry.id) ? "★ Pinned" : "☆ Pin"}
          </button>
          <button type="button" className="button small" aria-pressed={presenter.compare.includes(entry.id)} onClick={() => presenter.toggleCompare(entry.id)}>
            {presenter.compare.includes(entry.id) ? "In comparison" : "Compare"}
          </button>
          <CopyButton entry={entry} />
        </div>
      </header>

      {held && (
        <BeforeSend
          entry={entry}
          injections={held.injections}
          network={held.kind === "network"}
          deciding={deciding}
          onDecide={onDecide}
        />
      )}

      {modification && (
        <div className="modified-banner" role="note">
          <strong>Deliberately changed: {modification.field}</strong>
          <span>
            <span className="modified-from">{modification.original}</span>
            <span aria-hidden="true"> → </span>
            <span className="modified-to">{modification.sent}</span>
          </span>
        </div>
      )}

      <div className="inspector-body">
        <InspectorSection title="What this means" open>
          <p className="inspector-explanation">{explain(entry)}</p>
          {everything && entry.notes && entry.notes.length > 0 && (
            <ul className="notes">
              {entry.notes.filter(Boolean).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </InspectorSection>

        {showDetails && (entry.endpoint || entry.params || entry.requestHeaders) && (
          <InspectorSection title={held ? "Request (not sent yet)" : "Request"} open>
            <RequestView entry={entry} explainParams={Boolean(held)} showHeaders={everything || Boolean(held)} />
          </InspectorSection>
        )}

        {showDetails && !held && (entry.status !== undefined || entry.result !== undefined || entry.responseHeaders) && (
          <InspectorSection title="Response" open>
            <dl className="kv">
              {entry.status !== undefined && (
                <div>
                  <dt>HTTP status</dt>
                  <dd className={failure ? "is-error" : "is-ok"}>
                    {String(entry.status)} {failure ? "— failure" : "— success"}
                  </dd>
                </div>
              )}
              {typeof entry.durationMs === "number" && (
                <div>
                  <dt>Duration</dt>
                  <dd>{entry.durationMs} ms (Node waited for this response)</dd>
                </div>
              )}
              {(error.error || error.description) && (
                <div>
                  <dt>Error</dt>
                  <dd className="is-error">
                    {error.error} {error.description && `— ${error.description}`}
                  </dd>
                </div>
              )}
              {entry.responseHeaders?.Location && (
                <div>
                  <dt>Redirect location</dt>
                  <dd>
                    <code>{entry.responseHeaders.Location}</code>
                  </dd>
                </div>
              )}
            </dl>
            {everything && entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0 && (
              <>
                <h4>Headers</h4>
                <KeyValues values={entry.responseHeaders} />
              </>
            )}
            {entry.result !== undefined && (
              <>
                <h4>Body (sanitized)</h4>
                {isRecord(entry.result) ? <KeyValues values={entry.result} /> : <Value value={entry.result} />}
              </>
            )}
            {step && !held && (
              <p className="enables">
                {failure ? (
                  <>
                    <strong>Flow stopped here.</strong> Nothing that depends on this step ran.
                  </>
                ) : (
                  <>
                    <strong>Enables next:</strong> {step.next}
                  </>
                )}
              </p>
            )}
          </InspectorSection>
        )}

        {step && (
          <InspectorSection title="Why this happens" open={!held && everything}>
            <dl className="facts-list">
              <Fact label="Why it exists">{entry.why ?? step.why}</Fact>
              <Fact label="If it were missing">{step.ifMissing}</Fact>
              <Fact label="Specification">{step.spec}</Fact>
              <Fact label="Can the browser see it?">{step.browserVisible}</Fact>
              <Fact label="Sensitive data?">{step.sensitive}</Fact>
            </dl>
          </InspectorSection>
        )}

        {showSecurity && step && (
          <InspectorSection title="Security" open={!held && everything}>
            <p className="concept">{entry.securityConcept ?? step.concept}</p>
            {entry.security && <p>{entry.security}</p>}
            <h4>Preconditions</h4>
            <ul className="checklist">
              {step.preconditions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h4>Possible outcomes</h4>
            <ul className="outcomes">
              {step.outcomes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </InspectorSection>
        )}

        {showSource && (step || entry.source) && (
          <InspectorSection title="Implementation reference" open={false}>
            <SourceList refs={entry.source ?? step?.source ?? []} env={step?.env ?? []} />
          </InspectorSection>
        )}
      </div>
    </aside>
  );
}

function BeforeSend({
  entry,
  injections,
  network,
  deciding,
  onDecide,
}: {
  entry: WireEntry;
  injections: InjectionId[];
  network: boolean;
  deciding: boolean;
  onDecide: Props["onDecide"];
}) {
  const { failureInjection, toggle } = usePresenter();
  return (
    <section className="before-send" aria-label="Paused: before send">
      <p className="before-send-title">
        <span aria-hidden="true">⏸</span> {network ? "BEFORE SEND — this request has NOT been sent" : "PAUSED — this step has NOT run yet"}
      </p>
      <p className="lede">
        {network
          ? "The backend built it and is holding it. Inspect every value below, then send it and watch the real response."
          : "Nothing has happened yet. Continue to let the backend run exactly this step."}
      </p>
      <div className="before-send-actions">
        <button type="button" className="button primary" disabled={deciding} onClick={() => onDecide("send")}>
          {network ? "Send request ▶" : "Next step ▶"}
        </button>
        <button type="button" className="button" disabled={deciding} onClick={() => onDecide("run")}>
          Run to the end
        </button>
        <button type="button" className="button danger" disabled={deciding} onClick={() => onDecide("abort")}>
          Stop the flow
        </button>
      </div>
      {injections.length > 0 && (
        <div className="injections">
          {failureInjection ? (
            <>
              <h4>Failure injection: send with one deliberate change</h4>
              <ul>
                {injections.map((id) => (
                  <li key={id}>
                    <button type="button" className="button inject" disabled={deciding} onClick={() => onDecide("send", id)}>
                      {INJECTIONS[id].label}
                    </button>
                    <span className="inject-effect">{INJECTIONS[id].effect}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="lede">
              {injections.length} failure injection{injections.length === 1 ? " is" : "s are"} available here.{" "}
              <button type="button" className="link-button" onClick={() => toggle("failureInjection")}>
                Turn on failure injection
              </button>
            </p>
          )}
        </div>
      )}
      <p className="lede before-send-note">Entry #{entry.id} is the exact request as the server built it (secrets redacted).</p>
    </section>
  );
}

function RequestView({ entry, explainParams, showHeaders }: { entry: WireEntry; explainParams: boolean; showHeaders: boolean }) {
  const params = (entry.params ?? {}) as Record<string, unknown>;
  const { from, to } = actorsOf(entry);
  const url =
    entry.endpoint && entry.paramsIn === "query" && Object.keys(params).length > 0
      ? `${entry.endpoint}?${Object.entries(params)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join("&")}`
      : entry.endpoint;
  const contentType = entry.requestHeaders?.["Content-Type"] ?? entry.requestHeaders?.["content-type"];
  const destination = entry.endpoint && /^https?:\/\//.test(entry.endpoint) ? new URL(entry.endpoint).host : ACTORS[to].name;

  return (
    <>
      {entry.method && (
        <p className="request-line">
          <code>
            <strong>{entry.method}</strong> {url}
          </code>
        </p>
      )}
      <dl className="kv">
        <div>
          <dt>Sender</dt>
          <dd>{ACTORS[from].name}</dd>
        </div>
        <div>
          <dt>Receiver</dt>
          <dd>{from === to ? "(inside the Node client — no network traffic)" : `${ACTORS[to].name} · ${destination}`}</dd>
        </div>
        {contentType && (
          <div>
            <dt>Content type</dt>
            <dd>{contentType}</dd>
          </div>
        )}
      </dl>
      {Object.keys(params).length > 0 && (
        <>
          <h4>{entry.paramsIn === "body" ? "Body (form parameters)" : entry.paramsIn === "query" ? "Query parameters" : "Values"}</h4>
          {explainParams ? <ParamTable params={params} /> : <KeyValues values={params} />}
        </>
      )}
      {showHeaders && entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0 && (
        <>
          <h4>Headers</h4>
          <KeyValues values={entry.requestHeaders} />
        </>
      )}
    </>
  );
}

/** Before send: every parameter with its purpose, so the audience can read the request line by line. */
function ParamTable({ params }: { params: Record<string, unknown> }) {
  return (
    <table className="param-table">
      <thead>
        <tr>
          <th scope="col">Parameter</th>
          <th scope="col">Value</th>
          <th scope="col">Purpose</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(params).map(([name, value]) => (
          <tr key={name}>
            <th scope="row">
              <Term name={name} />
            </th>
            <td>
              <Value value={value} />
            </td>
            <td>{glossaryFor(name)?.what ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InspectorSection({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return (
    <details className="inspector-section" open={open}>
      <summary>{title}</summary>
      <div className="inspector-section-body">{children}</div>
    </details>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ entry }: { entry: WireEntry }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="button small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(redact(entry), null, 2));
          setState("copied");
        } catch {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy (sanitized)"}
    </button>
  );
}
