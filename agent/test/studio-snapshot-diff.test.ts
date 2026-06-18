/**
 * S141/S142 — unit tests for the studio_only snapshot-diff resolution
 * (agent/lib/studio-snapshot-diff.ts). Covers the fail-closed anti-S31
 * contract: reliable vs degraded snapshot × null/parseable/stale created_at ×
 * ambiguity, PLUS the S142 concurrent-FOREIGN exact-1 cases (foreign work
 * already in-flight at snapshot is captured in the ALL-STATUS before-set and
 * excluded; degraded snapshot fail-closes entirely). These are the cases the
 * MERGE-gate reviewers reasoned about (Gemini MAJOR: chained-failure
 * wrong-artifact; Codex S141 CRITICAL: concurrent-foreign exact-1).
 *
 * NOTE: the before-set passed to freshCompleted is now the ALL-STATUS snapshot
 * (realListAllArtifactIds), so a Set entry models "this id existed in ANY status
 * before generation," including a foreign artifact that was still in-progress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createdAtMs,
  freshCompleted,
  resolveBySubmitId,
  hasUsableSubmitId,
} from "../lib/studio-snapshot-diff.js";
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
  // before-set empty because the snapshot failed; degraded fail-closes entirely.
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

test("DEGRADED snapshot: even a genuinely-new post-floor artifact is REJECTED (S142 — closes Codex's widening edge)", () => {
  // S141 admitted this on the created_at floor; that re-opened the door to a
  // FOREIGN artifact created just after the floor on a shared notebook (Codex's
  // degraded widening edge). With no before-set we cannot prove ours-vs-foreign,
  // so degraded now resolves NOTHING — the product fails-closed at its timeout.
  const arts = [art("new", AFTER)];
  const fresh = freshCompleted(arts, new Set(), FLOOR, false);
  assert.deepEqual(fresh, []);
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

test("created_at exactly AT the floor is admitted (>= boundary) under a reliable snapshot", () => {
  const atFloor = new Date(FLOOR).toISOString();
  const arts = [art("edge", atFloor)];
  assert.deepEqual(freshCompleted(arts, new Set(), FLOOR, true).map((a) => a.id), ["edge"]);
});

// ── S142 — concurrent-FOREIGN exact-1 (the gap the S141 11-test suite missed) ──

test("S142 CRITICAL: a FOREIGN artifact in-progress at snapshot, then completing, is EXCLUDED (not resolved as ours)", () => {
  // The exact Codex S141 counterexample: studio_only against a shared parent
  // notebook. "foreign" was already in-progress when we snapshotted, so its id is
  // in the ALL-STATUS before-set. It completes (post-floor) while OUR own artifact
  // is still rendering → it is the only post-floor completed id, but it must NOT be
  // resolved as ours. Pre-S142 (completed-only before-set) this returned ["foreign"].
  const arts = [art("foreign", AFTER), art("old-completed", BEFORE)];
  const beforeAll = new Set(["foreign", "old-completed"]); // foreign was in-flight at snapshot
  const fresh = freshCompleted(arts, beforeAll, FLOOR, true);
  assert.deepEqual(fresh, [], "foreign in-flight-at-snapshot artifact is in the before-set → excluded");
});

test("S142: OURS resolves even when a foreign in-flight artifact also completes (foreign in before-set, ours is not)", () => {
  // Both complete in the same poll cycle; foreign was in the before-set, ours was
  // not (its id is brand-new). Only ours is fresh → resolved, no ambiguity.
  const arts = [art("ours", AFTER), art("foreign", AFTER)];
  const beforeAll = new Set(["foreign"]);
  const fresh = freshCompleted(arts, beforeAll, FLOOR, true);
  assert.deepEqual(fresh.map((a) => a.id), ["ours"]);
});

// ── S142 — PRIMARY resolver: exact submit-task_id match (closes the residual) ──

test("hasUsableSubmitId: real id usable; null / empty / (unparsed) sentinel are not", () => {
  assert.equal(hasUsableSubmitId("00fbc0ac-d232"), true);
  assert.equal(hasUsableSubmitId(""), false);
  assert.equal(hasUsableSubmitId(null), false);
  assert.equal(hasUsableSubmitId(undefined), false);
  assert.equal(hasUsableSubmitId("(unparsed)"), false);
});

test("resolveBySubmitId: our submit id present in the completed list resolves THAT artifact", () => {
  const arts = [art("ours-id", AFTER), art("foreign-id", AFTER)];
  assert.equal(resolveBySubmitId(arts, "ours-id")?.id, "ours-id");
});

test("resolveBySubmitId CRITICAL: a foreign exactly-1 is NOT resolved — its id ≠ our submit id", () => {
  // Codex S141 residual (foreign starts AFTER snapshot, completes before ours):
  // the completed list holds only the foreign artifact, but it can never match
  // our unique submit id → null → caller keeps waiting for OUR id (never a wrong download).
  const arts = [art("foreign-started-after-snapshot", AFTER)];
  assert.equal(resolveBySubmitId(arts, "ours-still-processing"), null);
});

test("resolveBySubmitId: ours not yet completed (absent from completed list) → null (keep waiting)", () => {
  const arts = [art("old-completed", BEFORE)];
  assert.equal(resolveBySubmitId(arts, "ours-still-processing"), null);
});

test("resolveBySubmitId: unparseable / missing submit id → null (caller uses snapshot-diff fallback)", () => {
  const arts = [art("something", AFTER)];
  assert.equal(resolveBySubmitId(arts, "(unparsed)"), null);
  assert.equal(resolveBySubmitId(arts, null), null);
  assert.equal(resolveBySubmitId(arts, ""), null);
});
