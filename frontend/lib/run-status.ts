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
