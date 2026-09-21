import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ACTOR_ORDER, ACTORS } from "../../../server/src/timeline";
import { explain, isFailure, shortPath } from "../model";
import { isEssential, matchesFilters, usePresenter } from "../presenter";
import type { ActorId, LabState, WireEntry } from "../types";

/*
 * THE LIVE PROTOCOL CANVAS: a sequence diagram drawn only from real events.
 *
 * One wire-log entry becomes one or two arrows ("legs"):
 *   - a browser redirect is two dashed legs: Node ┄302┄► Browser ┄GET┄► Auth server
 *   - a back-channel call is a solid request ► and a thin response ◄ (status · ms)
 *   - a step inside Node is a small self-loop
 * Between the authorization request and the callback sits a shaded block on the
 * authorization server: login and consent, which this app cannot see.
 *
 * A request the debugger is holding is drawn as a ghost arrow marked "not sent".
 * Only arrows that arrived live animate; history from before the page loaded is drawn still.
 */

type LegStyle = "redirect" | "request" | "response" | "self";
type Tone = "ok" | "error" | "info" | "held";

interface Leg {
  key: string;
  kind: "leg";
  entry: WireEntry;
  from: ActorId;
  to: ActorId;
  style: LegStyle;
  label: string;
  sub: string;
  tone: Tone;
  /** Time since the previous message, shown in the gutter. */
  gap: string | null;
}

interface Block {
  key: string;
  kind: "block";
  waiting: boolean;
}

interface PauseMarker {
  key: string;
  kind: "pause";
  entry: WireEntry;
}

type Row = Leg | Block | PauseMarker;

const LANE_CENTER: Record<ActorId, number> = { browser: 10, react: 30, node: 50, auth: 70, fhir: 90 };

interface Props {
  entries: WireEntry[];
  /** The latest run only, or everything. */
  runEntries: WireEntry[];
  lab: LabState;
  liveIds: Set<number>;
  awaitingAuthorizationServer: boolean;
}

