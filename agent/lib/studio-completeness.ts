/**
 * S129 — Worker-level fail-closed studio-completeness gate.
 *
 * Closes the recurring "video completed in the notebook but never reached the
 * gallery" bug. Two root defects compounded it:
 *   1. The pipeline's poll loop detects completion via `notebooklm artifact
 *      poll <task_id>`, which returns `in_progress` even AFTER the video is
 *      fully rendered (verified live S129: same task_id → poll says
 *      `in_progress`, `artifact list --type video` says `completed`/status_id 3).
 *      So the loop never sees the video finish.
 *   2. The pipeline then fails OPEN — it writes phase=7/phase_status=complete
 *      with a completion_note acknowledging the video was still in_progress,
 *      and the worker uploads whatever's on disk. No video.mp4 → silently gone.
 *      The publish-gate checks claims (not studio artifacts); the Phase 6.5
 *      verify gate compares notebook-COMPLETED-artifacts vs disk, so a product
 *      not yet "completed" per the broken poll is EMPTY on both sides → skipped.
 *
 * This module is the deterministic backstop in the WORKER (not the drift-prone
 * `claude -p` slash prompt). BEFORE completeJob, it asserts requested ==
 * delivered using the RELIABLE signal (`artifact list --type <T>` filtered to
 * status_id===3), and DOWNLOADS BY ARTIFACT ID (`-a <id>`, never bare
 * default-latest) any selected product that is ready-but-not-on-disk. A
 * still-rendering product is polled up to a bounded budget. Anything still
 * missing after the budget makes the gate FAIL-CLOSED — the job must NOT report
 * success (caller marks it failed + alerts the operator).
 *
 * The recovery download runs AFTER `claude -p` exits, so it is NOT bounded by
 * MAX_JOB_DURATION_MS (that cap only kills the claude subprocess), and NLM
 * list/download is $0.
 *
 * Pure orchestration + injectable seams (listArtifacts / downloadArtifact /
 * listDir / now / sleep) so the loop is unit-testable without spawning the NLM
 * CLI. See test/studio-completeness.test.ts.
 *
 * Pairs with feedback_worker_90min_cap_kills_nlm_video_poll.md (the
 * "worker-level fallback … currently not implemented" it called for),
 * feedback_nlm_download_default_latest.md (download by id, not default-latest),
 * and feedback_post_run_artifact_verification.md (the Phase 6.5 gate this
 * backstops).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { studioFilename } from "./conventions.js";
import { STUDIO_PRODUCT_LIST } from "./plan-types.js";
import { pickWinners } from "./studio-winner.js";
import type {
  PipelineState,
  SelectedProducts,
  StudioRecoveryProduct,
} from "../types.js";
import {
  classifyDownloadFailure,
  realDownloadArtifact,
  realListArtifacts,
  realListArtifactsWithStatus,
  type DownloadResult,
  type NlmArtifactRef,
  type NlmArtifactRefWithStatus,
} from "./nlm-artifact-cli.js";
import {
  artifactCreatedAtMs,
  deriveRunStart,
  safeMs,
} from "./artifact-timestamps.js";
import { STUDIO_VIDEO_RENDER_ENABLED } from "./worker-config.js";

// Canonical product order — single-sourced (S169) from conventions.json via
// plan-types' STUDIO_PRODUCT_LIST (itself derived from the conventions Record).
// STUDIO_PRODUCT_LIST follows conventions key-insertion order (audio, video,
// slides, report, infographic) — identical to the former literal — so
// obligedProducts() output is byte-for-byte unchanged.
const STUDIO_ORDER = STUDIO_PRODUCT_LIST;

// Conventions product name → NotebookLM CLI type. The CLI uses "slide-deck"
// for what conventions calls "slides"; both `artifact list --type` and
// `download <type>` take this value. Cinematic videos share the "video" type.
// S197: exported READONLY for the studio-product-checker (design §5.1, Codex
// MINOR) — the checker must import this map, never re-author it (the regen
// script's separate PRODUCT_DEFS is the drift this single-source prevents).
// A parity test (studio-product-checker.test.ts) pins slides → slide-deck +
// key-set equality with STUDIO_PRODUCT_LIST.
export const PRODUCT_TO_NLM_TYPE: Readonly<Record<string, string>> = {
  audio: "audio",
  video: "video",
  slides: "slide-deck",
  report: "report",
  infographic: "infographic",
};

export interface CompletenessDeps {
  /** COMPLETED artifacts (status_id===3) of an NLM type, newest-first. null on CLI/parse error. */
  listArtifacts: (notebookId: string, nlmType: string) => NlmArtifactRef[] | null;
  /**
   * S187 P0-2 (Branch (c)) — ALL artifacts of a type WITH status_id (incl. a
   * still-rendering status_id-1 video), newest-first. null on CLI/parse error.
   * Used ONLY to detect + anti-stale-match a rendering video; realListArtifacts
   * stays the completed-only download source for every existing path.
   */
  listArtifactsWithStatus: (
    notebookId: string,
    nlmType: string,
  ) => NlmArtifactRefWithStatus[] | null;
  /**
   * Download a specific artifact BY ID to outPath. `ok` is true only on a
   * non-empty file; on failure the captured exitCode/signal/stderr drive the
   * transient-vs-terminal taxonomy (design §8). `timeoutMs` lets the decoupled
   * sweep pass a SHORTER spawnSync timeout (~90s) than the in-gate path's 300s,
   * so a per-tick budget bounds added claim latency (Codex MAJOR-2).
   */
  downloadArtifact: (
    notebookId: string,
    artifactId: string,
    nlmType: string,
    outPath: string,
    timeoutMs?: number,
  ) => Promise<DownloadResult>;
  /**
   * Regular files (not dirs) in the deliverables dir as {name, size} pairs; []
   * if the dir is absent. S161 R2-3: the gate is SIZE-AWARE — a 0-byte file is a
   * truncated/empty non-deliverable and must NOT satisfy the gate, so the size
   * travels with the name through this single inventory pass (no separate stat).
   */
  listDir: (dir: string) => Promise<Array<{ name: string; size: number }>>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface CompletenessOptions {
  /** Total wait budget per still-rendering product, after claude -p exits. */
  recoveryBudgetMs: number;
  /** Re-list interval while a product is still rendering. */
  pollIntervalMs: number;
  /**
   * S187 P0-2 (Branch (c)) — dark-launch flag override. Defaults to the module
   * const STUDIO_VIDEO_RENDER_ENABLED (the production source of truth); threaded
   * here ONLY so unit tests can exercise the flag-ON render-classification path
   * (a load-time const cannot be flipped post-import under node --test). The
   * executor never sets it ⇒ production reads the const, so behaviour is unchanged.
   */
  videoRenderEnabled?: boolean;
}

