/**
 * Typed HTTP client for the Dynamic Research queue API.
 *
 * Talks to the Next.js API routes on Vercel (or local dev server).
 * All mutating endpoints require X-Agent-Key auth header.
 */

import type { ResearchJob, JobStatus, PlanReviewStatus } from "./types.js";
import type { ResearchPlan } from "./lib/plan-types.js";

// ── Config ──────────────────────────────────────────────────────────

const API_BASE = process.env.API_BASE_URL ?? "https://dynamic-research.vercel.app";
const AGENT_KEY = process.env.AGENT_SECRET_KEY ?? "";

if (!AGENT_KEY) {
  console.error("[api-client] AGENT_SECRET_KEY not set — agent updates will be rejected");
}

// ── Helpers ─────────────────────────────────────────────────────────

function agentHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Agent-Key": AGENT_KEY,
  };
}

async function ensureOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`[api-client] ${context}: ${res.status} ${res.statusText} — ${body}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Claim the next pending job. Returns the job or null if queue is empty.
 */
export async function claimJob(): Promise<ResearchJob | null> {
  const res = await fetch(`${API_BASE}/api/queue/claim`, {
    method: "POST",
    headers: agentHeaders(),
  });

  if (res.status === 204) return null;
  await ensureOk(res, "claimJob");
  return res.json() as Promise<ResearchJob>;
}

/**
 * Get current job status by ID.
 */
export async function getJob(id: string): Promise<ResearchJob> {
  const res = await fetch(`${API_BASE}/api/queue/${id}`);
  await ensureOk(res, `getJob(${id})`);
  return res.json() as Promise<ResearchJob>;
}

/**
 * Update job progress. Only callable by authenticated agents.
 *
 * S58.5: the plan_review_* fields are accepted at the API layer so the
 * worker can record review state without going through a separate route.
 * Worker normally calls them via the focused helper below
 * (updatePlanReviewStatus) but raw `updateJob` accepts them for forward-
 * compat with future internal callers.
 */
export async function updateJob(
  id: string,
  update: {
    current_phase?: string;
    phase_status?: string;
    progress_pct?: number;
    status?: JobStatus;
    result_slug?: string;
    error_message?: string;
    plan_json?: ResearchPlan | null;
    plan_review_status?: PlanReviewStatus;
    plan_review_iterations?: number;
    plan_review_attempts?: number;
    plan_review_next_attempt_at?: string | null;
    plan_review_error?: string | null;
  },
): Promise<ResearchJob> {
  const res = await fetch(`${API_BASE}/api/queue/${id}`, {
    method: "PATCH",
    headers: agentHeaders(),
    body: JSON.stringify(update),
  });
  await ensureOk(res, `updateJob(${id})`);
  return res.json() as Promise<ResearchJob>;
}

/**
 * Mark job as completed with result slug.
 */
export async function completeJob(id: string, resultSlug: string): Promise<void> {
  await updateJob(id, {
    status: "completed",
    progress_pct: 100,
    current_phase: "Complete",
    phase_status: "All outputs delivered",
    result_slug: resultSlug,
  });
}

/**
 * Mark job as failed with error message.
 */
export async function failJob(id: string, errorMessage: string): Promise<void> {
  await updateJob(id, {
    status: "failed",
    error_message: errorMessage.slice(0, 2000),
  });
}

// ── S58.5 plan-review gate helpers ─────────────────────────────────

/**
 * Update plan-review fields on a queued job. Used by the worker between
 * synthesizePlan() + reviewPlan() invocations to record state machine
 * transitions per `Documentation/final-plan-design-gate.md` §5.
 *
 * Does NOT touch the existing JobStatus enum (Codex CRITICAL-1 split).
 *
 * Typical sequences:
 *   - plan synth complete:
 *       updatePlanReviewStatus(id, "reviewing", { plan_json: synthesized })
 *   - reviewers APPROVED:
 *       updatePlanReviewStatus(id, "approved", { plan_json: final, iterations })
 *   - reviewers REQUEST_CHANGES (terminal for round):
 *       updatePlanReviewStatus(id, "request_changes", { plan_json: final, iterations, error_message })
 *   - reviewers BLOCKED (terminal):
 *       updatePlanReviewStatus(id, "blocked", { plan_json: final, error_message })
 *       — caller separately sets status="failed" via failJob
 *   - infra failure → SYSTEM_BLOCKED + auto-retry:
 *       updatePlanReviewStatus(id, "system_blocked", {
 *         iterations, attempts, next_attempt_at, error_message
 *       })
 *       — caller separately resets status="pending" via the queue claim path
 */
export async function updatePlanReviewStatus(
  id: string,
  plan_review_status: PlanReviewStatus,
  opts: {
    plan_json?: ResearchPlan | null;
    iterations?: number;
    attempts?: number;
    next_attempt_at?: string | null;
    error_message?: string | null;
  } = {},
): Promise<ResearchJob> {
  const update: Parameters<typeof updateJob>[1] = {
    plan_review_status,
  };
  if (opts.plan_json !== undefined) update.plan_json = opts.plan_json;
  if (typeof opts.iterations === "number")
    update.plan_review_iterations = opts.iterations;
  if (typeof opts.attempts === "number")
    update.plan_review_attempts = opts.attempts;
  if (opts.next_attempt_at !== undefined)
    update.plan_review_next_attempt_at = opts.next_attempt_at;
  if (opts.error_message !== undefined) {
    // Per schema CHECK: truncated 500 chars.
    update.plan_review_error =
      opts.error_message === null
        ? null
        : opts.error_message.slice(0, 500);
  }
  return await updateJob(id, update);
}
