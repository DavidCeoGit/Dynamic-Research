/**
 * GET /api/state
 *
 * Returns the most recent state.json from any project in Supabase Storage.
 * This is the endpoint polled by the useRunState() SWR hook every 5s.
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  let slugs: string[];
  try {
    slugs = await listProjects();
  } catch (err) {
    return Response.json(
      { error: "Failed to list projects", detail: String(err) },
      { status: 500 },
    );
  }

  if (slugs.length === 0) {
    return Response.json(
      { error: "No projects found in storage" },
      { status: 404 },
    );
  }

  // ── Find the most recent state.json across all projects ─────
  let newestSlug: string | null = null;
  let newestFilename: string | null = null;
  let newestCreatedAt = "";

  for (const slug of slugs) {
    const stateFilename = await findStateFile(slug);
    if (!stateFilename) continue;

    // Use created_at from storage metadata to find the newest
    const files = await listFiles(slug);
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

  // ── Read and return ─────────────────────────────────────────
  try {
    const state = await readStateJson(newestSlug, newestFilename);
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: "Failed to read state.json", detail: String(err) },
      { status: 500 },
    );
  }
}
