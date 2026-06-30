/**
 * Finalize a recovered/interrupted research run.
 *
 * Uploads all on-disk artifacts to Supabase Storage under the topic_slug
 * folder, then optionally PATCHes the queue row to a final status.
 *
 * Usage (CLI — operator break-glass):
 *   node --env-file=.env --import=tsx scripts/finalize-recovered-run.ts \
 *     <job-id> <workdir> <slug> <status> [error_message] [--force]
 *
 * Status: 'failed' | 'completed' | 'cancelled'
 *
 * Lint gate (S30, hard): runs `lint-deliverables.ts <workdir> --strict` before
 * any upload. Refuses to proceed if lint fails. Pass --force to override (will
 * still print the violations and tag the upload with a warning). --force skips
 * ONLY the lint gate — NOT the S129 obligation re-assertion below.
 *
 * S158 — the lint+upload+patch CORE is extracted into an importable
 * `finalizeRecoveredRun()` so the decoupled studio-recovery sweep
 * (agent/lib/studio-recovery-sweep.ts) and this manual CLI share ONE proven,
 * obligation-checked completion path (design §7/§9; parity test
 * agent/test/finalize-recovered-run.parity.test.ts). The CLI body only runs
 * when this file is executed directly (the import.meta main guard at the
 * bottom) — importing it never triggers argv parsing / process.exit (G10).
 *
 * KEYSTONE (Codex MAJOR-4): when status==='completed', finalizeRecoveredRun
 * RE-ASSERTS the full S129 obligation set — it fetches the queue row's DURABLE
 * selected_products, runs pickWinners over the on-disk deliverables, and
 * REFUSES to PATCH 'completed' if any obliged studio product lacks a non-empty
 * convention winner. Without this, reusing the finalize path for the
 * out-of-band sweep would be a fail-open (the original script uploaded
 * everything + PATCHed completed with NO presence check). The completed edge
 * from the sweep is now gated on the same on-disk-presence proof as the S129
 * gate itself. --force does NOT bypass this presence check.
 *
 * One-shot operator script for cases where the executor's auto-upload
 * never ran (e.g. timeout-killed run + post-wake fetch-failed). Does NOT
 * forge pipeline completion: status=failed is the honest call when the
 * run didn't reach phase 7 cleanly. completed is allowed only if the
 * obligation re-assertion passes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { isSkipFile, getContentType } from "../lib/conventions.js";
import { uploadWithAudit } from "../lib/storage-paths.js";
import { obligedProducts } from "../lib/studio-completeness.js";
import { pickWinners } from "../lib/studio-winner.js";
import { markUsageCompleted } from "../lib/usage-tracking.js";
import type { SelectedProducts } from "../types.js";

export type FinalizeStatus = "failed" | "completed" | "cancelled";

export interface FinalizeUploadArgs {
  organizationId: string;
  jobId: string;
  slug: string;
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Injectable seams so the sweep + the parity test exercise the SAME core. */
export interface FinalizeDeps {
  /** Supabase REST base + service-role key (RLS-bypassing, like the original). */
  url: string;
  key: string;
  /** Run the lint gate against the workdir; returns the exit status (null on spawn failure). */
  runLint: (workDir: string) => number | null;
  /** List filenames (incl. non-deliverables) in the workdir. */
  readDir: (dir: string) => Promise<string[]>;
  /** Stat a path → {isFile, size}. */
  statPath: (p: string) => Promise<{ isFile: boolean; size: number }>;
  /** Read a file → Buffer. */
  readFile: (p: string) => Promise<Buffer>;
  /** Upload one deliverable; returns {ok, reason?}. */
  upload: (args: FinalizeUploadArgs) => Promise<{ ok: boolean; reason?: string }>;
  /** Fetch the queue row's org + DURABLE selected_products (obligation source). */
  fetchRow: (
    jobId: string,
  ) => Promise<{ organization_id: string; selected_products: SelectedProducts | null } | null>;
  /** PATCH the queue row with the final status + any extra columns. */
  patchRow: (
    jobId: string,
    body: Record<string, unknown>,
  ) => Promise<{ ok: boolean; httpStatus: number; row?: Record<string, unknown> | null; text?: string }>;
  /**
   * Reconcile the usage ledger to 'complete' for a run finalized as 'completed'
   * (S186 D-9). Best-effort; never throws. Called ONLY after a successful
   * completed PATCH. Injected so the parity test pins the completed-edge call.
   */
  markUsageCompleted: (researchQueueId: string) => Promise<void>;
  log: (msg: string) => void;
}

