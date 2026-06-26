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
import { archiveStaleStateFiles, findStateFile } from "./lib/find-state-file.js";
import {
  sendPlanReviewEmail,
  sendDeliveryDelayedEmail,
} from "./lib/notify.js";
import { recordUsage } from "./lib/usage-tracking.js";
import { synthesizePlan, PlanSynthesisError } from "./lib/plan-synthesizer.js";
import { reviewPlan } from "./lib/plan-reviewer.js";
import { makePlanReviewTransports } from "./lib/plan-transports.js";
import type { ResearchPlan, ReviewerCall, ReviewFinding } from "./lib/plan-types.js";
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

// ── S59 plan-review gate helper ─────────────────────────────────────

interface PlanReviewOutcome {
  proceed: boolean;
  /** Diagnostic reason when proceed=false (recorded in error_message + email). */
  reason: string;
  /**
   * S85 plan-review convergence (design §5b) — advisory reservations recorded
   * when the plan proceeded under terminal-ladder rule R5 (one reviewer
   * approved; non-critical refinements remain). Threaded to the completion
   * email so the user sees them as non-blocking notes. Empty/undefined on every
   * other path (clean approval, R1–R4 block, system_blocked).
   */
  reservations?: ReviewFinding[];
}

/**
 * S85 (design §5b option 1) — render the R5 reservations into a short advisory
 * string persisted into `plan_review_error` on the APPROVED path. The column is
 * null on a clean approval; here it is repurposed as an advisory note (NOT an
 * error). Truncated to fit the schema's 500-char cap downstream. Returns null
 * when there is nothing to surface.
 */
function buildReservationAdvisory(
  terminalDecision: string | undefined,
  reservations: ReviewFinding[] | undefined,
): string | null {
  if (!reservations || reservations.length === 0) return null;
  const lines = reservations
    .slice(0, 8)
    .map((f) => `[${f.severity}/${f.origin}] ${f.message}`);
  const more =
    reservations.length > 8 ? ` (+${reservations.length - 8} more)` : "";
  return (
    `Proceeding with ${reservations.length} advisory reservation${reservations.length === 1 ? "" : "s"} ` +
    `(terminal rule ${terminalDecision ?? "R5"}): ${lines.join(" | ")}${more}`
  );
}

/**
 * S61 Bug 51 fix — persist each ReviewerCall to public.plan_reviews.
 */
async function persistReviewerCalls(
  job: ResearchJob,
  calls: ReviewerCall[],
): Promise<void> {
  if (calls.length === 0) return;
  const sb = getSupabase();
  const rows = calls.map((c) => ({
    research_queue_id: job.id,
    organization_id: job.organization_id,
    iteration: c.iteration,
    reviewer: c.reviewer,
    plan_version: c.plan_version,
    verdict: c.verdict,
    findings: c.findings,
    model_id: c.model_id,
    provider: c.provider,
    input_tokens: c.input_tokens ?? null,
    output_tokens: c.output_tokens ?? null,
    total_cost_usd: c.total_cost_usd ?? null,
    duration_ms: c.duration_ms ?? null,
    raw_json: c.raw_json ?? null,
  }));
  const { error } = await sb.from("plan_reviews").insert(rows);
  if (error) {
    log(
      job.id,
      `[plan-review] audit-persist insert error (non-fatal): ${error.message}`,
    );
    return;
  }
  log(
    job.id,
    `[plan-review] audit-persist ok: ${rows.length} row${rows.length === 1 ? "" : "s"} written to plan_reviews`,
  );
}

/**
 * S59 Phase 0a + 0b — runs synthesizePlan() then reviewPlan() between manifest
 * write and `claude -p` spawn, per Documentation/final-plan-design-gate.md §3+§4.
 *
 * S64 (C-C2): planSynthesis catch (site 2) now classifies the thrown
 * PlanSynthesisError's `.cause` (the original transport error) via
 * classifyTerminalError(). On terminal classification:
 *   markPendingTerminalExit({...classified, source: "executor:plan-synthesis"})
 * runs BEFORE the existing failJob/notifyTerminal/return path, so worker.ts
 * picks up the pending-exit flag AFTER executeJob() finishes naturally.
 */
