/**
 * Time estimation for research pipeline execution.
 *
 * Based on production data from 3 completed runs (Canyon Lake, HELOC).
 */

import type { SelectedProducts } from "./types/queue";
import { STUDIO_PRODUCT_KEYS, type StudioProductKey } from "./studio-products";

/** Per-component time estimates in minutes. S172 site H: typed as a complete
 *  Record over the canonical product keys (+ base/vendors) so adding a product to
 *  STUDIO_PRODUCT_KEYS makes an omitted minute-estimate a compile error. */
const TIMES: Record<StudioProductKey, number> & { base: number; vendors: number } = {
  base: 12,       // Perplexity + NotebookLM + CI scoring + synthesis
  audio: 8,
  video: 15,      // Cinematic format
  slides: 6,
  report: 5,
  infographic: 10,
  vendors: 20,    // Vendor discovery + enrichment
};

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

  // S172 site H (design §5 rule 5): iterate the canonical key set rather than a
  // hand-unrolled if-chain. Typing TIMES forces the LITERAL complete but does NOT
  // force the consuming logic to read a new key — this loop does, so a new product
  // can never be silently dropped from the ETA.
  for (const k of STUDIO_PRODUCT_KEYS) {
    if (products[k]) total += TIMES[k];
  }
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
