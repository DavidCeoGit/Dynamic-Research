/**
 * GET  /api/queue/[id] — Poll job status (user-facing, session-scoped)
 * PATCH /api/queue/[id] — Update job progress (agent only, X-Agent-Key)
 *
 * S146 Phase 4 — GET resolves org from the SESSION via requireOrgOr401()
 * (the Phase-2 env fallback is retired) and keeps .eq('organization_id', orgId)
 * so users can only poll jobs in their own org; unauthenticated → 401. PATCH is
 * the worker's progress-update path and stays on X-Agent-Key auth — proxy.ts
 * short-circuits PATCH so it never reaches the session layer.
 */

import { getSupabase } from "@/lib/supabase";
import { agentUpdateSchema } from "@/lib/validate";
import { requireOrgOr401 } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ── GET — Poll job status ───────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("research_queue")
    .select("*")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: "Failed to fetch job", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  return Response.json(data);
}

// ── PATCH — Agent progress update ───────────────────────────────────

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Validate agent key
  const agentKey = request.headers.get("X-Agent-Key");
  if (!agentKey || agentKey !== process.env.AGENT_SECRET_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = agentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = {};
  const data = parsed.data;

  if (data.current_phase !== undefined) updates.current_phase = data.current_phase;
  if (data.phase_status !== undefined) updates.phase_status = data.phase_status;
  if (data.progress_pct !== undefined) updates.progress_pct = data.progress_pct;
  if (data.status !== undefined) {
    updates.status = data.status;
    if (data.status === "completed") updates.completed_at = new Date().toISOString();
  }
  if (data.result_slug !== undefined) updates.result_slug = data.result_slug;
  if (data.error_message !== undefined) updates.error_message = data.error_message;

  // S58 plan-review gate (allowlist extension — schema accepts these via
  // planReviewStatusEnum, but the handler must explicitly pass them through
  // or they get silently dropped). null is meaningful for plan_json /
  // plan_review_next_attempt_at / plan_review_error: undefined = leave the
  // column unchanged, null = explicitly clear it.
  if (data.plan_json !== undefined) updates.plan_json = data.plan_json;
  if (data.plan_review_status !== undefined)
    updates.plan_review_status = data.plan_review_status;
  if (data.plan_review_iterations !== undefined)
    updates.plan_review_iterations = data.plan_review_iterations;
  if (data.plan_review_attempts !== undefined)
    updates.plan_review_attempts = data.plan_review_attempts;
  if (data.plan_review_next_attempt_at !== undefined)
    updates.plan_review_next_attempt_at = data.plan_review_next_attempt_at;
  if (data.plan_review_error !== undefined)
    updates.plan_review_error = data.plan_review_error;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("research_queue")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !row) {
    return Response.json(
      { error: "Failed to update job", detail: error?.message },
      { status: 500 },
    );
  }

  return Response.json(row);
}
