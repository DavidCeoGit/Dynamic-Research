/**
 * POST   /api/runs/hide   — hide one or more completed runs from MY view
 * DELETE /api/runs/hide   — unhide (restore to MY view)
 *
 * Per-user SOFT hide (S92). UI-only: never deletes DB/storage data.
 *
 * Implementation invariants (from the MERGE-gate review):
 *  - DB writes use the RLS-respecting anon+cookie client (createServerSupabase),
 *    NEVER the service-role getSupabase() which bypasses RLS (Codex MAJOR-A).
 *  - Auth via requireOrgContext() directly (401 no-session / 403 no-membership),
 *    NOT getOrgContextDualPath() which env-falls-back on no-membership (Codex MAJOR-B).
 *  - Ownership gate = storage existence under the caller's own org prefix
 *    (projectExists), NOT a research_queue lookup which misses storage-only
 *    legacy runs (Gemini MAJOR-1). projectExists also confines existence
 *    inference to the caller's own org.
 *  - Body validated by a shared zod schema so malformed slugs 400 (not 500).
 *
 * See Documentation/runs-hide-from-view-design-gate.md.
 */
import {
  requireOrgContext,
  UnauthorizedError,
  ForbiddenError,
  type OrgContext,
} from "@/lib/auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { projectExists } from "@/lib/storage";
import { parseHideBody } from "@/lib/hidden-runs";

export const dynamic = "force-dynamic";

/** Resolve the org context, or return a 401/403 Response for the caller to return. */
async function resolveContext(): Promise<OrgContext | Response> {
  try {
    return await requireOrgContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: "Not signed in" }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return Response.json(
        { error: "No organization membership" },
        { status: 403 },
      );
    }
    throw err; // genuine failure → 500 via the framework
  }
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
  const ctx = await resolveContext();
  if (ctx instanceof Response) return ctx;
  const { user, orgId } = ctx;

  const slugs = await readSlugs(request);
  if (slugs instanceof Response) return slugs;

  const supabase = await createServerSupabase();
  const hidden: string[] = [];
  const skipped: { slug: string; reason: string }[] = [];

  for (const slug of slugs) {
    // Ownership gate: the run must exist in the caller's OWN storage prefix.
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
      { user_id: user.id, organization_id: orgId, slug },
      { onConflict: "user_id,organization_id,slug", ignoreDuplicates: true },
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
  const ctx = await resolveContext();
  if (ctx instanceof Response) return ctx;
  const { user, orgId } = ctx;

  const slugs = await readSlugs(request);
  if (slugs instanceof Response) return slugs;

  // No projectExists gate on unhide — RLS already restricts the delete to the
  // caller's own rows, and allowing it even when the run no longer exists in
  // storage lets a user clean up orphaned hidden rows.
  const supabase = await createServerSupabase();
  const { error } = await supabase
    .from("user_hidden_runs")
    .delete()
    .eq("user_id", user.id)
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
