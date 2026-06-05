/**
 * GET /api/state
 * GET /api/state?slug=<project-slug>
 *
 * Without slug: returns the most recent state.json across all projects
 * in the caller's org.
 * With slug: returns state.json for the specified project, scoped to the
 * caller's org via the storage-path prefix (<orgId>/<slug>/).
 *
 * S29 hotfix: normalize the state so missing nested fields don't throw
 * "Cannot convert undefined or null to object" downstream. Recovered /
 * legacy runs (e.g., cam AI run u9el closed by finalize-recovered-run.ts
 * in S28) write state.json without selectedProducts / artifacts /
 * customizations / userContext top-level keys. Filling defaults at the
 * API boundary keeps every downstream consumer safe without scattering
 * null guards.
 *
 * S56 Phase 2 — org resolution moves from module-const SYSTEM_DEFAULT_ORG_ID +
 * resolveOrgForSlug() to per-request getOrgContextDualPath(). The cross-org
 * data boundary is the storage path prefix <orgId>/<slug>/ in
 * scopedStoragePath(); a user with org-A's session/env can only resolve
 * paths under <orgA>/, so they cannot read org-B's files (Gemini F1, S56).
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";
import { getOrgContextDualPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

type StateLike = Record<string, unknown>;

function obj(v: unknown): StateLike {
  return v && typeof v === "object" ? (v as StateLike) : {};
}

function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function normalizeState(raw: StateLike): StateLike {
  const userContext = obj(raw.userContext);
  const customizations = obj(raw.customizations);
  const perplexity = obj(customizations.perplexity);
  const notebookLM = obj(customizations.notebookLM);
  const vendorEvaluation = obj(raw.vendorEvaluation);

  return {
    ...raw,
    userContext: {
      contextFilePath: userContext.contextFilePath ?? null,
      additionalUrls: arr<string>(userContext.additionalUrls),
      claimsToVerify: arr<string>(userContext.claimsToVerify),
      domainKnowledge: arr<string>(userContext.domainKnowledge),
      constraints: arr<string>(userContext.constraints),
      localSourcePath: userContext.localSourcePath ?? null,
    },
    selectedProducts: obj(raw.selectedProducts),
    customizations: {
      perplexity: {
        queryFraming: (perplexity.queryFraming as string) ?? "",
        emphasis: arr<string>(perplexity.emphasis),
        outputStructure: (perplexity.outputStructure as string) ?? "",
      },
      notebookLM: {
        persona: (notebookLM.persona as string) ?? "",
        researchMode: (notebookLM.researchMode as string) ?? "deep",
        priorities: arr<string>(notebookLM.priorities),
      },
      studio: obj(customizations.studio),
    },
    vendorEvaluation: {
      enabled: vendorEvaluation.enabled ?? false,
      vendorType: (vendorEvaluation.vendorType as string) ?? "",
      serviceArea: (vendorEvaluation.serviceArea as string) ?? "",
      serviceAddress: (vendorEvaluation.serviceAddress as string) ?? "",
      jobDescription: (vendorEvaluation.jobDescription as string) ?? "",
      maxVendorsDiscovered: (vendorEvaluation.maxVendorsDiscovered as number) ?? 10,
      maxVendorsEnriched: (vendorEvaluation.maxVendorsEnriched as number) ?? 5,
      vendorsDiscovered: arr<string>(vendorEvaluation.vendorsDiscovered),
      vendorsShortlisted: arr<string>(vendorEvaluation.vendorsShortlisted),
      vendorsExcluded: arr<string>(vendorEvaluation.vendorsExcluded),
      preScreeningComplete: vendorEvaluation.preScreeningComplete ?? false,
    },
    artifacts: obj(raw.artifacts),
    files_written: arr<string>(raw.files_written),
    perplexity_source_urls_passed: arr<string>(raw.perplexity_source_urls_passed),
    perplexity_source_urls_rejected: arr<string>(raw.perplexity_source_urls_rejected),
    tier1_scores: obj(raw.tier1_scores),
    queued_urls_for_notebooklm: arr<string>(raw.queued_urls_for_notebooklm),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slugParam = searchParams.get("slug");

  const { orgId, source } = await getOrgContextDualPath();
  const orgHeaders = { "X-Org-Source": source };

  // ── Slug-specific lookup ──────────────────────────────────────
  if (slugParam) {
    // Cross-tenant isolation here is the storage path prefix:
    // findStateFile/listFiles/readStateJson all go through
    // scopedStoragePath(orgId, slug) → `<orgId>/<slug>/...`. A user with
    // org-A's session/env can never resolve a path under org-B/, so a slug
    // owned by another org returns null from findStateFile and 404s below.
    // No research_queue DB check needed (Gemini F1, S56 — that check would
    // have blocked legacy runs whose queue row was deleted but storage
    // remained).
    const stateFilename = await findStateFile(orgId, slugParam);
    if (!stateFilename) {
      return Response.json(
        { error: `No state.json found for project: ${slugParam}` },
        { status: 404, headers: orgHeaders },
      );
    }
    try {
      const state = await readStateJson(orgId, slugParam, stateFilename);
      return Response.json(normalizeState(state as StateLike), { headers: orgHeaders });
    } catch (err) {
      return Response.json(
        { error: "Failed to read state.json", detail: String(err) },
        { status: 500, headers: orgHeaders },
      );
    }
  }

  // ── Latest across all projects ────────────────────────────────
  let slugs: string[];
  try {
    slugs = await listProjects(orgId);
  } catch (err) {
    return Response.json(
      { error: "Failed to list projects", detail: String(err) },
      { status: 500, headers: orgHeaders },
    );
  }

  if (slugs.length === 0) {
    return Response.json(
      { error: "No projects found in storage" },
      { status: 404, headers: orgHeaders },
    );
  }

  let newestSlug: string | null = null;
  let newestFilename: string | null = null;
  let newestCreatedAt = "";

  for (const slug of slugs) {
    const stateFilename = await findStateFile(orgId, slug);
    if (!stateFilename) continue;

    const files = await listFiles(orgId, slug);
    const stateEntry = files.find((f) => f.name === stateFilename);
    const createdAt = stateEntry?.created_at ?? "";

    if (createdAt > newestCreatedAt) {
      newestCreatedAt = createdAt;
      newestSlug = slug;
      newestFilename = stateFilename;
    }
  }

  if (!newestSlug || !newestFilename) {
    return Response.json(
      { error: "No state.json found in any project" },
      { status: 404, headers: orgHeaders },
    );
  }

  try {
    const state = await readStateJson(orgId, newestSlug, newestFilename);
    return Response.json(normalizeState(state as StateLike), { headers: orgHeaders });
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500, headers: orgHeaders },
    );
  }
}
