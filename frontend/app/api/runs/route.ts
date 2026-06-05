/**
 * GET /api/runs
 *
 * Returns { runs, hiddenCount, auth } for every project that contains a
 * state.json in the caller's organization. Used by the dashboard index.
 *
 * Envelope (was a bare RunSummary[]) so the UI can render "N hidden — Show
 * hidden" and auth-gate the hide controls from the body (Codex MAJOR-C/MINOR-D).
 *
 * Per-user hide (S92): runs the caller has hidden are excluded by default;
 * `?show_hidden=1` includes them annotated `hidden: true`. The hidden set is
 * read via the RLS-respecting anon+cookie client; only a real session
 * (source === "session") has one — env-fallback behaves exactly as before.
 *
 * S56 Phase 2 — org resolution via per-request getOrgContextDualPath().
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";
import { getOrgContextDualPath } from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";

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

  const { orgId, source } = await getOrgContextDualPath();
  const auth = source === "session";
  const orgHeaders = { "X-Org-Source": source };

  let slugs: string[];
  try {
    slugs = await listProjects(orgId);
  } catch (err) {
    return Response.json(
      { error: "Failed to list projects", detail: String(err) },
      { status: 500, headers: orgHeaders },
    );
  }

  // Hidden-slug set — only a real session has one. RLS scopes the SELECT to
  // auth.uid() + the caller's org, so this returns just this user's rows.
  let hiddenSlugs = new Set<string>();
  if (auth) {
    try {
      const supabase = await createServerSupabase();
      const { data } = await supabase.from("user_hidden_runs").select("slug");
      hiddenSlugs = new Set((data ?? []).map((r) => r.slug as string));
    } catch {
      hiddenSlugs = new Set();
    }
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

  return Response.json(
    { runs: summaries, hiddenCount, auth },
    { headers: orgHeaders },
  );
}
