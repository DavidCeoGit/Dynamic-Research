/**
 * Tests for summarizeStateProgress() — the pure, total progress-summary used by
 * watchStateFile. Regression coverage for the S166 MERGE-gate CRITICAL (Codex):
 * the helper readPipelineState returns kind:"ok" for ANY JSON object, but a
 * malformed object whose phase/phase_status is itself a non-primitive (e.g.
 * {"phase":{"toString":null}}) would throw on PHASE_MAP key coercion / string
 * interpolation, escaping watchStateFile's async setInterval as an UNHANDLED
 * REJECTION. summarizeStateProgress must classify such a state as "malformed"
 * (never throw). These are sensitivity proofs: the two exact Codex counterexamples
 * are asserted to NOT throw and to be malformed; valid states must NOT be flagged.
 *
 * S199 F2: also covers the "status-update" kind — a same-(phase, pct) state
 * whose phase_status TEXT changed (the Studio-poll heartbeat pattern) must
 * surface as "status-update" (never silently "unchanged", never an unthrottled
 * "update"), and a phase TRANSITION must stay "update" regardless of status.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/watch-state-progress.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarizeStateProgress } from "../lib/state-evaluation.js";
import type { PipelineState } from "../types.js";

/** Build a minimal state — summarizeStateProgress only reads phase/phase_status. */
const mk = (phase: unknown, phase_status: unknown): PipelineState =>
  ({ phase, phase_status }) as unknown as PipelineState;

describe("summarizeStateProgress — malformed (S166 unhandled-rejection regression)", () => {
  test("Codex counterexample 1: phase is a non-coercible object → malformed, NOT thrown", () => {
    const state = mk({ toString: null }, "running");
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("Codex counterexample 2: phase_status is a non-coercible object → malformed, NOT thrown", () => {
    const state = mk("1", { toString: null });
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("phase is an array → malformed", () => {
    assert.equal(summarizeStateProgress(mk([], "running"), "", 0, "").kind, "malformed");
  });

  test("phase_status is a plain object → malformed", () => {
    assert.equal(summarizeStateProgress(mk("5", { a: 1 }), "", 0, "").kind, "malformed");
  });

  test("both fields objects → malformed (and never throws)", () => {
    const state = mk({}, {});
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("malformed precedence: non-primitive status on the SAME phase → malformed, never status-update", () => {
    assert.equal(
      summarizeStateProgress(mk("5", { toString: null }), "5", 60, "running").kind,
      "malformed",
    );
  });
});

describe("summarizeStateProgress — valid (behavior preserved + guard not over-broad)", () => {
  test("known phase '5' from empty → update with mapped name/pct (proves PHASE_MAP integration)", () => {
    const r = summarizeStateProgress(mk("5", "running"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phase, "5");
    assert.equal(r.phaseName, "Synthesis");
    assert.equal(r.pct, 60);
    assert.equal(r.phaseStatus, "running");
  });

  test("same known phase + matching pct + same status text → unchanged (no spurious update)", () => {
    // PHASE_MAP['5'].pct === 60, so lastPhase '5' + lastPct 60 + identical
    // status text = no change of any kind.
    assert.equal(
      summarizeStateProgress(mk("5", "running"), "5", 60, "running").kind,
      "unchanged",
    );
  });

  test("unknown phase → update with phaseKey as name + lastPct fallback (no throw)", () => {
    const r = summarizeStateProgress(mk("zzz-not-a-phase", "x"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phaseName, "zzz-not-a-phase");
    assert.equal(r.pct, 0);
  });

  test("a normal string state is NOT flagged malformed (guard not over-broad)", () => {
    assert.notEqual(summarizeStateProgress(mk("3", "complete"), "", 0, "").kind, "malformed");
  });
});

describe("summarizeStateProgress — status-update (S199 F2 same-phase status sync)", () => {
  test("same (phase, pct), new status text → status-update carrying mapped name/pct + the NEW text", () => {
    const next = "Phase 5.5a: Studio polling - 2/5 products complete (poll 12)";
    const r = summarizeStateProgress(
      mk("5.5", next),
      "5.5",
      70,
      "Phase 5.5a: Studio polling - 1/5 products complete (poll 6)",
    );
    assert.equal(r.kind, "status-update");
    if (r.kind !== "status-update") return;
    assert.equal(r.phase, "5.5");
    assert.equal(r.phaseName, "Studio Products");
    assert.equal(r.pct, 70);
    assert.equal(r.phaseStatus, next);
  });

  test("phase transition with changed status → update, never status-update (transition precedence)", () => {
    const r = summarizeStateProgress(mk("6", "evaluating"), "5.5", 70, "polling");
    assert.equal(r.kind, "update");
  });

  test("unknown phase, same as last, status text changed → status-update with lastPct fallback", () => {
    const r = summarizeStateProgress(mk("zzz-not-a-phase", "b"), "zzz-not-a-phase", 42, "a");
    assert.equal(r.kind, "status-update");
    if (r.kind !== "status-update") return;
    assert.equal(r.pct, 42);
    assert.equal(r.phaseName, "zzz-not-a-phase");
  });

  test("status text reverting to the tracked last value → unchanged (strict equality, not ordering)", () => {
    assert.equal(
      summarizeStateProgress(mk("5.5", "poll 6"), "5.5", 70, "poll 6").kind,
      "unchanged",
    );
  });
});