export interface FinalizeArgs {
  jobId: string;
  workDir: string;
  slug: string;
  status: FinalizeStatus;
  errorMessage?: string | null;
  /** --force: skips ONLY the lint gate, NEVER the obligation presence check. */
  force?: boolean;
  /** Extra columns folded into the PATCH (e.g. studio_recovery_status). */
  extraPatch?: Record<string, unknown>;
}

export interface FinalizeResult {
  ok: boolean;
  /** True when finalize REFUSED on the obligation presence check (fail-safe,
   *  NOT a transient error) — the caller must NOT treat the job as completed. */
  refused?: boolean;
  reason?: string;
  uploaded: number;
  skipped: number;
  failed: number;
  httpStatus?: number;
  /** Obliged products found absent on disk (populated when refused). */
  missingObliged?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared lint+obligation+upload+patch core. Used by BOTH the manual CLI and the
 * auto-recovery sweep so the S129 obligation re-assertion (keystone) is the
 * SAME single code path (design §7/§9). Never spawns claude -p; pure
 * upload/patch over already-on-disk deliverables.
 */
// S187 P0-2 — the 5 research-text DELIVERABLES (design G11). Mirrors
// state-evaluation.RESEARCH_TEXT_ROLES + conventions.json research.roles (minus
// the non-deliverable context/state). Inlined to avoid coupling this script to
// state-evaluation; the MERGE gate may single-source it.
const RESEARCH_TEXT_ROLES = [
  "brief",
  "perplexity",
  "comparison",
  "vendor-evaluation",
  "notebooklm",
] as const;

interface FinalizeCoreOpts {
  /**
   * S187 P0-2 — best-effort video deferral: EXCLUDE 'video' from the obligation
   * re-assertion AND additionally require the 5 research-text deliverables present
   * on disk. ONLY the video is ever deferrable (design §7.2/D-3, Codex M-7 — a
   * NARROW flag, not a broad deferredProducts param). Default off ⇒
   * finalizeRecoveredRun's behaviour is byte-identical (the parity test pins it).
   */
  deferVideo?: boolean;
}

/**
 * S187 P0-2 — thin public wrapper preserving the EXACT finalizeRecoveredRun
 * signature (the sweep + the parity test call this). Delegates to finalizeCore
 * with no deferral — byte-identical to the pre-S187 body.
 */
export async function finalizeRecoveredRun(
  args: FinalizeArgs,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  return finalizeCore(args, deps);
}

async function finalizeCore(
  args: FinalizeArgs,
  deps: FinalizeDeps,
  opts: FinalizeCoreOpts = {},
): Promise<FinalizeResult> {
  const { jobId, workDir, slug, status } = args;
  const force = args.force ?? false;
  const log = deps.log;

  if (!UUID_RE.test(jobId)) {
    return { ok: false, refused: true, reason: `"${jobId}" is not a UUID`, uploaded: 0, skipped: 0, failed: 0 };
  }
  if (!["failed", "completed", "cancelled"].includes(status)) {
    return { ok: false, refused: true, reason: `status must be failed|completed|cancelled, got "${status}"`, uploaded: 0, skipped: 0, failed: 0 };
  }

  // ── Lint gate (S30) — --force skips ONLY this, not the obligation check ──
  const lintStatus = deps.runLint(workDir);
  if (lintStatus !== 0) {
    if (!force) {
      return {
        ok: false,
        reason: `lint failed (exit ${lintStatus}) — refusing to upload (pass --force to override the LINT gate only)`,
        uploaded: 0,
        skipped: 0,
        failed: 0,
      };
    }
    log(`⚠  Lint failed (exit ${lintStatus}) but --force passed — proceeding. Operator-owned override.`);
  } else {
    log("✓ Lint clean — proceeding with upload.");
  }

  // ── Resolve org + DURABLE obligation set from the queue row ─────────────
  const row = await deps.fetchRow(jobId);
  if (!row) {
    return { ok: false, refused: true, reason: `research_queue row ${jobId} not found / query failed`, uploaded: 0, skipped: 0, failed: 0 };
  }
  const organizationId = row.organization_id ?? "";
  if (!organizationId) {
    return { ok: false, refused: true, reason: `research_queue row ${jobId} has no organization_id — cannot construct org-prefixed path`, uploaded: 0, skipped: 0, failed: 0 };
  }

  // ── On-disk inventory ───────────────────────────────────────────────────
  const entries = await deps.readDir(workDir);
  const onDiskFiles: string[] = [];
  for (const name of entries) {
    if (isSkipFile(name)) continue;
    try {
      const st = await deps.statPath(path.join(workDir, name));
      // S160 MAJOR (Codex): require st.size > 0 for the obligation inventory. The
      // keystone's contract is a "non-empty convention winner" — a zero-byte
      // obliged product must NOT satisfy pickWinners and complete the job. (A
      // 0-byte file is the degenerate truncated-download case the atomic-write in
      // realDownloadArtifact prevents at source; this is the keystone's own guard.)
      if (st.isFile && st.size > 0) onDiskFiles.push(name);
    } catch {
      // unreadable entry — skip
    }
  }

  // ── KEYSTONE: S129 obligation re-assertion BEFORE any completed PATCH ────
  // (Codex MAJOR-4 — the fail-open guard for the sweep's completion edge.)
  // Mirrors enforceStudioCompleteness: obligations come from the DURABLE DB
  // selected_products (NOT state, NOT the recovery payload), and every obliged
  // studio product must have a non-empty convention winner on disk. --force
  // does NOT bypass this — only the lint gate above.
  if (status === "completed") {
    // S187 P0-2: best-effort EXCLUDES video from the obligation re-assert (it is
    // deferred). deferVideo defaults off ⇒ the filter is a no-op and the obliged
    // set is byte-identical to the pre-S187 behaviour.
    const obliged = obligedProducts(row.selected_products).filter(
      (p) => !(opts.deferVideo && p === "video"),
    );
    const winners = pickWinners(onDiskFiles.map((name) => ({ name })));
    const missingObliged = obliged.filter((p) => !winners[p]);
    if (missingObliged.length > 0) {
      log(
        `[finalize] REFUSING to complete ${jobId}: obliged studio product(s) absent on disk: ` +
          `${missingObliged.join(", ")} (on-disk deliverables: ${onDiskFiles.join(", ") || "-"})`,
      );
      return {
        ok: false,
        refused: true,
        reason: `obliged studio product(s) missing on disk: ${missingObliged.join(", ")}`,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        missingObliged,
      };
    }
    log(
      `[finalize] obligation re-assert PASSED: ${obliged.length} obliged product(s) all present ` +
        `(${obliged.join(", ") || "none"})`,
    );
    // S187 P0-2 — best-effort ADDITIONALLY re-asserts the research-text
    // deliverables on disk. A missing research doc means a phase crash, NOT a
    // clean video-only gap, and must never best-effort-complete (Gemini C-1). The
    // all-5 recovery path doesn't need this (the video isn't deferred there); the
    // keystone here mirrors the Gate-A probe so the safety holds even if the probe
    // is bypassed/changed.
    if (opts.deferVideo) {
      const missingResearch = RESEARCH_TEXT_ROLES.filter(
        (role) => !onDiskFiles.some((n) => n.endsWith(`-${role}.md`)),
      );
      if (missingResearch.length > 0) {
        log(
          `[finalize] REFUSING best-effort ${jobId}: research deliverable(s) absent on disk: ` +
            `${missingResearch.join(", ")} (on-disk: ${onDiskFiles.join(", ") || "-"})`,
        );
        return {
          ok: false,
          refused: true,
          reason: `research deliverable(s) missing on disk: ${missingResearch.join(", ")}`,
          uploaded: 0,
          skipped: 0,
          failed: 0,
        };
      }
      log(
        `[finalize] best-effort research re-assert PASSED: all ${RESEARCH_TEXT_ROLES.length} research deliverables present`,
      );
    }
  }

  // ── Upload artifacts ────────────────────────────────────────────────────
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const name of entries) {
    if (isSkipFile(name)) {
      skipped++;
      continue;
    }
    const local = path.join(workDir, name);
    // S161 (Codex QA CRITICAL): make this loop's failure accounting MIRROR
    // executor.uploadOutputs — the READ BUFFER is the source of truth, and any
    // stat/read problem on a selected (non-skip) entry counts as FAILED for the
    // completed edge, never a benign skip. The pre-read stat is kept ONLY to skip
    // real subdirectories (readDir returns names without isFile); it is NOT the
    // 0-byte authority (a stat can report size>0 while the read returns empty —
    // Repro 1) and a stat THROW is not a skip (an obliged file that vanished between
    // the inventory and here must not complete uploaded:0/failed:0 — Repro 2).
    let st: { isFile: boolean; size: number };
    try {
      st = await deps.statPath(local);
    } catch {
      // Repro 2: cannot stat a non-skip entry (vanished/unreadable) → FAILED.
      log(`  ✗ ${name}: stat failed before upload (counted as failed)`);
      failed++;
      continue;
    }
    if (!st.isFile) {
      skipped++; // a real subdirectory — not a deliverable
      continue;
    }
    let buf: Buffer;
    try {
      buf = await deps.readFile(local);
    } catch (err) {
      // Read failure on a selected deliverable → FAILED (mirrors executor's catch).
      log(`  ✗ ${name}: read failed (counted as failed): ${(err as Error).message}`);
      failed++;
      continue;
    }
    // Repro 1: the buffer is authoritative — a 0-byte read must NOT ship bytes:0 as
    // complete, even if stat lied size>0. Matches executor's content.length===0 guard.
    if (buf.length === 0) {
      log(`  ✗ ${name}: refused zero-byte deliverable (not uploaded)`);
      failed++;
      continue;
    }
    const contentType = getContentType(name);
    const result = await deps.upload({
      organizationId,
      jobId,
      slug,
      filename: name,
      content: buf,
      contentType,
    });
    if (!result.ok) {
      log(`  ✗ ${name}: ${result.reason ?? "upload failed"}`);
      failed++;
    } else {
      log(`  ✓ ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${contentType})`);
      uploaded++;
    }
  }

