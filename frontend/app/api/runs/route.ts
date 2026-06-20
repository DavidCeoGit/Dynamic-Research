/**
 * GET /api/runs
 *
 * Returns { runs, hiddenCount, canHide } for every project that contains a
 * state.json in the caller's organization.
 *
 * v4 (S92): ORG-SCOPED hide. The hidden set is fetched for the resolved org via
 * the service-role client, scoped .eq("organization_id", orgId). `canHide` is
 * always true — the dashboard can always hide within its org. `?show_hidden=1`
 * includes hidden runs annotated `hidden: true`.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); an unauthenticated request returns 401.
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

interface RunSummary {
  slug: string;
  topic: string;
  timestamp: string;
  phase: string;
  phase_status: string;
  version: number;
  selectedProducts: Record<string, boolean>;
  vendorEvaluationEnabled: boolean;
  fileCount: number;
  hidden?: boolean;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const showHidden = searchParams.get("show_hidden") === "1";

  const auth = await requireOrgOr401();
  if (!auth.ok) return auth.res;
  const { orgId } = auth;

  let slugs: string[];
  try {
    slugs = await listProjects(orgId);
  } catch (err) {
    return Response.json(
      { error: "Failed to list projects", detail: String(err) },
      { status: 500 },
    );
  }

  // Org-scoped hidden set — fetched via service-role, explicitly scoped to the
  // resolved org (the load-bearing tenant boundary).
  let hiddenSlugs = new Set<string>();
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("user_hidden_runs")
      .select("slug")
      .eq("organization_id", orgId);
    hiddenSlugs = new Set((data ?? []).map((r) => r.slug as string));
  } catch {
    hiddenSlugs = new Set();
  }

  const summaries: RunSummary[] = [];
  let hiddenCount = 0;

  for (const slug of slugs) {
    const isHidden = hiddenSlugs.has(slug);
    if (isHidden) hiddenCount++;
    if (isHidden && !showHidden) continue;

    const stateFilename = await findStateFile(orgId, slug);
    if (!stateFilename) continue;

    try {
      const state = await readStateJson(orgId, slug, stateFilename);
      const files = await listFiles(orgId, slug);

      summaries.push({
        slug,
        topic: (state.topic as string) ?? slug,
        timestamp: (state.timestamp as string) ?? "",
        phase: (state.phase as string) ?? "0",
        phase_status: (state.phase_status as string) ?? "unknown",
        version: (state.version as number) ?? 1,
        selectedProducts:
          (state.selectedProducts as Record<string, boolean>) ?? {},
        vendorEvaluationEnabled:
          (state.vendorEvaluation as Record<string, unknown>)?.enabled === true,
        fileCount: files.length,
        ...(isHidden ? { hidden: true } : {}),
      });
    } catch {
      continue;
    }
  }

  // Most recent first
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return Response.json({ runs: summaries, hiddenCount, canHide: true });
}
