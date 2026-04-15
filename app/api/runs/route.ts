/**
 * GET /api/runs
 *
 * Returns an array of RunSummary objects for every project that
 * contains a state.json file. Used by the dashboard historical index.
 */

import {
  listProjects,
  findStateFile,
  listFiles,
  readStateJson,
} from "@/lib/storage";

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
}

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

  const summaries: RunSummary[] = [];

  for (const slug of slugs) {
    const stateFilename = await findStateFile(slug);
    if (!stateFilename) continue;

    try {
      const state = await readStateJson(slug, stateFilename);

      // Count files in the project (from storage list metadata)
      const files = await listFiles(slug);
      const fileCount = files.length;

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
        fileCount,
      });
    } catch {
      continue;
    }
  }

  // Most recent first
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return Response.json(summaries);
}
