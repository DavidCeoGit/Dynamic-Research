/**
 * GET /api/state
 * GET /api/state?slug=<project-slug>
 *
 * Without slug: returns the most recent state.json across all projects in the
 * caller's org. With slug: returns state.json for the specified project.
 *
 * S29 hotfix: normalize the state so missing nested fields don't throw.
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); an unauthenticated request returns 401.
 *
 * S92 v4 org-scoped hide: the no-slug "latest across all projects" path skips
 * runs hidden for the resolved org, fetched via service-role scoped to the org —
 * so a hidden newest run does not leak into the dashboard summary. The WITH-slug
 * direct-link path is deliberately NOT filtered.
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";
import { requireOrgOr401 } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

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

/**
 * S187 P0-2 (Branch (c)) — fetch the studio-recovery dimension for a run from
 * research_queue. These are DB columns (NOT part of state.json), so the results
 * page can only see studio_recovery_video_deferred if /api/state merges them in
 * (design G12/M-9: the results page reads /api/state). Keyed by topic_slug +
 * org — the SAME lookup as /api/runs/[slug]/plan-review. Best-effort: any DB
 * error, or no matching row (legacy storage-only runs have no queue row — S41),
 * yields {} so a missing recovery row never blocks the state response. orgId is
 * session-derived (never request-supplied), so this cannot read across orgs.
 */
async function fetchRecoveryFields(
  orgId: string,
  slug: string,
): Promise<{
  studio_recovery_video_deferred?: boolean;
  studio_recovery_status?: string;
}> {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("research_queue")
      .select("studio_recovery_video_deferred, studio_recovery_status")
      .eq("topic_slug", slug)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!data) return {};
    const out: {
      studio_recovery_video_deferred?: boolean;
      studio_recovery_status?: string;
    } = {};
    if (typeof data.studio_recovery_video_deferred === "boolean") {
      out.studio_recovery_video_deferred = data.studio_recovery_video_deferred;
    }
    if (typeof data.studio_recovery_status === "string") {
      out.studio_recovery_status = data.studio_recovery_status;
    }
    return out;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slugParam = searchParams.get("slug");

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  // ── Slug-specific lookup (NOT hide-filtered — direct access by URL) ──
  if (slugParam) {
    const stateFilename = await findStateFile(orgId, slugParam);
    if (!stateFilename) {
      return Response.json(
        { error: `No state.json found for project: ${slugParam}` },
        { status: 404 },
      );
    }
    try {
      const state = await readStateJson(orgId, slugParam, stateFilename);
      const recovery = await fetchRecoveryFields(orgId, slugParam);
      return Response.json({ ...normalizeState(state as StateLike), ...recovery });
    } catch (err) {
      return Response.json(
        { error: "Failed to read state.json", detail: String(err) },
        { status: 500 },
      );
    }
  }

  // ── Latest across all projects (hide-filtered, org-scoped) ────────
  let slugs: string[];
  try {
    slugs = await listProjects(orgId);
  } catch (err) {
    return Response.json(
      { error: "Failed to list projects", detail: String(err) },
      { status: 500 },
    );
  }

  // Exclude runs hidden for this org so a hidden newest run does not surface in
  // the dashboard summary. Service-role, org-scoped.
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("user_hidden_runs")
      .select("slug")
      .eq("organization_id", orgId);
    const hiddenSlugs = new Set((data ?? []).map((r) => r.slug as string));
    slugs = slugs.filter((s) => !hiddenSlugs.has(s));
  } catch {
    // best-effort: on a hidden-set read failure, fall back to unfiltered
  }

  if (slugs.length === 0) {
    return Response.json(
      { error: "No projects found in storage" },
      { status: 404 },
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
      { status: 404 },
    );
  }

  try {
    const state = await readStateJson(orgId, newestSlug, newestFilename);
    const recovery = await fetchRecoveryFields(orgId, newestSlug);
    return Response.json({ ...normalizeState(state as StateLike), ...recovery });
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500 },
    );
  }
}
