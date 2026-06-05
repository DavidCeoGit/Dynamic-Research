/**
 * Unit tests for the hide/unhide request-body parser (S92) + the S93 queue-job
 * key-space predicate.
 *
 * Run: node --import=tsx --test frontend/lib/__tests__/hidden-runs.test.ts
 *
 * Covers the Codex MINOR-E fix (malformed body → caught → 400, never a 500
 * from the storage-path guard) + traversal rejection + the 500-slug bulk cap +
 * the isQueueJobId disjointness assumption that lets one column key both a
 * storage slug and a failed/cancelled queue UUID (S93).
 * RLS isolation / cross-org rejection are DB-integration tests (design §8) and
 * require a seeded Supabase; they are out of scope for this pure unit file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHideBody,
  isQueueJobId,
  partitionHideTargets,
  canonicalizeTarget,
} from "../hidden-runs";

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

// ── S93: isQueueJobId — storage-slug vs queue-UUID disjointness ──────

test("isQueueJobId: a canonical lowercase UUID is a queue job id", () => {
  assert.equal(isQueueJobId("e18e1931-1c2d-4a5b-8f6e-0123456789ab"), true);
});

test("isQueueJobId: an uppercase UUID is still a queue job id", () => {
  assert.equal(isQueueJobId("E18E1931-1C2D-4A5B-8F6E-0123456789AB"), true);
});

test("isQueueJobId: a topic-slug storage run is NOT a queue job id", () => {
  assert.equal(isQueueJobId("ai-agent-frameworks-20260604"), false);
  assert.equal(isQueueJobId("my-run"), false);
});

test("isQueueJobId: near-misses (wrong length / segments) are not UUIDs", () => {
  assert.equal(isQueueJobId("e18e1931-1c2d-4a5b-8f6e"), false); // too few groups
  assert.equal(isQueueJobId("e18e19311c2d4a5b8f6e0123456789ab"), false); // no dashes
  assert.equal(isQueueJobId(""), false);
  assert.equal(isQueueJobId("g18e1931-1c2d-4a5b-8f6e-0123456789ab"), false); // non-hex
});

test("isQueueJobId: a real queue UUID also passes the hide-body slug guard", () => {
  // The two must agree: a job id must survive parseHideBody so the route can
  // gate it. (parseHideBody rejects '/', '\\', '..' — a UUID has none.)
  const id = "e18e1931-1c2d-4a5b-8f6e-0123456789ab";
  assert.deepEqual(parseHideBody({ slug: id }), [id]);
  assert.equal(isQueueJobId(id), true);
});

// ── S93: partitionHideTargets — routes each target to the right gate ─

test("partitionHideTargets: splits UUIDs (queue) from topic-slugs (storage)", () => {
  const id1 = "e18e1931-1c2d-4a5b-8f6e-0123456789ab";
  const id2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const { jobIds, slugs } = partitionHideTargets([
    id1,
    "ai-agents-20260604",
    id2,
    "vendor-eval-20260101",
  ]);
  assert.deepEqual(jobIds, [id1, id2]);
  assert.deepEqual(slugs, ["ai-agents-20260604", "vendor-eval-20260101"]);
});

test("partitionHideTargets: preserves order within each bucket; handles empties", () => {
  assert.deepEqual(partitionHideTargets([]), { jobIds: [], slugs: [] });
  assert.deepEqual(partitionHideTargets(["only-a-slug"]), {
    jobIds: [],
    slugs: ["only-a-slug"],
  });
});

// ── S93: canonicalizeTarget — uppercase UUID -> lowercase (Codex MINOR) ──

test("canonicalizeTarget: lowercases a UUID; leaves a storage slug as-is", () => {
  assert.equal(
    canonicalizeTarget("E18E1931-1C2D-4A5B-8F6E-0123456789AB"),
    "e18e1931-1c2d-4a5b-8f6e-0123456789ab",
  );
  assert.equal(canonicalizeTarget("ai-agents-20260604"), "ai-agents-20260604");
});

test("parseHideBody: uppercase + lowercase of the same UUID dedupe to one canonical id", () => {
  const upper = "E18E1931-1C2D-4A5B-8F6E-0123456789AB";
  const lower = "e18e1931-1c2d-4a5b-8f6e-0123456789ab";
  // A single uppercase id is normalized to canonical lowercase so it matches the
  // id Postgres returns from the ownership query.
  assert.deepEqual(parseHideBody({ slug: upper }), [lower]);
  // Mixed-case duplicates collapse to one entry.
  assert.deepEqual(parseHideBody({ slugs: [upper, lower] }), [lower]);
});
