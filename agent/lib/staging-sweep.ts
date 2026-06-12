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
 * ── S111 sweep-hardening trio (carried forward) ──────────────────────
 *   1. Marker-write-failure → FAIL CLOSED (the durable 24h marker is CLAIMED
 *      before the sweep; a failed claim SKIPS rather than re-sweeping on every
 *      respawn). A module-level in-memory backoff paces a single process.
 *   2. Marker-before-sweep (claim the window first so a process-crashing OOM
 *      sweep can't crash-loop the worker; re-stamp at COMPLETION).
 *   3. Stable resume cursor for truncated listings.
 *
 * ── S112 per-sweep budget + breadth-fair circular-ring resume ─────────
 * The S111 KNOWN LIMITATION (Gemini #2 / Codex MAJOR, deferred by owner) is
 * CLOSED here. Total sweep work is now bounded so the GC walk can never delay
 * the worker's idle-tick job polling on a pathological tree (one org with tens
 * of thousands of abandoned drafts). Design + dual-reviewer gate:
 * Documentation/sweep-fanout-budget-design-gate{,-peer-review}.md.
 *
 * Model (replaces the S111 per-prefix `Record<prefix,offset>` map):
 *   - ONE PAGE PER REQUEST. Each list() pulls a single LIST_LIMIT page; the
 *     walk descends/continues page by page. No multi-page accumulation (the old
 *     MAX_PAGES loop, under a request budget, re-fetched discarded pages — a
 *     thrash; Gemini #2). Memory is O(page × depth).
 *   - BUDGET counted at EVERY list level (root, uploads/, per-draft files):
 *     a global request cap (maxRequests) + wall-clock cap (maxMillis) bound the
 *     whole sweep; a per-org cap (maxRequestsPerOrg) bounds any single tenant so
 *     a giant org yields and other orgs are still serviced this sweep (Codex #3:
 *     the cap MUST count file-list calls — a 50k-draft org is 50k file lists).
 *   - BREADTH-FAIR CIRCULAR RING over orgs (Gemini #1 fairness; Codex #1/#2):
 *     `rootOffset` is a raw root-listing position that advances past EVERY root
 *     page (incl. org-less ones) and WRAPS to 0 at root EOF from ANY start —
 *     so no tenant is starved and the pointer can't strand past the end. Per-org
 *     in-progress position lives in `orgResume[orgId] = {draftOffset,fileOffset}`.
 *   - RAW-OFFSET resume (Codex #4): resume offsets index the unfiltered listing
 *     position (junk/non-UUID entries occupy a raw index), never the filtered
 *     array index — otherwise resume steps backward / loops.
 *   - ORPHAN PRUNE (Codex #5) only after a COMPLETE offset-0 → all-pages-EOF
 *     root pass with no error and no budget stop (a partial view must not drop a
 *     live org's resume entry).
 *   - SAFETY FLOOR (Codex-confirmed): the destructive core (UUID org/draft
 *     filters, `uploads` staging prefix, metadata-file filter, stampMs < cutoff)
 *     is UNCHANGED, so a resume-math bug is at worst a transient miss reclaimed
 *     on the next ring wrap — never an over-delete of a live file.
 *   - DELETE-SHIFT CONVERGENCE (MERGE-gate Codex BLOCKING): a remove() shrinks
 *     the listing (Supabase folders are virtual — a draft/org folder vanishes when
 *     its last object is deleted), so a forward resume offset persisted across a
 *     delete can land PAST the survivors that shifted left → that one sweep
 *     under-deletes and the orgResume entry clears on the false-EOF. The NEXT
 *     from-0 visit re-lists the shifted-left survivors and reclaims them; each
 *     ring with survivors deletes >=1, so the worker provably DRAINS EVERY expired
 *     file over successive 24h sweeps (verified to 50k drafts in the suite — see
 *     "WORKER converges" test). It is bounded EVENTUAL coverage, not single-pass:
 *     a pathological tenant drains slowly (fairness + tick-protection > drain
 *     speed; raise the caps if faster reclamation is ever needed). The MANUAL CLI
 *     (cleanup-staging-uploads.ts) therefore loops until a COMPLETE RING deletes
 *     nothing (per-ring, not per-chunk) so a delete-shift mid-ring EOF cannot make
 *     it report a false "drained."
 */

import * as fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { ATTACHMENTS, BUCKET } from "./conventions.js";

// Same canonical UUID shape as storage-paths.ts (kept private there; the
// two must stay in sync — it only ever matches real org/draft ids).
const UUID_SHAPE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Supabase storage list() page size. The walk lists exactly ONE page per
// request (S112) — name-sorted UUIDs carry no age correlation, so a fixed
// single page once a prefix exceeds 1000 would starve the tail; the budgeted
// ring instead pages through everything across sweeps via the resume cursor.
const LIST_LIMIT = 1000;
// Bulk-delete batch size (single DELETE calls 400 on empty-body+JSON CT —
// always use the bulk endpoint; see feedback_supabase_storage_bulk_delete).
const DELETE_BATCH = 100;

// ── Per-sweep budget defaults (S112) ─────────────────────────────────
// maxMillis is the PRIMARY tick-delay guard (bounds wall-clock to well under
// the 30s poll interval). maxRequests is a deterministic backup bound.
// maxRequestsPerOrg enforces multi-tenant fairness (a giant org yields after
// this many list calls so other orgs are serviced). At realistic scale a sweep
// finishes far below any cap and behaves exactly as before. See design §5.
//
// SAFE FLOORS (MERGE-gate Codex MINOR): the worker + CLI always use these
// defaults. A 3-level tree needs >=3 list calls (root + uploads + files) to reach
// a leaf, so maxRequests<3 / maxRequestsPerOrg<2 cannot make leaf progress and are
// UNSAFE — they exist only for unit tests that exercise the cursor mechanics on
// sub-budget slices (the prod callers never pass sub-floor values). maxMillis must
// be > 0. These are not clamped (clamping would defeat those mechanics tests); they
// are simply never supplied below the floor by any production path.
const MAX_REQUESTS = 300;
const MAX_REQUESTS_PER_ORG = 50;
const MAX_MILLIS = 15_000;

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

/** Per-org in-progress walk position (raw offsets), set when an org is not
 *  fully drained in a sweep; cleared when it drains completely. */
export interface OrgResume {
  draftOffset: number;
  fileOffset: number;
}

/**
 * Resume state persisted in the marker between sweeps (S112). Replaces the
 * S111 `SweepCursors = Record<prefix, offset>` map.
 *   - rootOffset: raw root-listing position where the next sweep resumes
 *     scanning org folders. Circular — advances per root page (incl. org-less
 *     pages) and wraps to 0 at root EOF from any start.
 *   - orgResume: per-org {draftOffset, fileOffset} for orgs truncated this
 *     sweep. Keyed by org id; cardinality ≈ tenant count. Pruned (orphan org
 *     folders) only after a complete offset-0 all-pages-EOF root pass.
 */
export interface WalkCursor {
  rootOffset: number;
  orgResume: Record<string, OrgResume>;
}

export interface SweepStats {
  orgsScanned: number;
  draftsScanned: number;
  filesScanned: number;
  expired: number;
  deleted: number;
  /** Accumulated non-fatal errors (list/remove failures). */
  errors: string[];
  /** Storage list() calls issued this sweep (the budgeted unit). */
  requestsUsed: number;
  /** True if the GLOBAL budget (maxRequests/maxMillis) tripped this sweep. */
  budgetExhausted: boolean;
  /** Resume cursor to persist for the NEXT sweep (circular ring + per-org). */
  nextCursor: WalkCursor;
  /** Populated in dryRun mode with the paths that WOULD be deleted. */
  wouldDelete: string[];
}

export interface SweepOptions {
  ttlHours?: number;
  now?: Date;
  dryRun?: boolean;
  logFn?: (msg: string) => void;
  /** Global per-sweep request cap (default MAX_REQUESTS). */
  maxRequests?: number;
  /** Per-org request cap for fairness (default MAX_REQUESTS_PER_ORG). */
  maxRequestsPerOrg?: number;
  /** Global wall-clock cap in ms (default MAX_MILLIS). */
  maxMillis?: number;
  /** Injectable clock for the elapsed/maxMillis check (defaults to `now` or wall-clock). */
  clockFn?: () => Date;
  /** Resume cursor from the prior sweep's nextCursor. */
  startCursor?: WalkCursor;
}

type DrainReason = "GLOBAL" | "PER_ORG" | "ERROR" | "DONE";

/** Shared mutable walk context — threaded through the ring + drain helpers. */
interface SweepCtx {
  sb: StorageSweepClientLike;
  cutoffMs: number;
  maxRequests: number;
  maxRequestsPerOrg: number;
  maxMillis: number;
  clock: () => Date;
  t0: number;
  stats: SweepStats;
  cursor: WalkCursor;
  expiredPaths: string[];
  /** List calls spent on the CURRENT org (reset at each org entry). */
  perOrg: number;
}

/** Global budget predicate — request count OR wall-clock. */
function overGlobalBudget(ctx: SweepCtx): boolean {
  return (
    ctx.stats.requestsUsed >= ctx.maxRequests ||
    ctx.clock().getTime() - ctx.t0 >= ctx.maxMillis
  );
}

/** Reject `p` if it doesn't settle within `ms` (timer unref'd + cleared). */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    // unref so a pending storage call can't keep the worker process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * List exactly one page. Increments the global request counter (the single
 * place a list is counted — a thrown/timed-out list still consumes a budget
 * unit BY DESIGN, so an error storm can't spin a prefix for free; the worker
 * just waits for the next 24h sweep). Never throws (S106 Codex MAJOR #3): a
 * resolved {error}, a rejected promise, AND a wall-clock timeout all degrade to
 * {error:true} + a recorded stats.errors entry; the caller then leaves the
 * relevant cursor UNTOUCHED so the same region is retried next sweep (deletes
 * are idempotent).
 *
 * The per-call timeout (breadth-review F1) bounds a SINGLE hung list() to the
 * remaining wall-clock budget — maxMillis is otherwise only sampled BETWEEN
 * calls, so without this one stalled storage call (up to the HTTP client's own
 * long default timeout) could delay the worker's idle tick past maxMillis,
 * defeating the headline tick-protection guarantee. Tests resolve list()
 * synchronously, so the timer never fires.
 */
async function listPage(
  ctx: SweepCtx,
  prefix: string,
  offset: number,
): Promise<{ items: ListedObject[]; eof: boolean; error: boolean }> {
  ctx.stats.requestsUsed += 1;
  const remainingMs = ctx.maxMillis - (ctx.clock().getTime() - ctx.t0);
  try {
    const listCall = ctx.sb.storage.from(BUCKET).list(prefix, {
      limit: LIST_LIMIT,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    const { data, error } =
      remainingMs > 0
        ? await withTimeout(listCall, remainingMs, `list exceeded maxMillis budget (${remainingMs}ms left)`)
        : await listCall;
    if (error) throw new Error(error.message);
    const items = data ?? [];
    return { items, eof: items.length < LIST_LIMIT, error: false };
  } catch (err) {
    ctx.stats.errors.push(
      `list(${prefix || "<root>"}@${offset}) failed: ${(err as Error).message}`,
    );
    return { items: [], eof: false, error: true };
  }
}

/** Collect expired file paths from a draft's listed objects (predicate UNCHANGED). */
function collectExpired(
  ctx: SweepCtx,
  draftPrefix: string,
  files: ListedObject[],
): void {
  for (const file of files) {
    ctx.stats.filesScanned += 1;
    const stamp = file.created_at ?? file.updated_at ?? null;
    const stampMs = stamp ? Date.parse(stamp) : NaN;
    if (Number.isNaN(stampMs)) {
      // Unknown age — leave it; better an orphan than deleting a file some
      // live draft is about to submit.
      ctx.stats.errors.push(
        `${draftPrefix}/${file.name}: unparseable created_at, left in place`,
      );
      continue;
    }
    if (stampMs < ctx.cutoffMs) {
      ctx.stats.expired += 1;
      ctx.expiredPaths.push(`${draftPrefix}/${file.name}`);
    }
  }
}

/** Page a single draft's files from fileStart; counts each list at global+per-org. */
async function drainDraftFiles(
  ctx: SweepCtx,
  draftPrefix: string,
  fileStart: number,
): Promise<{ complete: boolean; fileOffset: number; files: ListedObject[]; reason: DrainReason }> {
  const files: ListedObject[] = [];
  let fileOffset = fileStart;
  for (;;) {
    if (overGlobalBudget(ctx))
      return { complete: false, fileOffset, files, reason: "GLOBAL" };
    if (ctx.perOrg >= ctx.maxRequestsPerOrg)
      return { complete: false, fileOffset, files, reason: "PER_ORG" };
    const page = await listPage(ctx, draftPrefix, fileOffset);
    ctx.perOrg += 1;
    if (page.error)
      return { complete: false, fileOffset, files, reason: "ERROR" };
    for (const e of page.items) if (e.metadata !== null) files.push(e);
    if (page.eof) return { complete: true, fileOffset: 0, files, reason: "DONE" };
    fileOffset += page.items.length;
  }
}

/** Bounded two-level walk of one org (drafts → files) from its resume position. */
async function drainOrg(
  ctx: SweepCtx,
  orgId: string,
  resume: OrgResume,
): Promise<{ complete: boolean; resume: OrgResume; reason: DrainReason }> {
  const stagingRoot = `${orgId}/${ATTACHMENTS.staging_prefix}`;
  let draftOffset = resume.draftOffset;
  let firstDraft = true;
  for (;;) {
    if (overGlobalBudget(ctx))
      return { complete: false, resume: { draftOffset, fileOffset: 0 }, reason: "GLOBAL" };
    if (ctx.perOrg >= ctx.maxRequestsPerOrg)
      return { complete: false, resume: { draftOffset, fileOffset: 0 }, reason: "PER_ORG" };
    const page = await listPage(ctx, stagingRoot, draftOffset);
    ctx.perOrg += 1;
    if (page.error)
      return { complete: false, resume: { draftOffset, fileOffset: 0 }, reason: "ERROR" };
    for (let rawIdx = 0; rawIdx < page.items.length; rawIdx++) {
      const entry = page.items[rawIdx];
      if (!(entry.metadata === null && UUID_SHAPE_REGEX.test(entry.name))) continue;
      ctx.stats.draftsScanned += 1;
      const draftPrefix = `${stagingRoot}/${entry.name}`;
      const fileStart = firstDraft ? resume.fileOffset : 0;
      firstDraft = false;
      const f = await drainDraftFiles(ctx, draftPrefix, fileStart);
      // Files seen this call are real candidates already listed; collect them.
      // On resume we continue past f.fileOffset, so there is no double-collect.
      collectExpired(ctx, draftPrefix, f.files);
      if (!f.complete) {
        // Re-list THIS draft's raw offset next time; resume its files at f.fileOffset.
        return {
          complete: false,
          resume: { draftOffset: draftOffset + rawIdx, fileOffset: f.fileOffset },
          reason: f.reason,
        };
      }
    }
    if (page.eof)
      return { complete: true, resume: { draftOffset: 0, fileOffset: 0 }, reason: "DONE" };
    draftOffset += page.items.length;
  }
}

/**
 * Delete staged attachment files older than the TTL, bounded by a per-sweep
 * budget with breadth-fair circular-ring resume (S112). Best-effort: list and
 * remove failures accumulate in stats.errors; the sweep continues. Never throws
 * on storage-layer failures.
 */
export async function sweepStagingUploads(
  sb: StorageSweepClientLike,
  opts: SweepOptions = {},
): Promise<SweepStats> {
  const ttlHours = opts.ttlHours ?? ATTACHMENTS.staging_ttl_hours;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const logFn = opts.logFn ?? (() => {});
  const clock = opts.clockFn ?? (opts.now ? () => now : () => new Date());
  const maxRequests = opts.maxRequests ?? MAX_REQUESTS;
  const maxRequestsPerOrg = opts.maxRequestsPerOrg ?? MAX_REQUESTS_PER_ORG;
  const maxMillis = opts.maxMillis ?? MAX_MILLIS;
  const cutoffMs = now.getTime() - ttlHours * 3_600_000;

  const startRootOffset = opts.startCursor?.rootOffset ?? 0;
  const startOrgResume = opts.startCursor?.orgResume ?? {};

  const stats: SweepStats = {
    orgsScanned: 0,
    draftsScanned: 0,
    filesScanned: 0,
    expired: 0,
    deleted: 0,
    errors: [],
    requestsUsed: 0,
    budgetExhausted: false,
    // The cursor is mutated in place as orgs drain/truncate; rootOffset is
    // finalized at the end. Seeded from the incoming cursor.
    nextCursor: { rootOffset: startRootOffset, orgResume: { ...startOrgResume } },
    wouldDelete: [],
  };

  const ctx: SweepCtx = {
    sb,
    cutoffMs,
    maxRequests,
    maxRequestsPerOrg,
    maxMillis,
    clock,
    t0: clock().getTime(),
    stats,
    cursor: stats.nextCursor,
    expiredPaths: [],
    perOrg: 0,
  };

  const cursor = stats.nextCursor;
  const startedAt0 = startRootOffset === 0;
  let rootOffset = startRootOffset;
  const seenOrgIds = new Set<string>();
  let rootEOF = false;

  // ── Circular-ring root scan, one page per request ──────────────────
  rootLoop: for (;;) {
    if (overGlobalBudget(ctx)) {
      // Tripped between root pages → resume at the next unscanned page.
      cursor.rootOffset = rootOffset;
      stats.budgetExhausted = true;
      break;
    }
    const page = await listPage(ctx, "", rootOffset);
    if (page.error) {
      // Retry this same root page next sweep; keep progress on earlier pages.
      cursor.rootOffset = rootOffset;
      break;
    }
    for (let rawIdx = 0; rawIdx < page.items.length; rawIdx++) {
      const entry = page.items[rawIdx];
      if (!(entry.metadata === null && UUID_SHAPE_REGEX.test(entry.name))) continue;
      const orgId = entry.name;
      stats.orgsScanned += 1;
      seenOrgIds.add(orgId);
      ctx.perOrg = 0;
      const resume = cursor.orgResume[orgId] ?? { draftOffset: 0, fileOffset: 0 };
      const r = await drainOrg(ctx, orgId, resume);
      if (r.complete) {
        delete cursor.orgResume[orgId];
      } else {
        cursor.orgResume[orgId] = r.resume;
        if (r.reason === "GLOBAL") {
          // Global budget tripped inside this org → re-list THIS root page and
          // re-find the org by id next sweep; its draft/file progress is saved.
          cursor.rootOffset = rootOffset + rawIdx;
          stats.budgetExhausted = true;
          break rootLoop;
        }
        // PER_ORG or ERROR: this org yields; continue to the next org in page.
      }
    }
    if (page.eof) {
      rootEOF = true;
      break;
    }
    // Advance past the WHOLE raw page (incl. org-less / junk pages) so a long
    // run of non-UUID root entries can never re-fetch forever (Codex #2).
    rootOffset += page.items.length;
  }

  if (rootEOF) {
    // Completed the root ring this sweep. Prune orphan org cursors ONLY after a
    // true offset-0 → all-pages-EOF pass with no error/budget-stop (Codex #5):
    // a partial view must not drop a live org's resume entry.
    if (startedAt0 && !stats.budgetExhausted) {
      for (const key of Object.keys(cursor.orgResume)) {
        if (!seenOrgIds.has(key)) delete cursor.orgResume[key];
      }
    }
    // Circular wrap from ANY start so the pointer can never strand past the
    // end (Codex #1). Independent of whether any org remains truncated.
    cursor.rootOffset = 0;
  }

  if (dryRun) {
    stats.wouldDelete = ctx.expiredPaths;
    for (const p of ctx.expiredPaths) logFn(`[staging-sweep] WOULD DELETE: ${p}`);
    return stats;
  }

  for (let i = 0; i < ctx.expiredPaths.length; i += DELETE_BATCH) {
    const batch = ctx.expiredPaths.slice(i, i + DELETE_BATCH);
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
  /** Circular-ring resume cursor carried to the next sweep (S112). */
  walkCursor?: WalkCursor;
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
   * Injectable clock, called for the start timestamp, the sweep elapsed check,
   * and the completion timestamp. Lets tests prove the post-sweep marker records
   * COMPLETION, not start. Defaults to the fixed `now` (if given) or wall-clock.
   */
  clockFn?: () => Date;
  /** Injected storage client (tests). When set, the env/creds path is skipped. */
  sb?: StorageSweepClientLike;
  /** Injected in-memory backoff holder (tests). Defaults to the module singleton. */
  backoffState?: SweepBackoffState;
}

/** A valid resume offset is a non-negative integer (breadth-review F6: a
 *  hand-corrupted marker like `rootOffset:-5` would otherwise reach list()). */
const isValidOffset = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Read + validate a WalkCursor from a parsed marker; undefined if absent/legacy/corrupt. */
function readWalkCursor(marker: SweepMarker): WalkCursor | undefined {
  const wc = marker.walkCursor;
  if (!wc || typeof wc !== "object" || !isValidOffset(wc.rootOffset)) {
    return undefined;
  }
  const orgResume: Record<string, OrgResume> = {};
  if (wc.orgResume && typeof wc.orgResume === "object") {
    for (const [k, v] of Object.entries(wc.orgResume)) {
      if (
        v &&
        typeof v === "object" &&
        isValidOffset((v as OrgResume).draftOffset) &&
        isValidOffset((v as OrgResume).fileOffset)
      ) {
        orgResume[k] = { draftOffset: (v as OrgResume).draftOffset, fileOffset: (v as OrgResume).fileOffset };
      }
    }
  }
  return { rootOffset: wc.rootOffset, orgResume };
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
 * claim write fails we SKIP (fail closed — Codex BLOCKING). The pre-write keeps
 * the INCOMING walkCursor so a crash mid-sweep resumes idempotently (S112,
 * Gemini Q5). After a successful sweep the marker is re-written with the
 * COMPLETION timestamp + the advanced walkCursor. Best-effort throughout:
 * never throws, never blocks job processing on failure.
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
    let cursor: WalkCursor | undefined;
    try {
      const raw = await fs.readFile(markerPath, "utf-8");
      const marker = JSON.parse(raw) as SweepMarker;
      fileLastMs = Date.parse(marker.lastRunAt) || 0;
      // Legacy S111 markers carry `cursors` (the prefix map) and no walkCursor
      // → cursor stays undefined → fresh ring (a one-time progress reset; never
      // over-deletes, restarts from 0).
      cursor = readWalkCursor(marker);
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
    // skip (Codex BLOCKING). The pre-write keeps the INCOMING cursor so a crash
    // mid-sweep resumes from the same point next time (idempotent).
    backoff.lastRunMs = nowMs;
    const claimed = await writeMarker(
      markerPath,
      { lastRunAt: now.toISOString(), walkCursor: cursor },
      logFn,
    );
    if (!claimed) {
      logFn(
        "[staging-sweep] skipped: could not persist durable run marker — failing closed (avoids re-sweep on worker respawn)",
      );
      return { ran: false };
    }

    logFn("[staging-sweep] due — sweeping expired staging uploads");
    const stats = await sweepStagingUploads(sb, {
      logFn,
      now,
      clockFn: readClock,
      startCursor: cursor,
    });
    logFn(
      `[staging-sweep] done: orgs=${stats.orgsScanned} drafts=${stats.draftsScanned} ` +
        `files=${stats.filesScanned} expired=${stats.expired} deleted=${stats.deleted} ` +
        `requests=${stats.requestsUsed} errors=${stats.errors.length}` +
        `${stats.budgetExhausted ? " BUDGET-EXHAUSTED" : ""}`,
    );
    for (const e of stats.errors.slice(0, 10)) {
      logFn(`[staging-sweep] error: ${e}`);
    }

    // Re-stamp at COMPLETION so the 24h clock starts when the sweep finishes,
    // not when it began (Codex MAJOR — a >24h sweep would otherwise be due
    // again immediately). Clamp to >= the claim time (breadth-review F4) so a
    // BACKWARD wall-clock step (NTP/VM correction) between claim and completion
    // can't stamp an EARLIER time and shorten the 24h gate. Best-effort: the
    // durable window was already claimed by the pre-write, so a failed post-write
    // only loses cursor advancement (next sweep re-resumes from the old cursor).
    const completedMs = Math.max(nowMs, readClock().getTime());
    backoff.lastRunMs = completedMs;
    await writeMarker(
      markerPath,
      { lastRunAt: new Date(completedMs).toISOString(), walkCursor: stats.nextCursor },
      logFn,
    );

    return { ran: true, stats };
  } catch (err) {
    logFn(`[staging-sweep] unexpected error (non-fatal): ${(err as Error).message}`);
    return { ran: false };
  }
}
