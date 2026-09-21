import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { decide, gate, labState, LabStoppedError, resetLabForTests, setLabMode, subscribeLab } from "../src/lab.js";
import type { LabState } from "../src/timeline.js";
import { clearEntries, listEntries } from "../src/wireLog.js";

afterEach(() => {
  resetLabForTests();
  clearEntries();
});

/** Waits until the debugger holds a breakpoint, and returns it. */
async function breakpoint() {
  for (let i = 0; i < 100; i++) {
    const current = labState().breakpoint;
    if (current) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no breakpoint appeared");
}

test("run mode never pauses and records nothing", async () => {
  clearEntries();
  assert.deepEqual(await gate({ stage: "token-exchange", kind: "network" }), {});
  assert.deepEqual(await gate({ stage: "generate-state", kind: "internal" }), {});
  assert.equal(listEntries().length, 0);
  assert.equal(labState().breakpoint, null);
});

test("step mode holds the request, records the redacted 'before send' message, and continues on send", async () => {
  clearEntries();
  setLabMode("step");
  let released = false;
  const held = gate({
    stage: "token-exchange",
    kind: "network",
    title: "POST token endpoint",
    preview: {
      direction: "client-auth",
      method: "POST",
      endpoint: "https://auth.example/token",
      params: { grant_type: "authorization_code", code: "abcdefghijklmnop", code_verifier: "the-secret-verifier" },
      paramsIn: "body",
    },
    injections: ["remove-code-verifier"],
  }).then((decision) => {
    released = true;
    return decision;
  });

  const paused = await breakpoint();
  assert.equal(released, false, "the request must be held until the presenter decides");
  assert.equal(paused.stage, "token-exchange");
  assert.deepEqual(paused.injections, ["remove-code-verifier"]);

  const entry = listEntries().find((item) => item.id === paused.entryId);
  assert.ok(entry?.breakpoint);
  assert.deepEqual(entry.timeline, [{ step: "token-exchange", status: "active" }]);
  assert.equal(entry.direction, "client-auth");
  assert.equal(entry.params?.code, "abcdefgh… (truncated)");
  assert.match(String(entry.params?.code_verifier), /^\[REDACTED — \d+ chars\]$/);
  assert.equal(JSON.stringify(entry).includes("the-secret-verifier"), false);

  assert.equal(decide(paused.id, "send", "remove-code-verifier"), true);
  assert.deepEqual(await held, { inject: "remove-code-verifier" });
  assert.equal(labState().breakpoint, null);
  assert.equal(labState().mode, "step", "send runs one stage; the debugger stays in step mode");
});

test("messages mode pauses only before network messages", async () => {
  setLabMode("messages");
  assert.deepEqual(await gate({ stage: "generate-state", kind: "internal" }), {});
  const held = gate({ stage: "discovery", kind: "network" });
  const paused = await breakpoint();
  decide(paused.id, "send");
  assert.deepEqual(await held, {});
});

test("an injection must belong to the breakpoint, and a stale breakpoint id is refused", async () => {
  setLabMode("step");
  const held = gate({ stage: "validate-state", kind: "internal", injections: ["tamper-returned-state"] });
  const paused = await breakpoint();
  assert.throws(() => decide(paused.id, "send", "corrupt-refresh-token"), /cannot be injected/);
  assert.equal(decide(paused.id + 1000, "send"), false);
  decide(paused.id, "send", "tamper-returned-state");
  assert.deepEqual(await held, { inject: "tamper-returned-state" });
  assert.equal(decide(paused.id, "send"), false, "an answered breakpoint cannot be answered again");
});

test("abort stops the flow with LabStoppedError and records where it stopped", async () => {
  clearEntries();
  setLabMode("step");
  const held = gate({ stage: "redirect", kind: "network", title: "302 → authorization endpoint" });
  const paused = await breakpoint();
  decide(paused.id, "abort");
  await assert.rejects(held, LabStoppedError);
  const stop = listEntries().at(-1);
  assert.match(stop?.step ?? "", /Stopped by the presenter/);
  assert.deepEqual(stop?.timeline, [{ step: "redirect", status: "failed" }]);
});

test("run releases the current pause and switches the debugger off", async () => {
  setLabMode("step");
  const held = gate({ stage: "generate-verifier", kind: "internal" });
  await breakpoint();
  setLabMode("run");
  assert.deepEqual(await held, {});
  assert.equal(labState().mode, "run");
  assert.deepEqual(await gate({ stage: "generate-challenge", kind: "internal" }), {});
});

test("pauses queue: the second waits until the first is answered", async () => {
  setLabMode("step");
  const first = gate({ stage: "request-patient", kind: "network" });
  const second = gate({ stage: "request-observations", kind: "network" });
  const one = await breakpoint();
  assert.equal(one.stage, "request-patient");
  assert.equal(labState().queued, 1);
  decide(one.id, "send");
  await first;
  const two = await breakpoint();
  assert.equal(two.stage, "request-observations");
  decide(two.id, "send");
  await second;
});

test("every change of debugger state is published", async () => {
  const seen: LabState[] = [];
  const off = subscribeLab((state) => seen.push(state));
  setLabMode("step");
  const held = gate({ stage: "logout", kind: "internal" });
  const paused = await breakpoint();
  decide(paused.id, "send");
  await held;
  off();
  assert.deepEqual(
    seen.map((state) => [state.mode, state.breakpoint?.stage ?? null]),
    [
      ["step", null],
      ["step", "logout"],
      ["step", null],
    ],
  );
});
