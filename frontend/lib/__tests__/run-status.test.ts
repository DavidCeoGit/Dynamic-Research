/**
 * S160 — sensitive test for m7.
 *
 * The status-details card on the progress page rendered raw {job.status} even for
 * a recovering job (status='failed' + studio_recovery_status='pending'), so a job
 * that is actually self-healing showed a scary "failed" next to the "Finalizing
 * Media" header — a self-contradiction. studioStatusCardLabel maps that case to
 * "Finalizing media". This test FAILS on the bug (which would return "failed").
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/run-status.test.ts"
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isRecoveringStatus, studioStatusCardLabel } from "../run-status";

describe("run-status helpers (S160 m7)", () => {
  test("isRecoveringStatus: ONLY failed+pending is recovering", () => {
    assert.equal(isRecoveringStatus("failed", "pending"), true);
    assert.equal(isRecoveringStatus("failed", "exhausted"), false);
    assert.equal(isRecoveringStatus("failed", "recovered"), false);
    assert.equal(isRecoveringStatus("failed", "none"), false);
    assert.equal(isRecoveringStatus("failed", null), false);
    assert.equal(isRecoveringStatus("failed", undefined), false);
    assert.equal(isRecoveringStatus("completed", "pending"), false);
    assert.equal(isRecoveringStatus("running", "pending"), false);
    assert.equal(isRecoveringStatus(null, null), false);
  });

  test("studioStatusCardLabel: 'Finalizing media' for a recovering job (m7), raw status otherwise", () => {
    // The bug rendered raw {job.status} ('failed') for a recovering job.
    assert.equal(studioStatusCardLabel("failed", "pending"), "Finalizing media");
    // A genuinely terminal failed job still reads "failed".
    assert.equal(studioStatusCardLabel("failed", "exhausted"), "failed");
    assert.equal(studioStatusCardLabel("failed", "none"), "failed");
    assert.equal(studioStatusCardLabel("failed", null), "failed");
    assert.equal(studioStatusCardLabel("completed", "none"), "completed");
    assert.equal(studioStatusCardLabel("running", null), "running");
    assert.equal(studioStatusCardLabel(null, null), "");
  });
});
