/**
 * GET /api/runs/[slug]/manifest
 *
 * S35 Clone & Edit — returns the form-shaped payload for a run so the
 * new-research wizard can pre-fill from `?clone=<slug>`.
 *
 * S133 prefill fix — the form fields (topic, userContext.*, customizations.*,
 * selectedProducts, vendorEvaluation, ajiDnaEnabled) are sourced from the
 * **research_queue row** (the authoritative, form-shaped record the submit
 * route wrote), NOT state.json. The worker's state.json stores only a SHORT
 * 52-char title in `topic` and OMITS userContext/customizations entirely. For
 * legacy storage-only runs whose queue row was deleted (storage remains), we
 * FALL BACK to state.json per-field.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); unauthenticated → 401. Cross-tenant
 * isolation is the storage path prefix <orgId>/<slug>/ in projectExists +
 * findStateFile + readStateJson, AND the .eq("organization_id", orgId) tenant
 * boundary on the research_queue read below.
 */

import {
  findStateFile,
  readStateJson,
  projectExists,
} from "@/lib/storage";
import { requireOrgOr401 } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { resolveClonePublishRequired } from "@/lib/publish-flag";
import type { AttachmentMeta } from "@/lib/types/queue";

export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

// Mirror replay/route.ts: coerce a JSONB column / nested value to a plain
// object, never throwing on null / array / scalar.
function asJson(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

interface ManifestResponse {
  topic: string;
  userContext: {
    domainKnowledge: string[];
    constraints: string[];
    additionalUrls: string[];
    claimsToVerify: string[];
    publishRequired: boolean;
  };
  vendorEvaluation: {
    enabled: boolean;
    vendorType: string;
    serviceArea: string;
    serviceAddress: string;
    jobDescription: string;
    maxVendorsDiscovered: number;
    maxVendorsEnriched: number;
  };
  ajiDnaEnabled: boolean;
  selectedProducts: {
    audio: boolean;
    video: boolean;
    slides: boolean;
    report: boolean;
    infographic: boolean;
  };
  customizations: {
    perplexity: { queryFraming: string; emphasis: string[]; outputStructure: string };
    notebookLM: { persona: string; researchMode: "deep" | "standard"; priorities: string[] };
    studio: Record<string, Record<string, unknown>>;
  };
  notifyEmail: string;
  // S102 file-upload — the parent run's stored attachments (plain
  // AttachmentMeta, origin stripped). Clone & Edit re-tags these origin:"parent"
  // so the submit route copies their bytes from the parent's sources/ folder.
  // Sourced from the research_queue row, org-scoped. [] when the parent has
  // none / is a pre-S102 row / is a legacy storage-only run.
  attachments: AttachmentMeta[];
  // Lineage — the slug being cloned. Form re-sends this as parentSlug on submit.
  parentSlug: string;
  parentTopic: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  const exists = await projectExists(orgId, slug);
  if (!exists) {
    return Response.json({ error: `Run not found: ${slug}` }, { status: 404 });
  }

  const stateFilename = await findStateFile(orgId, slug);
  if (!stateFilename) {
    return Response.json(
      { error: `No state.json found for run: ${slug}` },
      { status: 404 },
    );
  }

  let state: Record<string, unknown>;
  try {
    state = await readStateJson(orgId, slug, stateFilename);
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500 },
    );
  }

  // The AUTHORITATIVE, form-shaped prompt lives on the research_queue row, not
  // state.json. Read it org-scoped (the `.eq("organization_id")` is the
  // cross-tenant boundary, matching replay/route.ts). This SAME row also
  // carries the parent's attachments (S102) and the durable publishRequired
  // (S120). Defaults / fallback-to-state.json apply when the row is absent —
  // a legacy storage-only run (queue row deleted, storage remains).
  //
  // Gemini MERGE-gate BLOCKING #2 (S56) — distinguish "no queue row" (legacy
  // storage-only run → fall back to state.json, must still clone) from "DB query
  // errored" (transient → must NOT silently drop the parent's real prompt /
  // attachments). .maybeSingle() returns error:null + data:null when the row is
  // simply absent, so a populated error is a genuine failure → fail closed 500.
  const supabase = getSupabase();
  const { data: queueRow, error: rowErr } = await supabase
    .from("research_queue")
    .select(
      "attachments, user_context, topic, customizations, selected_products, vendor_evaluation, aji_dna_enabled",
    )
    .eq("topic_slug", slug)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (rowErr) {
    return Response.json(
      { error: "Failed to read run row", detail: rowErr.message },
      { status: 500 },
    );
  }
  const attachments: AttachmentMeta[] =
    (queueRow?.attachments as AttachmentMeta[] | null) ?? [];

  // Source the form fields from the DB row when present; fall back to state.json
  // per-field for legacy storage-only runs (row absent). State.json keeps a
  // separate ref because publishRequired ORs the DB + state + legacy echo
  // sources via the canonical predicate (do not collapse them).
  const hasRow = queueRow != null;
  const ucState = (state.userContext as Record<string, unknown>) ?? {};

  // Prefer the authoritative row topic, but fall back to state.json's
  // (truncated but non-empty) title when the row's topic is null/empty —
  // a present-but-empty row field must NOT shadow a usable state title
  // (Gemini S144 CRITICAL). `||` selects the first non-empty string; both
  // empty → "" (same as the prior per-branch behavior). parentTopic derives
  // from this same `topic`, so lineage stays consistent.
  const stateTopic = (state.topic as string | null) ?? "";
  const rowTopic = hasRow ? ((queueRow.topic as string | null) ?? "") : "";
  const topic = rowTopic || stateTopic;
  const uc = hasRow
    ? asJson(queueRow.user_context)
    : ucState;
  const ve = hasRow
    ? asJson(queueRow.vendor_evaluation)
    : ((state.vendorEvaluation as Record<string, unknown>) ?? {});
  const cust = hasRow
    ? asJson(queueRow.customizations)
    : ((state.customizations as Record<string, unknown>) ?? {});
  const sp = hasRow
    ? asJson(queueRow.selected_products)
    : ((state.selectedProducts as Record<string, unknown>) ?? {});
  const px = asJson(cust.perplexity);
  const nlm = asJson(cust.notebookLM);

  const manifest: ManifestResponse = {
    topic,
    userContext: {
      domainKnowledge: (uc.domainKnowledge as string[]) ?? [],
      constraints: (uc.constraints as string[]) ?? [],
      additionalUrls: (uc.additionalUrls as string[]) ?? [],
      claimsToVerify: (uc.claimsToVerify as string[]) ?? [],
      // MRPF PUBLISH gate (S118 Codex HIGH; S120 Defect C): a Clone & Edit of a
      // publish-bound parent must default the new run's checkbox CHECKED, not
      // drop it. Route every available source through the canonical strict
      // predicate: the authoritative DB user_context (queueRow.user_context),
      // the top-level state flag (legacy storage-only runs, no queue row), and
      // the legacy state.userContext echo. Stays user-EDITABLE (default, not
      // sticky). Uses the STATE userContext for the echo arg, not the merged
      // `uc`, so DB-vs-state sources stay independent in the OR.
      publishRequired: resolveClonePublishRequired({
        queueRowUserContext:
          (queueRow?.user_context as { publishRequired?: unknown } | null | undefined) ?? null,
        statePublishRequired: state.publish_required,
        stateUserContextPublishRequired: ucState.publishRequired,
      }),
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
    // aji_dna_enabled is snake_case on the DB row + in state.json (worker
    // pipeline) but ajiDnaEnabled in the form schema. Map here.
    ajiDnaEnabled: hasRow
      ? !!(queueRow.aji_dna_enabled as boolean | undefined)
      : (((state.aji_dna_enabled as boolean | undefined) ??
          (state.ajiDnaEnabled as boolean | undefined)) ??
        false),
    selectedProducts: {
      audio: !!sp.audio,
      video: !!sp.video,
      slides: !!sp.slides,
      report: !!sp.report,
      infographic: !!sp.infographic,
    },
    customizations: {
      perplexity: {
        queryFraming: (px.queryFraming as string) ?? "",
        emphasis: (px.emphasis as string[]) ?? [],
        outputStructure: (px.outputStructure as string) ?? "",
      },
      notebookLM: {
        persona: (nlm.persona as string) ?? "",
        researchMode:
          ((nlm.researchMode as string) === "standard" ? "standard" : "deep") as
            | "deep"
            | "standard",
        priorities: (nlm.priorities as string[]) ?? [],
      },
      studio: (cust.studio as Record<string, Record<string, unknown>>) ?? {},
    },
    // notifyEmail intentionally left blank — not part of the prompt-edit prefill,
    // and leaving the email out of the manifest response avoids exposing it.
    notifyEmail: "",
    attachments,
    parentSlug: slug,
    parentTopic: topic,
  };

  return Response.json(manifest);
}
