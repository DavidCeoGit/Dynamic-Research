/**
 * Single source of truth for "which state.json is the CURRENT one" when a
 * workdir (or, after uploadOutputs, a scoped storage prefix) holds more than
 * one state-file candidate.
 *
 * Why this exists (S87 e18e1931):
 *   Research workdirs are REUSED across re-queues of the same topic_slug, so
 *   stale "<timestamp>-state.json" files from earlier failed runs pile up next
 *   to the current run's state file. The historical selector — "prefer exact
 *   state.json, else the FIRST '<x>-state.json' in directory order" (executor
 *   S83 8b32c97, mirrored to 3 sibling sites in S84) — returned whichever name
 *   sorted first in readdir/list order, i.e. the OLDEST timestamp. That froze
 *   progress sync at Preflight AND false-failed verifyPipelineCompletion on a
 *   fully-completed job (the 6/2 phase-0 state.json shadowed the 6/3 phase-6
 *   one).
 *
 * Recency signal (Gemini + Codex MERGE-gate, S87): the run timestamp EMBEDDED
 * IN THE FILENAME ("<YYYYMMDD>-<HHMMSS>-state.json") is the run's LOGICAL time
 * and the ground truth for which run is newer. It is preferred over proxy
 * times, which are unreliable here:
 *   - fs mtime can be clobbered to one tick by a zip/bulk-copy workdir restore;
 *   - Supabase created_at is upload-COMPLETION order — a stale file uploaded
 *     after a fresh one in the same batch gets a NEWER created_at.
 * To avoid comparing the embedded wall-clock (read as UTC) against a real-epoch
 * proxy time across two clocks (Codex MAJOR), selection BUCKETS by name shape:
 * if ANY candidate carries an embedded timestamp, only those are ranked (by
 * embedded time); the plain "state.json" / slug-named "<slug>-state.json"
 * fallback (mtime / created_at) is used ONLY when NO candidate is timestamped.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** True if a filename is a state-file candidate: plain "state.json" or any
 * "<prefix>-state.json" (timestamp- or slug-prefixed). */
export function isStateFileName(name: string): boolean {
  return name === "state.json" || name.endsWith("-state.json");
}

/**
 * Subdir (under the per-job workdir) that holds state files carried over from a
 * PRIOR attempt in a REUSED workdir. The name is deliberately NOT a state-file
 * candidate, and findStateFile() reads the workdir non-recursively, so archived
 * files are invisible to selection.
 */
export const SUPERSEDED_STATE_DIR = ".superseded-state";

/**
 * Move every prior-attempt state-file candidate out of the workdir ROOT before
 * the current run writes or anything reads, so findStateFile() cannot return a
 * stale (possibly terminal/PASSING) manifest from an earlier re-queue.
 *
 * Why (S117 stale-terminal-state fail-open):
 *   Per-slug workdirs (`C:/tmp/research-compare/<slug>/`) are intentionally
 *   reused across re-queues of the same topic_slug. If a prior attempt left a
 *   PASSING `publish_verification` and the new spawn exits WITHOUT writing its
 *   own state, findStateFile() would return the stale passing file and the
 *   PUBLISH gate would publish-clear a run that did no work — the exact
 *   fail-open class MRPF PUBLISH exists to prevent, smuggled in via workdir
 *   reuse. Archiving at claim time makes findStateFile() return null in that
 *   case, so the existing "no state.json was written" guard (executor
 *   verifyPipelineCompletion / studio_only null-state read) fires and the job
 *   fails CLOSED. It also removes the cosmetic poller mirroring of a stale
 *   terminal phase ~5s post-spawn.
 *   See feedback_stale_terminal_state_fail_open_hazard.
 *
 * Worker runs are always FRESH — the spawn brief forbids interactive resume and
 * publish-required runs must never reuse cached legs — so removing the prior
 * state file from selection never strands a legitimate resume. Forensics are
 * preserved (rename, not delete) under SUPERSEDED_STATE_DIR.
 *
 * Collision-safe across repeated re-queues without Date.now()/random: each
 * archived name is prefixed with a monotonic index derived from the count of
 * files already in the archive dir. Returns the ORIGINAL names archived (empty
 * if the workdir is absent or holds no candidates — idempotent no-op).
 */
