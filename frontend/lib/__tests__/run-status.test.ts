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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isRecoveringStatus,
  studioStatusCardLabel,
  studioRecoveryKind,
} from "../run-status";

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

describe("studioRecoveryKind (S187 P0-2 / Branch c)", () => {
  test("nullish / empty payload → 'download'", () => {
    assert.equal(studioRecoveryKind(undefined), "download");
    assert.equal(studioRecoveryKind(null), "download");
    assert.equal(studioRecoveryKind({}), "download");
    assert.equal(studioRecoveryKind({ products: null }), "download");
    assert.equal(studioRecoveryKind({ products: [] }), "download");
  });

  test("a 'render' product → 'render'", () => {
    assert.equal(
      studioRecoveryKind({ products: [{ recovery_kind: "render" }] }),
      "render",
    );
  });

  test("only 'download' products → 'download'", () => {
    assert.equal(
      studioRecoveryKind({ products: [{ recovery_kind: "download" }] }),
      "download",
    );
  });

  test("absent recovery_kind ⇒ 'download' (backward-compat, mirrors the agent)", () => {
    assert.equal(studioRecoveryKind({ products: [{}] }), "download");
    assert.equal(
      studioRecoveryKind({ products: [{ recovery_kind: undefined }] }),
      "download",
    );
  });

  test("mixed download + render → 'render' (render takes precedence)", () => {
    assert.equal(
      studioRecoveryKind({
        products: [{ recovery_kind: "download" }, { recovery_kind: "render" }],
      }),
      "render",
    );
  });

  test("tolerates malformed product entries (no throw)", () => {
    const payload = {
      products: [null, { recovery_kind: "render" }],
    } as unknown as Parameters<typeof studioRecoveryKind>[0];
    assert.equal(studioRecoveryKind(payload), "render");
  });
});

describe("predicate parity guard (S189 dedup / design G12)", () => {
  // The failed+pending "recovering" predicate must live ONLY in run-status.ts
  // (isRecoveringStatus). The dashboard inlined it pre-S189; this guard fails if
  // either user-facing surface reintroduces the inline form instead of routing
  // through the helper — the single-source enforcement the design asked for.
  const here = dirname(fileURLToPath(import.meta.url));
  const pages: Record<string, string> = {
    dashboard: join(here, "..", "..", "app", "page.tsx"),
    progress: join(here, "..", "..", "app", "new", "[id]", "page.tsx"),
  };
  // Matches an inline `studio_recovery_status === "pending"` (either quote style).
  const inlinePredicate = /studio_recovery_status\s*===\s*['"]pending['"]/;

  for (const [name, file] of Object.entries(pages)) {
    test(`${name} routes through isRecoveringStatus, no inline failed+pending predicate`, () => {
      const src = readFileSync(file, "utf8");
      assert.ok(
        src.includes("isRecoveringStatus("),
        `${name} should call isRecoveringStatus() rather than inline the recovering predicate`,
      );
      assert.ok(
        !inlinePredicate.test(src),
        `${name} must not inline 'studio_recovery_status === "pending"' — use isRecoveringStatus()`,
      );
    });
  }
});
