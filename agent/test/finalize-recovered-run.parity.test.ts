/**
 * S158 — parity + keystone tests for finalizeRecoveredRun().
 *
 * The shared lint+obligation+upload+patch core is reused by BOTH the manual
 * break-glass CLI and the decoupled studio-recovery sweep. The KEYSTONE (Codex
 * MAJOR-4) is the S129 obligation re-assertion: finalizeRecoveredRun MUST refuse
 * to PATCH 'completed' when an obliged studio product (from the DURABLE
 * selected_products) has no on-disk convention winner — otherwise reusing the
 * finalize path for the sweep would be a fail-OPEN. --force skips ONLY the lint
 * gate, never the presence check. Parity: the auto + manual call shapes enforce
 * the identical obligation guard.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/finalize-recovered-run.parity.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  finalizeRecoveredRun,
  type FinalizeArgs,
  type FinalizeDeps,
} from "../scripts/finalize-recovered-run.js";
import type { SelectedProducts } from "../types.js";

const JOB = "11111111-1111-1111-1111-111111111111";
const TS = "20260615-190502";

function sel(over: Partial<Record<string, boolean>>): SelectedProducts {
  return { audio: false, video: false, slides: false, report: false, infographic: false, ...over } as SelectedProducts;
}
function deliverable(product: string, ext: string): string {
  return `some-title-${TS}-${product}.${ext}`;
}

interface Mock {
  deps: FinalizeDeps;
  patches: Record<string, unknown>[];
  uploads: string[];
  logs: string[];
}

function mockDeps(over: {
  onDisk?: string[];
  selected?: SelectedProducts | null;
  row?: { organization_id: string; selected_products: SelectedProducts | null } | null;
  lint?: number | null;
  uploadFails?: boolean;
  /** statPath reports size 0 (a real 0-byte file: read also returns empty). */
  zeroByte?: string[];
  /** stat-lies: statPath reports size>0 but readFile returns an EMPTY buffer (Codex QA Repro 1). */
  emptyRead?: string[];
  /** statPath THROWS for these (vanished/unreadable between inventory and upload — Repro 2). */
  statThrows?: string[];
} = {}): Mock {
  const patches: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const logs: string[] = [];
  const isEmptyRead = (p: string) =>
    (over.zeroByte ?? []).some((z) => p.endsWith(z)) ||
    (over.emptyRead ?? []).some((z) => p.endsWith(z));
  const deps: FinalizeDeps = {
    url: "http://supabase.local",
    key: "service-role-key",
    runLint: () => (over.lint === undefined ? 0 : over.lint),
    readDir: async () => over.onDisk ?? [],
    statPath: async (p) => {
      if ((over.statThrows ?? []).some((z) => p.endsWith(z))) throw new Error("ENOENT (test)");
      return {
        isFile: true,
        size: (over.zeroByte ?? []).some((z) => p.endsWith(z)) ? 0 : 100,
      };
    },
    // The READ BUFFER is the source of truth: empty for real-0-byte AND stat-lies files.
    readFile: async (p) => (isEmptyRead(p) ? Buffer.alloc(0) : Buffer.from("data")),
    upload: async (a) => {
      uploads.push(a.filename);
      return over.uploadFails ? { ok: false, reason: "storage 500 (test)" } : { ok: true };
    },
    fetchRow: async () =>
      over.row !== undefined
        ? over.row
        : { organization_id: "org-1", selected_products: over.selected ?? null },
    patchRow: async (_jobId, body) => {
      patches.push(body);
      return { ok: true, httpStatus: 200, row: body };
    },
    log: (m) => logs.push(m),
  };
  return { deps, patches, uploads, logs };
}

function completedArgs(over: Partial<FinalizeArgs> = {}): FinalizeArgs {
  return { jobId: JOB, workDir: "/p", slug: "topic-abc123", status: "completed", ...over };
}

