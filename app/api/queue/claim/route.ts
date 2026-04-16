/**
 * POST /api/queue/claim
 *
 * Atomic agent job claiming. Uses FOR UPDATE SKIP LOCKED to prevent
 * race conditions when multiple agents poll simultaneously.
 *
 * Returns the claimed job or 204 if no pending jobs.
 */

import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Validate agent key
  const agentKey = request.headers.get("X-Agent-Key");
  if (!agentKey || agentKey !== process.env.AGENT_SECRET_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Atomic claim: select oldest pending job and immediately set to running.
  // FOR UPDATE SKIP LOCKED ensures no two agents claim the same job.
  const { data, error } = await supabase.rpc("claim_next_job");

  if (error) {
    // If the RPC doesn't exist yet, fall back to a two-step approach
    // (slightly less atomic but functional during development)
    const { data: pending } = await supabase
      .from("research_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (!pending) {
      return new Response(null, { status: 204 });
    }

    const { data: claimed, error: updateError } = await supabase
      .from("research_queue")
      .update({ status: "running", claimed_at: new Date().toISOString() })
      .eq("id", pending.id)
      .eq("status", "pending") // Optimistic lock: only update if still pending
      .select("*")
      .single();

    if (updateError || !claimed) {
      // Another agent grabbed it between our select and update
      return new Response(null, { status: 204 });
    }

    return Response.json(claimed);
  }

  // RPC returned null = no pending jobs
  if (!data || (Array.isArray(data) && data.length === 0)) {
    return new Response(null, { status: 204 });
  }

  return Response.json(Array.isArray(data) ? data[0] : data);
}
