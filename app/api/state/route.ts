/**
 * GET /api/state
 * GET /api/state?slug=<project-slug>
 *
 * Without slug: returns the most recent state.json across all projects.
 * With slug: returns state.json for the specified project.
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slugParam = searchParams.get("slug");

  // ── Slug-specific lookup ──────────────────────────────────────
  if (slugParam) {
    const stateFilename = await findStateFile(slugParam);
    if (!stateFilename) {
      return Response.json(
        { error: `No state.json found for project: ${slugParam}` },
        { status: 404 },
      );
    }
    try {
      const state = await readStateJson(slugParam, stateFilename);
      return Response.json(state);
    } catch (err) {
      return Response.json(
        { error: "Failed to read state.json", detail: String(err) },
        { status: 500 },
      );
    }
  }

  // ── Latest across all projects ────────────────────────────────
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

  let newestSlug: string | null = null;
  let newestFilename: string | null = null;
  let newestCreatedAt = "";

  for (const slug of slugs) {
    const stateFilename = await findStateFile(slug);
    if (!stateFilename) continue;

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