async function runPlanReviewGate(
  job: ResearchJob,
  workDir: string,
): Promise<PlanReviewOutcome> {
  const enforce = process.env.PLAN_REVIEW_ENFORCE?.trim() !== "false";
  const shadowMode = !enforce;
  // S85 plan-review convergence (design §4 / §6.5 edge 5) — independent
  // dark-launch flag for the severity-graded terminal ladder. Default false:
  // the ladder computes + records terminal_decision + would-be reservations
  // for telemetry, but R5 does NOT flip the emitted status to APPROVED, so
  // production behavior is unchanged until PLAN_REVIEW_LADDER_ENFORCE=true.
  const ladderEnforce = process.env.PLAN_REVIEW_LADDER_ENFORCE?.trim() === "true";

  log(job.id, `[plan-review] gate fired (enforce=${enforce}, shadow=${shadowMode}, ladderEnforce=${ladderEnforce})`);

  await updatePlanReviewStatus(job.id, "reviewing").catch((err) => {
    log(job.id, `[plan-review] mark-reviewing write failed (non-fatal): ${(err as Error).message}`);
  });

  const transports = makePlanReviewTransports();

  let plan: ResearchPlan;
  try {
    const synth = await synthesizePlan(job, {
      transport: transports.synthesizer,
      signal: AbortSignal.timeout(5 * 60 * 1000),
      maxAttempts: 2,
    });
    plan = synth.plan;
    log(
      job.id,
      `[plan-review] synth ok: $${synth.total_cost_usd.toFixed(4)} (${synth.attempts} attempt${synth.attempts === 1 ? "" : "s"}, ${synth.input_tokens ?? 0}+${synth.output_tokens ?? 0} tok)`,
    );
  } catch (err) {
    // S64 (C-C2): classify the underlying transport error BEFORE the
    // existing user-facing failure path. PlanSynthesisError.cause holds the
    // original Anthropic SDK error when the failure was transport-level
    // (vs content-level retry exhaustion, which has no cause).
    const originalErr = err instanceof PlanSynthesisError ? err.cause : err;
    const classified = classifyTerminalError({ err: originalErr });
    if (classified) {
      markPendingTerminalExit({
        ...classified,
        source: "executor:plan-synthesis",
      });
      log(
        job.id,
        `[plan-review] terminal-error classified: kind=${classified.kind} signature=${classified.signature} — worker will exit after this job finishes`,
      );
    }

    const msg = err instanceof PlanSynthesisError
      ? `${err.message} (attempt errors: ${err.attemptErrors.join(" | ").slice(0, 400)})`
      : (err as Error).message;
    log(job.id, `[plan-review] synth failed: ${msg}`);
    await updatePlanReviewStatus(job.id, "system_blocked", {
      error_message: `Synthesis failed: ${msg}`,
    }).catch(() => undefined);
    if (!shadowMode) {
      await failJob(job.id, `Plan synthesis failed: ${msg}`).catch(() => undefined);
      await notifyTerminal(job, "failed", `Plan synthesis failed: ${msg}`);
      return { proceed: false, reason: "plan synthesis system_blocked" };
    }
    return { proceed: true, reason: "shadow-mode forced proceed after synth failure" };
  }

  // S64 G-C1 (Gemini MERGE-gate v1): plan-reviewer.ts:runIntegration now
  // RE-THROWS on terminal classification (per C-C2 site 3) instead of
  // returning a synthetic UNAVAILABLE row. Without this try/catch the
  // exception escaped runPlanReviewGate -> executeJob -> poll(), leaving
  // the job stuck in running/reviewing status with no failJob call.
  // The terminal-error flag was markPending'd inside runIntegration;
  // worker.ts:finalizeTerminalExitIfPending() picks it up after this
  // function returns. Here we just do user-facing teardown.
  let reviewResult: Awaited<ReturnType<typeof reviewPlan>>;
  try {
    reviewResult = await reviewPlan(plan, job, {
      geminiTransport: transports.gemini,
      codexTransport: transports.codex,
      integrationTransport: transports.integration,
      signal: AbortSignal.timeout(15 * 60 * 1000),
      shadowMode,
      ladderEnforce,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(job.id, `[plan-review] reviewPlan threw: ${msg}`);
    await updatePlanReviewStatus(job.id, 'system_blocked', {
      error_message: `Plan review failed: ${msg}`,
    }).catch(() => undefined);
    // S64 Codex MERGE-gate A1: a thrown terminal error is an infra/SYSTEM_BLOCKED-
    // class signal — same semantic as reviewPlan returning status='SYSTEM_BLOCKED',
    // which reviewPlan preserves even in shadow mode (see finalize() in
    // plan-reviewer.ts). Shadow-mode SHOULD continue to gate on this — letting
    // the spawn proceed after an account-level terminal error has already
    // marked the worker for exit would burn the queue against a known-broken
    // account state. Fail the job in both modes; the pending-exit flag will
    // be consumed by worker.ts:finalizeTerminalExitIfPending() either way.
    await failJob(job.id, `Plan review failed: ${msg}`).catch(() => undefined);
    await notifyTerminal(job, 'failed', `Plan review failed: ${msg}`);
    return { proceed: false, reason: `plan review threw: ${msg}` };
  }

  // S85 — surface terminal_decision (R1..R5) + reservation count for §5a
  // telemetry / dark-launch measurement. Present only when the terminal ladder
  // ran; grep `terminal=R5` in worker.log to count R5 trigger-rate before
  // flipping PLAN_REVIEW_LADDER_ENFORCE=true.
  const reservations = reviewResult.reservations ?? [];
  const terminalSuffix = reviewResult.terminal_decision
    ? ` terminal=${reviewResult.terminal_decision} reservations=${reservations.length}`
    : "";
  log(
    job.id,
    `[plan-review] verdict=${reviewResult.status} iters=${reviewResult.iterations} calls=${reviewResult.reviewer_calls.length} cost=$${reviewResult.total_cost_usd.toFixed(4)}${terminalSuffix}${reviewResult.user_message ? ` msg="${reviewResult.user_message.slice(0, 100)}"` : ""}`,
  );

  const planReviewStatus =
    reviewResult.status === "APPROVED" ? "approved" :
    reviewResult.status === "REQUEST_CHANGES" ? "request_changes" :
    reviewResult.status === "BLOCKED" ? "blocked" :
    "system_blocked";

  // S85 (design §5b option 1) — on the emitted-APPROVED path, persist any R5
  // reservations into plan_review_error as an advisory note (NOT an error). On
  // every other path keep the existing user_message semantics.
  const advisory =
    reviewResult.status === "APPROVED"
      ? buildReservationAdvisory(reviewResult.terminal_decision, reservations)
      : null;
  await updatePlanReviewStatus(job.id, planReviewStatus, {
    plan_json: reviewResult.final_plan,
    iterations: reviewResult.iterations,
    error_message: advisory ?? reviewResult.user_message ?? null,
  }).catch((err) => {
    log(job.id, `[plan-review] status-write failed (non-fatal): ${(err as Error).message}`);
  });

  await persistReviewerCalls(job, reviewResult.reviewer_calls).catch((err) => {
    log(
      job.id,
      `[plan-review] audit-persist threw (non-fatal): ${(err as Error).message}`,
    );
  });

  await fs.writeFile(
    path.join(workDir, "research-plan.json"),
    JSON.stringify(reviewResult.final_plan, null, 2),
  );

  if (reviewResult.status === "APPROVED") {
    // S85 — thread R5 reservations (if any) to the completion email (§5b
    // option 2). Empty on a clean approval.
    return { proceed: true, reason: "plan approved", reservations };
  }
  if (reviewResult.status === "SYSTEM_BLOCKED") {
    await failJob(
      job.id,
      reviewResult.user_message ?? "Plan review system_blocked",
    ).catch(() => undefined);
    await notifyTerminal(
      job,
      "failed",
      reviewResult.user_message ?? "Plan review system_blocked",
    );
    return { proceed: false, reason: `plan review system_blocked: ${reviewResult.user_message ?? ""}` };
  }
  await failJob(
    job.id,
    reviewResult.user_message ?? `Plan review ${reviewResult.status.toLowerCase()}`,
  ).catch(() => undefined);
  await sendPlanReviewEmail({
    to: job.notify_email,
    slug: job.topic_slug,
    topic: job.topic,
    status: reviewResult.status,
    user_message: reviewResult.user_message ?? "Plan review terminal state.",
    findings: reviewResult.reviewer_calls
      .flatMap((c) => c.findings)
      .slice(0, 20),
  }).catch((err) => {
    log(job.id, `[plan-review] email send failed (non-fatal): ${(err as Error).message}`);
  });
  return {
    proceed: false,
    reason: `plan review ${reviewResult.status.toLowerCase()}: ${reviewResult.user_message ?? ""}`,
  };
}

// ── Main executor ───────────────────────────────────────────────────

export async function executeJob(job: ResearchJob): Promise<string> {
  const slug = job.topic_slug;
  const workDir = path.join(WORKING_DIR, slug);
  const projectsDir = path.join(PROJECTS_DIR, slug);

  log(job.id, `Starting job: "${job.topic}" (slug: ${slug})`);

  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });

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

    const stateWatcher = watchStateFile(job, workDir);

    // S69: pass getStdout so waitForProcess can compute in-flight cost
    // estimates and trip MAX_JOB_COST_CENTS. Back-compat: arg is optional;
    // callers that don't pass it (none currently) just skip the cost check.
    const { code: exitCode, killReason } = await waitForProcess(claudeProcess, job, getStdout);
    exitCodeForUsage = exitCode;
    stdoutForUsage = getStdout();

    stateWatcher.stop();

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

      await failJob(job.id, verdict.reason);
      await notifyTerminal(job, "failed", verdict.reason);
      throw new Error(verdict.reason);
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
  const { code: exitCode } = await waitForProcess(child, job);
  stateWatcher.stop();

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
