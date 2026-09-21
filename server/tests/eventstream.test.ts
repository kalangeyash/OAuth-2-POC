import assert from "node:assert/strict";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { streamEvents } from "../src/eventStream.js";
import { BOOT_ID, clearEntries, record } from "../src/wireLog.js";

interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

let server: Server;
let port: number;

before(async () => {
  server = createServer((req, res) => streamEvents(req, res, 50));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens the stream and collects parsed events until `done` says stop. */
function openStream(headers: Record<string, string> = {}) {
  const events: SseEvent[] = [];
  const raw: string[] = [];
  let response: IncomingMessage | undefined;
  let buffer = "";
  const waiters: (() => void)[] = [];

  const request = get({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
    response = res;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw.push(chunk);
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event: SseEvent = { event: "message", data: undefined };
        let hasData = false;
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event.event = line.slice(7);
          else if (line.startsWith("id: ")) event.id = line.slice(4);
          else if (line.startsWith("data: ")) {
            event.data = JSON.parse(line.slice(6));
            hasData = true;
          }
        }
        if (hasData) events.push(event);
      }
      waiters.splice(0).forEach((wake) => wake());
    });
  });

  async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out; received: ${JSON.stringify(events)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  return {
    events,
    /** Wire-log entries only (not hello, lab or cleared). */
    messages: () => events.filter((event) => event.event === "message"),
    raw,
    until,
    get response() {
      return response;
    },
    close: () => request.destroy(),
  };
}

test("hello first, then the backlog with ids, then live entries", async () => {
  clearEntries();
  const first = record({ direction: "internal", step: "before connecting", outcome: "info" });
  const stream = openStream();
  await stream.until(() => stream.events.some((event) => event.event === "lab"));

  assert.equal(stream.response?.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(stream.events[0].event, "hello");
  assert.deepEqual(stream.events[0].data, { bootId: BOOT_ID, latestId: first.id });
  assert.equal(stream.events[1].id, String(first.id));
  assert.equal((stream.events[1].data as { step: string }).step, "before connecting");
  // The debugger's state follows the backlog.
  assert.deepEqual(stream.events[2], { event: "lab", data: { mode: "run", breakpoint: null, queued: 0 } });

  const live = record({ direction: "internal", step: "while connected", outcome: "info" });
  await stream.until(() => stream.messages().length >= 2);
  assert.equal(stream.messages()[1].id, String(live.id));
  assert.equal((stream.messages()[1].data as { step: string }).step, "while connected");
  stream.close();
});

test("Last-Event-ID resumes after that entry, without repeating it", async () => {
  clearEntries();
  const one = record({ direction: "internal", step: "one", outcome: "info" });
  record({ direction: "internal", step: "two", outcome: "info" });
  const stream = openStream({ "Last-Event-ID": String(one.id) });
  await stream.until(() => stream.events.some((event) => event.event === "lab"));
  const steps = stream.messages().map((event) => (event.data as { step: string }).step);
  assert.deepEqual(steps, ["two"]);
  stream.close();
});

test("a Last-Event-ID from before a restart (ahead of this log) replays everything", async () => {
  clearEntries();
  record({ direction: "internal", step: "only entry", outcome: "info" });
  const stream = openStream({ "Last-Event-ID": "999999" });
  await stream.until(() => stream.messages().length >= 1);
  assert.equal((stream.messages()[0].data as { step: string }).step, "only entry");
  stream.close();
});

test("clearing the log is streamed as a cleared event", async () => {
  clearEntries();
  const stream = openStream();
  await stream.until(() => stream.events.length >= 1);
  clearEntries();
  await stream.until(() => stream.events.some((event) => event.event === "cleared"));
  stream.close();
});

test("credentials recorded while streaming arrive redacted", async () => {
  clearEntries();
  const stream = openStream();
  await stream.until(() => stream.events.length >= 1);
  record({
    direction: "client-auth",
    step: "Token exchange",
    params: { code: "code-value-that-is-long", code_verifier: "verifier-secret-value" },
    requestHeaders: { Authorization: "Basic Y2xpZW50OnNlY3JldA==" },
    result: { access_token: "access-token-secret", refresh_token: "refresh-token-secret", id_token: "id-token-secret" },
    outcome: "ok",
  });
  await stream.until(() => stream.messages().length >= 1);
  const wire = stream.raw.join("");
  for (const secret of [
    "code-value-that-is-long",
    "verifier-secret-value",
    "Y2xpZW50OnNlY3JldA==",
    "access-token-secret",
    "refresh-token-secret",
    "id-token-secret",
  ]) {
    assert.equal(wire.includes(secret), false, `${secret} was streamed`);
  }
  stream.close();
});

test("heartbeats keep the connection alive, and a closed stream stops listening", async () => {
  clearEntries();
  const stream = openStream();
  await stream.until(() => stream.raw.join("").includes(": ping"));
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Recording after the client left must not throw (the listener was removed on close).
  assert.doesNotThrow(() => record({ direction: "internal", step: "after close", outcome: "info" }));
});