  // ── C2 (MERGE-gate fix): a failed UPLOAD must NOT complete the job ─────────
  // The on-disk presence keystone passed, but a Supabase upload then failed —
  // marking the row 'completed' here would be a FAIL-OPEN (completed while a
  // deliverable is missing from the gallery). The normal executor path hard-fails
  // the run when any deliverable upload fails (uploadResult.failed.length > 0); the
  // shared finalize core must enforce the same for the completed edge. Return
  // before the PATCH so the decoupled sweep retries (or eventually exhausts).
  // status='failed'/'cancelled' is an honest non-success record and is unaffected.
  if (status === "completed" && failed > 0) {
    log(
      `[finalize] REFUSING to complete ${jobId}: ${failed} deliverable upload(s) failed ` +
        `(${uploaded} uploaded) — leaving non-completed for the sweep to retry`,
    );
    return {
      ok: false,
      reason: `${failed} deliverable upload(s) failed — refusing to mark completed`,
      uploaded,
      skipped,
      failed,
    };
  }

  // ── PATCH DB row ────────────────────────────────────────────────────────
  const patchBody: Record<string, unknown> = {
    status,
    completed_at: new Date().toISOString(),
  };
  const finalErrorMessage =
    force && lintStatus !== 0
      ? `${args.errorMessage ?? ""}${args.errorMessage ? " | " : ""}lint=fail (forced)`.trim()
      : args.errorMessage ?? null;
  if (finalErrorMessage) patchBody.error_message = finalErrorMessage;
  if (status === "completed") patchBody.result_slug = slug;
  if (args.extraPatch) Object.assign(patchBody, args.extraPatch);

