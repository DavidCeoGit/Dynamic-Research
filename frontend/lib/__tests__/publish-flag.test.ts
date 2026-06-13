/**
 * S120 — frontend publish-flag mirror unit tests (frontend/lib/publish-flag.ts).
 *
 * Covers the canonical strict predicate (isPublishFlagSet) and the clone/replay
 * prefill source-OR (resolveClonePublishRequired — the Defect C fix). The
 * source-OR test pins the SOURCE SELECTION (which fields are read), not just the
 * boolean coercion: the S118 no-op bug was reading the wrong field
 * (state.userContext.publishRequired, never written) — so the regression must
 * assert each authoritative source independently produces `true`.
 *
 * Behavioral parity with the agent's isPublishFlagSet is enforced separately by
 * test/publish-flag-parity.test.ts (imports BOTH real exports).
 *
 * Run: node --import=tsx --test frontend/lib/__tests__/publish-flag.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublishFlagSet, resolveClonePublishRequired } from "../publish-flag";

test("isPublishFlagSet: accepts only true and 'true' (case/space-insensitive)", () => {
  for (const v of [true, "true", "TRUE", " true ", "\tTrUe "]) {
    assert.equal(isPublishFlagSet(v), true, `expected ${JSON.stringify(v)} accepted`);
  }
});

test("isPublishFlagSet: rejects 'on'/'1'/'yes' and other non-true values", () => {
  for (const v of ["on", "1", "yes", "false", "", "0", 1, 0, null, undefined, {}, []]) {
    assert.equal(isPublishFlagSet(v as unknown), false, `expected ${JSON.stringify(v)} rejected`);
  }
});

// ── resolveClonePublishRequired — Defect C source-OR ────────────────

test("resolveClonePublishRequired (i): DB user_context true + state.userContext lacks the field → true (job 97906d8c shape)", () => {
  // The EXACT live runstate that proved the S118 fix was a no-op: the
  // authoritative DB jsonb carries the flag; the state.json echo does not.
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: { publishRequired: true },
      statePublishRequired: undefined,
      stateUserContextPublishRequired: undefined,
    }),
    true,
  );
});

test("resolveClonePublishRequired (ii): no queue row (legacy storage-only) + state.publish_required true → true", () => {
  // .maybeSingle() → data:null for legacy runs with no queue row; the top-level
  // state flag must still default the clone CHECKED (DB-only would downgrade it).
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: null,
      statePublishRequired: true,
      stateUserContextPublishRequired: undefined,
    }),
    true,
  );
});

test("resolveClonePublishRequired: DB string 'true' (direct-insert, bypasses zod) → true", () => {
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: { publishRequired: "true" },
      statePublishRequired: undefined,
      stateUserContextPublishRequired: undefined,
    }),
    true,
  );
});

test("resolveClonePublishRequired: legacy state.userContext echo alone → true", () => {
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: null,
      statePublishRequired: undefined,
      stateUserContextPublishRequired: true,
    }),
    true,
  );
});

test("resolveClonePublishRequired: all absent / false / rejected → false (non-publish clone)", () => {
  assert.equal(resolveClonePublishRequired({}), false);
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: { publishRequired: false },
      statePublishRequired: false,
      stateUserContextPublishRequired: false,
    }),
    false,
  );
  // "on" is a rejected non-boolean at EVERY source — must not silently engage.
  assert.equal(
    resolveClonePublishRequired({
      queueRowUserContext: { publishRequired: "on" },
      statePublishRequired: "1",
      stateUserContextPublishRequired: "yes",
    }),
    false,
  );
});
