/**
 * POST   /api/runs/hide   — hide one or more completed runs from the org's view
 * DELETE /api/runs/hide   — unhide (restore to the org's view)
 *
 * v4 (S92): ORG-SCOPED soft hide that works on the env-fallback path (the live
 * dashboard has no session). UI-only, reversible, non-destructive.
 *
 * Invariants (v4 MERGE-gate review, Gemini->Codex):
 *  - Org context via getOrgContextDualPath() (env or session) — the SAME tenant
 *    boundary the dashboard reads use. NOT requireOrgContext() (which would 401
 *    the env path and make hide unusable).
 *  - DB via the service-role client (getSupabase), ALWAYS scoped
 *    .eq("organization_id", orgId). The env path has no auth.uid(), so the RLS/
 *    anon client cannot be used; RLS on the table is enabled with no policies
 *    (service-role-only). Route-level org-scoping is the load-bearing boundary.
 *  - No user_id (table is org-scoped). onConflict "organization_id,slug".
 *  - Rate-limited FIRST (before body parse): 429 + Retry-After + X-RateLimit-Remaining.
 *  - Ownership gate on POST: projectExists(orgId, slug) (storage existence in the org).
 *  - Body validated by parseHideBody (400 on malformed).
 *
 * See Documentation/runs-hide-from-view-env-path-revision.md.
 */
import { getOrgContextDualPath } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { projectExists } from "@/lib/storage";
import { parseHideBody } from "@/lib/hidden-runs";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function rateLimited(request: Request): Promise<Response | null> {
  const rl = await checkRateLimit(clientIp(request));
  if (rl.allowed) return null;
  return Response.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: {
        "Retry-After": String(rl.retryAfterSec),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

async function readSlugs(request: Request): Promise<string[] | Response> {
  try {
    return parseHideBody(await request.json());
  } catch {
    return Response.json(
      { error: "Invalid body: expected { slug } or { slugs: [...] }" },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  const limited = await rateLimited(request);
  if (limited) return limited;

  const { orgId } = await getOrgContextDualPath();

  const slugs = await readSlugs(request);
  if (slugs instanceof Response) return slugs;

  const supabase = getSupabase();
  const hidden: string[] = [];
  const skipped: { slug: string; reason: string }[] = [];

  for (const slug of slugs) {
    // Ownership gate: the run must exist in the resolved org's storage prefix.
    let exists = false;
    try {
      exists = await projectExists(orgId, slug);
    } catch {
      exists = false;
    }
    if (!exists) {
      skipped.push({ slug, reason: "not_found_in_org" });
      continue;
    }

    const { error } = await supabase.from("user_hidden_runs").upsert(
      { organization_id: orgId, slug },
      { onConflict: "organization_id,slug", ignoreDuplicates: true },
    );
    if (error) {
      skipped.push({ slug, reason: "db_error" });
      continue;
    }
    hidden.push(slug);
  }

  return Response.json({ hidden, skipped });
}

export async function DELETE(request: Request) {
  const limited = await rateLimited(request);
  if (limited) return limited;

  const { orgId } = await getOrgContextDualPath();

  const slugs = await readSlugs(request);
  if (slugs instanceof Response) return slugs;

  const supabase = getSupabase();
  const { error } = await supabase
    .from("user_hidden_runs")
    .delete()
    .eq("organization_id", orgId)
    .in("slug", slugs);

  if (error) {
    return Response.json(
      { error: "Failed to unhide", detail: error.message },
      { status: 500 },
    );
  }
  return Response.json({ unhidden: slugs });
}
