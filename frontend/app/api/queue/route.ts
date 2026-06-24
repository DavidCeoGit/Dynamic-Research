/**
 * POST /api/queue — Creates a new research job in the queue.
 * GET  /api/queue — Lists active jobs (pending, running, failed) for the
 *                   caller's organization, as an envelope so the UI can hide
 *                   failed/cancelled jobs (S93).
 *
 * Validates inputs via Zod, generates a unique slug, calculates
 * estimated completion time, and inserts into research_queue.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); an unauthenticated request returns 401.
 * Because reaching the handler body now implies an authenticated session, the
 * former `source !== "session"` attachment guard is gone (it can never fire).
 *
 *   1. Derive orgId FIRST via requireOrgOr401() — before any DB lookup.
 *   2. Parent slug → parent_run_id lookup adds .eq('organization_id', orgId)
 *      so a user cannot reference another org's run as a parent (§4.4 C-C1).
 *   3. Insert adds explicit `organization_id: orgId` — replaces reliance on
 *      the Phase A schema DEFAULT (which Phase 5 will DROP).
 *   4. GET filters .eq('organization_id', orgId) so users only see jobs in
 *      their own org.
 *
 * S93 — GET returns { jobs, hiddenCount, canHide } (was a bare array),
 * mirroring /api/runs. Failed/cancelled jobs the org has hidden are filtered
 * out unless ?show_hidden=1, in which case they are returned annotated
 * `hidden: true`. The hidden set is org-scoped via the service-role client.
 *
 * Note: unlike the storage routes, the queue routes query research_queue
 * directly (no storage-path scoping). The .eq('organization_id', orgId)
 * IS the cross-tenant boundary here — load-bearing, not redundant.
 */

