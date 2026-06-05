/**
 * Per-user "hide completed runs from my view" — shared helpers (S92).
 *
 * Soft, UI-only hide: a row in public.user_hidden_runs marks a run hidden for
 * ONE user. Never deletes DB/storage data. See
 * Documentation/runs-hide-from-view-design-gate.md.
 */
import { z } from "zod";

/**
 * Slug guard — mirrors the traversal rules in storage-paths.ts so a malformed
 * body returns a clean 400 here instead of throwing a 500 deeper inside
 * scopedStoragePath()/projectExists() (Codex MINOR-E).
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
 * Throws ZodError on invalid input (the route maps that to a 400).
 */
export function parseHideBody(json: unknown): string[] {
  const parsed = hideBodySchema.parse(json);
  const set = new Set<string>();
  if (parsed.slug) set.add(parsed.slug);
  for (const s of parsed.slugs ?? []) set.add(s);
  return [...set];
}
