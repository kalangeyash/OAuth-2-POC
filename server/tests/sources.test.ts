import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TIMELINE, type SourceRef } from "../src/timeline.js";

/*
 * The UI's "Implementation reference" panel points the audience at real code.
 * These tests make sure every reference names a file that exists and a function
 * or route that is really in it, so the panel can never invent a path.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function assertSourceExists(ref: SourceRef): void {
  const file = path.join(ROOT, ref.file);
  assert.ok(existsSync(file), `${ref.file} does not exist`);
  const text = readFileSync(file, "utf8");
  const route = ref.symbol.match(/^(GET|POST|DELETE) (\S+)$/);
  if (route) {
    const [, method, routePath] = route;
    const pattern = new RegExp(`\\.${method.toLowerCase()}\\(\\s*"${routePath.replace(/[/.]/g, "\\$&")}"`);
    assert.match(text, pattern, `${ref.file} has no ${ref.symbol} route`);
  } else {
    const pattern = new RegExp(`(function\\s+${ref.symbol}\\b|const\\s+${ref.symbol}\\b|${ref.symbol}\\s*[(=:])`);
    assert.match(text, pattern, `${ref.file} does not define ${ref.symbol}`);
  }
}

test("every timeline step's source reference points at real code", () => {
  const refs = TIMELINE.flatMap((step) => step.source);
  assert.ok(refs.length >= 25);
  for (const ref of refs) assertSourceExists(ref);
});

test("only login and consent (which happen at the authorization server) have no source in this repository", () => {
  const withoutSource = TIMELINE.filter((step) => step.source.length === 0).map((step) => step.id);
  assert.deepEqual(withoutSource, ["login", "consent"]);
});

test("the environment variables each step names are real configuration", () => {
  const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  for (const name of new Set(TIMELINE.flatMap((step) => step.env))) {
    assert.match(example, new RegExp(`^#?\\s*${name}=`, "m"), `${name} is not in .env.example`);
  }
});
