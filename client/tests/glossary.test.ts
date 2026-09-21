import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BUILDER_MODS, INJECTIONS } from "../../server/src/timeline.js";
import { GLOSSARY, glossaryFor } from "../src/glossary.js";
import { SCENARIOS } from "../src/scenarios.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The "Explain this value" panel names real code. It must never point at a file or function that does not exist. */
test("every glossary source reference is real", () => {
  for (const entry of Object.values(GLOSSARY)) {
    assert.ok(entry.source.length > 0, `${entry.term} has no source reference`);
    for (const ref of entry.source) {
      const file = path.join(ROOT, ref.file);
      assert.ok(existsSync(file), `${ref.file} does not exist`);
      const text = readFileSync(file, "utf8");
      const route = ref.symbol.match(/^(GET|POST) (\S+)$/);
      const found = route
        ? text.includes(`.${route[1].toLowerCase()}("${route[2]}"`)
        : new RegExp(`(function\\s+${ref.symbol}\\b|const\\s+${ref.symbol}\\b)`).test(text);
      assert.ok(found, `${ref.file} does not define ${ref.symbol} (${entry.term})`);
    }
  }
});

test("every authorization request parameter the server sends has an explanation", () => {
  for (const name of [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "aud",
    "code_challenge",
    "code_challenge_method",
    "code",
    "code_verifier",
    "grant_type",
    "refresh_token",
  ]) {
    assert.ok(glossaryFor(name), `no glossary entry for ${name}`);
  }
  assert.equal(glossaryFor("Cookie")?.term, "smart_demo_sid (session cookie)");
});

test("scenarios are numbered 1–10, and only the illustration runs nothing", () => {
  assert.deepEqual(
    SCENARIOS.map((scenario) => scenario.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    SCENARIOS.filter((scenario) => scenario.run.kind === "illustration").map((scenario) => scenario.id),
    ["spa-exposure"],
  );
});

test("builder modifications and injections all have labels and expected effects", () => {
  for (const mod of Object.values(BUILDER_MODS)) assert.ok(mod.label && mod.effect && mod.expect);
  for (const injection of Object.values(INJECTIONS)) assert.ok(injection.label && injection.effect && injection.concept);
});
