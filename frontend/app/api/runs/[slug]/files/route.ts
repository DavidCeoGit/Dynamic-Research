/**
 * GET /api/runs/[slug]/files
 *
 * Returns the structured file inventory for a project in Supabase Storage.
 * Used by the gallery to populate version dropdowns and file listings.
 *
 * S56 Phase 2 — replaces resolveOrgForSlug stopgap with session-or-env
 * orgId from getOrgContextDualPath(). Cross-tenant isolation is the storage
 * path prefix <orgId>/<slug>/ in projectExists + listFiles — a user with
 * org-A's session/env can never resolve a path under org-B/. No
 * research_queue DB check (Gemini F1, S56).
 */

import { listFiles, projectExists } from "@/lib/storage";
import { buildFileInventoryFromStorage } from "@/lib/files";
import { getOrgContextDualPath } from "@/lib/auth";

export const dynamic = "force-dynamic";

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
      { error: `Project not found: ${slug}` },
      { status: 404, headers: orgHeaders },
    );
  }

  const files = await listFiles(orgId, slug);
  const inventory = buildFileInventoryFromStorage(files);

  return Response.json(inventory, { headers: orgHeaders });
}
