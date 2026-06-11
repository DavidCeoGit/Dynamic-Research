/**
 * POST /api/runs/[slug]/replay
 *
 * S60 — one-click rerun of a prior run. Skips the /new wizard. Returns
 * the new run's slug so the client can navigate to `/runs/<new-slug>`.
 * Lineage: parentSlug on the new row points at the slug being replayed.
 *
 * S60.1 — optional body `{ selectedProducts: { audio, video, slides,
 * report, infographic } }` lets the caller override which Studio products
 * are generated. When absent or empty, the parent's selected_products
 * passes through unchanged. Lets dark-launch testing be cheap: replay
 * with only `report` checked instead of all 5.
 *
 * pipelineMode is always "full" for replay v1 (even if parent was
 * studio_only — that chain adds complexity not needed here). Insert
 * logic mirrors POST /api/queue intentionally; future refactor: extract
 * createJobFromPayload() helper.
 */

import { getSupabase } from "@/lib/supabase";
import {
  researchJobPayloadSchema,
  selectedProductsSchema,
  generateSlug,
} from "@/lib/validate";
import { estimateMinutes } from "@/lib/estimates";
import type { SelectedProducts, AttachmentMeta } from "@/lib/types/queue";
import { getOrgContextDualPath } from "@/lib/auth";
import { verifyAndCopyAttachments, removeRunSources } from "@/lib/storage";
import { mapDbAttachmentsToParentPayload } from "@/lib/attachments-copy";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

