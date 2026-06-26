/**
 * S136 Layer 2 — tests for the pure duration-cap-kill recovery guard
 * (shouldRecoverAfterDurationKill). This is the unit-testable core the Gemini
 * MERGE CRITICAL-2 / Codex K-4 review required: prove that a COST-cap kill and
 * any terminal-error kill are NEVER recovery-eligible, so a runaway/cost-killed
 * job can never be laundered into a "success" by the studio-completeness gate.
 * The IO orchestration (readStateForRecovery + enforceStudioCompleteness) is
 * already covered by studio-completeness.test.ts; here we pin the DECISION.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/duration-kill-recovery.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRecoverAfterDurationKill } from "../lib/claude-spawn.js";

test("DURATION kill, no terminal error, notebook present → recover", () => {
  assert.equal(shouldRecoverAfterDurationKill("DURATION", false, true), true);
});

test("COST kill is NEVER recoverable (cost-bypass guard) even with artifacts done", () => {
  assert.equal(shouldRecoverAfterDurationKill("COST", false, true), false);
});

test("DURATION kill WITH a terminal error stays fail-fast (credit/auth/billing/model)", () => {
  assert.equal(shouldRecoverAfterDurationKill("DURATION", true, true), false);
});

test("DURATION kill with no notebook_id → not recoverable (nothing to recover from)", () => {
  assert.equal(shouldRecoverAfterDurationKill("DURATION", false, false), false);
});

test("NONE (clean exit, not a kill) → not recovery-eligible", () => {
  assert.equal(shouldRecoverAfterDurationKill("NONE", false, true), false);
});

test("COST kill remains false across all other-flag combinations", () => {
  for (const term of [true, false]) {
    for (const nb of [true, false]) {
      assert.equal(
        shouldRecoverAfterDurationKill("COST", term, nb),
        false,
        `COST must never recover (terminal=${term}, notebook=${nb})`,
      );
    }
  }
});
