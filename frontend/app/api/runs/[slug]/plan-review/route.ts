/**
 * GET /api/runs/[slug]/plan-review
 *
 * S60 — surfaces the plan-review gate state (per migration
 * 20260527_plan_review_gate.sql §1) for a given run slug, so the
 * runs/[slug]/page.tsx UI can render a derived-display banner from the
 * (status, plan_review_status) tuple.
 *
 * S60.3 — also returns `topic` so the page can show a meaningful
 * "pending pickup" view when state.json hasn't been written yet.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); unauthenticated → 401. Cross-tenant
 * boundary: `.eq('organization_id', orgId)` is load-bearing — research_queue is
 * queried directly (not via storage-path scoping).
 */

import { getSupabase } from "@/lib/supabase";
import { requireOrgOr401 } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface PlanReviewSummary {
  topic: string;
  status: string;
  plan_review_status: string | null;
  plan_review_iterations: number | null;
  plan_review_attempts: number | null;
  plan_review_next_attempt_at: string | null;
  plan_review_error: string | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("research_queue")
    .select(
      "topic, status, plan_review_status, plan_review_iterations, plan_review_attempts, plan_review_next_attempt_at, plan_review_error",
    )
    .eq("topic_slug", slug)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) {
    return Response.json(
      { error: "Failed to query research_queue", detail: error.message },
      { status: 500 },
    );
  }

  if (!data) {
    return Response.json(
      { error: `No queue row found for slug in your org: ${slug}` },
      { status: 404 },
    );
  }

  const body: PlanReviewSummary = {
    topic: (data.topic as string) ?? "",
    status: data.status as string,
    plan_review_status: (data.plan_review_status as string | null) ?? null,
    plan_review_iterations:
      (data.plan_review_iterations as number | null) ?? null,
    plan_review_attempts:
      (data.plan_review_attempts as number | null) ?? null,
    plan_review_next_attempt_at:
      (data.plan_review_next_attempt_at as string | null) ?? null,
    plan_review_error: (data.plan_review_error as string | null) ?? null,
  };

  return Response.json(body);
}
