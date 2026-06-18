/**
 * S142 — unit tests for studio_only id-primary resolution
 * (agent/lib/studio-snapshot-diff.ts). The resolver matches OUR generate-submit
 * task_id exactly against the COMPLETED artifact list. Because that id is unique
 * per generation, this is immune to the concurrent-foreign class (a foreign
 * artifact on a shared parent notebook can never equal our submit id); an
 * unparseable submit id resolves to null so the caller fails closed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBySubmitId, hasUsableSubmitId } from "../lib/studio-snapshot-diff.js";
import type { NlmArtifactRef } from "../lib/studio-completeness.js";

const AFTER = "2026-06-17T12:05:00Z";
const BEFORE = "2026-06-17T11:50:00Z";

function art(id: string, created_at: string): NlmArtifactRef {
  return { id, title: `title-${id}`, created_at };
}

test("hasUsableSubmitId: real id usable; null / empty / (unparsed) sentinel are not", () => {
  assert.equal(hasUsableSubmitId("00fbc0ac-d232-4ad4-bb33-b1738c9f9f17"), true);
  assert.equal(hasUsableSubmitId(""), false);
  assert.equal(hasUsableSubmitId(null), false);
  assert.equal(hasUsableSubmitId(undefined), false);
  assert.equal(hasUsableSubmitId("(unparsed)"), false);
});

test("resolveBySubmitId: our submit id present in the completed list resolves THAT artifact", () => {
  const arts = [art("ours-id", AFTER), art("foreign-id", AFTER)];
  assert.equal(resolveBySubmitId(arts, "ours-id")?.id, "ours-id");
});

test("CRITICAL: a foreign artifact (started after our snapshot, completed first) is NOT resolved — its id ≠ our submit id", () => {
  // The Codex S141/S142 concurrent-foreign case: on a shared parent notebook the
  // completed list holds only a foreign artifact while OURS still renders. Its id
  // can never equal our unique submit id → null → the caller keeps waiting for
  // OUR id (never a wrong download).
  const arts = [art("foreign-started-after-snapshot", AFTER)];
  assert.equal(resolveBySubmitId(arts, "ours-still-processing"), null);
});

test("resolveBySubmitId: ours not yet completed (absent from completed list) → null (keep waiting)", () => {
  const arts = [art("old-parent-completed", BEFORE)];
  assert.equal(resolveBySubmitId(arts, "ours-still-processing"), null);
});

test("resolveBySubmitId: unparseable / missing submit id → null (caller fails closed)", () => {
  const arts = [art("something", AFTER)];
  assert.equal(resolveBySubmitId(arts, "(unparsed)"), null);
  assert.equal(resolveBySubmitId(arts, null), null);
  assert.equal(resolveBySubmitId(arts, ""), null);
});

test("resolveBySubmitId: strict equality only — a prefix of our id does NOT match", () => {
  // NLM CLI supports partial-id matching elsewhere; resolution must NOT, or a
  // foreign artifact whose id is a prefix/superstring could be mistaken for ours.
  const arts = [art("00fbc0ac", AFTER), art("00fbc0ac-d232-4ad4-bb33-b1738c9f9f17-EXTRA", AFTER)];
  assert.equal(resolveBySubmitId(arts, "00fbc0ac-d232-4ad4-bb33-b1738c9f9f17"), null);
});

test("resolveBySubmitId: picks the exact id even when other completed artifacts exist", () => {
  const arts = [art("other-1", AFTER), art("ours", AFTER), art("other-2", BEFORE)];
  assert.equal(resolveBySubmitId(arts, "ours")?.id, "ours");
});
