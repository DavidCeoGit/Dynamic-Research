/**
 * Typed HTTP client for the Dynamic Research queue API.
 *
 * Talks to the Next.js API routes on Vercel (or local dev server).
 * All mutating endpoints require X-Agent-Key auth header.
 */

import type { ResearchJob, JobStatus } from "./types.js";

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
