import { useState } from "react";
import { navigateTo } from "../api";
import type { DemoId, DemoResult, WireEntry } from "../types";
import { DIRECTIONS, shortEndpoint } from "./WireLog";

/*
 * Each demo breaks the flow at a DIFFERENT point, and that is the teachable
 * difference between them. `breaks` names where to look, so six results cannot
 * read as six identical cards with different paragraphs.
 */
/*
 * The honest frame: a refusal by the party that should refuse is the security
 * control WORKING, so it is green with a tick. Amber is reserved for an
 * acceptance the specification says should not have happened. Red is a genuine
 * failure of the flow.
 *
 * `rejected` is a single boolean but does not mean the same thing in every demo,
 * so each demo says how to read both of its outcomes rather than sharing one
 * sentence. Force token expiry is the clearest case: for it, "not rejected"
 * means the refresh recovered, which is the good ending.
 */
type DemoTone = "defended" | "accepted" | "recovered" | "failed";

interface DemoVerdicts {
  rejected: { glyph: string; label: string; tone: DemoTone };
  accepted: { glyph: string; label: string; tone: DemoTone };
}

const DEMOS: { id: DemoId; label: string; hint: string; breaks: string; verdicts: DemoVerdicts; needsConnection?: boolean }[] = [
  {
    id: "redirect-mismatch",
    label: "Mismatched redirect URI",
    hint: "Logs in with a trailing slash added to redirect_uri.",
    breaks: "Breaks at step 6, the token endpoint — after /authorize has already accepted it.",
    verdicts: {
      rejected: { glyph: "✓", label: "The token endpoint refused it, as the spec requires", tone: "defended" },
      accepted: { glyph: "!", label: "The provider allowed the mismatch — and that is the problem", tone: "accepted" },
    },
  },
  {
    id: "tamper-state",
    label: "Tamper with state",
    hint: "Logs in, but the server replaces its stored state first.",
    breaks: "Breaks at step 5, state validation. Look for what is missing: there is no token request at all.",
    verdicts: {
      rejected: { glyph: "✓", label: "Our server stopped the flow before using the code", tone: "defended" },
      accepted: { glyph: "!", label: "The mismatch was not caught — and that is the problem", tone: "accepted" },
    },
  },
  {
    id: "replay-code",
    label: "Replay authorization code",
    hint: "Logs in, then sends the same code to the token endpoint twice.",
    breaks: "Breaks nothing on this sandbox — it answers 200 twice. That is the lesson.",
    verdicts: {
      rejected: { glyph: "✓", label: "The code was refused the second time, as the RFC requires", tone: "defended" },
      accepted: { glyph: "!", label: "The sandbox accepted the replay — and that is the problem", tone: "accepted" },
    },
  },
  {
    id: "no-pkce-verifier",
    label: "Remove PKCE verifier",
    hint: "Logs in, then leaves code_verifier out of the token request.",
    breaks: "Breaks at step 6, the token endpoint. Expand the request and look for the missing code_verifier.",
    verdicts: {
      rejected: { glyph: "✓", label: "The token endpoint refused it, as PKCE requires", tone: "defended" },
      accepted: { glyph: "!", label: "The code worked without its verifier — and that is the problem", tone: "accepted" },
    },
  },
  {
    id: "broad-scope",
    label: "Request patient/*.read",
    hint: "Logs in asking for every patient resource type.",
    breaks: "Breaks nothing — the sandbox grants exactly what was asked for. Compare the two grants below.",
    verdicts: {
      rejected: { glyph: "✓", label: "The broad scope was cut down to what was needed", tone: "defended" },
      accepted: { glyph: "!", label: "Granted in full, exactly as asked — and that is the problem", tone: "accepted" },
    },
  },
  {
    id: "force-expiry",
    label: "Force token expiry",
    hint: "Invalidates the stored access token, then calls the FHIR API.",
    breaks: "Breaks at step 8, the FHIR call — then recovers: 401, refresh, retry.",
    verdicts: {
      rejected: { glyph: "✕", label: "Could not recover: re-authentication required", tone: "failed" },
      accepted: { glyph: "✓", label: "Rejected, then recovered without a new login", tone: "recovered" },
    },
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
  // The five redirect demos unload the page; without this the grid stays live and
  // clickable during the gap and a second click can start a competing flow.
  const [leaving, setLeaving] = useState<DemoId | null>(null);

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
          const busy = leaving === item.id || (running && item.id === "force-expiry");
          return (
            <button
              key={item.id}
              type="button"
              className={demo?.id === item.id ? "demo-button is-active" : "demo-button"}
              disabled={running || blocked || leaving !== null}
              aria-label={`${item.label}. ${blocked ? "Connect first: this needs stored tokens." : item.hint}`}
              onClick={() => {
                if (item.id === "force-expiry") {
                  onForceExpiry();
                } else {
                  setLeaving(item.id);
                  navigateTo(`/demo/${item.id}`);
                }
              }}
            >
              <span className="demo-label">{item.label}</span>
              <span className="demo-hint">
                {busy
                  ? "Running…"
                  : blocked
                    ? "Connect first: this needs stored tokens."
                    : item.hint}
              </span>
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
  const breaks = DEMOS.find((item) => item.id === demo.id)?.breaks;

  /*
   * Two of the six are not refusals: this sandbox accepts a replayed code and
   * grants patient/*.read as asked. Dressing those up as failures would be the one
   * genuinely dishonest thing this panel could do, so they get their own verdict.
   */
  const catalogue = DEMOS.find((item) => item.id === demo.id);
  const outcome = demo.status === "running" ? null : demo.rejected ? "rejected" : "accepted";
  const verdict =
    outcome && catalogue ? catalogue.verdicts[outcome] : { glyph: "…", label: "Running", tone: "running" as const };
  const state = demo.status === "running" ? "running" : (verdict as { tone: string }).tone;

  return (
    <div className={`demo-result is-${state}`} aria-live="polite" aria-atomic="true" aria-busy={state === "running" || undefined}>
      <h3>{demo.title}</h3>
      <p className="demo-verdict">
        <span aria-hidden="true">{verdict.glyph}</span>
        {verdict.label}
      </p>
      {breaks && <p className="demo-breakpoint">{breaks}</p>}
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
            <p className="absent">{missingEntriesReason(demo, entries)}</p>
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

/* "Cleared" and "not arrived yet" are different things; the 1 s wire poll and the
   2 s session poll race, so the second is common and is not an error. */
function missingEntriesReason(demo: DemoResult, entries: WireEntry[]): string {
  const first = entries[0]?.id;
  const last = entries.at(-1)?.id;
  if (first !== undefined && first > demo.firstEntryId) {
    return "This demo's wire log entries were cleared, so the evidence is no longer on screen. Run it again to see them.";
  }
  if (last !== undefined && last < demo.firstEntryId) {
    return "Waiting for this demo's wire log entries to arrive.";
  }
  return "This demo produced no wire log entries.";
}

function problem(entry: WireEntry): string | null {
  const result = entry.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") return null;
  if (typeof result.verdict === "string" && entry.outcome === "error") return result.verdict;
  if (typeof result.error === "string") return [result.error, result.error_description].filter(Boolean).join(": ");
  return null;
}
