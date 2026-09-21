import { useMemo, useState } from "react";
import { ACTOR_ORDER, ACTORS, CHANNELS, type ActorId, type Channel } from "../../../server/src/timeline";
import { redact } from "../../../server/src/redaction";
import { clock } from "../flow";
import { actorsOf, isFailure, shortPath } from "../model";
import { isEssential, matchesFilters, usePresenter } from "../presenter";
import type { WireEntry } from "../types";
import { PanelHead, Value } from "./bits";

/*
 * THE TRAFFIC MONITOR: DevTools' network tab for the OAuth flow.
 * Every row is a real event from the server's wire log (already redacted there).
 */

interface Props {
  entries: WireEntry[];
}

export function NetworkMonitor({ entries }: Props) {
  const presenter = usePresenter();
  const { filters, setFilters, selectedId, select, pinned, togglePin, compare, toggleCompare, detailLevel } = presenter;
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const rows = useMemo(
    () =>
      entries.filter(
        (entry) =>
          matchesFilters(entry, filters) &&
          (detailLevel === "everything" || isEssential(entry) || pinned.includes(entry.id)) &&
          (!pinnedOnly || pinned.includes(entry.id)),
      ),
    [entries, filters, detailLevel, pinnedOnly, pinned],
  );
  const compared = compare.map((id) => entries.find((entry) => entry.id === id)).filter(Boolean) as WireEntry[];

  const toggleActor = (actor: ActorId) =>
    setFilters({ actors: filters.actors.includes(actor) ? filters.actors.filter((a) => a !== actor) : [...filters.actors, actor] });
  const toggleChannel = (channel: Channel) =>
    setFilters({
      channels: filters.channels.includes(channel) ? filters.channels.filter((c) => c !== channel) : [...filters.channels, channel],
    });

  return (
    <section className="monitor" aria-label="HTTP traffic monitor">
      <PanelHead title="Traffic monitor" note="Every row is a real event recorded by the Node server, sanitized before it left the server.">
        <button type="button" className="button small" onClick={() => exportTrace(rows)} disabled={rows.length === 0}>
          Export sanitized trace
        </button>
      </PanelHead>

      <div className="monitor-filters">
        <input
          type="search"
          className="search"
          placeholder="Search URL, parameters, status…"
          aria-label="Search messages"
          value={filters.search}
          onChange={(event) => setFilters({ search: event.target.value })}
        />
        <div className="chip-group" role="group" aria-label="Filter by actor">
          {ACTOR_ORDER.map((actor) => (
            <button
              key={actor}
              type="button"
              className={`filter-chip actor-${actor}`}
              aria-pressed={filters.actors.includes(actor)}
              onClick={() => toggleActor(actor)}
            >
              {ACTORS[actor].short}
            </button>
          ))}
        </div>
        <div className="chip-group" role="group" aria-label="Filter by channel">
          {(Object.keys(CHANNELS) as Channel[]).map((channel) => (
            <button
              key={channel}
              type="button"
              className={`filter-chip channel-${channel}`}
              aria-pressed={filters.channels.includes(channel)}
              onClick={() => toggleChannel(channel)}
            >
              {channel === "front" ? "Front" : channel === "back" ? "Back" : "Local"}
            </button>
          ))}
        </div>
        <select
          aria-label="Filter by result"
          value={filters.status}
          onChange={(event) => setFilters({ status: event.target.value as "all" | "success" | "error" })}
        >
          <option value="all">All results</option>
          <option value="success">Success only</option>
          <option value="error">Errors only</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={pinnedOnly} onChange={(event) => setPinnedOnly(event.target.checked)} /> Pinned only
        </label>
      </div>

      {compared.length === 2 && <CompareView left={compared[0]} right={compared[1]} onClose={() => compared.forEach((entry) => toggleCompare(entry.id))} />}
      {compared.length === 1 && (
        <p className="lede compare-hint">
          #{compared[0].id} is in the comparison. Tick one more message to compare them side by side.
        </p>
      )}

      <div className="table-scroll monitor-scroll">
        <table className="monitor-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Pin</span>
              </th>
              <th scope="col">#</th>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Method</th>
              <th scope="col">URL / step</th>
              <th scope="col">Channel</th>
              <th scope="col" className="num">
                Status
              </th>
              <th scope="col" className="num">
                Duration
              </th>
              <th scope="col">Security</th>
              <th scope="col">
                <span className="visually-hidden">Compare</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const { from, to } = actorsOf(entry);
              const failed = isFailure(entry);
              return (
                <tr
                  key={entry.id}
                  className={[
                    entry.id === selectedId ? "is-selected" : "",
                    failed ? "is-error" : "",
                    entry.breakpoint ? "is-breakpoint" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => select(entry.id)}
                >
                  <td>
                    <button
                      type="button"
                      className="pin"
                      aria-pressed={pinned.includes(entry.id)}
                      aria-label={pinned.includes(entry.id) ? `Unpin #${entry.id}` : `Pin #${entry.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePin(entry.id);
                      }}
                    >
                      {pinned.includes(entry.id) ? "★" : "☆"}
                    </button>
                  </td>
                  <td className="mono">{entry.id}</td>
                  <td className="mono">{clock(entry.timestamp)}</td>
                  <td>
                    <span className={`actor-dot actor-${from}`} aria-hidden="true" />
                    {ACTORS[from].short}
                    {from !== to && <span className="muted"> → {ACTORS[to].short}</span>}
                  </td>
                  <td className="mono">{entry.method ?? "—"}</td>
                  <td className="url-cell">
                    <button type="button" className="row-link" onClick={() => select(entry.id)}>
                      {entry.breakpoint && "⏸ "}
                      {entry.endpoint ? shortPath(entry.endpoint) : entry.step}
                    </button>
                    {entry.endpoint && <span className="muted row-step">{entry.step}</span>}
                  </td>
                  <td>
                    <span className={`channel-tag channel-${entry.channel}`}>{entry.channel}</span>
                  </td>
                  <td className={`num mono${failed ? " is-error" : ""}`}>{entry.status ?? (entry.breakpoint ? "held" : "—")}</td>
                  <td className="num mono">{typeof entry.durationMs === "number" ? `${entry.durationMs} ms` : "—"}</td>
                  <td className="security-cell">{securityTag(entry)}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Compare #${entry.id}`}
                      checked={compare.includes(entry.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleCompare(entry.id)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="absent monitor-empty">No messages match. Clear a filter, or run a scenario.</p>}
      </div>
    </section>
  );
}

/** What protects (or is exposed by) this message, in a few words. */
function securityTag(entry: WireEntry): string {
  const params = entry.params ?? {};
  const headers = entry.requestHeaders ?? {};
  const tags: string[] = [];
  if (entry.channel === "front") tags.push("public: visible in URL");
  if ("code_verifier" in params) tags.push("PKCE verifier (redacted)");
  if ("code_challenge" in params) tags.push("PKCE challenge");
  if ("state" in params || entry.detail?.kind === "state-check") tags.push("state (CSRF)");
  if ("refresh_token" in params) tags.push("refresh token (redacted)");
  if ((headers.Authorization ?? "").startsWith("[REDACTED") && entry.direction === "client-fhir") tags.push("Bearer token (redacted)");
  if ("Cookie" in headers) tags.push("session cookie only");
  if (entry.injection || entry.demo?.modified) tags.push("DELIBERATELY CHANGED");
  return tags.join(" · ") || (entry.channel === "local" ? "inside this app" : "—");
}

function CompareView({ left, right, onClose }: { left: WireEntry; right: WireEntry; onClose: () => void }) {
  const fields: [string, (entry: WireEntry) => unknown][] = [
    ["Step", (entry) => entry.step],
    ["Route", (entry) => `${ACTORS[actorsOf(entry).from].short} → ${ACTORS[actorsOf(entry).to].short}`],
    ["Request", (entry) => [entry.method, entry.endpoint].filter(Boolean).join(" ") || "—"],
    ["Status", (entry) => entry.status ?? "—"],
    ["Duration", (entry) => (typeof entry.durationMs === "number" ? `${entry.durationMs} ms` : "—")],
  ];
  const paramKeys = [...new Set([...Object.keys(left.params ?? {}), ...Object.keys(right.params ?? {})])];
  const headerKeys = [...new Set([...Object.keys(left.requestHeaders ?? {}), ...Object.keys(right.requestHeaders ?? {})])];
  const resultKeys = [
    ...new Set([
      ...Object.keys((left.result as Record<string, unknown>) ?? {}),
      ...Object.keys((right.result as Record<string, unknown>) ?? {}),
    ]),
  ];
  const row = (label: string, a: unknown, b: unknown) => {
    const differs = JSON.stringify(a) !== JSON.stringify(b);
    return (
      <tr key={label} className={differs ? "is-different" : undefined}>
        <th scope="row">{label}</th>
        <td>
          <Value value={a ?? "—"} />
        </td>
        <td>
          <Value value={b ?? "—"} />
        </td>
      </tr>
    );
  };
  return (
    <div className="compare" role="region" aria-label="Message comparison">
      <div className="compare-head">
        <h3>
          Compare #{left.id} and #{right.id}
        </h3>
        <button type="button" className="button small" onClick={onClose}>
          Close comparison
        </button>
      </div>
      <table className="compare-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">#{left.id}</th>
            <th scope="col">#{right.id}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(([label, read]) => row(label, read(left), read(right)))}
          {paramKeys.map((key) => row(`param ${key}`, left.params?.[key], right.params?.[key]))}
          {headerKeys.map((key) => row(`header ${key}`, left.requestHeaders?.[key], right.requestHeaders?.[key]))}
          {resultKeys.map((key) =>
            row(`response ${key}`, (left.result as Record<string, unknown>)?.[key], (right.result as Record<string, unknown>)?.[key]),
          )}
        </tbody>
      </table>
      <p className="lede">Highlighted rows differ. Secrets are compared only as their redacted marks.</p>
    </div>
  );
}

/** Downloads the visible messages as JSON. They were redacted by the server; redact() runs again anyway. */
function exportTrace(entries: WireEntry[]): void {
  const trace = {
    kind: "smart-on-fhir-oauth-protocol-trace",
    exportedAt: new Date().toISOString(),
    note: "Sanitized: every entry was redacted by the Node server before it was stored, and again before export. Synthetic sandbox data only.",
    entries: redact(entries),
  };
  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `oauth-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
