/**
 * POST /api/queue — Creates a new research job in the queue.
 * GET  /api/queue — Lists active jobs (pending, running, failed) for the
 *                   caller's organization, as an envelope so the UI can hide
 *                   failed/cancelled jobs (S93).
 *
 * Validates inputs via Zod, generates a unique slug, calculates
 * estimated completion time, and inserts into research_queue.
 *
 * S56 Phase 2 — per design §4.1 (Pattern A) + §4.4 (Codex C-C1 BLOCKING fix
 * for cross-tenant parent_run_id leak):
 *
 *   1. Derive orgId FIRST via getOrgContextDualPath() — before any DB lookup.
 *   2. Parent slug → parent_run_id lookup adds .eq('organization_id', orgId)
 *      so a user cannot reference another org's run as a parent.
 *   3. Insert adds explicit `organization_id: orgId` — replaces reliance on
 *      the Phase A schema DEFAULT (which Phase 5 will DROP).
 *   4. studio_only error message updated to reflect same-org scope.
 *   5. GET filters .eq('organization_id', orgId) so users only see jobs in
 *      their own org.
 *
 * S93 — GET now returns { jobs, hiddenCount, canHide } (was a bare array),
 * mirroring /api/runs. Failed/cancelled jobs the org has hidden (a row in
 * user_hidden_runs keyed by the job UUID) are filtered out unless ?show_hidden=1,
 * in which case they are returned annotated `hidden: true`. The hidden set is
 * org-scoped via the service-role client — the SAME tenant boundary as the
 * list query itself.
 *
 * Note: unlike the storage routes, the queue routes query research_queue
 * directly (no storage-path scoping). The .eq('organization_id', orgId)
 * IS the cross-tenant boundary here — load-bearing, not redundant.
 * Early-400 responses (invalid JSON, Zod failures) carry X-Org-Source:none
 * for telemetry completeness (Gemini F3, S56).
 */

