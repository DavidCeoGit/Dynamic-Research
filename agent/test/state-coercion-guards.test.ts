/**
 * Tests for the S168 state-field coercion guards in executor.ts — the same bug
 * class as the S166 watcher CRITICAL, applied to the two REMAINING coercion
 * sites the S166 fix deliberately left: (1) the MAX_JOB_DURATION recovery gate's
 * notebook_id, and (2) verifyPipelineCompletion's phase/phase_status.
 *
 * state.json is JSON.parsed from an UNTRUSTED child-written file, so its fields
 * are NOT guaranteed to match PipelineState's declared `string` types. A
 * JSON-representable non-null object (e.g. {"toString":null}) throws "Cannot
 * convert object to primitive value" on String()/`${}`/MAP[] coercion. These are
 * sensitivity proofs (the exact counterexamples are asserted to NOT throw and to
 * fail CLOSED) PLUS behavior-preservation proofs (valid states unchanged, and
 * the fail-OPEN that a naive log-only fix would create is asserted absent).
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/state-coercion-guards.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isNonPrimitiveStateField,
  recoverableNotebookId,
  evaluateCompletion,
  shouldRecoverAfterDurationKill,
} from "../executor.js";
import type { PipelineState } from "../types.js";

/** Build a minimal state with only the fields under test. */
const mkState = (phase: unknown, phase_status: unknown): PipelineState =>
  ({ phase, phase_status }) as unknown as PipelineState;
const mkNb = (notebook_id: unknown): PipelineState =>
  ({ notebook_id }) as unknown as PipelineState;

// ── isNonPrimitiveStateField ────────────────────────────────────────

describe("isNonPrimitiveStateField — the coercion-safety predicate", () => {
  test("non-null objects/arrays → true (would throw on coercion)", () => {
    assert.equal(isNonPrimitiveStateField({}), true);
    assert.equal(isNonPrimitiveStateField([]), true);
    assert.equal(isNonPrimitiveStateField({ toString: null }), true);
    assert.equal(isNonPrimitiveStateField({ a: 1 }), true);
    assert.equal(isNonPrimitiveStateField([1, 2]), true);
  });

  test("primitives + null/undefined → false (coerce safely)", () => {
    for (const v of ["x", "", "complete", 5, 0, -1, 3.14, NaN, true, false, null, undefined]) {
      assert.equal(isNonPrimitiveStateField(v), false, `expected false for ${String(v)}`);
    }
  });
});

// ── recoverableNotebookId (site 1: recovery gate) ───────────────────

describe("recoverableNotebookId — fail CLOSED on a non-string id (S168 site 1)", () => {
  test("a non-empty string id is returned verbatim (behavior preserved)", () => {
    assert.equal(recoverableNotebookId(mkNb("nb-abc-123")), "nb-abc-123");
    const uuid = "8b1f0c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    assert.equal(recoverableNotebookId(mkNb(uuid)), uuid);
  });

  test("empty string → null (matches the original !!'' === false)", () => {
    assert.equal(recoverableNotebookId(mkNb("")), null);
  });

  test("null / missing / null-state → null", () => {
    assert.equal(recoverableNotebookId(mkNb(null)), null);
    assert.equal(recoverableNotebookId(mkNb(undefined)), null);
    assert.equal(recoverableNotebookId(null), null);
  });

  test("CRITICAL: a non-coercible object id NEVER throws and yields null (fail CLOSED, not fail OPEN)", () => {
    const bad = mkNb({ toString: null });
    assert.doesNotThrow(() => recoverableNotebookId(bad));
    assert.equal(recoverableNotebookId(bad), null);
  });

  test("other non-string truthy ids (number/boolean/array/object) → null", () => {
    assert.equal(recoverableNotebookId(mkNb(5)), null);
    assert.equal(recoverableNotebookId(mkNb(true)), null);
    assert.equal(recoverableNotebookId(mkNb([])), null);
    assert.equal(recoverableNotebookId(mkNb({})), null);
  });
});

describe("recovery gate wiring — no fail-OPEN laundering (recoverableNotebookId × shouldRecoverAfterDurationKill)", () => {
  // The site-1 call passes `recoverableNotebookId(state) !== null` as hasNotebookId.
  const hasId = (state: PipelineState | null) => recoverableNotebookId(state) !== null;

  test("valid string id under a clean DURATION kill → recovery eligible (behavior preserved)", () => {
    assert.equal(shouldRecoverAfterDurationKill("DURATION", false, hasId(mkNb("nb-123"))), true);
  });

  test("non-coercible object id → NOT recovery eligible (the fix: a garbage id can't be laundered into success)", () => {
    assert.equal(
      shouldRecoverAfterDurationKill("DURATION", false, hasId(mkNb({ toString: null }))),
      false,
    );
  });

  test("numeric id → NOT recovery eligible (was fail-OPEN under !!recoveryState.notebook_id)", () => {
    assert.equal(shouldRecoverAfterDurationKill("DURATION", false, hasId(mkNb(5))), false);
  });

  test("empty-string id → NOT recovery eligible (unchanged from original)", () => {
    assert.equal(shouldRecoverAfterDurationKill("DURATION", false, hasId(mkNb(""))), false);
  });
});

