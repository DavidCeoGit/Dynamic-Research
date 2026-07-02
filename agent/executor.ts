/**
 * Job executor — takes a claimed ResearchJob and runs the pipeline.
 *
 * 1. Prepares working directory with a job manifest
 * 2. Spawns `claude` CLI to run /research-compare non-interactively
 * 3. Watches state.json for progress, relays updates via API
 * 4. Uploads final outputs to Supabase Storage
 * 5. Returns result slug on success
 *
 * S64 (preflight-cost-architecture v3.1, C-C2): terminal-error classifier
 * hooks at two catch sites — Claude spawn exit-nonzero (site 1) and plan
 * synthesis throw (site 2). When classifier returns a TerminalError,
 * markPendingTerminalExit() sets the worker-level flag without disrupting
 * the existing finally / telemetry / failJob / notifyTerminal paths.
 * worker.ts consumes the flag AFTER executeJob() returns and decides to
 * exit 1 + advance the file-backed circuit breaker. Classifier is
 * side-effect-free (no fs, no exit, no state mutation).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { updateJob, completeJob, failJob, updatePlanReviewStatus } from "./api-client.js";
import {
  asMetaOrNull,
  downloadAttachments,
  type AttachmentDownloadResult,
} from "./lib/attachments.js";
import {
  archiveStaleStateFiles,
  archiveStaleStudioMarkers,
  findStateFile,
} from "./lib/find-state-file.js";
import {
  writeChildBreadcrumb,
  deleteChildBreadcrumb,
} from "./lib/child-breadcrumb.js";
import {
  sendDeliveryDelayedEmail,
} from "./lib/notify.js";
import { recordUsage } from "./lib/usage-tracking.js";
import { runPlanReviewGate } from "./lib/plan-review-gate.js";
import {
  classifyTerminalError,
  markPendingTerminalExit,
} from "./lib/preflight-backoff.js";
import {
  evaluatePublishGateForJob,
  isPublishRequired,
  logPublishFlagDiagnostics,
  readUrgentBypass,
} from "./lib/publish-gate.js";
import {
  enforceStudioCompleteness,
  defaultDeps as studioCompletenessDeps,
} from "./lib/studio-completeness.js";
import { studioRecoveryBackoffMs } from "./lib/studio-recovery-sweep.js";
import type { ResearchJob, PipelineState, StudioRecoveryPayload } from "./types.js";
import {
  WORKING_DIR,
  PROJECTS_DIR,
  PUBLISH_RISK_ACCEPT_DIR,
  DRY_RUN,
  SUPABASE_URL,
  SUPABASE_KEY,
  STUDIO_RECOVERY_MAX_MS,
  STUDIO_RECOVERY_POLL_MS,
  STUDIO_VIDEO_RENDER_ENABLED,
} from "./lib/worker-config.js";
import { getSupabase } from "./lib/worker-supabase.js";
import {
  spawnClaude,
  waitForProcess,
  shouldRecoverAfterDurationKill,
} from "./lib/claude-spawn.js";
import {
  watchStateFile,
  verifyPipelineCompletion,
  readStateForRecovery,
  recoverableNotebookId,
  shouldDeferForVideoRender,
  type CompletionVerdict,
} from "./lib/state-evaluation.js";
import { notifyTerminal } from "./lib/terminal-notify.js";
import { buildManifest, buildPrompt } from "./lib/job-manifest.js";
import { uploadOutputs } from "./lib/upload-outputs.js";

// ── mcp-proxy config path (re-anchored, S173 decomposition principle 9) ──
// spawnClaude moved to lib/claude-spawn.ts; the proxy config must resolve
// relative to agent/ (THIS file), not agent/lib/. Computed here from
// executor's import.meta.url and passed into spawnClaude. See design §6.4.
const MCP_PROXY_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "mcp-proxy",
  "mcp-config.json",
);

// ── Main executor ───────────────────────────────────────────────────

export async function executeJob(job: ResearchJob): Promise<string> {
  const slug = job.topic_slug;
  const workDir = path.join(WORKING_DIR, slug);
  const projectsDir = path.join(PROJECTS_DIR, slug);

  log(job.id, `Starting job: "${job.topic}" (slug: ${slug})`);

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });

  // S197 (studio-product-checker §4.2, fresh-Claude M-1): a hard worker death
  // (power loss, kill -9) never runs the finally below, so a prior attempt of
  // this SAME job id can leave an orphaned child-PID breadcrumb. Delete it at
  // claim time so the re-claim's pre-spawn window (attachments, manifest, the
  // multi-minute plan-review gate) can't present a stale crumb as a live
  // child. The checker also freshness-gates on spawnedAt >= claimed_at — this
  // is the belt. Best-effort by contract (never throws).
  await deleteChildBreadcrumb(job.id, (m) => log(job.id, m));

  // S161 R2-1 (belt-and-suspenders): clear any orphan `*.part` download temps left
  // in the REUSED projectsDir by a prior killed/crashed run (realDownloadArtifact
  // writes the binary to `<final>.part` and only renames it into place on success;
  // a kill mid-spawn or the sweep's artifact-gone branch can strand one). The
  // `.part` ext is on the upload skip-list so an orphan can never reach the gallery,
  // but sweeping at job start keeps the dir from accumulating temps across re-queues.
  // Best-effort — never blocks the run.
  try {
    const existing = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const d of existing) {
      if (d.isFile() && d.name.endsWith(".part")) {
        await fs.rm(path.join(projectsDir, d.name), { force: true }).catch(() => {});
      }
    }
  } catch {
    // projectsDir freshly created / unreadable — nothing to sweep
  }

  // S117 stale-terminal-state fail-open hardening: per-slug workdirs are reused
  // across re-queues. Archive any prior attempt's *-state.json BEFORE this run
  // writes or the poller/gate reads, so findStateFile() can never return a
  // stale (possibly PASSING) manifest. With the stale file gone, a new spawn
  // that exits without writing its own state hits the existing "no state.json"
  // guard (verifyPipelineCompletion / studio_only null-state read) and fails
  // CLOSED instead of publish-clearing a no-work run. Covers BOTH the full and
  // studio_only paths — this is the single workDir chokepoint both share.
  // See feedback_stale_terminal_state_fail_open_hazard.
  // Codex MERGE-gate (S117): a non-ENOENT archive failure means we could NOT
  // prove the workdir is clear of a stale passing manifest — fail the job
  // CLOSED rather than proceed and risk publish-clearing it.
  let archivedState: string[] = [];
  try {
    archivedState = await archiveStaleStateFiles(workDir);
  } catch (err) {
    const reason =
      `PUBLISH gate fail-closed (MRPF): could not archive prior-attempt state files in the ` +
      `reused workdir (${(err as Error).message}) — refusing to run on a workdir that may still ` +
      `hold a stale passing publish_verification`;
    log(job.id, reason);
    await failJob(job.id, reason);
    await notifyTerminal(job, "failed", reason);
    throw new Error(reason);
  }
  if (archivedState.length > 0) {
    log(
      job.id,
      `[stale-state] archived ${archivedState.length} prior-attempt state file(s): ${archivedState.join(", ")}`,
    );
  }

  // S197 (studio-product-checker §10.9, fresh-Claude C-1 sibling): also sweep
  // a prior attempt's studio_before_ids.json launch marker into the same
  // .superseded-state/ archive. BEST-EFFORT (never throws, unlike the
  // fail-closed state-file archive above): a leftover marker is not a publish
  // fail-open hazard — the child rewrites the snapshot at step 1.7 before any
  // generate, and the checker ignores markers older than claimed_at.
  const archivedMarkers = await archiveStaleStudioMarkers(workDir);
  if (archivedMarkers.length > 0) {
    log(
      job.id,
      `[stale-state] archived prior-attempt studio marker(s): ${archivedMarkers.join(", ")}`,
    );
  }

  const allowlistDir = path.join(workDir, ".claude");
  await fs.mkdir(allowlistDir, { recursive: true });
  await fs.writeFile(
    path.join(allowlistDir, "sandbox-allowlist"),
    "# Per-job allowlist: ephemeral worker workdir, not under user review.\n# Permits direct writes so state.json + outputs don't route through sandbox/.\n**\n",
  );

  // S106 Phase 3 — pull submitted attachments into <workDir>/sources/ BEFORE
  // the manifest is built so localSourcePath + attachmentsSkipped reflect what
  // actually landed on disk. Skipped on studio_only (regen never reads
  // sources/) and DRY_RUN (no storage round-trips in simulation).
  // SKIP-AND-RECORD: a bad file never fails the job.
  let attachmentsResult: AttachmentDownloadResult = { downloaded: [], skipped: [] };
  if (
    !DRY_RUN &&
    job.pipeline_mode !== "studio_only" &&
    (job.attachments?.length ?? 0) > 0
  ) {
    try {
      attachmentsResult = await downloadAttachments(
        getSupabase(),
        job,
        workDir,
        (msg) => log(job.id, msg),
      );
    } catch (err) {
      // downloadAttachments never throws by contract; this guards Supabase
      // client construction. Proceed without attachments rather than failing
      // a multi-dollar run over its source files.
      log(
        job.id,
        `[attachments] download stage errored (non-fatal): ${(err as Error).message}`,
      );
      attachmentsResult = {
        downloaded: [],
        // asMetaOrNull: a forged row can hold non-object elements (audit
        // A18); raw nulls here used to TypeError later in buildManifest's
        // s.meta.originalName dereference and hard-fail the job.
        skipped: (job.attachments ?? []).map((meta) => ({
          meta: asMetaOrNull(meta),
          reason: `download stage errored: ${(err as Error).message}`,
        })),
      };
    }
    log(
      job.id,
      `[attachments] ${attachmentsResult.downloaded.length} downloaded, ` +
        `${attachmentsResult.skipped.length} skipped`,
    );
  }

  const manifestPath = path.join(workDir, "job-manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(buildManifest(job, attachmentsResult, workDir), null, 2),
  );
  log(job.id, `Manifest written to ${manifestPath}`);

  if (job.pipeline_mode === "studio_only") {
    await updatePlanReviewStatus(job.id, "approved", {
      error_message: null,
    }).catch((err) => {
      log(job.id, `[plan-review] studio_only inheritance marker write failed (non-fatal): ${(err as Error).message}`);
    });
    return await runStudioOnly(job, workDir, manifestPath);
  }

  const planReviewOutcome = await runPlanReviewGate(job, workDir);
  if (!planReviewOutcome.proceed) {
    throw new Error(planReviewOutcome.reason);
  }
  // S85 (design §5b option 2) — carry any R5 reservations through to the
  // completion email at job end. Empty on a clean approval / studio_only path.
  const planReservations = planReviewOutcome.reservations ?? [];

  await updateJob(job.id, {
    status: "running",
    current_phase: "Preflight",
    phase_status: "Preparing workspace",
    progress_pct: 2,
  });

  // MRPF PUBLISH gate (S108 Codex C3): snapshot the operator sign-off BEFORE
  // spawning the pipeline. The completion gate consumes THIS snapshot, never a
  // post-run re-read — the spawned child (same OS user, has Write/Bash, knows
  // its own job id from the manifest) could otherwise forge the sign-off file
  // mid-run. A file that must pre-date the spawn cannot be child-authored.
  const bypassSnapshot = await readUrgentBypass(PUBLISH_RISK_ACCEPT_DIR, job.id);

  if (DRY_RUN) {
    // S108 Codex C4: DRY_RUN produces no content and writes no state file, so
    // it can never satisfy the publish gate — completing it would mark a
    // publish-required row "completed" without any verification. Fail closed.
    // S120: alarm on a present-but-non-boolean job flag BEFORE the strict
    // predicate decides (a rejected value here = silent DRY_RUN pass-through).
    logPublishFlagDiagnostics(
      job.id,
      [{ value: job.user_context?.publishRequired, source: "job.user_context" }],
      (line) => log(job.id, line),
    );
    if (isPublishRequired(job, null)) {
      const reason =
        "PUBLISH gate fail-closed (MRPF): DRY_RUN cannot publish-clear a publish-required job — unset publishRequired for dry runs";
      log(job.id, reason);
      await failJob(job.id, reason);
      await notifyTerminal(job, "failed", reason);
      throw new Error(reason);
    }
    log(job.id, "[DRY RUN] Skipping Claude CLI execution");
    await simulateDryRun(job);
    return slug;
  }

  const fullPrompt = buildPrompt(job, manifestPath, attachmentsResult);
  const promptPath = path.join(workDir, "claude-prompt.md");
  await fs.writeFile(promptPath, fullPrompt);

  const spawnPrompt =
    `Read the full execution brief at ${promptPath} and then execute it. ` +
    `Do not ask the user any questions — all inputs are in the brief and the referenced manifest.`;

  let finalStatus: "complete" | "failed" = "failed";
  let stdoutForUsage = "";
  let exitCodeForUsage = -1;
  let spawnSucceeded = false;
  let getStdout: () => string = () => "";
  let getStderr: () => string = () => "";

  try {
    let claudeProcess: ChildProcess;

    try {
      const spawned = spawnClaude(spawnPrompt, workDir, MCP_PROXY_CONFIG_PATH);
      claudeProcess = spawned.child;
      getStdout = spawned.getStdout;
      getStderr = spawned.getStderr;
      spawnSucceeded = true;
    } catch (err) {
      await failJob(job.id, `Failed to spawn claude: ${err}`);
      await notifyTerminal(job, "failed", `Failed to spawn claude: ${err}`);
      throw err;
    }

    // S197 (studio-product-checker §4.2): job→child-PID breadcrumb — the only
    // worker-side state the independent checker consumes for child liveness.
    // Semantics: "child spawned, exit NOT yet observed by the worker." Written
    // only when the OS assigned a pid (a missing pid degrades the checker
    // gracefully rather than planting a crumb that can never match a live
    // process). Best-effort by contract (never throws).
    if (Number.isInteger(claudeProcess.pid)) {
      await writeChildBreadcrumb(
        job.id,
        {
          pid: claudeProcess.pid as number,
          spawnedAt: new Date().toISOString(),
          workDir,
          projectsDir,
        },
        (m) => log(job.id, m),
      );
    }

    const stateWatcher = watchStateFile(job, workDir);

    let waitOutcome!: Awaited<ReturnType<typeof waitForProcess>>;
    try {
      // S69: pass getStdout so waitForProcess can compute in-flight cost
      // estimates and trip MAX_JOB_COST_CENTS. Back-compat: arg is optional;
      // callers that don't pass it (none currently) just skip the cost check.
      waitOutcome = await waitForProcess(claudeProcess, job, getStdout);

      // S197 (§4.2, Gemini CRITICAL-1): the child's exit is now OBSERVED —
      // delete the breadcrumb HERE, not at the end of executeJob. The S129 gate
      // + uploads below can legitimately run 15+ min with no DB movement; a
      // crumb lingering through that tail would false-storm the checker's
      // CHILD_DEAD_JOB_RUNNING on every healthy run.
      await deleteChildBreadcrumb(job.id, (m) => log(job.id, m));
    } finally {
      // S199 F2: stop in a FINALLY so a waitForProcess rejection (child
      // "error" event) can't leak a live watcher into the daemon — it would
      // PATCH on every 30s text change for the daemon's lifetime. AWAITED so
      // the final progress flush settles before any terminal completeJob/
      // failJob write downstream. stop() is idempotent.
      await stateWatcher.stop();
    }
    const { code: exitCode, killReason } = waitOutcome;

    exitCodeForUsage = exitCode;
    stdoutForUsage = getStdout();

    // S136 Layer 2: a MAX_JOB_DURATION cap-kill whose studio artifacts already
    // finished in NotebookLM should be RECOVERED (download → upload → complete)
    // rather than hard-failed. Set on the eligible path below; when non-null it
    // replaces the verifyPipelineCompletion verdict so control flows through the
    // existing PUBLISH + studio-completeness + upload + completeJob tail.
    let recoveryVerdict: CompletionVerdict | null = null;

    if (exitCode !== 0) {
      const errMsg = `Claude process exited with code ${exitCode}`;
      log(job.id, errMsg);

      // S64 (C-C2 site 1): classify the failure against stdout/stderr tails.
      // Credit-out / auth-out / billing-error / model-not-found surfaces as
      // either a "credit balance is too low"-style message in stdout or as a
      // 401/403 HTTP status mentioned in the stream. The classifier is pure;
      // markPendingTerminalExit() defers exit until executeJob() finishes
      // (preserving the finally below + downstream telemetry writes).
      const stdoutTail = stdoutForUsage.slice(-4096);
      const stderrTail = getStderr().slice(-4096);
      const classified = classifyTerminalError({
        err: new Error(errMsg),
        stdoutTail,
        stderrTail,
      });

      // S136 Layer 2 recovery gate (Gemini MERGE CRITICAL-2 / Codex K-4):
      // ONLY a pure duration cap-kill with NO terminal error and a recoverable
      // notebook is eligible. A cost-cap kill (killReason==="COST") and any
      // classified terminal error stay fail-fast — they MUST NOT be recovered,
      // so a runaway/cost-killed job can never be laundered into a success.
      const recoveryState =
        killReason === "DURATION" && !classified
          ? await readStateForRecovery(job, workDir)
          : null;
      // Validate notebook_id at the SOURCE: a parsed-JSON state.json may carry a
      // non-string notebook_id. Gate recovery on a non-empty STRING (fail CLOSED
      // otherwise — never launder a garbage id into a success verdict) and use
      // the validated value in the log so a non-coercible object can't throw
      // there. (S168; recoverableNotebookId mirrors the S166 coercion guard.)
      const recoveryNotebookId = recoverableNotebookId(recoveryState);
      if (shouldRecoverAfterDurationKill(killReason, !!classified, recoveryNotebookId !== null)) {
        log(
          job.id,
          `[S136] MAX_JOB_DURATION cap-kill with no terminal error — attempting studio-completeness recovery instead of failing (notebook ${recoveryNotebookId})`,
        );
        recoveryVerdict = {
          success: true,
          reason: "S136: recovered after MAX_JOB_DURATION cap-kill",
          state: recoveryState!,
        };
      } else {
        if (classified) {
          markPendingTerminalExit({
            ...classified,
            source: "executor:claude-spawn",
          });
          log(
            job.id,
            `[executor] terminal-error classified: kind=${classified.kind} signature=${classified.signature} — worker will exit after this job finishes`,
          );
        }

        await failJob(job.id, errMsg);
        await notifyTerminal(job, "failed", errMsg);
        throw new Error(errMsg);
      }
    }

    const verdict = recoveryVerdict ?? (await verifyPipelineCompletion(workDir));
    if (!verdict.success) {
      log(job.id, `Pipeline did not complete: ${verdict.reason}`);

      // Pipeline-incomplete after exit 0 can also surface terminal errors
      // (e.g. /research-compare wrote ERROR: credit-out to state.json then
      // exited 0 to avoid retry-storms). Classify against verdict.reason +
      // stdout tail. Same fast-path-no-op semantics as above.
      const classified = classifyTerminalError({
        err: new Error(verdict.reason),
        stdoutTail: stdoutForUsage.slice(-4096),
        stateFailureReason: verdict.reason,
      });
      if (classified) {
        markPendingTerminalExit({
          ...classified,
          source: "executor:claude-spawn",
        });
        log(
          job.id,
          `[executor] terminal-error classified (post-verify): kind=${classified.kind} signature=${classified.signature}`,
        );
      }

      // S187 P0-2 (Branch (c)) — Gate-A defer interception. Flag-gated (default
      // OFF). Fires ONLY when (a) NO terminal error was classified above (Codex
      // M-8: never park a credit/auth/billing/model failure as "rendering"), and
      // (b) the deliverable-presence probe confirms the ONLY missing deliverable
      // is the Studio video (every non-video studio + research doc present, publish
      // gate satisfied). On defer the run does NOT fail here — it falls through to
      // the success path → Gate B (enforceStudioCompleteness), which classifies the
      // video as render → recoverablePending → the purelyTransient park below writes
      // status='failed'+studio_recovery_status='pending'. If Gate B can't CONFIRM
      // the render it still hard-fails (no fail-open). verdict.state is present on
      // the failure verdict (attached by verifyPipelineCompletion, S187).
      let deferred = false;
      if (!classified && STUDIO_VIDEO_RENDER_ENABLED && verdict.state) {
        const entries: Array<{ name: string; size: number }> = [];
        try {
          const dirents = await fs.readdir(projectsDir, { withFileTypes: true });
          for (const d of dirents) {
            if (!d.isFile()) continue;
            try {
              const st = await fs.stat(path.join(projectsDir, d.name));
              entries.push({ name: d.name, size: st.size });
            } catch {
              // unreadable entry — treat as absent
            }
          }
        } catch {
          // projectsDir missing/unreadable — entries stays [] → probe terminal
        }
        const publishOk = evaluatePublishGateForJob(
          job,
          verdict.state,
          bypassSnapshot,
        ).ok;
        const probe = shouldDeferForVideoRender({
          notebookId: verdict.state.notebook_id,
          entries,
          selected: job.selected_products,
          publishOk,
        });
        if (probe.defer) {
          deferred = true;
          log(job.id, `[executor] Gate-A DEFER (video still rendering): ${probe.reason}`);
        } else {
          log(job.id, `[executor] Gate-A defer declined → terminal: ${probe.reason}`);
        }
      }

      if (!deferred) {
        await failJob(job.id, verdict.reason);
        await notifyTerminal(job, "failed", verdict.reason);
        throw new Error(verdict.reason);
      }
      // Deferred: fall through to the success path. verdict.state is set, so the
      // publish gate + Gate B below read it normally; Gate B parks the run.
    }
    log(job.id, verdict.reason);

    // MRPF PUBLISH gate (S108) — fail-closed, BEFORE any upload: a
    // publish-required job whose verification manifest is missing, degraded,
    // or failed must never reach the gallery. Closes the S100 fail-open
    // (silently-401'd Perplexity leg → WebSearch fallback → fabricated stats
    // shipped). See lib/publish-gate.ts + the design synthesis in
    // Documentation/mrpf-publish-gate-design-gate-peer-review.md.
    // S120: alarm on any present-but-non-boolean publishRequired source BEFORE
    // the gate decides applicability — a rejected non-boolean is the silent
    // gate-skip case (a bypassed normalization boundary).
    logPublishFlagDiagnostics(
      job.id,
      [
        { value: job.user_context?.publishRequired, source: "job.user_context" },
        { value: verdict.state?.publish_required, source: "state.publish_required" },
      ],
      (line) => log(job.id, line),
    );
    const publishGate = evaluatePublishGateForJob(
      job,
      verdict.state ?? null,
      bypassSnapshot,
    );
    if (publishGate.applicable) {
      if (!publishGate.ok) {
        const reason =
          `PUBLISH gate fail-closed (MRPF): ${publishGate.reasons.join("; ")}`.slice(0, 2000);
        log(job.id, reason);
        await failJob(job.id, reason);
        await notifyTerminal(job, "failed", reason);
        throw new Error(reason);
      }
      if (publishGate.bypassed) {
        log(
          job.id,
          (`[publish-gate] URGENT human risk-acceptance applied (${publishGate.signoffLine}); ` +
            `accepted defects: ${publishGate.reasons.join("; ")}`).slice(0, 2000),
        );
      } else {
        log(job.id, "[publish-gate] publish_verification PASSED — all legs live, all claims verified");
      }
    }

    // S129 studio-completeness fail-closed gate. BEFORE upload so any recovered
    // file is shipped by the same uploadOutputs pass. Closes the recurring
    // "video finished in the notebook but never reached the gallery" bug: the
    // pipeline declares phase 7 complete even when a selected product is still
    // (per the unreliable `artifact poll`) in_progress, and uploads only what's
    // on disk. Here the worker re-checks requested-vs-delivered with the
    // reliable `artifact list --type` signal, downloads ready-but-missing
    // products by id, and refuses to complete a job that is genuinely missing a
    // selected product. verdict.state is the parsed state.json (guaranteed on
    // the success path); if absent we skip the gate (the empty-deliverables
    // guard below still fires) rather than crash.
    if (verdict.state) {
      const completeness = await enforceStudioCompleteness(
        job.selected_products, // DURABLE DB obligation source (Codex MAJOR-3), not state
        verdict.state,
        projectsDir,
        {
          recoveryBudgetMs: STUDIO_RECOVERY_MAX_MS,
          pollIntervalMs: STUDIO_RECOVERY_POLL_MS,
        },
        studioCompletenessDeps((line) => log(job.id, line)),
      );
      if (completeness.recovered.length > 0) {
        log(
          job.id,
          `[studio-completeness] recovered ${completeness.recovered.length} product(s): ` +
            completeness.recovered.join(", "),
        );
      }
      if (!completeness.ok) {
        const reason =
          `Studio completeness fail-closed (S129): selected product(s) missing and ` +
          `unrecoverable from NotebookLM: ${completeness.stillMissing.join(", ")}. ` +
          completeness.notes.join(" | ");
        log(job.id, reason.slice(0, 2000));

        // S158 taxonomy split (design §4/§7): a job is recoverable-pending iff
        // EVERY still-missing product is branch (b) — a CONFIRMED status_id-3
        // artifact whose download TRANSIENTLY failed. If so, tag the parallel
        // studio_recovery_* dimension and hand to the out-of-band sweep instead
        // of a terminal failure. INVARIANT (design §9): status STILL becomes
        // 'failed' and we STILL throw — recoverablePending never makes ok true,
        // so this branch can NEVER fall through to completeJob. The only
        // differences from today's behavior are the recovery metadata + a
        // non-terminal "delivery delayed" email (vs the "failed" email).
        const recoverable = completeness.recoverablePending ?? [];
        const notebookId = completeness.notebookId;
        const purelyTransient =
          recoverable.length > 0 &&
          !!notebookId &&
          completeness.stillMissing.every((p) =>
            recoverable.some((rp) => rp.product === p),
          );

        if (purelyTransient) {
          const nowMs = Date.now();
          const nowIso = new Date(nowMs).toISOString();
          // attempts=1 marks the in-gate recovery attempt; the sweep increments
          // from here. first_failed_at is the TRIGGER-IMMUNE age anchor (G6),
          // written ONCE here and never re-touched by the sweep.
          const nextIso = new Date(nowMs + studioRecoveryBackoffMs(1)).toISOString();
          const payload: StudioRecoveryPayload = {
            notebookId: notebookId as string,
            products: recoverable.map((rp) => ({
              product: rp.product,
              artifactId: rp.artifactId,
              nlmType: rp.nlmType,
              filename: rp.filename,
              // S187 P0-2: carry Branch-(c) render fields through. Download
              // products omit them → absent ⇒ 'download' (backward-compat); a
              // 'render' video carries recovery_kind + the videoTaskId/runFloorMs
              // anti-stale identity the sweep needs (it never loads the workdir).
              ...(rp.recovery_kind ? { recovery_kind: rp.recovery_kind } : {}),
              ...(rp.videoTaskId ? { videoTaskId: rp.videoTaskId } : {}),
              ...(rp.runFloorMs != null ? { runFloorMs: rp.runFloorMs } : {}),
            })),
          };
          let dimensionWritten = false;
          try {
            // ONE atomic updateJob — fold the recovery dimension into the SAME
            // PATCH as status='failed'+error_message so a crash between writes
            // can't leave a 'failed' row with no recovery dimension (design §7
            // ordering note); a missing dimension would just yield today's
            // hard-fail (fail-safe).
            await updateJob(job.id, {
              status: "failed",
              error_message: reason.slice(0, 2000),
              studio_recovery_status: "pending",
              studio_recovery_first_failed_at: nowIso,
              studio_recovery_attempts: 1,
              studio_recovery_next_attempt_at: nextIso,
              studio_recovery_payload: payload,
              studio_recovery_error: completeness.recoveryStderr?.slice(0, 500),
            });
            dimensionWritten = true;
          } catch (e) {
            // Fail-SAFE: a recovery-dimension WRITE failure degrades to a plain
            // terminal failure (today's behavior — the S156 floor we accept).
            log(
              job.id,
              `[studio-completeness] recovery-dimension write failed (${(e as Error).message}) — degrading to terminal failed`,
            );
          }
          if (dimensionWritten) {
            log(
              job.id,
              `[studio-completeness] TRANSIENT branch — recoverable-pending ` +
                `[${recoverable.map((r) => r.product).join(",")}] tagged for out-of-band ` +
                `recovery (first retry ~${Math.round(studioRecoveryBackoffMs(1) / 60000)}min)`,
            );
            // Non-terminal "delivery delayed" email INSTEAD of the "failed" one.
            if (job.notify_email) {
              await sendDeliveryDelayedEmail({
                to: job.notify_email,
                slug: job.topic_slug,
                topic: job.topic,
              }).catch((err) =>
                log(job.id, `[notify] delivery-delayed email failed (non-fatal): ${(err as Error).message}`),
              );
            }
            // status='failed' + throw (the telemetry finally still runs); the
            // decoupled sweep self-heals it out-of-band. NEVER reaches completeJob.
            throw new Error(reason);
          }
          // else: write failed → fall through to the terminal hard-fail below.
        }

        // Branch (a), or a recoverable branch whose dimension write failed —
        // today's terminal behavior verbatim.
        await failJob(job.id, reason.slice(0, 2000));
        await notifyTerminal(job, "failed", reason.slice(0, 2000));
        throw new Error(reason);
      }
    } else {
      log(
        job.id,
        "[studio-completeness] WARN: verdict.state absent on success path — skipping completeness gate",
      );
    }

    log(job.id, "Pipeline complete — uploading outputs to Supabase Storage");
    const uploadResult = await uploadOutputs(job, projectsDir);

    // S88 MERGE-B empty-guard (caller-side per Codex MINOR — same failJob +
    // notifyTerminal + throw contract as a failed upload, so recordUsage in the
    // finally preserves failed telemetry). A verified-complete pipeline with no
    // uploadable deliverables in Projects/<slug>/ means the skill's copy-to-
    // Projects (Phase 6 Step B) / Pandoc (Step C) never ran — fail loudly
    // rather than report a deliverable-less success.
    if (uploadResult.selected === 0) {
      const reason =
        `Pipeline verified complete but no uploadable deliverables found in Projects/${slug}/ ` +
        `— copy-to-Projects (skill Phase 6 Step B/Pandoc Step C) did not run`;
      log(job.id, reason);
      await failJob(job.id, reason);
      await notifyTerminal(job, "failed", reason);
      throw new Error(reason);
    }

    if (uploadResult.failed.length > 0) {
      const preview = uploadResult.failed
        .slice(0, 5)
        .map((f) => `${f.remoteName} (${f.reason})`)
        .join("; ");
      const more = uploadResult.failed.length > 5
        ? ` and ${uploadResult.failed.length - 5} more`
        : "";
      const reason =
        `Uploaded ${uploadResult.uploaded} of ${uploadResult.uploaded + uploadResult.failed.length} deliverables; ` +
        `${uploadResult.failed.length} failed: ${preview}${more}`;
      log(job.id, reason);
      await failJob(job.id, reason);
      await notifyTerminal(job, "failed", reason);
      throw new Error(reason);
    }

    await completeJob(job.id, slug);
    await notifyTerminal(job, "completed", undefined, planReservations);
    log(job.id, `Job completed successfully (${uploadResult.uploaded} files uploaded)`);

    finalStatus = "complete";
    return slug;
  } finally {
    // S197 (§4.2) failsafe: covers throw paths between the breadcrumb write
    // and the post-waitForProcess delete (e.g. waitForProcess itself throwing).
    // Idempotent + never throws; on the normal path the crumb is already gone.
    await deleteChildBreadcrumb(job.id, (m) => log(job.id, m));
    if (spawnSucceeded) {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
        await recordUsage({
          sb,
          researchQueueId: job.id,
          organizationId: job.organization_id,
          stdoutBuf: stdoutForUsage,
          exitCode: exitCodeForUsage,
          finalJobStatus: finalStatus,
        }).catch((err) => {
          log(job.id, `[usage-tracking] recordUsage threw outside best-effort guard: ${(err as Error).message}`);
        });
      } catch (clientErr) {
        log(job.id, `[usage-tracking] supabase client construction failed (non-blocking): ${(clientErr as Error).message}`);
      }
    }
  }
}

// ── Studio-only regeneration (CE-3) ─────────────────────────────────

function spawnRegenScript(workDir: string, manifestPath: string): ChildProcess {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(__dirname, "scripts", "regenerate-studio-products.ts");
  const args = ["--import=tsx", scriptPath, workDir, manifestPath];

  log("spawn", `node --import=tsx regenerate-studio-products.ts [...]`);

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log("regen:out", line.slice(0, 200));
    }
  });
  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log("regen:err", line.slice(0, 200));
    }
  });

  return child;
}

async function readStudioFailureReason(workDir: string, exitCode: number): Promise<string> {
  try {
    const stateFile = await findStateFile(workDir);
    if (stateFile) {
      const state = JSON.parse(await fs.readFile(stateFile, "utf-8")) as PipelineState;
      const status = String(state.phase_status ?? "");
      if (status.startsWith("ERROR:")) return status.slice("ERROR:".length).trim();
    }
  } catch {
    // fall through to generic
  }
  return `regenerate-studio-products.ts exited with code ${exitCode}`;
}

async function runStudioOnly(
  job: ResearchJob,
  workDir: string,
  manifestPath: string,
): Promise<string> {
  const slug = job.topic_slug;
  log(job.id, "[studio-only] Regenerating Studio products against the parent notebook");

  await updateJob(job.id, {
    status: "running",
    current_phase: "Studio Products",
    phase_status: "Resolving parent notebook",
    progress_pct: 10,
  });

  // MRPF PUBLISH gate (S108 Codex C3): pre-spawn sign-off snapshot — same
  // contract as the full-pipeline path; the regen child must not be able to
  // author its own authorization.
  const bypassSnapshot = await readUrgentBypass(PUBLISH_RISK_ACCEPT_DIR, job.id);

  if (DRY_RUN) {
    // S108 Codex C4: same fail-closed rule as the full-pipeline DRY_RUN.
    // S120: alarm on a present-but-non-boolean job flag before the decision.
    logPublishFlagDiagnostics(
      job.id,
      [{ value: job.user_context?.publishRequired, source: "job.user_context" }],
      (line) => log(job.id, line),
    );
    if (isPublishRequired(job, null)) {
      const reason =
        "PUBLISH gate fail-closed (MRPF, studio_only): DRY_RUN cannot publish-clear a publish-required job — unset publishRequired for dry runs";
      log(job.id, reason);
      await failJob(job.id, reason);
      await notifyTerminal(job, "failed", reason);
      throw new Error(reason);
    }
    log(job.id, "[DRY RUN] Skipping regenerate-studio-products.ts execution");
    await completeJob(job.id, slug);
    await notifyTerminal(job, "completed");
    return slug;
  }

  let child: ChildProcess;
  try {
    child = spawnRegenScript(workDir, manifestPath);
  } catch (err) {
    const msg = `Failed to spawn regenerate-studio-products.ts: ${err}`;
    await failJob(job.id, msg);
    await notifyTerminal(job, "failed", msg);
    throw err;
  }

  const stateWatcher = watchStateFile(job, workDir);
  // S136: waitForProcess now returns {code, killReason}; the studio-only regen
  // path keeps its existing fail-fast behavior (no duration recovery here yet).
  let waitOutcome!: Awaited<ReturnType<typeof waitForProcess>>;
  try {
    waitOutcome = await waitForProcess(child, job);
  } finally {
    // S199 F2: finally + awaited — same watcher-leak-proofing and
    // terminal-write ordering guarantee as the main path.
    await stateWatcher.stop();
  }
  const { code: exitCode } = waitOutcome;

  if (exitCode !== 0) {
    const reason = await readStudioFailureReason(workDir, exitCode);
    log(job.id, `[studio-only] failed: ${reason}`);
    await failJob(job.id, reason);
    await notifyTerminal(job, "failed", reason);
    throw new Error(reason);
  }

  // MRPF PUBLISH gate (S108) — studio_only re-serializes existing research
  // for external distribution, so a publish-required job must still carry a
  // passing publish_verification in its state file. State read errors leave
  // studioState null, which the gate treats as a missing manifest (fail
  // closed) rather than a pass.
  let studioState: PipelineState | null = null;
  try {
    const studioStateFile = await findStateFile(workDir);
    if (studioStateFile) {
      studioState = JSON.parse(await fs.readFile(studioStateFile, "utf-8")) as PipelineState;
    }
  } catch (err) {
    // Loud, not fatal (S108 Gemini G3): a publish-flagged job (durable jsonb
    // flag — the only flag a worker job can carry) still fails closed below
    // via the missing manifest; this log is for the state-corruption forensics.
    log(
      job.id,
      `[publish-gate] state.json unreadable in studio_only workdir (${(err as Error).message}) — gate evaluates with null state`,
    );
    studioState = null;
  }
  // S120: alarm on any present-but-non-boolean publishRequired source before
  // the studio_only gate decides applicability.
  logPublishFlagDiagnostics(
    job.id,
    [
      { value: job.user_context?.publishRequired, source: "job.user_context" },
      { value: studioState?.publish_required, source: "state.publish_required" },
    ],
    (line) => log(job.id, line),
  );
  const publishGate = evaluatePublishGateForJob(job, studioState, bypassSnapshot);
  if (publishGate.applicable && !publishGate.ok) {
    const reason =
      `PUBLISH gate fail-closed (MRPF, studio_only): ${publishGate.reasons.join("; ")}`.slice(0, 2000);
    log(job.id, reason);
    await failJob(job.id, reason);
    await notifyTerminal(job, "failed", reason);
    throw new Error(reason);
  }
  if (publishGate.applicable && publishGate.bypassed) {
    log(
      job.id,
      (`[publish-gate] URGENT human risk-acceptance applied (${publishGate.signoffLine}); ` +
        `accepted defects: ${publishGate.reasons.join("; ")}`).slice(0, 2000),
    );
  }

  await updateJob(job.id, {
    current_phase: "Complete",
    phase_status: "Studio products regenerated",
    progress_pct: 100,
  });
  await completeJob(job.id, slug);
  await notifyTerminal(job, "completed");
  log(job.id, "[studio-only] Job completed");
  return slug;
}

// ── Dry run simulator ───────────────────────────────────────────────

async function simulateDryRun(job: ResearchJob): Promise<void> {
  const phases = [
    { name: "Preflight", pct: 5, delay: 1000 },
    { name: "Research Brief", pct: 8, delay: 1000 },
    { name: "Perplexity Research", pct: 15, delay: 2000 },
    { name: "CI Tier 1 Scoring", pct: 25, delay: 1000 },
    { name: "NotebookLM Import", pct: 30, delay: 1000 },
    { name: "NotebookLM Research", pct: 40, delay: 2000 },
    { name: "Extraction", pct: 50, delay: 1000 },
    { name: "Synthesis", pct: 60, delay: 2000 },
    { name: "Studio Products", pct: 70, delay: 3000 },
    { name: "Finalization", pct: 95, delay: 1000 },
    { name: "Complete", pct: 100, delay: 500 },
  ];

  for (const phase of phases) {
    log(job.id, `[DRY RUN] Phase: ${phase.name} (${phase.pct}%)`);
    await updateJob(job.id, {
      current_phase: phase.name,
      phase_status: `[DRY RUN] ${phase.name}`,
      progress_pct: phase.pct,
    }).catch((err) => log(job.id, `Progress update failed: ${err}`));
    await sleep(phase.delay);
  }

  await completeJob(job.id, job.topic_slug);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Logging ─────────────────────────────────────────────────────────

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}