import { getSupabase } from "@/lib/supabase";
import { researchJobPayloadSchema, generateSlug } from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { SelectedProducts } from "@/lib/types/queue";
import { getOrgContextDualPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "X-Org-Source": "none" } },
    );
  }

  const parsed = researchJobPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400, headers: { "X-Org-Source": "none" } },
    );
  }

  // §4.4 (C-C1): derive orgId FIRST, before any DB lookup. The parent
  // lookup in step 2 below depends on knowing the caller's org so it can
  // refuse cross-org parent references.
  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  const data = parsed.data;
  const slug = generateSlug(data.topic);
  const estimate = estimateMinutes(
    data.selectedProducts as SelectedProducts,
    data.vendorEvaluation.enabled,
  );

  const supabase = getSupabase();

  // S35 Clone & Edit — if parentSlug present, resolve to UUID for the
  // parent_run_id FK. Unknown slug for a full-pipeline submission is fine
  // (the user's brief is still valid); but for studio_only it's fatal —
  // the worker needs the parent's NLM notebook id and would otherwise be
  // told to do something it cannot do. .maybeSingle() avoids the .single()
  // zero-rows throw (S33 adversarial #11).
  //
  // §4.4 (C-C1 BLOCKING): same-org scope. Without .eq('organization_id', orgId)
  // a user could craft a studio-only POST referencing another org's run; the
  // worker would then resolve the parent by ID and read parent-org storage +
  // notebook data — cross-tenant leak. Same-org guard closes it route-side.
  // DB-level trigger (research_queue_parent_same_org) lands in Phase 5.
  let parentRunId: string | null = null;
  if (data.parentSlug) {
    const { data: parentRow } = await supabase
      .from("research_queue")
      .select("id")
      .eq("topic_slug", data.parentSlug)
      .eq("organization_id", orgId)
      .maybeSingle();
    parentRunId = parentRow?.id ?? null;
  }

  // CE-3 Bug 2 — when the user explicitly requested studio_only but the
  // parent slug doesn't resolve to a queue row IN THEIR ORG, return 400
  // instead of silently downgrading to a full pipeline. A silent downgrade
  // burns ~$5-15 and 1-2 hours on a job the user did not ask for, and many
  // storage-resident completed runs do not have a queue row (S41 finding).
  // Same-org scope per §4.4 above.
  if (data.pipelineMode === "studio_only" && !parentRunId) {
    return Response.json(
      {
        error: "Parent run not found in your organization's queue",
        detail:
          "Studio-only regeneration requires the parent run to have an active queue row (with the parent NLM notebook) in your organization. The slug you provided does not match any research_queue.topic_slug owned by your org. Re-submit as a full pipeline, or pick a different parent run.",
        parentSlug: data.parentSlug ?? null,
      },
      { status: 400, headers: orgHeaders },
    );
  }

  // pipeline_mode is NOT NULL with a 'full' default and CHECK ('full',
  // 'studio_only'); we always write an explicit string (an explicit NULL
  // would fail the constraint — DEFAULT only applies on column omission).
  const pipelineMode: "full" | "studio_only" =
    parentRunId && data.pipelineMode === "studio_only" ? "studio_only" : "full";

  // §4.4 (C-C1): explicit organization_id on insert replaces the Phase A
  // schema DEFAULT. Phase 5 will DROP DEFAULT, making this mandatory.
  const { data: row, error } = await supabase
    .from("research_queue")
    .insert({
      topic: data.topic,
      topic_slug: slug,
      organization_id: orgId,
      user_context: data.userContext,
      vendor_evaluation: data.vendorEvaluation,
      aji_dna_enabled: data.ajiDnaEnabled,
      selected_products: data.selectedProducts,
      customizations: data.customizations,
      notify_email: data.notifyEmail || null,
      estimated_minutes: estimate,
      parent_run_id: parentRunId,
      pipeline_mode: pipelineMode,
    })
    .select("id, topic_slug, estimated_minutes")
    .single();

  if (error) {
    return Response.json(
      { error: "Failed to create job", detail: error.message },
      { status: 500, headers: orgHeaders },
    );
  }

  return Response.json(
    { id: row.id, slug: row.topic_slug, estimatedMinutes: row.estimated_minutes },
    { status: 201, headers: orgHeaders },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const showHidden = searchParams.get("show_hidden") === "1";

  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("research_queue")
    .select("id, topic, topic_slug, status, current_phase, phase_status, progress_pct, estimated_minutes, created_at, result_slug")
    .eq("organization_id", orgId)
    .in("status", ["pending", "running", "failed"])
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json(
      { error: "Failed to fetch queue", detail: error.message },
      { status: 500, headers: orgHeaders },
    );
  }

  // Org-scoped hidden set — shared user_hidden_runs table. Bounded to the ids
  // actually returned (Gemini MINOR, S93): without `.in("slug", jobIds)` this
  // would load the org's entire historical hide set on every 5s poll. Scoping
  // to the active-job ids keeps it O(visible jobs). Completed-run hides are
  // storage slugs and never match a job UUID, so they are excluded for free.
  const jobIds = (data ?? []).map((j) => j.id as string);
  let hiddenIds = new Set<string>();
  if (jobIds.length > 0) {
    try {
      const { data: hr } = await supabase
        .from("user_hidden_runs")
        .select("slug")
        .eq("organization_id", orgId)
        .in("slug", jobIds);
      hiddenIds = new Set((hr ?? []).map((r) => r.slug as string));
    } catch {
      hiddenIds = new Set();
    }
  }

  const jobs: Record<string, unknown>[] = [];
  let hiddenCount = 0;
  for (const job of data ?? []) {
    const isHidden = hiddenIds.has(job.id as string);
    if (isHidden) hiddenCount++;
    if (isHidden && !showHidden) continue;
    jobs.push(isHidden ? { ...job, hidden: true } : job);
  }

  return Response.json(
    { jobs, hiddenCount, canHide: true },
    { headers: orgHeaders },
  );
}