import { getSupabase } from "@/lib/supabase";
import { researchJobPayloadSchema, generateSlug } from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { SelectedProducts, AttachmentMeta } from "@/lib/types/queue";
import { requireOrgOr401 } from "@/lib/auth";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";
import {
  verifyAndCopyAttachments,
  removeRunSources,
  removeStagedFiles,
} from "@/lib/storage";

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

  // §4.4 (C-C1): derive orgId FIRST, before any DB lookup. The parent lookup
  // below depends on knowing the caller's org so it can refuse cross-org parent
  // references. Phase 4: session-only; unauthenticated → 401.
  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  const data = parsed.data;

  // Audit A10/M1 — throttle the attachment copy-amplifier. Submit performs
  // the same verify+copy storage fan-out as replay (up to 5 copies + audit
  // rows per call) whenever it carries staging attachments OR a parentSlug
  // (origin:"parent" carry-overs copied out of the parent run's sources/).
  // GATED on copy-bearing submits only so the common text-only path never
  // draws from the shared 20-token/IP bucket (a wizard flow already spends
  // ~extract + generate + N mints, and the terminal submit must not 429).
  const triggersCopyFanout =
    (Array.isArray(data.attachments) && data.attachments.length > 0) ||
    typeof data.parentSlug === "string";
  if (triggersCopyFanout) {
    const rl = await checkRateLimit(clientIp(request));
    if (!rl.allowed) {
      return Response.json(
        { error: "Rate limit exceeded", detail: `Try again in ${rl.retryAfterSec}s.` },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }
  }

  const slug = generateSlug(data.topic);
  const estimate = estimateMinutes(
    data.selectedProducts as SelectedProducts,
    data.vendorEvaluation.enabled,
  );

  const supabase = getSupabase();

  // S35 Clone & Edit — if parentSlug present, resolve to UUID for the
  // parent_run_id FK. Unknown slug for a full-pipeline submission is fine
  // (the user's brief is still valid); but for studio_only it's fatal —
  // the worker needs the parent's NLM notebook id. .maybeSingle() avoids the
  // .single() zero-rows throw (S33 adversarial #11).
  //
  // §4.4 (C-C1 BLOCKING): same-org scope. Without .eq('organization_id', orgId)
  // a user could craft a studio-only POST referencing another org's run; the
  // worker would then resolve the parent by ID and read parent-org storage +
  // notebook data — cross-tenant leak. Same-org guard closes it route-side.
  // DB-level trigger (research_queue_parent_same_org) lands in Phase 5.
  let parentRunId: string | null = null;
  if (data.parentSlug) {
    const { data: parentRow, error: parentLookupError } = await supabase
      .from("research_queue")
      .select("id")
      .eq("topic_slug", data.parentSlug)
      .eq("organization_id", orgId)
      .maybeSingle();
    // Distinguish query-failure from no-data (cf. requireOrgContext taxonomy):
    // .maybeSingle() returns error:null on zero rows, so a populated error here
    // is a genuine DB failure — fail loud with 500 rather than letting the null
    // parentRunId masquerade as "parent not found" (a 400 that would wrongly
    // tell the user to re-submit, silently destroying their studio_only intent).
    if (parentLookupError) {
      return Response.json(
        { error: "Failed to resolve parent run", detail: parentLookupError.message },
        { status: 500 },
      );
    }
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
      { status: 400 },
    );
  }

  // pipeline_mode is NOT NULL with a 'full' default and CHECK ('full',
  // 'studio_only'); we always write an explicit string.
  const pipelineMode: "full" | "studio_only" =
    parentRunId && data.pipelineMode === "studio_only" ? "studio_only" : "full";

  // Attachments verify+copy (Phase 2). Run AFTER slug + parent resolution and
  // BEFORE the insert, so the run folder is self-contained and a failed copy is
  // retry-safe (no row references the slug). Reaching here implies an
  // authenticated session (Phase 4: the env path that could not own staged
  // bytes no longer exists), so no separate session check is needed. On any
  // verify/copy failure we return that status and insert NO row.
  let verifiedAttachments: AttachmentMeta[] = [];
  if (data.attachments.length > 0) {
    const copyResult = await verifyAndCopyAttachments({
      orgId,
      newSlug: slug,
      draftId: data.attachmentsDraftId ?? null,
      parentSlug: data.parentSlug ?? null,
      items: data.attachments,
      caller: "api/queue/route",
    });
    if (!copyResult.ok) {
      return Response.json(
        { error: "Attachment processing failed", detail: copyResult.error },
        { status: copyResult.status ?? 500 },
      );
    }
    verifiedAttachments = copyResult.verified ?? [];
  }

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
      attachments: verifiedAttachments,
    })
    .select("id, topic_slug, estimated_minutes")
    .single();

  if (error) {
    // Gemini MERGE-gate MAJOR #3 — the attachments were already copied into
    // <orgId>/<slug>/sources/ above; the slug is single-use, so a failed insert
    // would orphan them permanently. Best-effort clean up before returning.
    if (verifiedAttachments.length > 0) {
      await removeRunSources(orgId, slug, verifiedAttachments.map((a) => a.storedName));
    }
    return Response.json(
      { error: "Failed to create job", detail: error.message },
      { status: 500 },
    );
  }

  // Codex MERGE-gate MAJOR — the row is committed and the bytes now live under
  // <orgId>/<slug>/sources/, so the consumed staging copies are dead weight.
  // Best-effort delete them now (never throws); the Phase-3 24h TTL sweep is the
  // backstop for ABANDONED drafts. Only staging-origin items have a staging
  // object to reclaim; parent carry-overs must be left intact.
  if (data.attachmentsDraftId) {
    const stagedNames = data.attachments
      .filter((a) => a.origin === "staging")
      .map((a) => a.storedName);
    await removeStagedFiles(orgId, data.attachmentsDraftId, stagedNames);
  }

  return Response.json(
    { id: row.id, slug: row.topic_slug, estimatedMinutes: row.estimated_minutes },
    { status: 201 },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const showHidden = searchParams.get("show_hidden") === "1";

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("research_queue")
    .select("id, topic, topic_slug, status, current_phase, phase_status, progress_pct, estimated_minutes, created_at, result_slug, studio_recovery_status")
    .eq("organization_id", orgId)
    .in("status", ["pending", "running", "failed"])
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json(
      { error: "Failed to fetch queue", detail: error.message },
      { status: 500 },
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

  return Response.json({ jobs, hiddenCount, canHide: true });
}
