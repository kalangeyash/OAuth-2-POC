import { navigateTo } from "../api";
import type { DemoId, DemoResult, WireEntry } from "../types";
import { DIRECTIONS, shortEndpoint } from "./WireLog";

const DEMOS: { id: DemoId; label: string; hint: string; needsConnection?: boolean }[] = [
  { id: "redirect-mismatch", label: "Mismatched redirect URI", hint: "Logs in with a trailing slash added to redirect_uri." },
  { id: "tamper-state", label: "Tamper with state", hint: "Logs in, but the server replaces its stored state first." },
  { id: "replay-code", label: "Replay authorization code", hint: "Logs in, then sends the same code to the token endpoint twice." },
  { id: "no-pkce-verifier", label: "Remove PKCE verifier", hint: "Logs in, then leaves code_verifier out of the token request." },
  { id: "broad-scope", label: "Request patient/*.read", hint: "Logs in asking for every patient resource type." },
  {
    id: "force-expiry",
    label: "Force token expiry",
    hint: "Invalidates the stored access token, then calls the FHIR API.",
    needsConnection: true,
  },
];

const WAITING_TEXT =
  "Waiting for the browser to come back from the authorization server. If the authorization server shows an error page " +
  "instead of redirecting back, that page is the result: a server must not redirect to a URI it cannot verify. " +
  "Use the browser's Back button to return.";

interface Props {
  authorized: boolean;
  demo: DemoResult | null;
  entries: WireEntry[];
  running: boolean;
  onForceExpiry: () => void;
}

export function FailureDemoPanel({ authorized, demo, entries, running, onForceExpiry }: Props) {
  return (
    <section className="section break" aria-labelledby="break-title">
      <h2 id="break-title" className="break-title">
        BREAK SOMETHING
      </h2>
      <p className="lede">
        Each button makes the real failure happen on the Node server and against the sandbox. The normal flow still works
        afterwards.
      </p>
      <div className="demo-buttons">
        {DEMOS.map((item) => {
          const blocked = Boolean(item.needsConnection && !authorized);
          return (
            <button
              key={item.id}
              type="button"
              className={demo?.id === item.id ? "demo-button is-active" : "demo-button"}
              disabled={running || blocked}
              onClick={() => (item.id === "force-expiry" ? onForceExpiry() : navigateTo(`/demo/${item.id}`))}
            >
              <span className="demo-label">{item.label}</span>
              <span className="demo-hint">{blocked ? "Connect first: this needs stored tokens." : item.hint}</span>
            </button>
          );
        })}
      </div>
      {demo && <DemoResultView demo={demo} entries={entries} />}
    </section>
  );
}

function DemoResultView({ demo, entries }: { demo: DemoResult; entries: WireEntry[] }) {
  const related = entries.filter(
    (entry) => entry.id >= demo.firstEntryId && (demo.lastEntryId === null || entry.id <= demo.lastEntryId),
  );

  return (
    <div className="demo-result" aria-live="polite">
      <h3>{demo.title}</h3>
      <ol className="demo-chain">
        <li>
          <h4>What we changed</h4>
          <p>{demo.whatWeChanged}</p>
        </li>
        <li>
          <h4>Actual request and response</h4>
          {demo.outcome && <p className={demo.rejected ? "demo-outcome is-rejected" : "demo-outcome"}>{demo.outcome}</p>}
          {related.length > 0 ? (
            <ul className="demo-entries">
              {related.map((entry) => (
                <li key={entry.id} className={`dir-${entry.direction} outcome-${entry.outcome}`}>
                  #{entry.id} {entry.step}: {DIRECTIONS[entry.direction].route}
                  {entry.method ? ` ${entry.method} ${shortEndpoint(entry.endpoint)}` : ""}
                  {entry.status !== undefined ? ` → ${entry.status}` : ""}
                  {problem(entry) ? ` (${problem(entry)})` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="absent">This demo's wire log entries are not loaded. The log may have been cleared.</p>
          )}
        </li>
        <li>
          <h4>{demo.rejected === false ? "What happened" : "Why it failed"}</h4>
          <p>{demo.status === "running" ? WAITING_TEXT : demo.why}</p>
        </li>
        <li>
          <h4>OAuth concept illustrated</h4>
          <p>{demo.concept}</p>
        </li>
      </ol>
    </div>
  );
}

function problem(entry: WireEntry): string | null {
  const result = entry.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") return null;
  if (typeof result.verdict === "string" && entry.outcome === "error") return result.verdict;
  if (typeof result.error === "string") return [result.error, result.error_description].filter(Boolean).join(": ");
  return null;
}