export interface CompletenessResult {
  ok: boolean;
  selected: string[];
  presentBefore: string[];
  recovered: string[];
  stillMissing: string[];
  notes: string[];
  /**
   * S158 taxonomy split (design §4 branch (b)): still-missing products whose
   * failure was a TRANSIENT download of a CONFIRMED status_id-3 artifact — the
   * recoverable-pending set. ALWAYS a subset of stillMissing; it NEVER makes
   * `ok` true (ok stays `stillMissing.length === 0`). Empty when every
   * still-missing product is genuinely not-ready or terminally failed.
   */
  recoverablePending: StudioRecoveryProduct[];
  /** The notebook id recovery would use (echoed for the executor's payload). */
  notebookId?: string;
  /** Last captured NLM download stderr across recoverable products (design G9). */
  recoveryStderr?: string;
  /**
   * S187 P0-2 — true when Branch (c) classified the still-missing video as still
   * RENDERING in NLM (a recovery_kind:'render' product was added to
   * recoverablePending). Run-level convenience for logging/notify/tests; the
   * per-product recovery_kind is the source of truth.
   */
  videoStillRendering?: boolean;
}

/**
 * Products the run was OBLIGED to produce. Driven by the DURABLE DB selection
 * (job.selected_products), NOT the pipeline-written state.selectedProducts —
 * the whole point of a worker backstop is to not trust the drift-prone pipeline
 * (Codex MERGE MAJOR-3): a pipeline that drops/flips a product in state must not
 * be able to make the gate pass open. Defensive: tolerate a partial/loose object.
 * Exported (S158) so the shared finalizeRecoveredRun() re-asserts the SAME
 * obligation set before the sweep can flip a job to completed (Codex MAJOR-4).
 */
