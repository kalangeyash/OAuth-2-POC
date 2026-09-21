import { useEffect, useRef, useState } from "react";
import type { LabState, WireEntry } from "./types";

/*
 * The live wire log, streamed from GET /api/events (Server-Sent Events).
 *
 * Every entry the Node server records arrives here the moment it is recorded.
 * The server has already redacted it; nothing in this hook can un-redact it.
 *
 * - "history" is what the server had before this page connected (for example,
 *   everything recorded while this page was away at the authorization server).
 *   It is shown, but never animated as if it had just happened.
 * - A new bootId means the Node server restarted and its numbering began again,
 *   so the entries are replaced rather than merged.
 * - Messages are applied once per animation frame, so a 500-entry backlog costs
 *   one render, not 500.
 */

const MAX_ENTRIES = 500;

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface EventStream {
  entries: WireEntry[];
  status: StreamStatus;
  /** True once the server has answered at least once. */
  loaded: boolean;
  /** Entries with an id up to this were recorded before this page connected. */
  historyThrough: number;
  /** The protocol debugger: its mode and the breakpoint it is holding, if any. */
  lab: LabState;
}

const INITIAL_LAB: LabState = { mode: "run", breakpoint: null, queued: 0 };

export function useEventStream(onLiveEntry?: (entry: WireEntry) => void): EventStream {
  const [entries, setEntries] = useState<WireEntry[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [historyThrough, setHistoryThrough] = useState(0);
  const [lab, setLab] = useState<LabState>(INITIAL_LAB);
  const onLive = useRef(onLiveEntry);
  onLive.current = onLiveEntry;

  useEffect(() => {
    let source: EventSource | null = null;
    let bootId: string | null = null;
    let firstHello = true;
    let liveAfter = Number.POSITIVE_INFINITY;
    let queue: WireEntry[] = [];
    let reset = false;
    let frame = 0;

    const flush = () => {
      frame = 0;
      const batch = queue;
      const wasReset = reset;
      queue = [];
      reset = false;
      setEntries((current) => {
        const base = wasReset ? [] : current;
        const known = new Set(base.map((entry) => entry.id));
        const fresh = batch.filter((entry) => !known.has(entry.id));
        return fresh.length === 0 && !wasReset ? current : [...base, ...fresh].slice(-MAX_ENTRIES);
      });
      for (const entry of batch) if (entry.id > liveAfter) onLive.current?.(entry);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    const open = () => {
      source = new EventSource("/api/events");

      source.addEventListener("hello", (message) => {
        const hello = JSON.parse((message as MessageEvent<string>).data) as { bootId: string; latestId: number };
        if (bootId !== null && hello.bootId !== bootId) {
          // The server restarted: start again from an empty log, with no Last-Event-ID.
          bootId = hello.bootId;
          queue = [];
          reset = true;
          schedule();
          source?.close();
          open();
          return;
        }
        bootId = hello.bootId;
        if (firstHello) {
          firstHello = false;
          setHistoryThrough(hello.latestId);
        }
        liveAfter = Math.min(liveAfter === Number.POSITIVE_INFINITY ? hello.latestId : liveAfter, hello.latestId);
        setStatus("live");
        setLoaded(true);
      });

      source.addEventListener("message", (message) => {
        queue.push(JSON.parse((message as MessageEvent<string>).data) as WireEntry);
        schedule();
      });

      source.addEventListener("lab", (message) => {
        setLab(JSON.parse((message as MessageEvent<string>).data) as LabState);
      });

      source.addEventListener("cleared", () => {
        queue = [];
        reset = true;
        schedule();
      });

      // EventSource reconnects by itself (and sends Last-Event-ID); just say so.
      source.onerror = () => setStatus("reconnecting");
    };

    open();
    return () => {
      source?.close();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return { entries, status, loaded, historyThrough, lab };
}
