/**
 * Pure studio-deliverable winner selection — shared by
 * agent/scripts/verify-gallery-vs-notebook.ts (S89: extracted so the selection
 * logic is unit-testable without executing the script's top-level main()).
 *
 * The comparison the verify gate performs is entirely filename-based, so this
 * operates over a flat list of filenames regardless of whether they came from a
 * local Projects/<slug>/ readdir or a Supabase Storage listing.
 */

import { STUDIO_PRODUCTS } from "./conventions.js";

export interface GalleryWinner {
  filename: string;
  titleSlug: string;
  timestamp: string;
  version: number;
  // S36: optional single-letter variant suffix (e.g. "a", "b", "c", "d") for
  // multi-take S35 outputs like `*-video-v5a.mp4`, `-v5b.mp4`. Same-version
  // tiebreaks pick the LAST letter (DESC), matching frontend/lib/files.ts.
  variant: string;
}

// Version-aware match: catches v1 (no suffix), v2/v3+ (-vN), AND S35 multi-take
// letter variants (-vNa, -vNb, -vNc, -vNd). The canonical studio regex in
// conventions.json rejects -vN entirely, so we do our own parse here.
// See feedback_post_run_artifact_verification.md + frontend/lib/files.ts.
export const VERSIONED_STUDIO =
  /^([a-z0-9-]+)-(\d{8}-\d{6})-([a-z]+)(?:-v(\d+)([a-z]?))?\.([a-z0-9]+)$/;

// Select the winning deliverable per studio product from a flat list of
// filenames. Highest version wins; within a version, the later variant letter
// wins (v5d beats v5a); empty variant is earliest (v5 < v5a < v5d) — matches
// frontend inventory sort. Non-studio-shaped names and unknown products are
// ignored, so passing a whole Projects/ dir (which also holds brief.md,
// comparison.md, etc.) is safe.
export function pickWinners(
  files: Array<{ name: string }>,
): Record<string, GalleryWinner> {
  const byProduct: Record<string, GalleryWinner> = {};
  for (const { name } of files) {
    const m = name.match(VERSIONED_STUDIO);
    if (!m) continue;
    const [, titleSlug, timestamp, product, vStr, variant] = m;
    if (!STUDIO_PRODUCTS[product]) continue;
    const version = vStr ? parseInt(vStr, 10) : 1;

    const candidate: GalleryWinner = {
      filename: name,
      titleSlug,
      timestamp,
      version,
      variant: variant ?? "",
    };
    const cur = byProduct[product];
    if (
      !cur ||
      candidate.version > cur.version ||
      (candidate.version === cur.version && candidate.variant > cur.variant)
    ) {
      byProduct[product] = candidate;
    }
  }
  return byProduct;
}
