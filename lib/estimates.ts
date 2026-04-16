/**
 * Time estimation for research pipeline execution.
 *
 * Based on production data from 3 completed runs (Canyon Lake, HELOC).
 */

import type { SelectedProducts } from "./types/queue";

/** Per-component time estimates in minutes. */
const TIMES = {
  base: 12,       // Perplexity + NotebookLM + CI scoring + synthesis
  audio: 8,
  video: 15,      // Cinematic format
  slides: 6,
  report: 5,
  infographic: 10,
  vendors: 20,    // Vendor discovery + enrichment
} as const;

/**
 * Calculate estimated completion time in minutes.
 *
 * @param products - Which products are selected
 * @param vendorsEnabled - Whether vendor evaluation is enabled
 * @returns Estimated minutes (minimum 17, maximum ~76)
 */
export function estimateMinutes(
  products: SelectedProducts,
  vendorsEnabled: boolean,
): number {
  let total = TIMES.base;

  if (products.audio) total += TIMES.audio;
  if (products.video) total += TIMES.video;
  if (products.slides) total += TIMES.slides;
  if (products.report) total += TIMES.report;
  if (products.infographic) total += TIMES.infographic;
  if (vendorsEnabled) total += TIMES.vendors;

  return total;
}

/**
 * Map a progress percentage to the corresponding pipeline phase.
 */
export function phaseFromProgress(pct: number): string {
  if (pct < 10) return "Preflight";
  if (pct < 30) return "Research";
  if (pct < 40) return "CI Scoring";
  if (pct < 50) return "Import & Extraction";
  if (pct < 65) return "Synthesis";
  if (pct < 80) return "Vendors";
  if (pct < 100) return "Studio Products";
  return "Complete";
}
