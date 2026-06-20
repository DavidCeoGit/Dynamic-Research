/**
 * GET /api/runs/[slug]/files
 *
 * Returns the structured file inventory for a project in Supabase Storage.
 * Used by the gallery to populate version dropdowns and file listings.
 *
 * S146 Phase 4 — org resolved from the SESSION via requireOrgOr401() (the
 * Phase-2 env fallback is retired); unauthenticated → 401. Cross-tenant
 * isolation is the storage path prefix <orgId>/<slug>/ in projectExists +
 * listFiles — a user with org-A's session can never resolve a path under
 * org-B/. No research_queue DB check (Gemini F1, S56).
 */

import { listFiles, projectExists } from "@/lib/storage";
import { buildFileInventoryFromStorage } from "@/lib/files";
import { requireOrgOr401 } from "@/lib/auth";

export const dynamic = "force-dynamic";

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
    return Response.json(
      { error: `Project not found: ${slug}` },
      { status: 404 },
    );
  }

  const files = await listFiles(orgId, slug);
  const inventory = buildFileInventoryFromStorage(files);

  return Response.json(inventory);
}
