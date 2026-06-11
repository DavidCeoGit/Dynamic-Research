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
// prefix; hitting it sets stats.truncated so the shortfall is never silent.
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
  /** Populated in dryRun mode with the paths that WOULD be deleted. */
  wouldDelete: string[];
}

export interface SweepOptions {
  ttlHours?: number;
  now?: Date;
  dryRun?: boolean;
  logFn?: (msg: string) => void;
}

async function listPrefix(
  sb: StorageSweepClientLike,
  prefix: string,
  stats: SweepStats,
): Promise<ListedObject[]> {
  const all: ListedObject[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    // try/catch in addition to {error} inspection: a REJECTED list()
    // (network throw, client bug) must also degrade to a recorded error —
    // never escape the sweep's never-throws contract (S106 Codex MAJOR #3).
    let items: ListedObject[];
    try {
      const { data, error } = await sb.storage.from(BUCKET).list(prefix, {
        limit: LIST_LIMIT,
        offset: page * LIST_LIMIT,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(error.message);
      items = data ?? [];
    } catch (err) {
      stats.errors.push(
        `list(${prefix || "<root>"}) failed: ${(err as Error).message}`,
      );
      return all;
    }
    all.push(...items);
    if (items.length < LIST_LIMIT) return all;
  }
  // MAX_PAGES full pages — more may remain; surface it, never silently stop.
  stats.truncated = true;
  stats.errors.push(
    `list(${prefix || "<root>"}) exceeded ${MAX_PAGES * LIST_LIMIT} entries — remainder deferred to next sweep`,
  );
  return all;
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
  const cutoffMs = now.getTime() - ttlHours * 3_600_000;

  const stats: SweepStats = {
    orgsScanned: 0,
    draftsScanned: 0,
    filesScanned: 0,
    expired: 0,
    deleted: 0,
    errors: [],
    truncated: false,
    wouldDelete: [],
  };

  const expiredPaths: string[] = [];

  const rootEntries = await listPrefix(sb, "", stats);
  const orgFolders = rootEntries.filter(
    (e) => e.metadata === null && UUID_SHAPE_REGEX.test(e.name),
  );

  for (const org of orgFolders) {
    stats.orgsScanned += 1;
    const stagingRoot = `${org.name}/${ATTACHMENTS.staging_prefix}`;
    const draftEntries = await listPrefix(sb, stagingRoot, stats);
    const draftFolders = draftEntries.filter(
      (e) => e.metadata === null && UUID_SHAPE_REGEX.test(e.name),
    );

    for (const draft of draftFolders) {
      stats.draftsScanned += 1;
      const draftPrefix = `${stagingRoot}/${draft.name}`;
      const files = (await listPrefix(sb, draftPrefix, stats)).filter(
        (e) => e.metadata !== null,
      );

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
}

export interface MaybeSweepOptions {
  /** Marker file path; defaults to <cwd>/.staging-sweep-last. */
  markerPath?: string;
  logFn?: (msg: string) => void;
  now?: Date;
}

/**
 * Worker-tick entry point: run the sweep at most once per 24h, gated by a
 * file-backed marker (the worker PID rotates with every cron respawn, so
 * in-memory state can't pace a daily task). The marker is written after
 * every attempt — success OR failure — so a failing sweep retries tomorrow
 * instead of hammering storage on every 30s poll. Best-effort: never
 * throws, never blocks job processing on failure.
 */
export async function maybeRunStagingSweep(
  opts: MaybeSweepOptions = {},
): Promise<{ ran: boolean; stats?: SweepStats }> {
  const logFn = opts.logFn ?? (() => {});
  try {
    const markerPath =
      opts.markerPath ?? `${process.cwd()}/.staging-sweep-last`;
    const now = opts.now ?? new Date();

    let lastRunMs = 0;
    try {
      const raw = await fs.readFile(markerPath, "utf-8");
      const marker = JSON.parse(raw) as SweepMarker;
      lastRunMs = Date.parse(marker.lastRunAt) || 0;
    } catch {
      // Missing or corrupt marker → due now.
    }
    if (now.getTime() - lastRunMs < SWEEP_INTERVAL_HOURS * 3_600_000) {
      return { ran: false };
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) {
      logFn("[staging-sweep] skipped: Supabase credentials not configured");
      return { ran: false };
    }
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    logFn("[staging-sweep] due — sweeping expired staging uploads");
    const stats = await sweepStagingUploads(sb, { logFn, now });
    logFn(
      `[staging-sweep] done: orgs=${stats.orgsScanned} drafts=${stats.draftsScanned} ` +
        `files=${stats.filesScanned} expired=${stats.expired} deleted=${stats.deleted} ` +
        `errors=${stats.errors.length}${stats.truncated ? " TRUNCATED" : ""}`,
    );
    for (const e of stats.errors.slice(0, 10)) {
      logFn(`[staging-sweep] error: ${e}`);
    }

    await fs
      .writeFile(markerPath, JSON.stringify({ lastRunAt: now.toISOString() }))
      .catch((err) => {
        logFn(
          `[staging-sweep] marker write failed (non-fatal): ${(err as Error).message}`,
        );
      });

    return { ran: true, stats };
  } catch (err) {
    logFn(`[staging-sweep] unexpected error (non-fatal): ${(err as Error).message}`);
    return { ran: false };
  }
}
