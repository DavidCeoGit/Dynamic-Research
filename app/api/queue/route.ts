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
