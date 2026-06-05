/**
 * "Hide from my view" — shared helpers (S92 completed runs; S93 failed/cancelled
 * queue jobs).
 *
 * Soft, UI-only hide: a row in public.user_hidden_runs marks a target hidden for
 * one org. Never deletes DB/storage data. See
 * Documentation/runs-hide-from-view-design-gate.md +
 * Documentation/runs-hide-failed-cancelled-peer-review.md.
 */
import { z } from "zod";

/**
 * Slug guard — mirrors the traversal rules in storage-paths.ts so a malformed
 * body returns a clean 400 here instead of throwing a 500 deeper inside
 * scopedStoragePath()/projectExists() (Codex MINOR-E). A queue job UUID (S93)
 * contains none of the rejected characters, so it passes this same guard.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".."), {
    message: "slug must not contain '/', '\\', or '..'",
  });

export const hideBodySchema = z
  .object({
    slug: slugSchema.optional(),
    slugs: z.array(slugSchema).max(500).optional(),
  })
  .refine((b) => Boolean(b.slug) || (b.slugs?.length ?? 0) > 0, {
    message: "provide 'slug' or a non-empty 'slugs' array",
  });

/**
 * Validate + normalize a hide/unhide request body into a deduped slug list.
 * UUID-shaped targets are lowercased (canonicalizeTarget) so case variants of a
 * queue id collapse to one value and match the canonical (lowercase) id Postgres
 * returns (Codex MINOR, S93). Throws ZodError on invalid input (the route maps
 * that to a 400).
 */
export function parseHideBody(json: unknown): string[] {
  const parsed = hideBodySchema.parse(json);
  const set = new Set<string>();
  if (parsed.slug) set.add(canonicalizeTarget(parsed.slug));
  for (const s of parsed.slugs ?? []) set.add(canonicalizeTarget(s));
  return [...set];
}

/**
 * Canonical UUID shape. A research_queue job `id` is always a UUID; a storage
 * run slug is a topic-slug (e.g. "ai-agents-20260604") and is NEVER UUID-shaped.
 *
 * S93 keys BOTH hide targets in the same `slug` text column. That is only safe
 * because the two key spaces are disjoint — this predicate is the load-bearing
 * disjointness assumption, so the hide route uses it to route the ownership
 * gate (UUID -> research_queue lookup; otherwise -> storage projectExists).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isQueueJobId(target: string): boolean {
  return UUID_RE.test(target);
}

/**
 * Canonicalize a hide target: lowercase UUID-shaped queue ids (Postgres returns
 * uuid columns in canonical lowercase, so the route's validated-set comparison
 * + upsert + delete must use the same form — Codex MINOR, S93). Storage slugs
 * (already-lowercase topic-slugs) are returned unchanged.
 */
export function canonicalizeTarget(target: string): string {
  return isQueueJobId(target) ? target.toLowerCase() : target;
}

/**
 * Split a deduped hide-target list into queue-job UUIDs vs storage-run slugs so
 * the route can validate each space in ONE batched query instead of an N+1
 * per-target loop (Gemini MAJOR, S93). Order within each bucket is preserved.
 */
export function partitionHideTargets(targets: string[]): {
  jobIds: string[];
  slugs: string[];
} {
  const jobIds: string[] = [];
  const slugs: string[] = [];
  for (const t of targets) {
    if (isQueueJobId(t)) jobIds.push(t);
    else slugs.push(t);
  }
  return { jobIds, slugs };
}
