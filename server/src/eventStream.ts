import type { IncomingMessage, ServerResponse } from "node:http";
import { labState, subscribeLab } from "./lab.js";
import { BOOT_ID, listEntries, nextEntryId, subscribe, type WireEntry } from "./wireLog.js";

/*
 * GET /api/events: the wire log as a Server-Sent Events stream.
 *
 * Every page that is open receives each event the moment record() stores it, so
 * the timeline, the sequence diagram and every panel update from real server
 * events, not from a timer. Entries are redacted inside record(), before they are
 * stored or published, so this stream can only ever carry redacted data.
 *
 *   event: hello    {bootId, latestId}   first, on every (re)connection
 *   id: n + data    one wire-log entry     backlog first, then live
 *   event: cleared  {}                    the log was cleared (from any tab)
 *   event: lab      {mode, breakpoint}    the protocol debugger's state, on connect and on every change
 *   : ping                                every 15 s, so proxies keep the connection open
 *
 * EventSource reconnects on its own and sends Last-Event-ID; the backlog then
 * starts after that id, so nothing is missed or repeated across a reconnect.
 */

const HEARTBEAT_MS = 15_000;

export function streamEvents(req: IncomingMessage, res: ServerResponse, heartbeatMs = HEARTBEAT_MS): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells buffering reverse proxies (nginx) to pass each event straight through.
    "X-Accel-Buffering": "no",
  });

  const latestId = nextEntryId() - 1;
  const lastEventId = Number(req.headers["last-event-id"]) || 0;
  // An id from before a server restart can be ahead of this process's log: send everything.
  const since = lastEventId > latestId ? 0 : lastEventId;

  // Ask EventSource to wait 2 s before reconnecting after a drop.
  res.write("retry: 2000\n\n");
  sendEvent(res, "hello", { bootId: BOOT_ID, latestId });
  for (const entry of listEntries(since)) sendEntry(res, entry);
  sendEvent(res, "lab", labState());

  const unsubscribe = subscribe((event) => {
    if (event.type === "entry") sendEntry(res, event.entry);
    else sendEvent(res, "cleared", {});
  });
  const unsubscribeLab = subscribeLab((state) => sendEvent(res, "lab", state));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeLab();
  };
  req.on("close", close);
  res.on("close", close);
}

function sendEntry(res: ServerResponse, entry: WireEntry): void {
  res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
}

function sendEvent(res: ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