  const patch = await deps.patchRow(jobId, patchBody);
  if (!patch.ok) {
    return {
      ok: false,
      reason: `DB PATCH failed (HTTP ${patch.httpStatus}): ${patch.text ?? ""}`.slice(0, 500),
      uploaded,
      skipped,
      failed,
      httpStatus: patch.httpStatus,
    };
  }

  // ── Billing-ledger reconcile (S186 D-9/G9): the run completes HERE, but its
  // research_usage row was INSERTed 'failed' at park time (recordUsage in the
  // executor finally). Flip it to 'complete' so the ledger matches the delivered
  // run. Best-effort — a ledger hiccup must NEVER un-complete a run that already
  // PATCHed (this PATCH is the single completion edge). Only the completed edge;
  // failed/cancelled keep their honest non-success ledger row.
  if (status === "completed") {
    try {
      await deps.markUsageCompleted(jobId);
    } catch (billErr) {
      log(`[finalize] markUsageCompleted threw (non-blocking): ${(billErr as Error).message}`);
    }
  }

  return { ok: true, uploaded, skipped, failed, httpStatus: patch.httpStatus };
}

/** S187 P0-2 — args for the best-effort (video-deferred) completion edge. */
export interface FinalizeBestEffortArgs {
  jobId: string;
  workDir: string;
  slug: string;
  /** The ONLY deferrable product — a literal so the type forbids deferring anything else. */
  deferred: "video";
  /** The persisted render task id (from studio_recovery_payload) — launch proof. */
  videoTaskId: string;
}

