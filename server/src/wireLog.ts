import { randomUUID } from "node:crypto";
import { redact } from "./redaction.js";
import { channelOf, type Category, type Direction, type WireEntry } from "./timeline.js";

export type { Direction, WireEntry } from "./timeline.js";

/*
 * The wire log: a timestamped record of every important protocol step.
 *
 * Every entry passes through redact() BEFORE it is stored, printed or published,
 * so the log never holds a credential, and neither GET /api/wirelog nor the
 * /api/events stream can return anything but redacted data.
 *
 * One global in-memory list: this is a single-presenter demo.
 */

const DIRECTION_LABELS: Record<Direction, string> = {
  "browser-client": "Browser → Node client",
  "react-client": "React app → Node client",
  "browser-auth": "Browser → Authorization server",
  "auth-browser": "Authorization server → Browser → Node client",
  "client-auth": "Node client → Authorization server",
  "client-fhir": "Node client → FHIR server",
  internal: "Inside Node client",
};

/** Changes on every server start, so a browser can tell a restarted log from a continued one. */
export const BOOT_ID = randomUUID();

/** What callers pass to record(). id, timestamp and channel are always filled in here. */
export type WireInput = Omit<WireEntry, "id" | "timestamp" | "channel" | "category"> & { category?: Category };

export type LogEvent = { type: "entry"; entry: WireEntry } | { type: "cleared" };

/*
 * One stopwatch per outbound request. performance.now() is monotonic, so a clock
 * adjustment mid-demo cannot produce a negative or wild duration.
 */
export function startTimer(): () => number {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
}

const MAX_ENTRIES = 500;
const entries: WireEntry[] = [];
const listeners = new Set<(event: LogEvent) => void>();
let nextId = 1;

export function record(input: WireInput): WireEntry {
  const entry: WireEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    ...input,
    channel: channelOf(input.direction),
    category: input.category ?? defaultCategory(input.direction),
  };
  const safe = redact(entry);
  entries.push(safe);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  console.log(formatForConsole(safe));
  publish({ type: "entry", entry: safe });
  return safe;
}

export function listEntries(sinceId = 0): WireEntry[] {
  return entries.filter((entry) => entry.id > sinceId);
}

export function clearEntries(): void {
  entries.length = 0;
  publish({ type: "cleared" });
}

/** The id the next entry will receive. Used to group the entries a demo produces. */
export function nextEntryId(): number {
  return nextId;
}

/** Live listeners (the /api/events stream). They only ever receive redacted entries. */
export function subscribe(listener: (event: LogEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Console logging outside the wire log goes through the same redaction helper. */
export function logSafely(message: string, data?: unknown): void {
  console.log(data === undefined ? message : `${message} ${JSON.stringify(redact(data))}`);
}

function publish(event: LogEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // One broken stream must not stop the others, or the request that recorded the entry.
      console.error(`[wire] listener failed: ${(error as Error).message}`);
    }
  }
}

function defaultCategory(direction: Direction): Category {
  if (direction === "client-fhir") return "fhir";
  if (direction === "client-auth") return "token";
  if (direction === "browser-auth" || direction === "auth-browser") return "redirect";
  return "authorization";
}

function formatForConsole(entry: WireEntry): string {
  const time = entry.timestamp.slice(11, 19);
  const request = [entry.method, entry.endpoint].filter(Boolean).join(" ");
  const status = entry.status === undefined ? "" : ` → ${entry.status}`;
  const details = JSON.stringify({ params: entry.params, result: entry.result, notes: entry.notes }, null, 2);
  return `[wire #${entry.id} ${time}] ${DIRECTION_LABELS[entry.direction]} | ${entry.step}${request ? ` | ${request}` : ""}${status}\n${details}`;
}
