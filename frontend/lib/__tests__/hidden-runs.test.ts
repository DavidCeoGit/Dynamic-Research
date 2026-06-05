/**
 * Unit tests for the hide/unhide request-body parser (S92).
 *
 * Run: node --import=tsx --test frontend/lib/__tests__/hidden-runs.test.ts
 *
 * Covers the Codex MINOR-E fix (malformed body → caught → 400, never a 500
 * from the storage-path guard) + traversal rejection + the 500-slug bulk cap.
 * RLS isolation / cross-org rejection are DB-integration tests (design §8) and
 * require a seeded Supabase; they are out of scope for this pure unit file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHideBody } from "../hidden-runs";

test("accepts a single slug", () => {
  assert.deepEqual(parseHideBody({ slug: "my-run" }), ["my-run"]);
});

test("accepts a slugs array and dedupes", () => {
  assert.deepEqual(parseHideBody({ slugs: ["a", "b", "a"] }).sort(), ["a", "b"]);
});

test("merges slug + slugs, deduped", () => {
  assert.deepEqual(
    parseHideBody({ slug: "a", slugs: ["a", "b"] }).sort(),
    ["a", "b"],
  );
});

test("rejects an empty body", () => {
  assert.throws(() => parseHideBody({}));
});

test("rejects path traversal and separators", () => {
  assert.throws(() => parseHideBody({ slug: "../etc" }));
  assert.throws(() => parseHideBody({ slug: "a/b" }));
  assert.throws(() => parseHideBody({ slug: "a\\b" }));
});

test("rejects an empty-string slug", () => {
  assert.throws(() => parseHideBody({ slug: "" }));
});

test("rejects over-cap bulk arrays (>500)", () => {
  const big = Array.from({ length: 501 }, (_, i) => `s${i}`);
  assert.throws(() => parseHideBody({ slugs: big }));
});

test("accepts exactly 500", () => {
  const ok = Array.from({ length: 500 }, (_, i) => `s${i}`);
  assert.equal(parseHideBody({ slugs: ok }).length, 500);
});
