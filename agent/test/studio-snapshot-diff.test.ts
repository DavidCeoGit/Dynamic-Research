/**
 * S141 — unit tests for the studio_only snapshot-diff resolution
 * (agent/lib/studio-snapshot-diff.ts). Covers the fail-closed anti-S31
 * contract: reliable vs degraded snapshot × null/parseable/stale created_at ×
 * ambiguity. These are the cases the MERGE-gate reviewers reasoned about
 * (Gemini MAJOR: chained-failure wrong-artifact; grounded subagent: no
 * false-success path).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createdAtMs, freshCompleted } from "../lib/studio-snapshot-diff.js";
import type { NlmArtifactRef } from "../lib/studio-completeness.js";

const FLOOR = Date.parse("2026-06-17T12:00:00Z");
const AFTER = "2026-06-17T12:05:00Z"; // > floor
const BEFORE = "2026-06-17T11:50:00Z"; // < floor

function art(id: string, created_at: string): NlmArtifactRef {
  return { id, title: `title-${id}`, created_at };
}

test("createdAtMs parses ISO and rejects junk", () => {
  assert.equal(createdAtMs(art("a", AFTER)), Date.parse(AFTER));
  assert.equal(createdAtMs({ id: "a", title: "t", created_at: "" }), null);
  assert.equal(createdAtMs({ id: "a", title: "t", created_at: "not-a-date" }), null);
});

test("reliable snapshot: a single new id after the floor resolves", () => {
  const arts = [art("new", AFTER)];
  const fresh = freshCompleted(arts, new Set(["old"]), FLOOR, true);
  assert.deepEqual(fresh.map((a) => a.id), ["new"]);
});

test("reliable snapshot: an id already in the before-set is NOT fresh", () => {
  const arts = [art("old", AFTER)];
  const fresh = freshCompleted(arts, new Set(["old"]), FLOOR, true);
  assert.deepEqual(fresh, []);
});

test("reliable snapshot: provably-new id with NO created_at is admitted", () => {
  // not in before-set on a reliable snapshot ⇒ genuinely new; null date is fine.
  const arts: NlmArtifactRef[] = [{ id: "new", title: "t", created_at: "" }];
  const fresh = freshCompleted(arts, new Set(["old"]), FLOOR, true);
  assert.deepEqual(fresh.map((a) => a.id), ["new"]);
});

test("reliable snapshot: a new-but-STALE parseable date is rejected (defense-in-depth)", () => {
  const arts = [art("new", BEFORE)];
  const fresh = freshCompleted(arts, new Set(["old"]), FLOOR, true);
  assert.deepEqual(fresh, []);
});

test("DEGRADED snapshot: stale parent artifact (parseable, < floor) rejected — no S31", () => {
  // before-set empty because the snapshot failed; floor must do all the work.
  const arts = [art("stale-parent", BEFORE)];
  const fresh = freshCompleted(arts, new Set(), FLOOR, false);
  assert.deepEqual(fresh, []);
});

test("DEGRADED snapshot: artifact with NULL created_at is REJECTED — the Gemini MAJOR fix", () => {
  // The chained-failure that would otherwise reintroduce S31: empty before-set
  // + unparseable date. Must be rejected (unprovable freshness → fail-closed).
  const arts: NlmArtifactRef[] = [{ id: "ghost", title: "t", created_at: "" }];
  const fresh = freshCompleted(arts, new Set(), FLOOR, false);
  assert.deepEqual(fresh, []);
});

test("DEGRADED snapshot: a genuinely-new artifact after the floor still resolves", () => {
  const arts = [art("new", AFTER)];
  const fresh = freshCompleted(arts, new Set(), FLOOR, false);
  assert.deepEqual(fresh.map((a) => a.id), ["new"]);
});

test("ambiguity: TWO new completed ids both surface (caller fail-closes on >1)", () => {
  const arts = [art("new1", AFTER), art("new2", AFTER)];
  const fresh = freshCompleted(arts, new Set(["old"]), FLOOR, true);
  assert.equal(fresh.length, 2, "both returned so the caller can detect ambiguity and refuse to guess");
});

test("empty id is never fresh", () => {
  const arts: NlmArtifactRef[] = [{ id: "", title: "t", created_at: AFTER }];
  assert.deepEqual(freshCompleted(arts, new Set(), FLOOR, true), []);
  assert.deepEqual(freshCompleted(arts, new Set(), FLOOR, false), []);
});

test("created_at exactly AT the floor is admitted (>= boundary)", () => {
  const atFloor = new Date(FLOOR).toISOString();
  const arts = [art("edge", atFloor)];
  assert.deepEqual(freshCompleted(arts, new Set(), FLOOR, false).map((a) => a.id), ["edge"]);
});
