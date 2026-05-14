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
 * Auth NOTE: currently unauthenticated (matches the rest of /api/runs/*).
 * Phase A multi-tenancy MUST add org-aware auth here — without it, slug
 * guesses can read any run's manifest cross-tenant. Acceptance criterion:
 * 401 if no session, 404 if session has no membership in the run's org.
 */

import { findStateFile, readStateJson, projectExists } from "@/lib/storage";

export const dynamic = "force-dynamic";

interface ManifestResponse {
  topic: string;
  userContext: {
    domainKnowledge: string[];
    constraints: string[];
    additionalUrls: string[];
    claimsToVerify: string[];
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
  // Lineage — the slug being cloned. Form re-sends this as parentSlug on submit.
  parentSlug: string;
  parentTopic: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const exists = await projectExists(slug);
  if (!exists) {
    return Response.json({ error: `Run not found: ${slug}` }, { status: 404 });
  }

  const stateFilename = await findStateFile(slug);
  if (!stateFilename) {
    return Response.json(
      { error: `No state.json found for run: ${slug}` },
      { status: 404 },
    );
  }

  let state: Record<string, unknown>;
  try {
    state = await readStateJson(slug, stateFilename);
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500 },
    );
  }

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
    parentSlug: slug,
    parentTopic: (state.topic as string) ?? "",
  };

  return Response.json(manifest);
}