describe("finalizeRecoveredRun — KEYSTONE obligation re-assertion (Codex MAJOR-4)", () => {
  test("completed + every obliged product present on disk → ok, PATCHes completed", async () => {
    const m = mockDeps({
      selected: sel({ video: true, report: true }),
      onDisk: [deliverable("video", "mp4"), deliverable("report", "md")],
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, true);
    assert.equal(r.refused ?? false, false);
    assert.equal(m.patches.length, 1);
    assert.equal(m.patches[0].status, "completed");
    assert.equal(m.patches[0].result_slug, "topic-abc123");
    assert.deepEqual(m.uploads.sort(), [deliverable("report", "md"), deliverable("video", "mp4")].sort());
  });

  test("completed + an obliged product ABSENT on disk → REFUSES (no upload, no completed PATCH)", async () => {
    // Sensitivity: the ORIGINAL script uploaded everything + PATCHed completed
    // with NO presence check — this test FAILS on that fail-open version.
    const m = mockDeps({
      selected: sel({ video: true, report: true }),
      onDisk: [deliverable("report", "md")], // video missing
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.deepEqual(r.missingObliged, ["video"]);
    assert.equal(m.patches.length, 0, "must NOT PATCH completed when an obliged product is missing");
    assert.equal(m.uploads.length, 0, "must NOT upload when refusing");
  });

  test("--force skips the LINT gate but NOT the presence check", async () => {
    // lint fails, but the obliged product is missing → still refused.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [], // missing
      lint: 1,
    });
    const r = await finalizeRecoveredRun(completedArgs({ force: true }), m.deps);
    assert.equal(r.refused, true, "--force must NOT bypass the obligation presence check");
    assert.equal(m.patches.length, 0);
  });

  test("--force skips a failing lint when obligations ARE met → ok with lint=fail note", async () => {
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4")],
      lint: 1,
    });
    const r = await finalizeRecoveredRun(completedArgs({ force: true, errorMessage: "manual" }), m.deps);
    assert.equal(r.ok, true);
    assert.match(String(m.patches[0].error_message), /lint=fail \(forced\)/);
  });

  test("lint fails WITHOUT --force → blocked (not refused-for-obligation, no upload)", async () => {
    const m = mockDeps({ selected: sel({ video: true }), onDisk: [deliverable("video", "mp4")], lint: 1 });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false);
    assert.equal(r.refused ?? false, false, "a lint block is not an obligation refusal");
    assert.equal(m.uploads.length, 0);
    assert.equal(m.patches.length, 0);
  });

  test("status='failed' does NOT run the obligation check (honest non-success record)", async () => {
    const m = mockDeps({ selected: sel({ video: true }), onDisk: [] });
    const r = await finalizeRecoveredRun(
      completedArgs({ status: "failed", errorMessage: "gave up" }),
      m.deps,
    );
    assert.equal(r.ok, true);
    assert.equal(m.patches[0].status, "failed");
    assert.equal(m.patches[0].result_slug, undefined, "failed never sets result_slug");
  });

  test("extraPatch (sweep: studio_recovery_status=recovered) is folded into the completed PATCH", async () => {
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4")],
    });
    const r = await finalizeRecoveredRun(
      completedArgs({ extraPatch: { studio_recovery_status: "recovered", studio_recovery_attempts: 3 } }),
      m.deps,
    );
    assert.equal(r.ok, true);
    assert.equal(m.patches[0].studio_recovery_status, "recovered");
    assert.equal(m.patches[0].studio_recovery_attempts, 3);
  });

  test("missing organization_id → refuses (cannot construct org-prefixed path)", async () => {
    const m = mockDeps({ row: { organization_id: "", selected_products: sel({ video: true }) } });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.refused, true);
    assert.equal(m.patches.length, 0);
  });

  // ── C2: a failed UPLOAD must NOT complete the job (fail-open guard) ──────
  test("C2: completed + obliged product on disk but its UPLOAD fails → {ok:false}, NO completed PATCH", async () => {
    // Sensitivity: the bug counted failed++ but PATCHed completed unconditionally,
    // marking the run completed with the product missing from the gallery. The fix
    // mirrors executor.ts (hard-fail when any deliverable upload fails).
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4")], // presence keystone PASSES
      uploadFails: true, // …but the Supabase upload then fails
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false, "a failed upload must not complete the job");
    assert.equal(r.refused ?? false, false, "an upload failure is a transient error, not an obligation refusal");
    assert.ok((r.failed ?? 0) > 0, "the failed upload is counted");
    assert.equal(m.patches.length, 0, "must NOT PATCH completed when an upload failed");
  });

  test("keystone (Codex MAJOR): a ZERO-BYTE obliged product does NOT satisfy the obligation → REFUSES", async () => {
    // Sensitivity: the bug pushed onDisk names on st.isFile only (ignoring size),
    // so a 0-byte convention-named file counted as a winner and could complete.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4")],
      zeroByte: [deliverable("video", "mp4")], // present but empty
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.refused, true, "a 0-byte obliged product is not a non-empty winner");
    assert.deepEqual(r.missingObliged, ["video"]);
    assert.equal(m.patches.length, 0, "must NOT complete on a 0-byte obliged product");
  });

  test("R2-1: a leftover `.part` temp in the workdir is NEVER uploaded by finalize", async () => {
    // Sensitivity: without `.part` on skip_files.extensions, isSkipFile() is false
    // for the temp and the finalize upload loop ships it as a deliverable.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4"), `${deliverable("video", "mp4")}.part`],
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, true);
    assert.ok(!m.uploads.some((u) => u.endsWith(".part")), "a `.part` temp must never be uploaded");
    assert.deepEqual(m.uploads, [deliverable("video", "mp4")]);
  });

  test("R2-3 parity (Codex grounded CRITICAL): a 0-byte NON-obliged extra → refuses to complete (no PATCH)", async () => {
    // Sensitivity: without the upload-loop size guard, the keystone (which filters
    // 0-byte from the OBLIGATION inventory) passes for the present obliged `video`,
    // but the 0-byte NON-obliged `audio` extra uploads (bytes:0) and the job PATCHes
    // completed — the exact divergence from executor.uploadOutputs that Codex ran.
    // The size guard counts it failed → the completed-edge guard refuses.
    const m = mockDeps({
      selected: sel({ video: true }), // only video obliged
      onDisk: [deliverable("video", "mp4"), deliverable("audio", "mp3")],
      zeroByte: [deliverable("audio", "mp3")], // the EXTRA is empty (not obliged)
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false, "a 0-byte deliverable must not complete the job");
    assert.ok((r.failed ?? 0) > 0, "the 0-byte file is counted as a failed upload");
    assert.ok(!m.uploads.includes(deliverable("audio", "mp3")), "the 0-byte file is never uploaded");
    assert.equal(m.patches.length, 0, "must NOT PATCH completed with a 0-byte deliverable present");
  });

  test("R2-3 QA Repro 1 (Codex QA CRITICAL): stat reports size>0 but the READ is empty → refuses (no PATCH)", async () => {
    // Sensitivity: a pre-read `st.size===0` guard MISSES this — the stat lies (size>0)
    // and only the read buffer reveals the 0 bytes. The buffer-authoritative check
    // (matching executor.uploadOutputs) counts it failed → completed-edge refuses.
    const m = mockDeps({
      selected: sel({ video: true }), // only video obliged
      onDisk: [deliverable("video", "mp4"), deliverable("audio", "mp3")],
      emptyRead: [deliverable("audio", "mp3")], // stat size>0, read returns empty
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false, "an empty-on-read deliverable must not complete the job");
    assert.ok((r.failed ?? 0) > 0, "the empty-on-read file is counted as a failed upload");
    assert.ok(!m.uploads.includes(deliverable("audio", "mp3")), "the empty buffer is never uploaded");
    assert.equal(m.patches.length, 0, "must NOT PATCH completed when a read returns empty");
  });

  test("R2-3 QA Repro 2 (Codex QA CRITICAL): an upload-loop stat THROW counts as failed, not skipped → refuses", async () => {
    // Sensitivity: the old `catch { skipped++ }` let an entry that vanished between
    // inventory and upload complete with uploaded:0/failed:0. Counting a stat throw
    // as failed routes it through the completed-edge guard. The 0-byte/extra file
    // here is non-obliged (video alone satisfies the keystone), isolating the
    // stat-throw→failed accounting.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4"), deliverable("audio", "mp3")],
      statThrows: [deliverable("audio", "mp3")], // statPath throws (vanished/unreadable)
    });
    const r = await finalizeRecoveredRun(completedArgs(), m.deps);
    assert.equal(r.ok, false, "an unstattable selected entry must not complete the job");
    assert.ok((r.failed ?? 0) > 0, "the stat-throw entry is counted as failed (not skipped)");
    assert.equal(m.patches.length, 0, "must NOT PATCH completed when an upload-loop stat throws");
  });

  test("C2: the upload-fail guard is completed-only — status='failed' still records honestly", async () => {
    // A failed/cancelled record is allowed to PATCH even with a failed upload
    // (it is not claiming success); only the 'completed' edge is fail-open-guarded.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [deliverable("video", "mp4")],
      uploadFails: true,
    });
    const r = await finalizeRecoveredRun(
      completedArgs({ status: "failed", errorMessage: "gave up" }),
      m.deps,
    );
    assert.equal(r.ok, true);
    assert.equal(m.patches[0].status, "failed");
  });
});

describe("finalizeRecoveredRun — auto/manual PARITY", () => {
  test("auto (extraPatch) and manual (no extraPatch) BOTH enforce the obligation guard", async () => {
    const missing = { selected: sel({ video: true, audio: true }), onDisk: [deliverable("audio", "mp3")] };

    const auto = mockDeps(missing);
    const autoR = await finalizeRecoveredRun(
      completedArgs({ extraPatch: { studio_recovery_status: "recovered" } }),
      auto.deps,
    );

    const manual = mockDeps(missing);
    const manualR = await finalizeRecoveredRun(completedArgs(), manual.deps);

    // Same guard fires for both call shapes — neither completes a job missing video.
    assert.equal(autoR.refused, true);
    assert.equal(manualR.refused, true);
    assert.deepEqual(autoR.missingObliged, manualR.missingObliged);
    assert.equal(auto.patches.length, 0);
    assert.equal(manual.patches.length, 0);
  });
});
