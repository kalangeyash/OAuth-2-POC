import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
  /** Same route, read aloud. "→" is announced inconsistently or not at all. */
  spokenRoute: string;
  channel: string;
  redirect: boolean;
}

export const DIRECTIONS: Record<Direction, DirectionInfo> = {
  "browser-client": {
    from: 0,
    to: 1,
    route: "Browser → Node client",
    spokenRoute: "Browser to Node client",
    channel: "Request from the browser",
    redirect: false,
  },
  "browser-auth": {
    from: 0,
    to: 2,
    route: "Browser → Authorization server",
    spokenRoute: "Browser to Authorization server",
    channel: "Front channel: browser redirect",
    redirect: true,
  },
  "auth-browser": {
    from: 2,
    to: 1,
    route: "Authorization server → Browser → Node client",
    spokenRoute: "Authorization server to Browser to Node client",
    channel: "Front channel: browser redirect",
    redirect: true,
  },
  "client-auth": {
    from: 1,
    to: 2,
    route: "Node client → Authorization server",
    spokenRoute: "Node client to Authorization server",
    channel: "Back channel",
    redirect: false,
  },
  "client-fhir": {
    from: 1,
    to: 3,
    route: "Node client → FHIR server",
    spokenRoute: "Node client to FHIR server",
    channel: "Back channel",
    redirect: false,
  },
  internal: {
    from: 1,
    to: 1,
    route: "Inside the Node client",
    spokenRoute: "Inside the Node client",
    channel: "No network traffic",
    redirect: false,
  },
};

/** "/auth/token" instead of the full sandbox URL. The full endpoint is shown when an entry is expanded. */
export function shortEndpoint(endpoint?: string): string {
  if (!endpoint || !/^https?:\/\//.test(endpoint)) return endpoint ?? "";
  const { pathname } = new URL(endpoint);
  const marker = pathname.search(/\/(auth|fhir)\//i);
  return marker >= 0 ? pathname.slice(marker) : "/" + pathname.split("/").filter(Boolean).slice(-2).join("/");
}

type Filter = "all" | "front" | "back" | "errors";

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every entry" },
  { id: "front", label: "Front channel", hint: "Anything that travelled through the browser" },
  { id: "back", label: "Back channel", hint: "Server to server only" },
  { id: "errors", label: "Errors", hint: "Entries the provider refused" },
];

function matchesFilter(entry: WireEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return entry.outcome === "error";
  const info = DIRECTIONS[entry.direction];
  return filter === "front" ? info.redirect : info.channel === "Back channel";
}

/*
 * Elapsed time is measured from the most recent flow start, not from entries[0]:
 * the log is global, survives logouts, and its ids never restart on clear.
 */
function flowStartTime(entries: WireEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // These two step names are set in server/src/routes/auth.ts and are load-bearing here.
    if (entry.direction === "browser-client" && (entry.step === "Connect" || entry.step === "EHR launch")) {
      return new Date(entry.timestamp).getTime();
    }
  }
  return entries.length > 0 ? new Date(entries[0].timestamp).getTime() : null;
}

function formatElapsed(entry: WireEntry, start: number | null): string {
  if (start === null) return "—";
  const delta = (new Date(entry.timestamp).getTime() - start) / 1000;
  if (delta < 0) return "—";
  return delta < 10 ? `t+${delta.toFixed(1)}s` : `t+${Math.round(delta)}s`;
}

interface Props {
  entries: WireEntry[];
  serverReachable: boolean;
  /** False until the first poll has answered: "no traffic yet" would be a guess. */
  loaded: boolean;
  onClear: () => void;
}