export async function archiveStaleStateFiles(workDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(workDir);
  } catch (err) {
    // ENOENT = workdir not created yet → genuinely nothing to archive (safe
    // no-op). ANY OTHER error (transient EMFILE / Windows EPERM / ENOTDIR)
    // means we CANNOT prove the workdir is free of a prior attempt's PASSING
    // state.json — swallowing it would silently leave the stale manifest in
    // place and re-open the exact fail-OPEN this guard exists to close. So
    // rethrow and let the caller fail the job CLOSED (Codex MERGE-gate, S117).
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const stale = names.filter(isStateFileName);
  if (stale.length === 0) return [];

  const archiveDir = path.join(workDir, SUPERSEDED_STATE_DIR);
  await fs.mkdir(archiveDir, { recursive: true });

  // The index is derived from the current archive-dir count. This assumes
  // SERIAL invocation, which the worker guarantees: a single-process daemon
  // that claims and runs ONE job at a time (CLAUDE.md §6), so two executeJob()
  // calls never archive the same slug's workdir concurrently. If that invariant
  // were ever violated a same-index collision is, at worst, a forensics issue,
  // NEVER a live-state fail-open: on Windows fs.rename throws EEXIST/EPERM (the
  // job fails CLOSED); on POSIX it would overwrite an EARLIER archived sibling
  // (forensics loss only — the live workdir root is still cleared). So we do
  // not pay for a TOCTOU-safe allocator here.
  let existing: string[] = [];
  try {
    existing = await fs.readdir(archiveDir);
  } catch {
    // just created — empty
  }
  let idx = existing.length;

  const archived: string[] = [];
  for (const name of stale) {
    // rename within the same filesystem (subdir of workDir) — atomic + cheap.
    await fs.rename(
      path.join(workDir, name),
      path.join(archiveDir, `${idx}-${name}`),
    );
    archived.push(name);
    idx++;
  }
  return archived;
}

/**
 * Parse the run timestamp embedded in a state-file name into a sortable epoch
 * (ms). Matches ONLY a fully start/end-anchored "<YYYYMMDD>-<HHMMSS>-state.json"
 * (the shape the pipeline writes); a slug-named "<slug>-state.json" that merely
 * happens to end in digits is NOT treated as timestamped (Codex MINOR). Invalid
 * calendar values that Date.UTC would silently roll over (month 13, day 32) are
 * rejected via a round-trip check. Returns null for any non-match.
 *
 * The embedded value is wall-clock with no zone; callers compare it only
 * against OTHER embedded timestamps (same bias cancels), never against an
 * epoch fallback — see selectNewestStateFile bucketing.
 */
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
  /** Fallback recency (epoch ms), used ONLY when NO candidate carries an
   * embedded timestamp: fs mtimeMs (local) or Date.parse(created_at)||0
   * (storage). Callers MUST coerce a missing/unparseable value to 0. */
  fallbackTimeMs: number;
}

/**
 * Pick the newest state-file candidate, or null if there are none.
 *
 * Buckets by name shape to avoid cross-clock comparison (Codex MAJOR): if any
 * candidate is timestamped, rank ONLY those by embedded time; otherwise rank
 * the plain/slug candidates by fallbackTimeMs. Within the chosen bucket, an
 * exact tie breaks to the lexicographically-greater name (deterministic).
 *
 * Residual edge (documented, rare): a workdir that mixes a FRESH plain
 * state.json with a STALE timestamped one — only possible if the pipeline
 * switched naming convention mid-reuse — would pick the timestamped sibling.
 * The prior first-match selector was strictly worse in every such case.
 */
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

/**
 * Find the current state.json in a LOCAL workdir. Newest by embedded run
 * timestamp, falling back to fs mtime only when no candidate is timestamped.
 * Returns the absolute path, or null if no state file exists. A file that
 * vanishes between readdir and stat (race during an active run) is skipped.
 */
export async function findStateFile(workDir: string): Promise<string | null> {
  const names = await fs.readdir(workDir);
  const candidates: StateCandidate[] = [];
  for (const name of names) {
    if (!isStateFileName(name)) continue;
    try {
      const { mtimeMs } = await fs.stat(path.join(workDir, name));
      candidates.push({ name, fallbackTimeMs: mtimeMs });
    } catch {
      // vanished between readdir and stat — skip
    }
  }
  const best = selectNewestStateFile(candidates);
  return best ? path.join(workDir, best.name) : null;
}