function asJson(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  // Interim grounded-review #3 — replay mutates (insert) and fans out up to 5
  // storage copies + audit inserts per call; throttle it per-IP like the mint
  // route, so it can't be used as a free amplifier.
  const rl = await checkRateLimit(clientIp(request));
  if (!rl.allowed) {
    return Response.json(
      { error: "Rate limit exceeded", detail: `Try again in ${rl.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  // Optional body — `{ selectedProducts?: {...} }`. Tolerate empty/no body
  // so the bare-fetch case still works (current Replay flow before any
  // override UI lands).
  let overrideSelectedProducts: SelectedProducts | undefined;
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const body = JSON.parse(text) as Json;
      if (body && typeof body === "object" && "selectedProducts" in body) {
        const parsed = selectedProductsSchema.safeParse(body.selectedProducts);
        if (!parsed.success) {
          return Response.json(
            {
              error: "Invalid selectedProducts override",
              details: parsed.error.flatten(),
            },
            { status: 400, headers: orgHeaders },
          );
        }
        overrideSelectedProducts = parsed.data;
      }
    }
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: orgHeaders },
    );
  }

  const supabase = getSupabase();

  const { data: parent, error: fetchErr } = await supabase
    .from("research_queue")
    .select(
      // Codex MERGE-gate MINOR — select `id` HERE so the lineage FK comes from
      // this single org-scoped, error-checked query. The prior code re-queried
      // for `id` later and ignored that second query's error, so a transient
      // failure there silently dropped lineage (parent_run_id → null).
      "id, topic, user_context, vendor_evaluation, aji_dna_enabled, selected_products, customizations, notify_email, attachments",
    )
    .eq("topic_slug", slug)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (fetchErr) {
    return Response.json(
      { error: "Failed to fetch parent run", detail: fetchErr.message },
      { status: 500, headers: orgHeaders },
    );
  }
  if (!parent) {
    return Response.json(
      { error: `No queue row found for slug in your org: ${slug}` },
      { status: 404, headers: orgHeaders },
    );
  }

  const ve = asJson(parent.vendor_evaluation);
  const uc = asJson(parent.user_context);
  const cust = asJson(parent.customizations);
  const px = asJson(cust.perplexity);
  const nlm = asJson(cust.notebookLM);

  // If the caller supplied selectedProducts in the body, that wins;
  // otherwise inherit from parent.
  const selectedProducts =
    overrideSelectedProducts ??
    (parent.selected_products as Record<string, boolean>);

  const candidatePayload = {
    topic: parent.topic as string,
    userContext: {
      domainKnowledge: (uc.domainKnowledge as string[]) ?? [],
      constraints: (uc.constraints as string[]) ?? [],
      additionalUrls: (uc.additionalUrls as string[]) ?? [],
      claimsToVerify: (uc.claimsToVerify as string[]) ?? [],
      // MRPF PUBLISH gate (S108 Codex C2): a replay of a publish-bound run
      // must stay publish-bound — omitting this let zod default it to false,
      // silently downgrading the rerun out of the verification gate.
      publishRequired: uc.publishRequired === true,
    },
    vendorEvaluation: {
      enabled: (ve.enabled as boolean) ?? false,
      vendorType: (ve.vendorType as string) ?? "",
      serviceArea: (ve.serviceArea as string) ?? "",
      serviceAddress: (ve.serviceAddress as string) ?? "",
      jobDescription: (ve.jobDescription as string) ?? "",
      maxVendorsDiscovered: (ve.maxVendorsDiscovered as number) ?? 10,
      maxVendorsEnriched: (ve.maxVendorsEnriched as number) ?? 5,
    },
    ajiDnaEnabled: (parent.aji_dna_enabled as boolean) ?? false,
    selectedProducts,
    customizations: {
      perplexity: {
        queryFraming: (px.queryFraming as string) ?? "",
        emphasis: (px.emphasis as string[]) ?? [],
        outputStructure: (px.outputStructure as string) ?? "",
      },
      notebookLM: {
        persona: (nlm.persona as string) ?? "",
        researchMode:
          ((nlm.researchMode as string) === "standard"
            ? "standard"
            : "deep") as "deep" | "standard",
        priorities: (nlm.priorities as string[]) ?? [],
      },
      studio: (cust.studio as Record<string, Record<string, unknown>>) ?? {},
    },
    notifyEmail: (parent.notify_email as string | null) ?? "",
    parentSlug: slug,
    pipelineMode: "full" as const,
    // §3b — carry the parent's attachments forward (origin:"parent"); the
    // verify+copy below moves the bytes into the new run's sources/. Without
    // this, replaying an attachment-bearing run silently drops its files.
    attachments: mapDbAttachmentsToParentPayload(
      parent.attachments as AttachmentMeta[] | null | undefined,
    ),
    attachmentsDraftId: null,
  };

  const parsed = researchJobPayloadSchema.safeParse(candidatePayload);
  if (!parsed.success) {
    return Response.json(
      {
        error:
          "Parent payload no longer validates against current schema; rerun via /new?clone=<slug> and resolve the offending fields manually.",
        details: parsed.error.flatten(),
      },
      { status: 422, headers: orgHeaders },
    );
  }
  const data = parsed.data;

  const newSlug = generateSlug(data.topic);
  const estimate = estimateMinutes(
    data.selectedProducts as SelectedProducts,
    data.vendorEvaluation.enabled,
  );

  // Lineage FK reuses the `id` already fetched (+ org-scoped + error-checked)
  // by the single parent query above (Codex MERGE-gate MINOR).
  const parentRunId = (parent.id as string | null) ?? null;

  // §3b — verify the parent's attachments still exist under its sources/ and
  // copy them into the new run's sources/ BEFORE inserting the row (same
  // submit-time verify+copy the /api/queue route uses). Session-required when
  // attachments are present, mirroring submit. On any failure: no row inserted.
  let verifiedAttachments: AttachmentMeta[] = [];
  if (data.attachments.length > 0) {
    if (source !== "session") {
      return Response.json(
        { error: "Authentication required to replay a run with attachments" },
        { status: 401, headers: orgHeaders },
      );
    }
    const copyResult = await verifyAndCopyAttachments({
      orgId,
      newSlug,
      draftId: null,
      parentSlug: slug,
      items: data.attachments,
      caller: "api/runs/replay",
    });
    if (!copyResult.ok) {
      return Response.json(
        { error: "Attachment processing failed", detail: copyResult.error },
        { status: copyResult.status ?? 500, headers: orgHeaders },
      );
    }
    verifiedAttachments = copyResult.verified ?? [];
  }

  const { data: row, error: insertErr } = await supabase
    .from("research_queue")
    .insert({
      topic: data.topic,
      topic_slug: newSlug,
      organization_id: orgId,
      user_context: data.userContext,
      vendor_evaluation: data.vendorEvaluation,
      aji_dna_enabled: data.ajiDnaEnabled,
      selected_products: data.selectedProducts,
      customizations: data.customizations,
      notify_email: data.notifyEmail || null,
      estimated_minutes: estimate,
      parent_run_id: parentRunId,
      pipeline_mode: "full",
      attachments: verifiedAttachments,
    })
    .select("id, topic_slug, estimated_minutes")
    .single();

  if (insertErr) {
    // Gemini MERGE-gate MAJOR #3 — clean up the copies made above (the new slug
    // is single-use; a failed insert would orphan them under the new run's
    // sources/ permanently).
    if (verifiedAttachments.length > 0) {
      await removeRunSources(orgId, newSlug, verifiedAttachments.map((a) => a.storedName));
    }
    return Response.json(
      { error: "Failed to create replay job", detail: insertErr.message },
      { status: 500, headers: orgHeaders },
    );
  }

  return Response.json(
    {
      id: row.id,
      slug: row.topic_slug,
      estimatedMinutes: row.estimated_minutes,
    },
    { status: 201, headers: orgHeaders },
  );
}
