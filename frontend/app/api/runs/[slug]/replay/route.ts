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
import type { SelectedProducts } from "@/lib/types/queue";
import { getOrgContextDualPath } from "@/lib/auth";

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
      "topic, user_context, vendor_evaluation, aji_dna_enabled, selected_products, customizations, notify_email",
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

  const { data: parentRow } = await supabase
    .from("research_queue")
    .select("id")
    .eq("topic_slug", slug)
    .eq("organization_id", orgId)
    .maybeSingle();
  const parentRunId = parentRow?.id ?? null;

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
    })
    .select("id, topic_slug, estimated_minutes")
    .single();

  if (insertErr) {
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