export function ProtocolCanvas({ entries, runEntries, lab, liveIds, awaitingAuthorizationServer }: Props) {
  const { selectedId, select, filters, detailLevel } = usePresenter();
  const [scope, setScope] = useState<"run" | "all">("run");
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the newest message until the PRESENTER scrolls away (wheel, touch, keys).
  // Programmatic scrolls never count, so following cannot switch itself off.
  const [pinnedToLatest, setPinnedToLatest] = useState(true);
  const userScrolling = useRef(false);

  const source = scope === "run" ? runEntries : entries;
  const heldId = lab.breakpoint?.entryId ?? null;
  const visible = useMemo(
    () =>
      source.filter(
        (entry) =>
          entry.id === heldId ||
          (matchesFilters(entry, filters) && (detailLevel === "everything" || isEssential(entry, heldId))),
      ),
    [source, filters, heldId, detailLevel],
  );
  const hiddenCount = source.length - visible.length;
  const rows = useMemo(
    () => buildRows(visible, lab, awaitingAuthorizationServer),
    [visible, lab, awaitingAuthorizationServer],
  );

  const latestId = visible.at(-1)?.id ?? null;
  const currentId = lab.breakpoint?.entryId ?? latestId;
  const currentEntry = visible.find((entry) => entry.id === currentId);
  const currentActors = new Set<ActorId>();
  if (currentEntry) {
    const legs = rows.filter((row): row is Leg => row.kind === "leg" && row.entry.id === currentEntry.id);
    for (const leg of legs) {
      currentActors.add(leg.from);
      currentActors.add(leg.to);
    }
  }

  // Follow the newest message (layout effect: before paint, so it never flickers).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinnedToLatest) element.scrollTop = element.scrollHeight;
  }, [rows, pinnedToLatest]);

  // A message chosen elsewhere (traffic monitor, inspector ←/→) is brought into view,
  // without animation, and only if it is off screen. Following the latest is untouched.
  useEffect(() => {
    if (selectedId === null || pinnedToLatest) return;
    const element = scroller.current;
    const node = element?.querySelector<HTMLElement>(`[data-entry="${selectedId}"]`);
    if (!element || !node) return;
    const box = node.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    if (box.top < view.top + 30 || box.bottom > view.bottom) node.scrollIntoView({ block: "center" });
  }, [selectedId, pinnedToLatest]);

  const markUserScroll = () => {
    userScrolling.current = true;
  };

  return (
    <section className="canvas" aria-label="Live protocol canvas">
      <header className="canvas-head">
        <div className="canvas-title">
          <h2>Live protocol canvas</h2>
          <span className="canvas-count">
            {visible.length} message{visible.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Messages shown">
          <button type="button" aria-pressed={scope === "run"} onClick={() => setScope("run")}>
            This run
          </button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
            Everything
          </button>
        </div>
      </header>

      <p className="visually-hidden">
        A sequence diagram with five columns: Browser, React UI, Node BFF, Authorization server, FHIR server. Each message
        is a button that names its route; activate it to inspect the message.
      </p>

      <div
        className="canvas-scroll"
        ref={scroller}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onKeyDown={markUserScroll}
        onPointerDown={markUserScroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          if (atBottom) setPinnedToLatest(true);
          else if (userScrolling.current) setPinnedToLatest(false);
          userScrolling.current = false;
        }}
      >
        {/* Inside the scroller (and sticky), so a scrollbar can never shift the heads off their lifelines. */}
        <div className="lifeline-heads" aria-hidden="true">
          {ACTOR_ORDER.map((actor) => (
            <span key={actor} className={`lifeline-head actor-${actor}${currentActors.has(actor) ? " is-current" : ""}`}>
              {ACTORS[actor].short}
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="canvas-empty">
            <strong>No messages yet.</strong> Choose a scenario and press Run. Every real message between the five actors
            appears here the moment it happens.
          </p>
        ) : (
          <ol className="seq">
            {rows.map((row) =>
              row.kind === "block" ? (
                <li key={row.key} className={`seq-block${row.waiting ? " is-waiting" : ""}`}>
                  <span className="seq-block-box">
                    Login + consent at the authorization server
                    <small>{row.waiting ? "happening now — not visible to this app" : "not visible to this app"}</small>
                  </span>
                </li>
              ) : row.kind === "pause" ? (
                <li key={row.key} className="seq-pause" data-entry={row.entry.id}>
                  <button type="button" onClick={() => select(row.entry.id)}>
                    ⏸ paused: {row.entry.step.replace(/^⏸ (Before send|Paused before): /, "")}
                  </button>
                </li>
              ) : (
                <SeqLeg
                  key={row.key}
                  leg={row}
                  selected={row.entry.id === selectedId}
                  current={row.entry.id === currentId}
                  live={liveIds.has(row.entry.id)}
                  onSelect={() => select(row.entry.id)}
                />
              ),
            )}
          </ol>
        )}
      </div>
      {!pinnedToLatest && rows.length > 0 && (
        <button type="button" className="button small jump-latest" onClick={() => setPinnedToLatest(true)}>
          ↓ Jump to latest
        </button>
      )}
      {detailLevel === "essentials" && hiddenCount > 0 && (
        <p className="canvas-hidden-note">
          {hiddenCount} routine step{hiddenCount === 1 ? "" : "s"} inside Node hidden (Essentials). Switch to Everything to see them.
        </p>
      )}
    </section>
  );
}

