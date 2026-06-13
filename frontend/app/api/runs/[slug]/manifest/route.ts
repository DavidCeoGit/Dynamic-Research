/**
 * GET /api/runs/[slug]/manifest
 *
 * S35 Clone & Edit — returns the form-shaped payload for a run so the
 * new-research wizard can pre-fill from `?clone=<slug>`. Sourced from the
 * project's state.json with runtime-only fields (vendorsDiscovered, file
 * paths, phase tracking, extracted-context cache) stripped out.
 *
 * Output matches `researchJobPayloadSchema` so the frontend can do
 * `form.reset(manifest)` in one call without remapping.
 *
 * S56 Phase 2 — replaces resolveOrgForSlug stopgap with session-or-env
 * orgId from getOrgContextDualPath(). Cross-tenant isolation is the
 * storage path prefix <orgId>/<slug>/ in projectExists + findStateFile +
 * readStateJson — a user with org-A's session/env can never resolve a
 * path under org-B/. No research_queue DB check (Gemini F1, S56 — that
 * check would have blocked legacy runs whose queue row was deleted but
 * storage remained).
 */

import {
  findStateFile,
  readStateJson,
  projectExists,
} from "@/lib/storage";
import { getOrgContextDualPath } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { resolveClonePublishRequired } from "@/lib/publish-flag";
import type { AttachmentMeta } from "@/lib/types/queue";

export const dynamic = "force-dynamic";

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
  // Sourced from the research_queue row (not state.json), org-scoped. [] when
  // the parent has none / is a pre-S102 row.
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

  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  const exists = await projectExists(orgId, slug);
  if (!exists) {
    return Response.json(
      { error: `Run not found: ${slug}` },
      { status: 404, headers: orgHeaders },
    );
  }

  const stateFilename = await findStateFile(orgId, slug);
  if (!stateFilename) {
    return Response.json(
      { error: `No state.json found for run: ${slug}` },
      { status: 404, headers: orgHeaders },
    );
  }

  let state: Record<string, unknown>;
  try {
    state = await readStateJson(orgId, slug, stateFilename);
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500, headers: orgHeaders },
    );
  }

  // S102 file-upload — attachments are NOT in state.json; they live on the
  // research_queue row. Read them org-scoped (the `.eq("organization_id")` is
  // the cross-tenant boundary, matching plan-review/route.ts + replay/route.ts).
  // Defaults to [] when the column is null/absent or the row is gone (legacy
  // storage-only run) — never fails the manifest just because attachments
  // couldn't be loaded.
  // Gemini MERGE-gate BLOCKING #2 — distinguish "no queue row" (legacy
  // storage-only run → [] is correct, must still clone) from "DB query errored"
  // (transient → must NOT silently drop the parent's attachments, which would
  // permanently truncate the clone). .maybeSingle() returns error:null + data:
  // null when the row is simply absent, so a populated error is a genuine
  // failure → fail closed with 500 rather than returning [].
  // S120 Defect C — also select user_context here: it is the AUTHORITATIVE
  // durable publishRequired source (set at submit), and the worker never echoes
  // publishRequired into state.json's userContext. The S118 fix read
  // state.userContext.publishRequired (never written) → a no-op that silently
  // downgraded every clone of a publish parent out of the gate. The clone
  // prefill (below) ORs this DB source with the state flags via the canonical
  // predicate. .maybeSingle() returns data:null for legacy storage-only runs
  // with no queue row — handled by the OR (state flag carries those).
  let attachments: AttachmentMeta[] = [];
  let attachRowUserContext: { publishRequired?: unknown } | null = null;
  const supabase = getSupabase();
  const { data: attachRow, error: attachErr } = await supabase
    .from("research_queue")
    .select("attachments, user_context")
    .eq("topic_slug", slug)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (attachErr) {
    return Response.json(
      { error: "Failed to read attachments", detail: attachErr.message },
      { status: 500, headers: orgHeaders },
    );
  }
  attachments = (attachRow?.attachments as AttachmentMeta[] | null) ?? [];
  attachRowUserContext =
    (attachRow?.user_context as { publishRequired?: unknown } | null | undefined) ?? null;

  // Strip runtime-only fields. The form ingests userContext sans contextFilePath
  // + localSourcePath; vendorEvaluation sans vendorsDiscovered/Shortlisted/Excluded
  // + preScreeningComplete. Per-product customizations + notebookLM/perplexity
  // shapes pass through as-is.
  const uc = (state.userContext as Record<string, unknown>) ?? {};
  const ve = (state.vendorEvaluation as Record<string, unknown>) ?? {};
  const cust = (state.customizations as Record<string, unknown>) ?? {};
  const sp = (state.selectedProducts as Record<string, unknown>) ?? {};
  const px = (cust.perplexity as Record<string, unknown>) ?? {};
  const nlm = (cust.notebookLM as Record<string, unknown>) ?? {};

  const manifest: ManifestResponse = {
    topic: (state.topic as string) ?? "",
    userContext: {
      domainKnowledge: (uc.domainKnowledge as string[]) ?? [],
      constraints: (uc.constraints as string[]) ?? [],
      additionalUrls: (uc.additionalUrls as string[]) ?? [],
      claimsToVerify: (uc.claimsToVerify as string[]) ?? [],
      // MRPF PUBLISH gate (S118 Codex MERGE-gate HIGH; S120 Defect C fix): a
      // Clone & Edit of a publish-bound parent must default the new run's
      // checkbox CHECKED, not drop it. The S118 fix read only
      // state.userContext.publishRequired — which the worker NEVER writes — a
      // no-op that silently downgraded every clone (confirmed live, job
      // 97906d8c). The fix ORs every available source through the canonical
      // strict predicate: the authoritative DB user_context (covers normal
      // runs + the exact 97906d8c shape), the top-level state flag (covers
      // legacy storage-only runs with no queue row), and the legacy state echo.
      // Stays user-EDITABLE (default, not sticky) — a clone for internal
      // follow-up can still uncheck it.
      publishRequired: resolveClonePublishRequired({
        queueRowUserContext: attachRowUserContext,
        statePublishRequired: state.publish_required,
        stateUserContextPublishRequired: uc.publishRequired,
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
    // aji_dna_enabled is snake_case in state.json (worker pipeline) but ajiDnaEnabled
    // in the form schema. Map here.
    ajiDnaEnabled:
      (state.aji_dna_enabled as boolean | undefined) ??
      (state.ajiDnaEnabled as boolean | undefined) ??
      false,
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
    notifyEmail: "",
    attachments,
    parentSlug: slug,
    parentTopic: (state.topic as string) ?? "",
  };

  return Response.json(manifest, { headers: orgHeaders });
}