/**
 * S187 P0-2 (Branch (c)) — best-effort completion edge: complete a run with its
 * Studio VIDEO deferred (the render exceeded the window). NARROW + separately
 * auditable (design §7.2/D-3, Codex M-7): only the video is deferrable, NEVER
 * --force. Delegates to finalizeCore with deferVideo, which (a) EXCLUDES video
 * from the obligation re-assert, (b) ADDITIONALLY requires the 5 research-text
 * deliverables, (c) runs the SAME lint + non-empty inventory + failed-upload C2
 * guard + markUsageCompleted billing reconcile. PATCHes completed +
 * studio_recovery_status='recovered' + studio_recovery_video_deferred=true.
 * Refuses unless a persisted videoTaskId proves THIS run launched the render.
 */
export async function finalizeBestEffortRun(
  args: FinalizeBestEffortArgs,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  if (typeof args.videoTaskId !== "string" || args.videoTaskId.length === 0) {
    return {
      ok: false,
      refused: true,
      reason:
        "finalizeBestEffortRun: missing videoTaskId — refusing (cannot prove the render was launched)",
      uploaded: 0,
      skipped: 0,
      failed: 0,
    };
  }
  return finalizeCore(
    {
      jobId: args.jobId,
      workDir: args.workDir,
      slug: args.slug,
      status: "completed",
      errorMessage:
        "video render exceeded window — completed best-effort (non-video deliverables + research docs present); video deferred",
      force: false,
      extraPatch: {
        studio_recovery_status: "recovered",
        studio_recovery_video_deferred: true,
        studio_recovery_error: "video render exceeded window",
      },
    },
    deps,
    { deferVideo: true },
  );
}

