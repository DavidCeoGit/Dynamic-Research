/**
 * POST /api/queue — Creates a new research job in the queue.
 * GET  /api/queue — Lists active jobs (pending, running, failed).
 *
 * Validates inputs via Zod, generates a unique slug, calculates
 * estimated completion time, and inserts into research_queue.
 */

import { getSupabase } from "@/lib/supabase";
import { researchJobPayloadSchema, generateSlug } from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { SelectedProducts } from "@/lib/types/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = researchJobPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

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
  let parentRunId: string | null = null;
  if (data.parentSlug) {
    const { data: parentRow } = await supabase
      .from("research_queue")
      .select("id")
      .eq("topic_slug", data.parentSlug)
      .maybeSingle();
    parentRunId = parentRow?.id ?? null;
  }

  // CE-3 Bug 2 — when the user explicitly requested studio_only but the
  // parent slug doesn't resolve to a queue row, return 400 instead of
  // silently downgrading to a full pipeline. A silent downgrade burns
  // ~$5-15 and 1-2 hours on a job the user did not ask for, and many
  // storage-resident completed runs do not have a queue row (S41 finding).
  if (data.pipelineMode === "studio_only" && !parentRunId) {
    return Response.json(
      {
        error: "Parent run not found in queue",
        detail:
          "Studio-only regeneration requires the parent run to have an active queue row (with the parent NLM notebook). The slug you provided does not match any research_queue.topic_slug. Re-submit as a full pipeline, or pick a different parent run.",
        parentSlug: data.parentSlug ?? null,
      },
      { status: 400 },
    );
  }

  // pipeline_mode is NOT NULL with a 'full' default and CHECK ('full',
  // 'studio_only'); we always write an explicit string (an explicit NULL
  // would fail the constraint — DEFAULT only applies on column omission).
  const pipelineMode: "full" | "studio_only" =
    parentRunId && data.pipelineMode === "studio_only" ? "studio_only" : "full";

  const { data: row, error } = await supabase
    .from("research_queue")
    .insert({
      topic: data.topic,
      topic_slug: slug,
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
      { status: 500 },
    );
  }

  return Response.json(
    { id: row.id, slug: row.topic_slug, estimatedMinutes: row.estimated_minutes },
    { status: 201 },
  );
}

export async function GET() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("research_queue")
    .select("id, topic, topic_slug, status, current_phase, phase_status, progress_pct, estimated_minutes, created_at, result_slug")
    .in("status", ["pending", "running", "failed"])
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json(
      { error: "Failed to fetch queue", detail: error.message },
      { status: 500 },
    );
  }

  return Response.json(data);
}
