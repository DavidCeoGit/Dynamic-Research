/**
 * S160 m7 — pure run-status display helpers for the progress page.
 *
 * A status='failed' row whose studio_recovery_status='pending' is NOT terminal:
 * the studio artifacts are CONFIRMED complete in NotebookLM and the worker is
 * re-downloading them out-of-band (S158 transient-tolerant studio gate). The UI
 * must present it as in-progress ("Finalizing media"), never as the raw "failed"
 * status — otherwise the status-details card contradicts the recovering panel
 * and (m7) shows a scary "failed" for a job that is actually self-healing.
 *
 * Pure functions (no React) so they are unit-testable under node --test.
 */

/** A failed-but-recovering job: status='failed' AND studio_recovery_status='pending'. */
export function isRecoveringStatus(
  status: string | null | undefined,
  studioRecoveryStatus: string | null | undefined,
): boolean {
  return status === "failed" && studioRecoveryStatus === "pending";
}

/**
 * Label for the status-details card. "Finalizing media" while recovering, else
 * the raw status string (empty string for a nullish status).
 */
export function studioStatusCardLabel(
  status: string | null | undefined,
  studioRecoveryStatus: string | null | undefined,
): string {
  if (isRecoveringStatus(status, studioRecoveryStatus)) return "Finalizing media";
  return status ?? "";
}

/**
 * S187 P0-2 (Branch (c)) — which kind of recovery a parked run is doing, derived
 * from studio_recovery_payload. 'render' (the Studio video was still rendering at
 * the worker checkpoint) takes precedence over 'download' (the S158 download-blip
 * retry): whenever ANY pending product is a render wait, the UI shows the honest
 * "video still rendering" copy rather than "download hiccup". A per-product
 * recovery_kind that is absent ⇒ 'download' (backward-compat, mirrors the agent's
 * StudioRecoveryProduct default), so a legacy pending row reads as 'download'.
 *
 * A structural param type (not the imported StudioRecoveryPayload) keeps this
 * module hermetic + unit-testable under node --test without pulling in the
 * types/queue import chain.
 */
export function studioRecoveryKind(
  payload:
    | { products?: Array<{ recovery_kind?: "download" | "render" }> | null }
    | null
    | undefined,
): "download" | "render" {
  const products = payload?.products;
  if (!Array.isArray(products)) return "download";
  return products.some((p) => p?.recovery_kind === "render") ? "render" : "download";
}