export function obligedProducts(selected: SelectedProducts | null | undefined): string[] {
  const sel = (selected ?? {}) as unknown as Record<string, unknown>;
  return STUDIO_ORDER.filter((p) => sel[p] === true);
}

/**
 * The task/artifact id this run submitted for `product`, if the pipeline
 * persisted it into state.artifacts. Optional + forward-compatible: today's
 * state.json does not carry it, so the created-after-run-start floor is the
 * load-bearing anti-stale guard; an exact id (when present) is strictly tighter.
 */
function expectedArtifactId(state: PipelineState, product: string): string | null {
  const arts = state.artifacts as
    | Record<string, { task_id?: unknown; id?: unknown }>
    | undefined;
  const e = arts?.[product];
  const v =
    (typeof e?.task_id === "string" && e.task_id) ||
    (typeof e?.id === "string" && e.id) ||
    "";
  return v || null;
}

/**
 * S187 P0-2 (Branch (c)) — classify a still-missing VIDEO that produced NO
 * confirmed completed artifact. Returns a recovery_kind:'render' pending product
 * iff a STATUS-AWARE NLM list shows an artifact that is PROVABLY this run's video
 * (exact videoTaskId, else created_at >= the strict runFloorMs floor), regardless
 * of its current status_id (a just-completed status_id-3 is included to close the
 * sub-second race — the sweep's render arm downloads it on the first tick). null
 * (⇒ unchanged terminal hard-fail) when: the list CLI blips (conservative — a
 * one-shot classify can't safely keep-waiting without a placeholder filename),
 * the video was never launched, or the only matches are foreign/stale (older than
 * the floor, no exact id). The filename uses the artifact's REAL title so the
 * sweep's on-disk idempotency skip-check matches the eventual download.
 */
function classifyVideoRender(
  deps: CompletenessDeps,
  notebookId: string,
  expectedId: string | null,
  runFloorMs: number | null,
  namingTs: string,
): StudioRecoveryProduct | null {
  const arts = deps.listArtifactsWithStatus(notebookId, "video");
  if (arts == null) return null; // CLI blip at the one-shot classify → conservative terminal
  const match = arts.find((a) => {
    if (expectedId) return a.id === expectedId; // exact this-run identity (any status)
    if (runFloorMs == null) return false; // no exact id + no floor ⇒ cannot prove THIS run's
    const c = artifactCreatedAtMs(a);
    return c == null ? false : c >= runFloorMs; // strict anti-stale floor (no negative skew)
  });
  if (!match) return null; // never-launched / foreign / stale → terminal
  return {
    product: "video",
    artifactId: match.id,
    nlmType: "video",
    filename: studioFilename(match.title, namingTs, "video"),
    recovery_kind: "render",
    videoTaskId: expectedId ?? match.id,
    runFloorMs: runFloorMs == null ? undefined : runFloorMs,
  };
}

/**
 * Enforce requested == delivered for studio products, recovering any selected
 * product that is ready-but-not-on-disk. Returns ok=false (fail-closed) when a
 * selected product cannot be recovered within the budget — the caller must then
 * refuse to mark the job completed.
 */
