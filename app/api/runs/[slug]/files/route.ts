/**
 * GET /api/runs/[slug]/files
 *
 * Returns the structured file inventory for a project in Supabase Storage.
 * Used by the gallery to populate version dropdowns and file listings.
 */

import { listFiles, projectExists } from "@/lib/storage";
import { buildFileInventoryFromStorage } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const exists = await projectExists(slug);
  if (!exists) {
    return Response.json(
      { error: `Project not found: ${slug}` },
      { status: 404 },
    );
  }

  const files = await listFiles(slug);
  const inventory = buildFileInventoryFromStorage(files);

  return Response.json(inventory);
}
