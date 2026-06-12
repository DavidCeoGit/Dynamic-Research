/**
 * S106 — staging-TTL sweep for abandoned attachment drafts.
 *
 * Staged uploads live at <orgId>/uploads/<draftId>/<storedName>. The submit
 * route copies them to <orgId>/<slug>/sources/ and best-effort deletes the
 * staging copies, so anything still in staging after
 * ATTACHMENTS.staging_ttl_hours is garbage BY CONSTRUCTION (an abandoned
 * draft, or the leftovers of a failed best-effort cleanup). This module is
 * the backstop that reclaims it — the second half of the S105 Codex MAJOR
 * #2 finding (the first half, post-submit cleanup, shipped in Phase 2).
 *
 * Two entry points:
 *   - sweepStagingUploads(sb, opts): the sweep itself. Walks org folders →
 *     uploads/ → draft folders → files; deletes files whose created_at is
 *     older than the TTL. Injectable client + clock for unit tests.
 *   - maybeRunStagingSweep(opts): worker-tick wrapper. File-backed 24h gate
 *     (marker survives the worker's frequent cron-respawn PID rotations),
 *     lazy client construction, best-effort posture — NEVER throws.
 *
 * Manual CLI wrapper: agent/scripts/cleanup-staging-uploads.ts.
 *
 * ── S111 sweep-hardening trio (+ MERGE-gate integrations) ────────────
 * Three coupled robustness fixes layered on the S106 base, refined by the
 * Gemini (holistic) + Codex (grounded) MERGE-gate review:
 *   1. Marker-write-failure → FAIL CLOSED. The 24h gate keyed solely on a
 *      file marker silently failed OPEN if the marker WRITE failed (ENOSPC,
 *      permissions): every idle tick re-swept, hammering storage. The durable
 *      marker is now CLAIMED (written) BEFORE the sweep, and if that write
 *      fails the sweep is SKIPPED — a GC backstop can wait until the disk is
 *      healthy, which is strictly better than re-sweeping on every worker
 *      respawn (Codex BLOCKING: an in-memory-only backoff resets on the
 *      cron-respawn PID rotation, so it can't restore the 24h guarantee on a
 *      broken disk). A module-level in-memory backoff additionally paces the
 *      gate within a single process so a broken disk doesn't trigger a
 *      claim-attempt every 30s tick.
 *   2. Marker-before-sweep. The marker is claimed BEFORE the sweep runs. A
 *      sweep that crashes the *process* (OOM on a huge listing — not
 *      JS-catchable, so the never-throws contract can't help) would otherwise
 *      crash-loop the worker on every idle tick and starve all job
 *      processing. Claiming the 24h window first trades that for an unfinished
 *      tail waiting ≤24h — the correct trade for a GC backstop. The marker is
 *      re-written AFTER the sweep with the COMPLETION timestamp + resume
 *      cursors (so a >24h sweep isn't immediately due again).
 *   3. MAX_PAGES stable-cursor (inherit + prune-on-full-pass). When a prefix
 *      exceeds the MAX_PAGES page cap, a resume offset is persisted in the
 *      marker; the next sweep continues from there, advancing and wrapping to
 *      a fresh full pass on exhaustion → bounded eventual coverage. Cursors
 *      are INHERITED across sweeps (Gemini BLOCKING #1): a nested prefix whose
 *      parent paginated past it this sweep keeps its saved cursor instead of
 *      being dropped, so deep tails aren't permanently starved. Orphaned
 *      cursors (for a deleted child folder) are PRUNED — but ONLY when a parent
 *      listing exhausts from offset 0, i.e. a COMPLETE pass that genuinely saw
 *      every child (Codex MAJOR closed the forever-leak; Codex QA BLOCKING then
 *      caught that pruning on a RESUMED-then-exhausted parent — which saw only
 *      the tail — would wrongly drop cursors for children before the resume
 *      offset, reintroducing starvation; hence the offset-0 guard).
 *
 * KNOWN LIMITATION (Gemini #2 / Codex MAJOR — deliberate follow-up): MAX_PAGES
 * caps per-PREFIX listing only. Total sweep work (one list() per org, per
 * draft) is NOT bounded, and the worker awaits the sweep on its idle tick, so
 * a pathological tree (e.g. one org with tens of thousands of abandoned
 * drafts) could delay job polling. At this system's realistic tenant/draft
 * scale (drafts cap at ATTACHMENT_MAX_FILES files; jobs run 30–50 min so a
 * sub-minute pickup delay is immaterial) this is a tail risk, and marker-
 * before-sweep already prevents a runaway sweep from crash-looping the worker.
 * A proper per-sweep request budget with TREE-POSITION resume is tracked as a
 * follow-up; it is deliberately NOT bolted on here because a naive budget that
 * aborts mid-tree without position resume would reintroduce the tail
 * starvation item 3 just fixed.
 */