/**
 * Build the real (non-injected) deps. Shared by the CLI + the recovery sweep so
 * both go through the identical Supabase/lint/upload implementations.
 */
export function defaultFinalizeDeps(
  url: string,
  key: string,
  log: (msg: string) => void = (m) => console.log(m),
): FinalizeDeps {
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const lintScript = path.join(__dirname, "lint-deliverables.ts");

  return {
    url,
    key,
    runLint: (workDir) => {
      log(`\nLint gate: running ${path.basename(lintScript)} --strict on ${workDir}`);
      const lint = spawnSync(
        process.execPath,
        ["--import=tsx", lintScript, workDir, "--strict"],
        { stdio: "inherit" },
      );
      return lint.status;
    },
    readDir: (dir) => fs.readdir(dir),
    statPath: async (p) => {
      const st = await fs.stat(p);
      return { isFile: st.isFile(), size: st.size };
    },
    readFile: (p) => fs.readFile(p),
    upload: async (a) => {
      const result = await uploadWithAudit({
        sb,
        caller: "finalize-recovered-run.ts",
        organizationId: a.organizationId,
        researchQueueId: a.jobId,
        projectSlug: a.slug,
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        upsert: true,
      });
      return { ok: result.ok, reason: result.reason };
    },
    fetchRow: async (jobId) => {
      const res = await fetch(
        `${url}/rest/v1/research_queue?id=eq.${jobId}&select=organization_id,selected_products`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{
        organization_id?: string;
        selected_products?: SelectedProducts | null;
      }>;
      const r = rows[0];
      if (!r) return null;
      return {
        organization_id: r.organization_id ?? "",
        selected_products: r.selected_products ?? null,
      };
    },
    patchRow: async (jobId, body) => {
      const res = await fetch(`${url}/rest/v1/research_queue?id=eq.${jobId}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let rowOut: Record<string, unknown> | null = null;
      try {
        rowOut = (JSON.parse(text) as Array<Record<string, unknown>>)[0] ?? null;
      } catch {
        rowOut = null;
      }
      return { ok: res.ok, httpStatus: res.status, row: rowOut, text };
    },
    markUsageCompleted: async (researchQueueId) => {
      await markUsageCompleted({ sb, researchQueueId });
    },
    log,
  };
}

// ── CLI wrapper (runs ONLY when executed directly — never on import) ────────

async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const force = rawArgs.includes("--force");
  const positional = rawArgs.filter((a) => a !== "--force");
  const [jobId, workDir, slug, status, ...errorParts] = positional;
  const errorMessage = errorParts.join(" ") || null;

  if (!jobId || !workDir || !slug || !status) {
    console.error(
      "usage: finalize-recovered-run.ts <job-id> <workdir> <slug> <status> [error_message] [--force]",
    );
    process.exit(2);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  console.log(`\nFinalizing job ${jobId}`);
  console.log(`  workdir: ${workDir}`);
  console.log(`  slug: ${slug}`);
  console.log(`  status: ${status}`);

  const result = await finalizeRecoveredRun(
    { jobId, workDir, slug, status: status as FinalizeStatus, errorMessage, force },
    defaultFinalizeDeps(url, key),
  );

  console.log(
    `\nUpload summary: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed`,
  );
  if (!result.ok) {
    console.error(`\n✗ finalize failed${result.refused ? " (REFUSED)" : ""}: ${result.reason}`);
    process.exit(1);
  }
  console.log(`\nDB PATCH: HTTP ${result.httpStatus} — status=${status}`);
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runCli();
}

export {};
