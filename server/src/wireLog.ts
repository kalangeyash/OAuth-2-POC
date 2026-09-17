import { redact } from "./redaction.js";

/*
 * The wire log: a timestamped record of every important protocol step.
 *
 * Every entry passes through redact() BEFORE it is stored or printed, so the log
 * never holds a credential, and GET /api/wirelog can only return redacted data.
 *
 * One global in-memory list: this is a single-presenter demo.
 */

export type Direction =
  | "browser-client" // Browser → Node OAuth client
  | "browser-auth" // Browser → authorization server (front channel)
  | "auth-browser" // Authorization server → browser → Node client (front channel)
  | "client-auth" // Node client → authorization server (back channel)
  | "client-fhir" // Node client → FHIR server
  | "internal"; // A check or change inside the Node client

const DIRECTION_LABELS: Record<Direction, string> = {
  "browser-client": "Browser → Node client",
  "browser-auth": "Browser → Authorization server",
  "auth-browser": "Authorization server → Browser → Node client",
  "client-auth": "Node client → Authorization server",
  "client-fhir": "Node client → FHIR server",
  internal: "Inside Node client",
};

export interface WireEntry {
  id: number;
  timestamp: string;
  direction: Direction;
  step: string;
  method?: string;
  endpoint?: string;
  params?: Record<string, unknown>;
  status?: number | string;
  result?: unknown;
  notes?: string[];
  outcome: "ok" | "error" | "info";
}

const MAX_ENTRIES = 500;
const entries: WireEntry[] = [];
let nextId = 1;

export function record(entry: Omit<WireEntry, "id" | "timestamp">): WireEntry {
  const safe = redact({ id: nextId++, timestamp: new Date().toISOString(), ...entry });
  entries.push(safe);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  console.log(formatForConsole(safe));
  return safe;
}

export function listEntries(sinceId = 0): WireEntry[] {
  return entries.filter((entry) => entry.id > sinceId);
}

export function clearEntries(): void {
  entries.length = 0;
}

/** The id the next entry will receive. Used to group the entries a demo produces. */
export function nextEntryId(): number {
  return nextId;
}

/** Console logging outside the wire log goes through the same redaction helper. */
export function logSafely(message: string, data?: unknown): void {
  console.log(data === undefined ? message : `${message} ${JSON.stringify(redact(data))}`);
}

function formatForConsole(entry: WireEntry): string {
  const time = entry.timestamp.slice(11, 19);
  const request = [entry.method, entry.endpoint].filter(Boolean).join(" ");
  const status = entry.status === undefined ? "" : ` → ${entry.status}`;
  const details = JSON.stringify({ params: entry.params, result: entry.result, notes: entry.notes }, null, 2);
  return `[wire #${entry.id} ${time}] ${DIRECTION_LABELS[entry.direction]} | ${entry.step}${request ? ` | ${request}` : ""}${status}\n${details}`;
}
