import { useEffect, useRef, useState, type CSSProperties } from "react";
// The same redaction helper the server uses. Entries arrive already redacted;
// applying it again before rendering and copying is defence in depth.
import { redact } from "../../../server/src/redaction";
import type { Direction, WireEntry } from "../types";

const LANES = [
  { name: "Browser", className: "lane-browser" },
  { name: "Node client", className: "lane-node" },
  { name: "Authorization server", className: "lane-auth" },
  { name: "FHIR server", className: "lane-fhir" },
];

interface DirectionInfo {
  from: number;
  to: number;
  route: string;
  channel: string;
  redirect: boolean;
}

export const DIRECTIONS: Record<Direction, DirectionInfo> = {
  "browser-client": { from: 0, to: 1, route: "Browser → Node client", channel: "Request from the browser", redirect: false },
  "browser-auth": { from: 0, to: 2, route: "Browser → Authorization server", channel: "Front channel: browser redirect", redirect: true },
  "auth-browser": {
    from: 2,
    to: 1,
    route: "Authorization server → Browser → Node client",
    channel: "Front channel: browser redirect",
    redirect: true,
  },
  "client-auth": { from: 1, to: 2, route: "Node client → Authorization server", channel: "Back channel", redirect: false },
  "client-fhir": { from: 1, to: 3, route: "Node client → FHIR server", channel: "Back channel", redirect: false },
  internal: { from: 1, to: 1, route: "Inside the Node client", channel: "No network traffic", redirect: false },
};

