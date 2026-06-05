/**
 * POST   /api/runs/hide   — hide one or more runs from the org's view
 * DELETE /api/runs/hide   — unhide (restore to the org's view)
 *
 * v4 (S92): ORG-SCOPED soft hide that works on the env-fallback path (the live
 * dashboard has no session). UI-only, reversible, non-destructive.
 *
 * S93: extended to FAILED + CANCELLED queue jobs (the Active Pipelines section).
 * A completed run is a STORAGE slug; a failed/cancelled job is a research_queue
 * row keyed by its UUID `id` (which arrives in the same `slug` field). The two
 * key spaces are disjoint (storage slugs are topic-slugs, never UUIDs), so a
 * single body field covers both. POST validation is BATCHED (Gemini MAJOR, S93):
 *   - all UUID targets   -> ONE `.in("id", jobIds)` query scoped to org +
 *                           status IN ('failed','cancelled').
 *   - all slug targets   -> projectExists with bounded concurrency (cap fan-out
 *                           so a 500-target body can't burst the Storage pool).
 *   - validated targets  -> ONE bulk upsert (was N sequential upserts).
 *
 * Invariants (v4 MERGE-gate review, Gemini->Codex; S93 extends the same shape):
 *  - Org context via getOrgContextDualPath() (env or session) — the SAME tenant
 *    boundary the dashboard reads use. NOT requireOrgContext() (which would 401
 *    the env path and make hide unusable).
 *  - DB via the service-role client (getSupabase), ALWAYS scoped
 *    .eq("organization_id", orgId). The env path has no auth.uid(), so the RLS/
 *    anon client cannot be used; RLS on the table is enabled with no policies
 *    (service-role-only). Route-level org-scoping is the load-bearing boundary.
 *  - No user_id (table is org-scoped). onConflict "organization_id,slug".
 *  - Rate-limited FIRST (before body parse): 429 + Retry-After + X-RateLimit-Remaining.
 *  - Ownership gate on POST: a target must be a failed/cancelled job OR a storage
 *    run, both in the resolved org. Unowned targets are skipped, never hidden.
 *  - Body validated by parseHideBody (400 on malformed).
 *
 * See Documentation/runs-hide-from-view-env-path-revision.md +
 *     Documentation/runs-hide-failed-cancelled-peer-review.md.
 */
import { getOrgContextDualPath } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { projectExists } from "@/lib/storage";
import { parseHideBody, partitionHideTargets } from "@/lib/hidden-runs";
import { clientIp, checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type SkipReason = "not_found_in_org" | "db_error";

/**
 * Map over items with a bounded number of in-flight promises (Gemini MAJOR,
 * S93). Caps the Storage-API fan-out so a large bulk body cannot exhaust the
 * serverless instance's connection pool. Results are index-aligned with `items`.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

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

  const targets = await readSlugs(request);
  if (targets instanceof Response) return targets;

  const supabase = getSupabase();
  const { jobIds, slugs } = partitionHideTargets(targets);

  // Queue-job ownership: ONE org-scoped query for all UUID targets. Only this
  // org's failed/cancelled jobs are hideable.
  const validJobIds = new Set<string>();
  if (jobIds.length > 0) {
    try {
      const { data } = await supabase
        .from("research_queue")
        .select("id")
        .in("id", jobIds)
        .eq("organization_id", orgId)
        .in("status", ["failed", "cancelled"]);
      for (const r of data ?? []) validJobIds.add(r.id as string);
    } catch {
      /* leave empty → those targets fall through to not_found_in_org */
    }
  }

  // Storage-run ownership: bounded-concurrency existence checks in the org prefix.
  const validSlugs = new Set<string>();
  if (slugs.length > 0) {
    const exists = await mapLimit(slugs, 8, (s) =>
      projectExists(orgId, s).catch(() => false),
    );
    slugs.forEach((s, i) => {
      if (exists[i]) validSlugs.add(s);
    });
  }

  const validated = targets.filter(
    (t) => validJobIds.has(t) || validSlugs.has(t),
  );
  const skipped: { slug: string; reason: SkipReason }[] = targets
    .filter((t) => !validJobIds.has(t) && !validSlugs.has(t))
    .map((slug) => ({ slug, reason: "not_found_in_org" }));

  let hidden: string[] = [];
  if (validated.length > 0) {
    const { error } = await supabase.from("user_hidden_runs").upsert(
      validated.map((slug) => ({ organization_id: orgId, slug })),
      { onConflict: "organization_id,slug", ignoreDuplicates: true },
    );
    if (error) {
      return Response.json({
        hidden: [],
        skipped: [
          ...skipped,
          ...validated.map((slug) => ({ slug, reason: "db_error" as SkipReason })),
        ],
      });
    }
    hidden = validated;
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