export function WireLog({ entries, serverReachable, loaded, onClear }: Props) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [autoOpen, setAutoOpen] = useState<Set<number>>(new Set());
  const [liveIds, setLiveIds] = useState<Set<number>>(new Set());
  // "Receiving traffic" is true for a few seconds after anything lands, so the
  // pane reads as a live instrument rather than a static list.
  const [receiving, setReceiving] = useState(false);
  const liveTimer = useRef<number | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>("all");
  const [focusId, setFocusId] = useState<number | null>(null);
  const seenThrough = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  // Read inside the ResizeObserver callback without re-subscribing it.
  const focusRef = useRef<number | null>(null);
  focusRef.current = focusId;

  const start = useMemo(() => flowStartTime(entries), [entries]);
  const visible = useMemo(() => entries.filter((entry) => matchesFilter(entry, filter)), [entries, filter]);

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
        setReceiving(true);
        // Expire the "just arrived" marking, so it always means *just* arrived.
        // Without this every entry stays flagged new for the rest of the session.
        window.clearTimeout(liveTimer.current);
        liveTimer.current = window.setTimeout(() => {
          setLiveIds(new Set());
          setReceiving(false);
        }, 2600);
      }
    }
    seenThrough.current = lastId;
  }, [entries]);

  // Follow the newest entry — unless one exchange is focused, in which case a new
  // arrival must not scroll it off screen. That is the whole point of focusing.
  useEffect(() => {
    const element = scroller.current;
    if (element && followLatest.current && focusId === null) element.scrollTop = element.scrollHeight;
  }, [entries, autoOpen, focusId]);

  // Stay pinned to the newest entry when content grows later (details opening, web fonts loading).
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const element = scroller.current;
    const list = element?.querySelector(".entries");
    if (!element || !list) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current && focusRef.current === null) element.scrollTop = element.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasEntries]);

  useEffect(() => () => window.clearTimeout(liveTimer.current), []);

  useEffect(() => {
    if (focusId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocusId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId]);

  const focus = useCallback((id: number | null) => {
    setFocusId(id);
    if (id === null) return;
    const node = document.getElementById(`wire-entry-toggle-${id}`);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, []);

  const isOpen = (entry: WireEntry) =>
    overrides[entry.id] ?? (entry.id === focusId || entry.outcome === "error" || autoOpen.has(entry.id));
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
          <span className={receiving ? "wire-live is-receiving" : "wire-live"}>
            <span className="wire-live-dot" aria-hidden="true" />
            {receiving ? "Receiving" : "Listening"}
          </span>
          <span className="wire-count" role="status">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
            {filter !== "all" && ` · ${visible.length} shown`}
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
        <div className="wire-filters">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === filter ? "wire-filter is-on" : "wire-filter"}
              aria-pressed={option.id === filter}
              title={option.hint}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
          {focusId !== null && (
            <button type="button" className="button small" onClick={() => setFocusId(null)}>
              Show all {entries.length} entries
            </button>
          )}
        </div>
        <p className="wire-legend">
          <span>
            <span className="swatch" aria-hidden="true" /> Direct HTTP request
          </span>
          <span>
            <span className="swatch swatch-dashed" aria-hidden="true" /> Browser redirect (front channel)
          </span>
          <span>Secrets are redacted on the server. There is no way to reveal them.</span>
          <span>Select an entry to focus it. Escape clears the focus.</span>
        </p>
        {/* The lane row is positional, so it is hidden from assistive tech; each
            entry carries its own route in words instead. */}
        <p className="visually-hidden">
          The wire log is drawn as a sequence diagram with four columns: Browser, Node client, Authorization server,
          FHIR server. Every entry names its own route.
        </p>
        <div className="lanes" aria-hidden="true">
          {LANES.map((lane) => (
            <span key={lane.name} className={lane.className}>
              {lane.name}
            </span>
          ))}
        </div>
      </header>

      {!loaded ? (
        <p className="wire-empty">
          <span className="wire-empty-title">Connecting to the Node server's log…</span>
          Nothing has been read yet, so there is nothing to show.
        </p>
      ) : !serverReachable ? (
        <p className="wire-empty">
          <span className="wire-empty-title">The Node server is not answering.</span>
          The entries below are the last traffic received. They are kept on screen rather than cleared, so the flow so
          far is still readable.
        </p>
      ) : entries.length === 0 ? (
        <p className="wire-empty">
          <span className="wire-empty-title">Waiting for traffic.</span>
          No protocol traffic yet. Click Connect to start the flow, and every request the Node server makes appears here.
        </p>
      ) : visible.length === 0 ? (
        <p className="wire-empty">
          <span className="wire-empty-title">No entries match this filter.</span>
          {entries.length} entries are hidden. Choose All to see them again.
        </p>
      ) : (
        <ol className={focusId === null ? "entries" : "entries is-focusing"}>
          {visible.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              open={isOpen(entry)}
              isNew={liveIds.has(entry.id)}
              elapsed={formatElapsed(entry, start)}
              focusState={focusId === null ? "none" : entry.id === focusId ? "focused" : "dimmed"}
              onFocus={() => focus(entry.id === focusId ? null : entry.id)}
              onToggle={() => setOverrides((current) => ({ ...current, [entry.id]: !isOpen(entry) }))}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function Entry({
  entry,
  open,
  isNew,
  elapsed,
  focusState,
  onFocus,
  onToggle,
}: {
  entry: WireEntry;
  open: boolean;
  isNew: boolean;
  elapsed: string;
  focusState: "none" | "focused" | "dimmed";
  onFocus: () => void;
  onToggle: () => void;
}) {
  const safe = redact(entry);
  const info = DIRECTIONS[safe.direction];
  const span = Math.abs(info.to - info.from);
  const track = { "--start": Math.min(info.from, info.to), "--span": span } as CSSProperties;
  const verdict = (safe.result as { verdict?: unknown } | undefined)?.verdict;
  const duration = typeof safe.durationMs === "number" ? `${safe.durationMs} ms` : null;
  const classes = [
    "entry",
    `dir-${safe.direction}`,
    `outcome-${safe.outcome}`,
    isNew ? "is-new" : "",
    focusState === "focused" ? "is-focused" : "",
    focusState === "dimmed" ? "is-dimmed" : "",
  ];

  // One sentence that carries everything the arrow says visually.
  const spoken = [
    `Entry ${safe.id}`,
    safe.step,
    info.spokenRoute,
    info.channel,
    safe.method && safe.endpoint ? `${safe.method} ${shortEndpoint(safe.endpoint)}` : null,
    safe.status !== undefined ? `responded ${safe.status}` : "no HTTP response",
    duration ? `in ${safe.durationMs} milliseconds` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li className={classes.filter(Boolean).join(" ")}>
      {/* A static marker as well as the animation, so a reduced-motion viewer
          still sees which request just landed. */}
      {isNew && (
        <span className="entry-new">
          <span aria-hidden="true">●</span> just arrived
        </span>
      )}
      <button
        type="button"
        className="entry-summary"
        id={`wire-entry-toggle-${safe.id}`}
        aria-expanded={open}
        aria-controls={`wire-entry-${safe.id}`}
        aria-label={spoken}
        onClick={onToggle}
      >
        <span className="entry-meta" aria-hidden="true">
          <span className="entry-id">#{safe.id}</span>
          <span className="entry-elapsed" title={new Date(safe.timestamp).toLocaleTimeString([], { hour12: false })}>
            {elapsed}
          </span>
          <span className="entry-step">{safe.step}</span>
          <span className="entry-duration">{duration ?? ""}</span>
          <StatusCell entry={safe} />
        </span>
        <span className="lane-track" style={track} aria-hidden="true">
          {span === 0 ? (
            <span className="self-marker">{typeof verdict === "string" ? verdict : "Inside Node client"}</span>
          ) : (
            <>
              <span className="arrow-label">{[safe.method, shortEndpoint(safe.endpoint)].filter(Boolean).join(" ")}</span>
              <span
                className={["arrow", info.to > info.from ? "rightward" : "leftward", info.redirect ? "is-redirect" : ""].join(
                  " ",
                )}
              />
              {/* The response leg, so one entry visibly is a round trip. */}
              {safe.status !== undefined && (
                <>
                  <span className="arrow-return" />
                  <span className="arrow-return-label">
                    <span>
                      {safe.status}
                      {duration ? ` · ${duration}` : ""}
                    </span>
                  </span>
                </>
              )}
            </>
          )}
        </span>
      </button>
      {open && <EntryDetails entry={safe} onFocus={onFocus} focused={focusState === "focused"} />}
    </li>
  );
}

/*
 * Status is absent on every internal and browser-client entry — the majority of a
 * normal run. An empty cell there would read as "the response is missing", which
 * is a lie: there was no outbound request to respond to.
 */
function StatusCell({ entry }: { entry: WireEntry }) {
  if (entry.status !== undefined) return <span className="status-pill">{entry.status}</span>;
  if (entry.outcome === "error") return <span className="status-pill">failed</span>;
  return (
    <span className="status-none" title="No HTTP response: nothing was sent over the network for this entry.">
      —
    </span>
  );
}

function EntryDetails({ entry, onFocus, focused }: { entry: WireEntry; onFocus: () => void; focused: boolean }) {
  const info = DIRECTIONS[entry.direction];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const notes = (entry.notes ?? []).filter(Boolean);
  const hasRequest = Boolean(entry.params && Object.keys(entry.params).length > 0);
  const hasResponse = entry.result !== undefined || entry.status !== undefined;

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
    <div className="entry-details" id={`wire-entry-${entry.id}`} role="region" aria-labelledby={`wire-entry-toggle-${entry.id}`}>
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

      {entry.direction === "browser-client" && (
        <p className="lede">
          This is the browser's own request to the Node server. The Node server's answer is the page or JSON you are
          looking at, so it is not logged as a separate response.
        </p>
      )}

      {/* One wire entry already IS a request/response pair. Saying so explicitly is
          the difference between a log and a trace. */}
      {(hasRequest || hasResponse) && (
        <div className="entry-exchange">
          {hasRequest && (
            <div className="exchange-side">
              <h4>Request</h4>
              <KeyValues values={entry.params as Record<string, unknown>} />
            </div>
          )}
          {hasResponse && (
            <div className="exchange-side">
              <h4>Response</h4>
              <p className="exchange-status">
                {entry.status !== undefined ? entry.status : "no HTTP response"}
                {typeof entry.durationMs === "number" ? ` · ${entry.durationMs} ms` : ""}
              </p>
              {entry.result !== undefined &&
                (isPlainObject(entry.result) ? (
                  <KeyValues values={entry.result} />
                ) : (
                  <pre>{typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result, null, 2)}</pre>
                ))}
            </div>
          )}
        </div>
      )}

      {notes.length > 0 && (
        <ul className="entry-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="entry-actions">
        <button type="button" className="button small" onClick={onFocus}>
          {focused ? "Clear focus" : "Focus this exchange"}
        </button>
        <button type="button" className="button small" onClick={copy}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy redacted entry"}
        </button>
      </div>
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