// ── evaluateCompletion (site 2: verifyPipelineCompletion) ───────────

describe("evaluateCompletion — complete states (behavior preserved)", () => {
  test("phase '7' (Finalization) → success", () => {
    assert.equal(evaluateCompletion(mkState("7", "running")).success, true);
  });
  test("phase_status 'complete' → success", () => {
    assert.equal(evaluateCompletion(mkState("5", "complete")).success, true);
  });
  test("phase keyword 'complete' / 'done' / 'finalized' → success", () => {
    assert.equal(evaluateCompletion(mkState("complete", "")).success, true);
    assert.equal(evaluateCompletion(mkState("done", "")).success, true);
    assert.equal(evaluateCompletion(mkState("finalized", "")).success, true);
  });
  test("numeric phase >= 7 → success", () => {
    assert.equal(evaluateCompletion(mkState("8", "x")).success, true);
    assert.equal(evaluateCompletion(mkState("7.5", "x")).success, true);
  });
  test("augmented 'complete (...)' phase_status → success", () => {
    assert.equal(evaluateCompletion(mkState("3", "complete (all products rendered)")).success, true);
  });
  test("a runtime NUMERIC phase 7 (declared string) still resolves → success (coercion preserved)", () => {
    assert.equal(evaluateCompletion(mkState(7, "x")).success, true);
  });
});

describe("evaluateCompletion — incomplete state (behavior preserved)", () => {
  test("phase '3' running → failure naming the phase", () => {
    const v = evaluateCompletion(mkState("3", "running"));
    assert.equal(v.success, false);
    assert.match(v.reason, /phase 3/);
  });
});

describe("evaluateCompletion — malformed object fields → fail CLOSED, NEVER throw (S168 site 2)", () => {
  test("non-coercible object phase → malformed verdict, not a throw", () => {
    const state = mkState({ toString: null }, "running");
    assert.doesNotThrow(() => evaluateCompletion(state));
    const v = evaluateCompletion(state);
    assert.equal(v.success, false);
    assert.match(v.reason, /malformed/);
  });
  test("non-coercible object phase_status → malformed verdict, not a throw", () => {
    const state = mkState("3", { toString: null });
    assert.doesNotThrow(() => evaluateCompletion(state));
    assert.equal(evaluateCompletion(state).success, false);
    assert.match(evaluateCompletion(state).reason, /malformed/);
  });
  test("array / plain-object fields → malformed", () => {
    assert.equal(evaluateCompletion(mkState([], "x")).success, false);
    assert.equal(evaluateCompletion(mkState("x", {})).success, false);
    assert.match(evaluateCompletion(mkState({}, "x")).reason, /malformed/);
  });
});

describe("evaluateCompletion — non-string PRIMITIVE phase_status reaches .slice safely (the String() wrap, distinct from the object guard)", () => {
  test("numeric phase_status on an incomplete state → no throw, failure verdict stringifies it", () => {
    // 5 is a primitive (passes the object guard) but (5).slice is not a function;
    // the String() wrap on the .slice path is what makes this total.
    const state = mkState("3", 5);
    assert.doesNotThrow(() => evaluateCompletion(state));
    const v = evaluateCompletion(state);
    assert.equal(v.success, false);
    assert.match(v.reason, /phase_status: "5"/);
  });
  test("boolean phase_status on an incomplete state → no throw", () => {
    assert.doesNotThrow(() => evaluateCompletion(mkState("3", true)));
    assert.equal(evaluateCompletion(mkState("3", true)).success, false);
  });
});

describe("evaluateCompletion — NON-OBJECT parsed state → fail CLOSED, NEVER throw (Gemini S168 MERGE CRITICAL)", () => {
  // JSON.parse("null") returns the primitive null (NOT a SyntaxError), so a
  // child that writes literal `null`/`42`/`[]` to state.json would null-deref on
  // state.phase and escape on the sync path, bypassing failJob → orphaned job.
  test("null state (the JSON.parse('null') case) → no throw, malformed verdict", () => {
    assert.doesNotThrow(() => evaluateCompletion(null as unknown as PipelineState));
    const v = evaluateCompletion(null as unknown as PipelineState);
    assert.equal(v.success, false);
    assert.match(v.reason, /not a JSON object/);
  });
  test("undefined state → no throw, malformed", () => {
    assert.doesNotThrow(() => evaluateCompletion(undefined as unknown as PipelineState));
    assert.equal(evaluateCompletion(undefined as unknown as PipelineState).success, false);
  });
  test("primitive states (number / string / boolean) → no throw, malformed", () => {
    for (const v of [42, "done", true]) {
      assert.doesNotThrow(() => evaluateCompletion(v as unknown as PipelineState));
      assert.equal(evaluateCompletion(v as unknown as PipelineState).success, false);
    }
  });
  test("array state → no throw, malformed", () => {
    assert.doesNotThrow(() => evaluateCompletion([] as unknown as PipelineState));
    assert.equal(evaluateCompletion([] as unknown as PipelineState).success, false);
  });
});
