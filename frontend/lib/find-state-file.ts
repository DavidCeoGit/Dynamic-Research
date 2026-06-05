/**
 * Frontend mirror of agent/lib/find-state-file.ts — the PURE selection rule
 * only (the gallery reads state files from Supabase Storage, never the local
 * fs, so there is no fs-based findStateFile here). Kept in sync by convention,
 * symmetric with the storage-paths.ts agent/frontend mirror pattern.
 *
 * See agent/lib/find-state-file.ts for the full rationale (S87 e18e1931): the
 * run timestamp embedded in "<YYYYMMDD>-<HHMMSS>-state.json" is the ground
 * truth for which run is newer. Selection BUCKETS by name shape — if any
 * candidate is timestamped, only those are ranked; storage created_at is the
 * fallback ONLY when no candidate is timestamped (no cross-clock comparison).
 */

export function isStateFileName(name: string): boolean {
  return name === "state.json" || name.endsWith("-state.json");
}

export function embeddedStateTimestampMs(name: string): number | null {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-state\.json$/);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], S = +m[6];
  const ms = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== Mo - 1 || dt.getUTCDate() !== D ||
    dt.getUTCHours() !== H || dt.getUTCMinutes() !== Mi || dt.getUTCSeconds() !== S
  ) {
    return null;
  }
  return ms;
}

export interface StateCandidate {
  name: string;
  /** Fallback recency (epoch ms), used ONLY when no candidate carries an
   * embedded timestamp: Date.parse(created_at) || 0 for storage objects. */
  fallbackTimeMs: number;
}

export function selectNewestStateFile<T extends StateCandidate>(
  candidates: T[],
): T | null {
  if (candidates.length === 0) return null;
  const timestamped = candidates.filter(
    (c) => embeddedStateTimestampMs(c.name) !== null,
  );
  const useEmbedded = timestamped.length > 0;
  const pool = useEmbedded ? timestamped : candidates;

  let best: T | null = null;
  let bestKey = -Infinity;
  for (const c of pool) {
    const key = useEmbedded ? embeddedStateTimestampMs(c.name)! : c.fallbackTimeMs;
    if (best === null || key > bestKey || (key === bestKey && c.name > best.name)) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}