/** "/auth/token" instead of the full sandbox URL. The full endpoint is shown when an entry is expanded. */
export function shortEndpoint(endpoint?: string): string {
  if (!endpoint || !/^https?:\/\//.test(endpoint)) return endpoint ?? "";
  const { pathname } = new URL(endpoint);
  const marker = pathname.search(/\/(auth|fhir)\//i);
  return marker >= 0 ? pathname.slice(marker) : "/" + pathname.split("/").filter(Boolean).slice(-2).join("/");
}

interface Props {
  entries: WireEntry[];
  onClear: () => void;
}

export function WireLog({ entries, onClear }: Props) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [autoOpen, setAutoOpen] = useState<Set<number>>(new Set());
  const [liveIds, setLiveIds] = useState<Set<number>>(new Set());
  const seenThrough = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  // Entries that just arrived open automatically. On first load, only the last three.
  useEffect(() => {
    const lastId = entries.at(-1)?.id ?? 0;
    if (seenThrough.current === null) {
      if (entries.length === 0) return;
      setAutoOpen(new Set(entries.slice(-3).map((entry) => entry.id)));
    } else {
      const fresh = entries.filter((entry) => entry.id > (seenThrough.current ?? 0)).map((entry) => entry.id);
      if (fresh.length > 0) {
        setAutoOpen(new Set(fresh));
        setLiveIds(new Set(fresh));
      }
    }
    seenThrough.current = lastId;
  }, [entries]);

  useEffect(() => {
    const element = scroller.current;
    if (element && followLatest.current) element.scrollTop = element.scrollHeight;
  }, [entries, autoOpen]);

  // Stay pinned to the newest entry when content grows later (details opening, web fonts loading).
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const element = scroller.current;
    const list = element?.querySelector(".entries");
    if (!element || !list) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasEntries]);

  const isOpen = (entry: WireEntry) => overrides[entry.id] ?? (entry.outcome === "error" || autoOpen.has(entry.id));
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(entries.map((entry) => [entry.id, open])));

  return (
    <div
      className="wire-scroll"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <header className="wire-head">
        <div className="wire-toolbar">
          <h2>Wire log</h2>
          <span className="wire-count">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
          <button type="button" className="button small" onClick={() => setAll(true)}>
            Expand all
          </button>
          <button type="button" className="button small" onClick={() => setAll(false)}>
            Collapse all
          </button>
          <button type="button" className="button small" onClick={onClear}>
            Clear log
          </button>
        </div>
        <p className="wire-legend">
          <span>
            <span className="swatch" aria-hidden="true" /> Direct HTTP request
          </span>
          <span>
            <span className="swatch swatch-dashed" aria-hidden="true" /> Browser redirect (front channel)
          </span>
          <span>Secrets are redacted on the server. There is no way to reveal them.</span>
        </p>
        <div className="lanes" aria-hidden="true">
          {LANES.map((lane) => (
            <span key={lane.name} className={lane.className}>
              {lane.name}
            </span>
          ))}
        </div>
      </header>

      {entries.length === 0 ? (
        <p className="wire-empty">No protocol traffic yet. Click Connect to start the flow.</p>
      ) : (
        <ol className="entries">
          {entries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              open={isOpen(entry)}
              isNew={liveIds.has(entry.id)}
              onToggle={() => setOverrides((current) => ({ ...current, [entry.id]: !isOpen(entry) }))}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Entry({ entry, open, isNew, onToggle }: { entry: WireEntry; open: boolean; isNew: boolean; onToggle: () => void }) {
  const safe = redact(entry);
  const info = DIRECTIONS[safe.direction];
  const span = Math.abs(info.to - info.from);
  const track = { "--start": Math.min(info.from, info.to), "--span": span } as CSSProperties;
  const verdict = (safe.result as { verdict?: unknown } | undefined)?.verdict;
  const classes = ["entry", `dir-${safe.direction}`, `outcome-${safe.outcome}`, isNew ? "is-new" : ""];

  return (
    <li className={classes.join(" ")}>
      <button type="button" className="entry-summary" aria-expanded={open} onClick={onToggle}>
        <span className="entry-meta">
          <span className="entry-id">#{safe.id}</span>
          <time dateTime={safe.timestamp}>{new Date(safe.timestamp).toLocaleTimeString([], { hour12: false })}</time>
          <span className="entry-step">{safe.step}</span>
          {safe.status !== undefined && <span className="status-pill">{safe.status}</span>}
        </span>
        <span className="lane-track" style={track}>
          {span === 0 ? (
            <span className="self-marker">{typeof verdict === "string" ? verdict : "Inside Node client"}</span>
          ) : (
            <>
              <span className="arrow-label">{[safe.method, shortEndpoint(safe.endpoint)].filter(Boolean).join(" ")}</span>
              <span
                className={[
                  "arrow",
                  info.to > info.from ? "rightward" : "leftward",
                  info.redirect ? "is-redirect" : "",
                ].join(" ")}
              />
            </>
          )}
        </span>
      </button>
      {open && <EntryDetails entry={safe} />}
    </li>
  );
}

function EntryDetails({ entry }: { entry: WireEntry }) {
  const info = DIRECTIONS[entry.direction];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const notes = (entry.notes ?? []).filter(Boolean);

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(redact(entry), null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <div className="entry-details">
      <p className="entry-route">
        <strong>{info.route}</strong>. {info.channel}.
      </p>
      {entry.endpoint && (
        <p className="entry-endpoint">
          <code>
            {entry.method} {entry.endpoint}
          </code>
        </p>
      )}
      {entry.params && Object.keys(entry.params).length > 0 && (
        <>
          <h4>Parameters</h4>
          <KeyValues values={entry.params} />
        </>
      )}
      {entry.result !== undefined && (
        <>
          <h4>Result{entry.status !== undefined ? `: ${entry.status}` : ""}</h4>
          {isPlainObject(entry.result) ? (
            <KeyValues values={entry.result} />
          ) : (
            <pre>{typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result, null, 2)}</pre>
          )}
        </>
      )}
      {notes.length > 0 && (
        <ul className="entry-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <button type="button" className="button small" onClick={copy}>
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy redacted entry"}
      </button>
    </div>
  );
}

function KeyValues({ values }: { values: Record<string, unknown> }) {
  return (
    <dl className="kv">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <Value value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Value({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const hidden = value.startsWith("[REDACTED") || value.endsWith("(truncated)");
    return hidden ? <span className="redacted">{value}</span> : <>{value}</>;
  }
  if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) {
    return <>{value.join(" ")}</>;
  }
  if (typeof value === "object" && value !== null) {
    return <pre>{JSON.stringify(value, null, 2)}</pre>;
  }
  return <>{String(value)}</>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