import * as fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { ATTACHMENTS, BUCKET } from "./conventions.js";

// Same canonical UUID shape as storage-paths.ts (kept private there; the
// two must stay in sync — it only ever matches real org/draft ids).
const UUID_SHAPE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Supabase storage list() page size. listPrefix paginates with an offset
// loop (S106 Gemini finding 3: a fixed single page starves old drafts once
// an org accumulates >1000 — name-sorted UUIDs carry no age correlation, so
// the expired tail would never be reached). MAX_PAGES bounds a runaway
// prefix; hitting it sets stats.truncated AND records a resume cursor
// (S111 item 3) so the deferred tail is reached on a later sweep rather
// than restarting at offset 0 every time.
const LIST_LIMIT = 1000;
const MAX_PAGES = 20;
// Bulk-delete batch size (single DELETE calls 400 on empty-body+JSON CT —
// always use the bulk endpoint; see feedback_supabase_storage_bulk_delete).
const DELETE_BATCH = 100;

interface ListedObject {
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
  /** null metadata = folder placeholder; non-null = real object. */
  metadata: Record<string, unknown> | null;
}

/** Minimal structural client surface — lets tests inject a mock. */
export interface StorageSweepClientLike {
  storage: {
    from(bucket: string): {
      list(
        prefix: string,
        opts: {
          limit: number;
          offset?: number;
          sortBy?: { column: string; order: string };
        },
      ): Promise<{ data: ListedObject[] | null; error: { message: string } | null }>;
      remove(
        paths: string[],
      ): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

/** Per-prefix resume offsets for truncated listings (S111 item 3). */
export type SweepCursors = Record<string, number>;

export interface SweepStats {
  orgsScanned: number;
  draftsScanned: number;
  filesScanned: number;
  expired: number;
  deleted: number;
  /** Accumulated non-fatal errors (list/remove failures). */
  errors: string[];
  /** True if a prefix exceeded the MAX_PAGES pagination cap — remainder deferred. */
  truncated: boolean;
  /**
   * Resume offsets to persist for the NEXT sweep, keyed by prefix. Seeded
   * from the incoming cursors and adjusted per prefix VISITED this sweep:
   *   - truncated this sweep → offset advanced to the resume point;
   *   - exhausted this sweep  → entry cleared (wraps to a fresh pass);
   *   - errored this sweep    → entry left as-is (retry same region);
   *   - NOT visited (parent paginated past it) → inherited entry kept.
   * Keeping inherited entries is the Gemini S111 BLOCKING #1 fix: an empty-
   * by-default map silently dropped cursors for nested prefixes skipped under
   * a paginating ancestor, permanently starving their tails. To stop a deleted
   * child's cursor from then leaking forever (Codex MAJOR), orphaned
   * descendant cursors are pruned — but ONLY after a COMPLETE (offset-0)
   * parent pass that exhausts, since a resumed-then-exhausted parent saw only
   * its tail and must not drop cursors for children before the resume offset
   * (Codex QA BLOCKING).
   */
  nextCursors: SweepCursors;
  /** Populated in dryRun mode with the paths that WOULD be deleted. */
  wouldDelete: string[];
}

export interface SweepOptions {
  ttlHours?: number;
  now?: Date;
  dryRun?: boolean;
  logFn?: (msg: string) => void;
  /**
   * Incoming resume offsets (from the prior sweep's nextCursors). A prefix
   * present here is listed starting at its saved offset instead of 0.
   */
  cursors?: SweepCursors;
}

/**
 * Outcome of paginating a single prefix. Three states drive cursor handling:
 *   - exhausted: reached the end this pass → cursor cleared (wrap). If the pass
 *                also started at offset 0 the COMPLETE child set is known, so
 *                orphan cursors can be pruned (see sweepStagingUploads).
 *   - truncated: hit MAX_PAGES, more remains → cursor advances to resumeOffset;
 *                child set is INCOMPLETE, so no pruning.
 *   - error:     list failed → cursor left untouched so the same region is
 *                retried next sweep (deletes are idempotent); no pruning.
 */
type ListResult =
  | { items: ListedObject[]; status: "exhausted" }
  | { items: ListedObject[]; status: "truncated"; resumeOffset: number }
  | { items: ListedObject[]; status: "error" };

async function listPrefix(
  sb: StorageSweepClientLike,
  prefix: string,
  stats: SweepStats,
  startOffset: number,
): Promise<ListResult> {
  const all: ListedObject[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    // Offset-based resume. Note (Gemini S111 #3): if a prior sweep deleted
    // entries before this offset the listing shifts left, so a resumed offset
    // can step over a few not-yet-seen entries — but the cursor eventually
    // exhausts and wraps to 0, so nothing is PERMANENTLY skipped; the misses
    // are transient and reclaimed on the next full pass. Acceptable for a
    // daily GC backstop.
    const offset = startOffset + page * LIST_LIMIT;
    // try/catch in addition to {error} inspection: a REJECTED list()
    // (network throw, client bug) must also degrade to a recorded error —
    // never escape the sweep's never-throws contract (S106 Codex MAJOR #3).
    let items: ListedObject[];
    try {
      const { data, error } = await sb.storage.from(BUCKET).list(prefix, {
        limit: LIST_LIMIT,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(error.message);
      items = data ?? [];
    } catch (err) {
      stats.errors.push(
        `list(${prefix || "<root>"}) failed: ${(err as Error).message}`,
      );
      return { items: all, status: "error" };
    }
    all.push(...items);
    if (items.length < LIST_LIMIT) return { items: all, status: "exhausted" };
  }
  // MAX_PAGES full pages — more remain; persist where to resume next sweep.
  const resumeOffset = startOffset + MAX_PAGES * LIST_LIMIT;
  stats.truncated = true;
  stats.errors.push(
    `list(${prefix || "<root>"}) hit page cap at offset ${resumeOffset} — remainder deferred to next sweep (resume cursor saved)`,
  );
  return { items: all, status: "truncated", resumeOffset };
}

/**
 * Delete staged attachment files older than the TTL. Best-effort: list and
 * remove failures accumulate in stats.errors; the sweep continues. Never
 * throws on storage-layer failures.
 */
export async function sweepStagingUploads(
  sb: StorageSweepClientLike,
  opts: SweepOptions = {},
): Promise<SweepStats> {
  const ttlHours = opts.ttlHours ?? ATTACHMENTS.staging_ttl_hours;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const logFn = opts.logFn ?? (() => {});
  const inCursors = opts.cursors ?? {};
  const cutoffMs = now.getTime() - ttlHours * 3_600_000;

  const stats: SweepStats = {
    orgsScanned: 0,
    draftsScanned: 0,
    filesScanned: 0,
    expired: 0,
    deleted: 0,
    errors: [],
    truncated: false,
    // Seed from incoming cursors so prefixes NOT visited this sweep keep their
    // saved offset (Gemini S111 BLOCKING #1). record() + pruneOrphans() mutate.
    nextCursors: { ...inCursors },
    wouldDelete: [],
  };

  const record = (prefix: string, res: ListResult): ListResult => {
    if (res.status === "truncated") {
      stats.nextCursors[prefix] = res.resumeOffset;
    } else if (res.status === "exhausted") {
      delete stats.nextCursors[prefix];
    }
    // status === "error": leave the inherited cursor untouched.
    return res;
  };

  // Prune inherited descendant cursors whose top path segment is absent from a
  // parent's COMPLETE child listing (Codex MAJOR — a deleted child's cursor
  // would otherwise leak forever). Caller MUST only invoke this for a parent
  // that exhausted FROM OFFSET 0 (a full pass): a resumed-then-exhausted parent
  // saw only its tail, and pruning then would drop cursors for children before
  // the resume offset, reintroducing the Gemini #1 starvation (Codex QA).
  const pruneOrphans = (parentPrefix: string, presentChildren: Set<string>) => {
    const base = parentPrefix === "" ? "" : `${parentPrefix}/`;
    for (const key of Object.keys(stats.nextCursors)) {
      if (key === parentPrefix || !key.startsWith(base)) continue;
      const childSeg = key.slice(base.length).split("/")[0];
      if (!presentChildren.has(childSeg)) delete stats.nextCursors[key];
    }
  };

  const expiredPaths: string[] = [];

  const rootStart = inCursors[""] ?? 0;
  const rootRes = record("", await listPrefix(sb, "", stats, rootStart));
  if (rootRes.status === "exhausted" && rootStart === 0) {
    pruneOrphans("", new Set(rootRes.items.map((e) => e.name)));
  }
  const orgFolders = rootRes.items.filter(
    (e) => e.metadata === null && UUID_SHAPE_REGEX.test(e.name),
  );

  // Fan-out note (Gemini #2 / Codex MAJOR — see module KNOWN LIMITATION): this
  // nested walk issues one list() per org, per draft — bounded by MAX_PAGES PER
  // PREFIX but NOT in total, and the worker awaits it on the idle tick. Bounded
  // per-sweep work with tree-position resume is a deliberate follow-up.
  for (const org of orgFolders) {
    stats.orgsScanned += 1;
    const stagingRoot = `${org.name}/${ATTACHMENTS.staging_prefix}`;
    const draftStart = inCursors[stagingRoot] ?? 0;
    const draftRes = record(
      stagingRoot,
      await listPrefix(sb, stagingRoot, stats, draftStart),
    );
    if (draftRes.status === "exhausted" && draftStart === 0) {
      pruneOrphans(stagingRoot, new Set(draftRes.items.map((e) => e.name)));
    }
    const draftFolders = draftRes.items.filter(
      (e) => e.metadata === null && UUID_SHAPE_REGEX.test(e.name),
    );

    for (const draft of draftFolders) {
      stats.draftsScanned += 1;
      const draftPrefix = `${stagingRoot}/${draft.name}`;
      const fileRes = record(
        draftPrefix,
        await listPrefix(sb, draftPrefix, stats, inCursors[draftPrefix] ?? 0),
      );
      const files = fileRes.items.filter((e) => e.metadata !== null);

      for (const file of files) {
        stats.filesScanned += 1;
        const stamp = file.created_at ?? file.updated_at ?? null;
        const stampMs = stamp ? Date.parse(stamp) : NaN;
        if (Number.isNaN(stampMs)) {
          // Unknown age — leave it; better an orphan than deleting a
          // file some live draft is about to submit.
          stats.errors.push(`${draftPrefix}/${file.name}: unparseable created_at, left in place`);
          continue;
        }
        if (stampMs < cutoffMs) {
          stats.expired += 1;
          expiredPaths.push(`${draftPrefix}/${file.name}`);
        }
      }
    }
  }

  if (dryRun) {
    stats.wouldDelete = expiredPaths;
    for (const p of expiredPaths) logFn(`[staging-sweep] WOULD DELETE: ${p}`);
    return stats;
  }

  for (let i = 0; i < expiredPaths.length; i += DELETE_BATCH) {
    const batch = expiredPaths.slice(i, i + DELETE_BATCH);
    try {
      // remove() RESOLVES { error } rather than rejecting — inspect it
      // (feedback_supabase_remove_resolves_error_not_throws).
      const { error } = await sb.storage.from(BUCKET).remove(batch);
      if (error) {
        stats.errors.push(`remove batch (${batch.length} paths) failed: ${error.message}`);
        continue;
      }
      stats.deleted += batch.length;
      for (const p of batch) logFn(`[staging-sweep] deleted ${p}`);
    } catch (err) {
      stats.errors.push(`remove batch threw: ${(err as Error).message}`);
    }
  }

  return stats;
}

// ── Worker tick wrapper ─────────────────────────────────────────────

const SWEEP_INTERVAL_HOURS = 24;

interface SweepMarker {
  lastRunAt: string;
  /** Per-prefix resume offsets carried to the next sweep (S111 item 3). */
  cursors?: SweepCursors;
}

/** Mutable in-memory backoff holder (S111 item 1). Injectable for tests. */
export interface SweepBackoffState {
  lastRunMs: number;
}

// Module-level singleton: the real worker calls maybeRunStagingSweep with no
// backoffState, so every idle tick within one process shares this. It paces
// the 24h gate even when the file marker can't be persisted (so a broken disk
// doesn't trigger a claim attempt every 30s tick), and resets only on process
// restart (after which the durable file marker takes over — and a failed
// marker write fails CLOSED, so a respawn never re-sweeps blindly). Tests
// inject their own holder to stay order-independent.
const defaultBackoff: SweepBackoffState = { lastRunMs: 0 };

export interface MaybeSweepOptions {
  /** Marker file path; defaults to <cwd>/.staging-sweep-last. */
  markerPath?: string;
  logFn?: (msg: string) => void;
  /** Fixed clock (start === completion). Prefer clockFn for advancing time. */
  now?: Date;
  /**
   * Injectable clock, called once for the start timestamp and once for the
   * completion timestamp. Lets tests prove the post-sweep marker records
   * COMPLETION, not start. Defaults to the fixed `now` (if given) or wall-clock.
   */
  clockFn?: () => Date;
  /** Injected storage client (tests). When set, the env/creds path is skipped. */
  sb?: StorageSweepClientLike;
  /** Injected in-memory backoff holder (tests). Defaults to the module singleton. */
  backoffState?: SweepBackoffState;
}

/** Write the marker; returns true on success, false (logged) on failure. */
async function writeMarker(
  markerPath: string,
  marker: SweepMarker,
  logFn: (msg: string) => void,
): Promise<boolean> {
  try {
    await fs.writeFile(markerPath, JSON.stringify(marker));
    return true;
  } catch (err) {
    logFn(
      `[staging-sweep] marker write failed (non-fatal): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Worker-tick entry point: run the sweep at most once per 24h, gated by a
 * file-backed marker AND an in-memory backoff (S111 item 1 — the worker PID
 * rotates with every cron respawn so in-memory alone can't pace a daily task,
 * but the file marker alone fails open if its write fails; the gate keys on
 * the max of the two).
 *
 * The durable marker is CLAIMED before the sweep runs (S111 item 2): if the
 * claim write fails we SKIP (fail closed — Codex BLOCKING — rather than sweep
 * without a durable cadence record and re-sweep on the next respawn). After a
 * successful sweep the marker is re-written with the COMPLETION timestamp +
 * resume cursors (S111 item 3 + Codex clock-at-completion). Best-effort
 * throughout: never throws, never blocks job processing on failure.
 */
export async function maybeRunStagingSweep(
  opts: MaybeSweepOptions = {},
): Promise<{ ran: boolean; stats?: SweepStats }> {
  const logFn = opts.logFn ?? (() => {});
  const backoff = opts.backoffState ?? defaultBackoff;
  try {
    const markerPath =
      opts.markerPath ?? `${process.cwd()}/.staging-sweep-last`;
    // Clock: clockFn (advancing, for completion-time tests) > fixed now > wall.
    const fixedNow = opts.now;
    const readClock =
      opts.clockFn ?? (fixedNow ? () => fixedNow : () => new Date());
    const now = readClock();
    const nowMs = now.getTime();

    let fileLastMs = 0;
    let cursors: SweepCursors = {};
    try {
      const raw = await fs.readFile(markerPath, "utf-8");
      const marker = JSON.parse(raw) as SweepMarker;
      fileLastMs = Date.parse(marker.lastRunAt) || 0;
      if (marker.cursors && typeof marker.cursors === "object") {
        cursors = marker.cursors;
      }
    } catch {
      // Missing or corrupt marker → due now (subject to in-memory backoff).
    }

    // Gate on the MAX of file + in-memory backoff (item 1): a stale file
    // marker (write previously failed) is still paced by the live process.
    const effectiveLastMs = Math.max(fileLastMs, backoff.lastRunMs);
    if (nowMs - effectiveLastMs < SWEEP_INTERVAL_HOURS * 3_600_000) {
      return { ran: false };
    }

    let sb = opts.sb;
    if (!sb) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      if (!url || !key) {
        logFn("[staging-sweep] skipped: Supabase credentials not configured");
        return { ran: false };
      }
      sb = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }

    // ── Claim the 24h window BEFORE sweeping (items 1 + 2) ─────────────
    // In-memory first so a broken disk doesn't re-attempt the claim every 30s
    // tick. Then the DURABLE marker: if it can't be written we FAIL CLOSED and
    // skip — a GC backstop can wait for a healthy disk, and skipping beats
    // re-sweeping on every worker respawn (Codex BLOCKING). The pre-write keeps
    // the OLD cursors so a crash mid-sweep resumes from the same point next
    // time (idempotent).
    backoff.lastRunMs = nowMs;
    const claimed = await writeMarker(
      markerPath,
      { lastRunAt: now.toISOString(), cursors },
      logFn,
    );
    if (!claimed) {
      logFn(
        "[staging-sweep] skipped: could not persist durable run marker — failing closed (avoids re-sweep on worker respawn)",
      );
      return { ran: false };
    }

    logFn("[staging-sweep] due — sweeping expired staging uploads");
    const stats = await sweepStagingUploads(sb, { logFn, now, cursors });
    logFn(
      `[staging-sweep] done: orgs=${stats.orgsScanned} drafts=${stats.draftsScanned} ` +
        `files=${stats.filesScanned} expired=${stats.expired} deleted=${stats.deleted} ` +
        `errors=${stats.errors.length}${stats.truncated ? " TRUNCATED" : ""}`,
    );
    for (const e of stats.errors.slice(0, 10)) {
      logFn(`[staging-sweep] error: ${e}`);
    }

    // Re-stamp at COMPLETION so the 24h clock starts when the sweep finishes,
    // not when it began (Codex MAJOR — a >24h sweep would otherwise be due
    // again immediately). Best-effort: the durable window was already claimed
    // by the pre-write, so a failed post-write only loses cursor advancement
    // (next sweep re-resumes from the old cursors — idempotent).
    const finishedAt = readClock();
    backoff.lastRunMs = finishedAt.getTime();
    await writeMarker(
      markerPath,
      { lastRunAt: finishedAt.toISOString(), cursors: stats.nextCursors },
      logFn,
    );

    return { ran: true, stats };
  } catch (err) {
    logFn(`[staging-sweep] unexpected error (non-fatal): ${(err as Error).message}`);
    return { ran: false };
  }
}
