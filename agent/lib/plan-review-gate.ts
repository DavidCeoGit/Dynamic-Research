/**
 * Plan-review gate (S59 Phase 0a/0b) — runs synthesizePlan() then reviewPlan()
 * between manifest write and the `claude -p` spawn, per
 * Documentation/final-plan-design-gate.md §3+§4. Extracted verbatim from
 * executor.ts in the S177 Wave-D decomposition (design
 * Documentation/executor-studio-decomposition-design-gate.md §4.1, §8 wave D).
 * PURE MOVE: runPlanReviewGate + buildReservationAdvisory + persistReviewerCalls
 * + PlanReviewOutcome, byte-identical bodies. The S64 terminal-error classifier
 * calls (classifyTerminalError/markPendingTerminalExit, imported from
 * preflight-backoff) move WITH the gate; executor still imports them too for
 * its own claude-spawn catch sites.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { failJob, updatePlanReviewStatus } from "../api-client.js";
import { sendPlanReviewEmail } from "./notify.js";
import { synthesizePlan, PlanSynthesisError } from "./plan-synthesizer.js";
import { reviewPlan } from "./plan-reviewer.js";
import { makePlanReviewTransports } from "./plan-transports.js";
import type { ResearchPlan, ReviewerCall, ReviewFinding } from "./plan-types.js";
import {
  classifyTerminalError,
  markPendingTerminalExit,
} from "./preflight-backoff.js";
import type { ResearchJob } from "../types.js";
import { getSupabase } from "./worker-supabase.js";
import { notifyTerminal } from "./terminal-notify.js";

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}

// ── S59 plan-review gate helper ─────────────────────────────────────

export interface PlanReviewOutcome {
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
export async function runPlanReviewGate(
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