export async function enforceStudioCompleteness(
  obliged: SelectedProducts | null | undefined,
  state: PipelineState,
  projectsDir: string,
  opts: CompletenessOptions,
  deps: CompletenessDeps,
): Promise<CompletenessResult> {
  // S187 P0-2: resolve the dark-launch flag ONCE — opts override (tests) else the
  // module const (production). Used by the Branch-(c) render classification below.
  const videoRenderEnabled = opts.videoRenderEnabled ?? STUDIO_VIDEO_RENDER_ENABLED;
  // Obligations come from the DURABLE DB selection, NOT pipeline-written state.
  const selected = obligedProducts(obliged);
  const entries = await deps
    .listDir(projectsDir)
    .catch(() => [] as Array<{ name: string; size: number }>);
  // S161 R2-3 (PRIMARY-path zero-byte fail-open): filter 0-byte files out BEFORE
  // pickWinners. A present-but-empty convention file (truncated/empty download)
  // is NOT a deliverable — counting it as a winner let the gate pass open and the
  // executor upload an empty buffer + completeJob. Filtering it makes the obliged
  // product MISSING → recovery re-download / fail-closed, identical to the
  // finalize keystone's `size > 0` inventory guard (consistency across both paths).
  const nonEmpty = entries.filter((e) => e.size > 0);
  const winners = pickWinners(nonEmpty.map((e) => ({ name: e.name })));
  const presentBefore = selected.filter((p) => winners[p]);
  const missing = selected.filter((p) => !winners[p]);

  const result: CompletenessResult = {
    ok: true,
    selected,
    presentBefore,
    recovered: [],
    stillMissing: [],
    notes: [],
    recoverablePending: [],
  };

  if (missing.length === 0) {
    deps.log(
      `[studio-completeness] all ${selected.length} selected product(s) present` +
        `${selected.length ? `: ${selected.join(", ")}` : ""}`,
    );
    return result;
  }

  deps.log(
    `[studio-completeness] selected=[${selected.join(",")}] present=[${presentBefore.join(",") || "-"}] ` +
      `MISSING=[${missing.join(",")}] — attempting reliable artifact-list recovery`,
  );

  const notebookId = state.notebook_id ?? "";
  if (!notebookId) {
    result.ok = false;
    result.stillMissing = [...missing];
    result.notes.push(
      "state.notebook_id is null — cannot recover any missing product from NotebookLM",
    );
    // No notebook id ⇒ nothing is recoverable-pending (branch (a) — genuine
    // hard-fail). recoverablePending stays [] so the executor treats it as a
    // plain terminal failure, never the recoverable branch.
    return result;
  }
  // S158: echo the notebook id so the executor can build the recovery payload.
  result.notebookId = notebookId;

  // Real run-start: {compact} names recovered files; {ms} is the strict anti-stale
  // floor. NO negative skew (Codex CRITICAL-1: a 5-min tolerance re-admitted a
  // parent created 92s pre-start). runFloorMs is null ONLY when no real timestamp
  // is derivable — then the floor degrades to best-effort (never a synthesized
  // "now", which would wrongly exclude this run's real artifact — Codex CRITICAL-2).
  const runStart = deriveRunStart(winners, state);
  const runFloorMs = runStart?.ms ?? null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const namingTs =
    runStart?.compact ??
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
      `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  if (runFloorMs == null) {
    deps.log(
      `[studio-completeness] WARN: no real run timestamp derivable — naming recovered files ${namingTs} ` +
        `and DEGRADING the anti-stale guard to newest-completed (reused-notebook risk)`,
    );
    result.notes.push(
      "no run-start floor derivable — anti-stale guard degraded to newest-completed",
    );
  }

  // Sanitize budget/interval against NaN/negative env (Codex MAJOR-4).
  const budgetMs = safeMs(opts.recoveryBudgetMs, 0, 0);
  const pollMs = safeMs(opts.pollIntervalMs, 60_000, 1);

  for (const product of missing) {
    const nlmType = PRODUCT_TO_NLM_TYPE[product];
    if (!nlmType) {
      result.stillMissing.push(product);
      result.notes.push(`${product}: no NotebookLM type mapping — cannot recover`);
      continue;
    }
    const expectedId = expectedArtifactId(state, product);

    const deadline = deps.now() + budgetMs;
    let attempts = 0;
    let recovered = false;
    // S158 taxonomy split: remember whether a status_id-3 winner was EVER
    // confirmed for this product, and the LAST captured download failure, so
    // the post-loop classifier can distinguish branch (b) (confirmed + transient
    // download failure = recoverable-pending) from branch (a) (never confirmed,
    // or a terminal local-disk failure = unchanged hard-fail).
    let lastWinner: NlmArtifactRef | null = null;
    let lastDownload: DownloadResult | null = null;
    for (;;) {
      // Don't START a new list once the budget is spent — but ALWAYS do the
      // first attempt (the dominant "poll lied, asset already done" case recovers
      // in one shot even with a 0 budget). So: guard only after attempt #1. This
      // closes the "one extra list AT the deadline" edge (Codex QA finding-4).
      if (attempts > 0 && deps.now() >= deadline) break;
      attempts++;
      const arts = deps.listArtifacts(notebookId, nlmType) ?? [];
      // Anti-stale (Gemini CRITICAL-1 / Codex CRITICAL-1): in a REUSED notebook a
      // parent's older COMPLETED video must NOT be mistaken for this run's still-
      // rendering one. Prefer an exact submitted id; else require created AT/AFTER
      // run start (strict). Fall back to newest-completed only if no floor exists.
      const candidates = arts.filter((a) => {
        if (expectedId) return a.id === expectedId;
        if (runFloorMs == null) return true;
        const c = artifactCreatedAtMs(a);
        return c == null ? false : c >= runFloorMs;
      });
      const winner = candidates[0]; // arts are COMPLETED + newest-first; filter keeps order
      if (winner) {
        const filename = studioFilename(winner.title, namingTs, product);
        const outPath = path.join(projectsDir, filename);
        const dl = await deps.downloadArtifact(notebookId, winner.id, nlmType, outPath);
        if (dl.ok) {
          result.recovered.push(product);
          result.notes.push(
            `${product}: recovered ${filename} from completed artifact ${winner.id} (attempt ${attempts})`,
          );
          deps.log(
            `[studio-completeness] RECOVERED ${product} → ${filename} (artifact ${winner.id})`,
          );
          recovered = true;
          break;
        }
        // Confirmed status_id-3 artifact, download failed — remember it so the
        // taxonomy split can classify transient-vs-terminal after the budget.
        lastWinner = winner;
        lastDownload = dl;
        result.notes.push(
          `${product}: completed artifact ${winner.id} found but download failed ` +
            `(exit=${dl.exitCode ?? "?"} signal=${dl.signal ?? "-"}) — retrying`,
        );
      } else if (arts.length > 0) {
        result.notes.push(
          `${product}: ${arts.length} completed artifact(s) in notebook but none match ` +
            `${expectedId ? `id ${expectedId}` : "this run's start time"} — treating as still-rendering`,
        );
      }

      // Check the budget AFTER an attempt (so at least one try always happens),
      // then sleep only the remaining time — never overshoot, never an extra
      // list past the deadline (Codex MAJOR-4).
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await deps.sleep(Math.min(pollMs, remaining));
    }

    if (!recovered) {
      result.stillMissing.push(product);
      // S158 taxonomy split (design §4): a status_id-3 winner WAS confirmed AND
      // the last download failure classifies TRANSIENT ⇒ branch (b),
      // recoverable-pending (the decoupled sweep can re-download it off the
      // critical path). A never-confirmed product (still-rendering) or a
      // TERMINAL local-disk failure stays branch (a) — unchanged hard-fail,
      // NOT recoverable. ok stays `stillMissing.length === 0` regardless.
      const cls = lastWinner
        ? classifyDownloadFailure(
            lastDownload?.exitCode ?? null,
            lastDownload?.stderr ?? "",
            lastDownload?.signal ?? null,
          )
        : null;
      // S187 P0-2 Branch (c): a still-missing VIDEO with NO confirmed completed
      // artifact (lastWinner null) may be THIS run's video still RENDERING in NLM.
      // Flag-gated (OFF ⇒ unchanged hard-fail). A confirmed+transient download
      // failure is Branch (b) below (not render). Composability: the executor's
      // purelyTransient gate already requires EVERY stillMissing product to be
      // recoverable, so adding the render video here makes a mixed (b)+(c) run park
      // (not hard-fail) only when audio-blip AND video-render are BOTH recoverable.
      const renderPending =
        !lastWinner && videoRenderEnabled && product === "video"
          ? classifyVideoRender(deps, notebookId, expectedId, runFloorMs, namingTs)
          : null;
      if (lastWinner && cls === "transient") {
        result.recoverablePending.push({
          product,
          artifactId: lastWinner.id,
          nlmType,
          filename: studioFilename(lastWinner.title, namingTs, product),
        });
        if (lastDownload?.stderr && !result.recoveryStderr) {
          result.recoveryStderr = lastDownload.stderr.slice(0, 500);
        }
        result.notes.push(
          `${product}: confirmed artifact ${lastWinner.id} download TRANSIENTLY failed ` +
            `within ${Math.round(budgetMs / 60000)}min budget (${attempts} attempt(s)) — recoverable-pending`,
        );
        deps.log(
          `[studio-completeness] RECOVERABLE-PENDING ${product} (artifact ${lastWinner.id}) ` +
            `after ${attempts} attempt(s) — handing to the out-of-band recovery sweep`,
        );
      } else if (renderPending) {
        result.recoverablePending.push(renderPending);
        result.videoStillRendering = true;
        result.notes.push(
          `video: still rendering in NLM (artifact ${renderPending.artifactId}) — ` +
            `recoverable-pending(render); the decoupled sweep polls until status_id 3`,
        );
        deps.log(
          `[studio-completeness] RECOVERABLE-PENDING(render) video ` +
            `(artifact ${renderPending.artifactId}, videoTaskId ${renderPending.videoTaskId}) — ` +
            `handing to the out-of-band render-poll sweep`,
        );
      } else {
        result.notes.push(
          `${product}: ${
            lastWinner ? "download TERMINALLY failed (local-disk)" : "no recoverable completed artifact"
          } within ${Math.round(budgetMs / 60000)}min budget (${attempts} attempt(s))`,
        );
        deps.log(
          `[studio-completeness] STILL MISSING ${product} after ${attempts} attempt(s) / ` +
            `${Math.round(budgetMs / 60000)}min budget`,
        );
      }
    }
  }

  // INVARIANT (design §9): ok is EXACTLY "every selected product is on disk".
  // recoverablePending is a subset of stillMissing counted as not-delivered, so
  // it can NEVER make ok true — a recoverable job still takes the executor's
  // !ok branch and is failed (then swept), never completed-while-missing.
  result.ok = result.stillMissing.length === 0;
  return result;
}

/** Default real deps for the worker. */
export function defaultDeps(log: (msg: string) => void): CompletenessDeps {
  return {
    listArtifacts: realListArtifacts,
    listArtifactsWithStatus: realListArtifactsWithStatus,
    downloadArtifact: realDownloadArtifact,
    listDir: async (dir: string) => {
      // S161 R2-3: stat each regular file so the gate can reject 0-byte winners.
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      const out: Array<{ name: string; size: number }> = [];
      for (const d of dirents) {
        if (!d.isFile()) continue;
        try {
          const st = await fs.stat(path.join(dir, d.name));
          out.push({ name: d.name, size: st.size });
        } catch {
          // unreadable entry — skip (treated as absent)
        }
      }
      return out;
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}