function SeqLeg({
  leg,
  selected,
  current,
  live,
  onSelect,
}: {
  leg: Leg;
  selected: boolean;
  current: boolean;
  live: boolean;
  onSelect: () => void;
}) {
  const from = LANE_CENTER[leg.from];
  const to = LANE_CENTER[leg.to];
  // Labels may reach past the two lanes they connect (up to half a lane each side), so short spans stay readable.
  const low = Math.max(0, Math.min(from, to) - 10);
  const high = Math.min(100, Math.max(from, to) + 10);
  const classes = [
    "seq-row",
    `style-${leg.style}`,
    `tone-${leg.tone}`,
    selected ? "is-selected" : "",
    current ? "is-current" : "",
    live ? "is-live" : "",
    to < from ? "is-leftward" : "",
  ];
  const spoken = `#${leg.entry.id} ${leg.entry.step}: ${ACTORS[leg.from].short} to ${ACTORS[leg.to].short}, ${leg.label}${leg.sub ? `, ${leg.sub}` : ""}`;

  return (
    <li className={classes.filter(Boolean).join(" ")} data-entry={leg.entry.id}>
      <button type="button" className="seq-hit" aria-label={spoken} aria-pressed={selected} onClick={onSelect}>
        <span className="seq-gap" aria-hidden="true">
          {leg.gap ?? ""}
        </span>
        <span className="seq-track" aria-hidden="true">
          {leg.style === "self" ? (
            <>
              <svg className="seq-self" viewBox="0 0 40 26" style={{ left: `${from}%` }}>
                <path d="M0 5 H26 Q34 5 34 13 Q34 21 26 21 H6" className="seq-line" markerEnd={`url(#seq-head-${leg.tone})`} />
              </svg>
              <span className="seq-self-label" style={{ left: `calc(${from}% + 44px)` }}>
                <span className="seq-name">{leg.label}</span>
                {leg.sub && <span className="seq-sub">{leg.sub}</span>}
              </span>
            </>
          ) : (
            <>
              <span className="seq-label" style={{ left: `${low}%`, width: `${high - low}%` }}>
                <span className="seq-name">{leg.label}</span>
              </span>
              <svg className="seq-svg" width="100%" height="16">
                <line
                  x1={`${from}%`}
                  x2={`${to}%`}
                  y1="8"
                  y2="8"
                  className="seq-line"
                  markerEnd={`url(#${leg.style === "response" ? "seq-open" : "seq-head"}-${leg.tone})`}
                />
                <circle cx={`${from}%`} cy="8" r="3.5" className="seq-origin" />
              </svg>
              {leg.sub && (
                <span className="seq-sub" style={{ left: `${low}%`, width: `${high - low}%` }}>
                  {leg.sub}
                </span>
              )}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

/** The arrowheads, defined once and referenced by every arrow. */
export function SeqMarkers() {
  const tones: Tone[] = ["ok", "error", "info", "held"];
  return (
    <svg width="0" height="0" className="seq-defs" aria-hidden="true" focusable="false">
      <defs>
        {tones.map((tone) => (
          <g key={tone}>
            <marker id={`seq-head-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className={`seq-mark tone-${tone}`} />
            </marker>
            <marker id={`seq-open-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M1,1 L9,5 L1,9" className={`seq-mark-open tone-${tone}`} />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Entries → rows
// ---------------------------------------------------------------------------

function buildRows(entries: WireEntry[], lab: LabState, awaitingAuthorizationServer: boolean): Row[] {
  const rows: Row[] = [];
  let previous: WireEntry | null = null;

  entries.forEach((entry, index) => {
    const gap = previous ? formatGap(Date.parse(entry.timestamp) - Date.parse(previous.timestamp)) : null;
    previous = entry;

    if (entry.breakpoint) {
      if (entry.id !== lab.breakpoint?.entryId) {
        rows.push({ key: `pause-${entry.id}`, kind: "pause", entry });
        return;
      }
      rows.push(...heldLegs(entry, gap));
      return;
    }

    rows.push(...legsOf(entry, gap));

    // Login and consent happen between the authorization request and the callback.
    if (entry.direction === "browser-auth") {
      const rest = entries.slice(index + 1).filter((item) => !item.breakpoint && item.direction !== "internal");
      const next = rest[0];
      const callbackFollows = next?.direction === "auth-browser";
      if (callbackFollows || !next) {
        rows.push({ key: `block-${entry.id}`, kind: "block", waiting: !callbackFollows && awaitingAuthorizationServer });
      }
    }
  });
  return rows;
}

function legsOf(entry: WireEntry, gap: string | null): Leg[] {
  const tone: Tone = isFailure(entry) ? "error" : entry.outcome === "ok" ? "ok" : "info";
  const path = shortPath(entry.endpoint);
  const request = [entry.method, path].filter(Boolean).join(" ");
  const status = entry.status !== undefined ? String(entry.status) : "";
  const ms = typeof entry.durationMs === "number" ? `${entry.durationMs} ms` : "";
  const summary = oneLine(explain(entry));
  const base = { entry, gap, tone };

  switch (entry.direction) {
    case "browser-client":
      return [{ ...base, key: `${entry.id}`, kind: "leg", from: "browser", to: "node", style: "request", label: request || entry.step, sub: entry.step }];
    case "react-client":
      return [{ ...base, key: `${entry.id}`, kind: "leg", from: "react", to: "node", style: "request", label: request || entry.step, sub: entry.step }];
    case "browser-auth":
      return [
        { ...base, key: `${entry.id}-a`, kind: "leg", from: "node", to: "browser", style: "redirect", label: "302 Found · Location: authorization endpoint", sub: "" },
        { ...base, gap: null, key: `${entry.id}-b`, kind: "leg", from: "browser", to: "auth", style: "redirect", label: `GET ${path} (authorization request)`, sub: summary },
      ];
    case "auth-browser": {
      const params = entry.params ?? {};
      const carried = "error" in params ? "error=…" : "code=…&state=…";
      return [
        { ...base, key: `${entry.id}-a`, kind: "leg", from: "auth", to: "browser", style: "redirect", label: `302 · Location: /callback?${carried}`, sub: "" },
        { ...base, gap: null, key: `${entry.id}-b`, kind: "leg", from: "browser", to: "node", style: "redirect", label: `GET /callback?${carried}`, sub: summary },
      ];
    }
    case "client-auth":
    case "client-fhir": {
      const target: ActorId = entry.direction === "client-auth" ? "auth" : "fhir";
      const legs: Leg[] = [
        { ...base, key: `${entry.id}-req`, kind: "leg", from: "node", to: target, style: "request", label: request, sub: `${entry.step} — ${summary}` },
      ];
      if (status) {
        legs.push({
          ...base,
          gap: null,
          key: `${entry.id}-res`,
          kind: "leg",
          from: target,
          to: "node",
          style: "response",
          label: [status, ms].filter(Boolean).join(" · "),
          sub: responseSummary(entry),
        });
      }
      return legs;
    }
    case "internal":
      return [{ ...base, key: `${entry.id}`, kind: "leg", from: "node", to: "node", style: "self", label: entry.step, sub: "" }];
  }
}

/** The request the debugger is holding: drawn, but clearly not sent. */
function heldLegs(entry: WireEntry, gap: string | null): Leg[] {
  const kind = entry.breakpoint?.kind;
  const path = shortPath(entry.endpoint);
  const base = { entry, gap, tone: "held" as const, kind: "leg" as const };
  const label = entry.step.replace(/^⏸ (Before send|Paused before): /, "");
  if (kind === "internal" || entry.direction === "internal") {
    return [{ ...base, key: `${entry.id}`, from: "node", to: "node", style: "self", label: `⏸ ${label}`, sub: "paused before this step runs" }];
  }
  if (entry.direction === "browser-auth") {
    return [{ ...base, key: `${entry.id}`, from: "node", to: "browser", style: "redirect", label: `⏸ 302 → ${path} — NOT SENT`, sub: "held by the debugger" }];
  }
  const target: ActorId = entry.direction === "client-fhir" ? "fhir" : "auth";
  return [
    {
      ...base,
      key: `${entry.id}`,
      from: "node",
      to: target,
      style: "request",
      label: `⏸ ${[entry.method, path].filter(Boolean).join(" ")} — NOT SENT`,
      sub: "held by the debugger: inspect it, then Send",
    },
  ];
}

function responseSummary(entry: WireEntry): string {
  const result = entry.result as Record<string, unknown> | undefined;
  if (result && typeof result === "object") {
    if (typeof result.error === "string") return `${result.error}${typeof result.error_description === "string" ? `: ${result.error_description}` : ""}`;
    if ("access_token" in result) return "access + refresh + ID tokens (redacted)";
    if (typeof result.resourceType === "string") return `${result.resourceType}${typeof result.total === "number" ? ` · ${result.total} total` : ""}`;
    if ("authorization_endpoint" in result) return "SMART configuration: endpoints discovered";
  }
  return "";
}

function oneLine(text: string): string {
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence;
}

function formatGap(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `+${ms} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60_000)} min`;
}
