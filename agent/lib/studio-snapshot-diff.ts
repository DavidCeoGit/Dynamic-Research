/**
 * S141 — studio_only snapshot-diff resolution (extracted for unit testing).
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
 * The NEW completed artifacts of a type since the snapshot. `snapshotReliable`
 * is whether the pre-gen snapshot list for this product SUCCEEDED (vs degrading
 * to an empty before-set after 3 failed tries).
 *
 * S141 Gemini MERGE MAJOR — fail-closed under chained failure: if the snapshot
 * DEGRADED, the before-set diff proves nothing, so freshness must be PROVEN by a
 * parseable created_at at/after the floor. An absent/unparseable created_at on a
 * degraded snapshot is UNPROVABLE and is REJECTED (otherwise a stale parent-run
 * artifact with malformed metadata could be admitted → reintroduces S31). When
 * the snapshot was RELIABLE, "not in before-set" itself proves newness, so a
 * provably-new id with no created_at is fine; a parseable-but-stale created_at is
 * still rejected as defense-in-depth.
 */
export function freshCompleted(
  arts: NlmArtifactRef[],
  beforeIds: Set<string>,
  runFloorMs: number,
  snapshotReliable: boolean,
): NlmArtifactRef[] {
  return arts.filter((a) => {
    if (!a.id || beforeIds.has(a.id)) return false;
    const c = createdAtMs(a);
    if (snapshotReliable) {
      return c == null ? true : c >= runFloorMs;
    }
    // Degraded snapshot: unprovable freshness → fail-closed (never S31).
    return c != null && c >= runFloorMs;
  });
}
