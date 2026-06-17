/**
 * S141 — studio_only snapshot-diff resolution (extracted for unit testing).
 * S142 — hardened against the concurrent-FOREIGN exact-1 false-success.
 *
 * The studio_only regen path (agent/scripts/regenerate-studio-products.ts)
 * resolves each product's NEW completed NotebookLM artifact by diffing the
 * type's COMPLETED-artifact list (realListArtifacts → status_id===3 only)
 * against a pre-generation snapshot, then downloads BY ID. This module holds
 * the pure decision logic so it can be exercised without spawning the NLM CLI
 * or self-executing the script (which parses process.argv + calls main() at
 * import time). See agent/test/studio-snapshot-diff.test.ts.
 *
 * Fail-closed is the governing principle: studio_only is NOT wrapped by the
 * S136 Layer-2 cap-kill recovery (it is its own executor exit branch), so an
 * unproven artifact must NEVER be admitted (that would reintroduce the S31
 * wrong-artifact bug). When freshness cannot be proven, the product stays
 * unresolved and the run fails — never a wrong download.
 *
 * S142 — the before-set is now ALL-STATUS, not completed-only. studio_only runs
 * against a SHARED parent notebook; the S141 completed-only snapshot could not
 * see a FOREIGN generation already IN-PROGRESS at our start, so when that
 * foreign artifact completed it was the only "new" completed id → resolved as
 * ours (Codex S141 CRITICAL). The snapshot now records every artifact id of the
 * type regardless of status (realListAllArtifactIds), so an already-in-flight
 * foreign artifact is in the before-set and is excluded once it completes. The
 * residual — a foreign generation that STARTS strictly after our snapshot and
 * completes before ours — is narrowed but not closed by this layer; it stays
 * fail-closed-friendly (the >1-new guard at the call site refuses to guess when
 * both ours and a foreign artifact complete).
 */

import type { NlmArtifactRef } from "./studio-completeness.js";

/** created_at → epoch ms, or null if absent/unparseable (mirror of
 * studio-completeness.ts artifactCreatedAtMs, which is not exported). */
export function createdAtMs(a: NlmArtifactRef): number | null {
  if (!a.created_at) return null;
  const ms = Date.parse(a.created_at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The NEW completed artifacts of a type since the snapshot.
 *
 * @param arts            COMPLETED artifacts of the type (status_id===3), from
 *                        realListArtifacts, newest-first.
 * @param beforeAllIds    ALL-STATUS artifact ids present BEFORE generation
 *                        (realListAllArtifactIds snapshot) — includes
 *                        in-progress/pending foreign work, so a foreign artifact
 *                        already in flight at our start is excluded once it
 *                        completes (S142).
 * @param runFloorMs      now − skew buffer, captured before the snapshot.
 * @param snapshotReliable whether the all-status snapshot list SUCCEEDED (vs
 *                        degrading to an empty before-set after 3 failed tries).
 *
 * S142 — DEGRADED snapshot is fully fail-closed: with no before-set we cannot
 * distinguish OURS from a foreign artifact created just after the floor (Codex's
 * S141 "widening edge"). studio_only has no Layer-2 backstop, so admitting on
 * created_at alone is an unacceptable guess → resolve NOTHING. The product rides
 * to its per-product timeout and the run fails (re-runnable) rather than risk
 * S31. A reliable all-status snapshot is the ONLY path that resolves an artifact.
 *
 * Under a RELIABLE snapshot, "not in the all-status before-set" proves the
 * artifact did not exist (in ANY state) when we started, so a provably-new id
 * with no created_at is admitted; a parseable-but-stale created_at is still
 * rejected as defense-in-depth (Gemini S141 MAJOR).
 */
export function freshCompleted(
  arts: NlmArtifactRef[],
  beforeAllIds: Set<string>,
  runFloorMs: number,
  snapshotReliable: boolean,
): NlmArtifactRef[] {
  // Degraded snapshot → unprovable ours-vs-foreign → fail-closed (never S31).
  if (!snapshotReliable) return [];
  return arts.filter((a) => {
    if (!a.id || beforeAllIds.has(a.id)) return false;
    const c = createdAtMs(a);
    return c == null ? true : c >= runFloorMs;
  });
}
