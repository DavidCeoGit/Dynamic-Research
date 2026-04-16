/**
 * GET  /api/queue/[id] — Poll job status
 * PATCH /api/queue/[id] — Update job progress (agent only)
 */

import { getSupabase } from "@/lib/supabase";
import { agentUpdateSchema } from "@/lib/validate";

export const dynamic = "force-dynamic";

// ── GET — Poll job status ───────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("research_queue")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
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
