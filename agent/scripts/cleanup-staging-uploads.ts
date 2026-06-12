/**
 * S106 — manual CLI for the staging-TTL sweep (abandoned attachment drafts).
 *
 * Deletes objects under <orgId>/uploads/<draftId>/ older than
 * ATTACHMENTS.staging_ttl_hours (default 24h, conventions.json canonical).
 * Anything that old is garbage by construction: the submit route copies
 * staged files OUT of staging synchronously before inserting the queue row.
 *
 * The worker daemon runs the same sweep automatically (~once per 24h via
 * lib/staging-sweep.ts maybeRunStagingSweep). This wrapper exists for
 * manual/forced runs and for verifying the sweep during the Phase 3 E2E.
 *
 * SAFETY MODEL (same shape as phase-b-cleanup-legacy-storage-paths.ts):
 *   1. Default mode is dry-run: print what WOULD be deleted, do nothing.
 *   2. --confirm required for real DELETE.
 *   3. Only files under a UUID-shaped <org>/uploads/<draft>/ prefix are
 *      candidates — deliverables and sources/ are structurally out of scope.
 *   4. Files with unparseable timestamps are left in place (logged).
 *
 * S112 — the worker sweep is per-tick budget-bounded (so the GC walk can't
 * delay job polling). A human-invoked CLI run wants ONE complete pass, so this
 * wrapper LOOPS the bounded sweep, feeding each chunk's nextCursor into the
 * next, until a full circular-ring pass completes (rootOffset back to 0 with no
 * org left truncated). A small inter-chunk sleep paces the storage API
 * (Gemini Q4 — an unbounded single pass risks rate-limit / memory on a massive
 * tree).
 *
 * Usage:
 *   node --env-file=.env --import=tsx scripts/cleanup-staging-uploads.ts [--confirm] [--ttl-hours=N]
 *
 * Exit codes:
 *   0 — success (including zero candidates)
 *   1 — completed with errors (partial sweep; safe to re-run) or fatal
 *   3 — usage / env error
 */

import { createClient } from "@supabase/supabase-js";
import { sweepStagingUploads, type WalkCursor } from "../lib/staging-sweep.js";
import { ATTACHMENTS } from "../lib/conventions.js";

// ── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");

let ttlHours = ATTACHMENTS.staging_ttl_hours;
const unknown: string[] = [];
for (const a of args) {
  if (a === "--confirm") continue;
  const m = a.match(/^--ttl-hours=(\d+)$/);
  if (m) {
    ttlHours = Number(m[1]);
    continue;
  }
  unknown.push(a);
}
if (unknown.length > 0) {
  console.error(`unknown args: ${unknown.join(" ")}`);
  console.error("usage: cleanup-staging-uploads.ts [--confirm] [--ttl-hours=N]");
  process.exit(3);
}

// ── Env ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(3);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Safety backstop on the chunk loop: the ring is guaranteed to terminate
// (rootOffset wraps to 0 and orgResume empties on a full pass), but a very large
// tree at the default per-sweep budget could take many chunks. This cap prevents
// an unbounded loop if a bug ever broke termination; it is far above any real need.
const MAX_CHUNKS = 200_000;
const SLEEP_MS = 200;
// Stop the loop after this many CONSECUTIVE chunks that made no delete progress
// AND recorded errors — a persistent list failure must not retry to the chunk cap
// (MERGE-gate Codex MAJOR). Transient single-chunk errors are tolerated.
const MAX_ERROR_STREAK = 5;

function ringComplete(cursor: WalkCursor): boolean {
  return cursor.rootOffset === 0 && Object.keys(cursor.orgResume).length === 0;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = CONFIRM ? "delete" : "dry-run";
  console.log(
    `=== STAGING SWEEP — expired attachment drafts (mode=${mode}, ttl=${ttlHours}h) ===`,
  );

  const agg = {
    chunks: 0,
    orgsScanned: 0,
    draftsScanned: 0,
    filesScanned: 0,
    expired: 0,
    deleted: 0,
    wouldDelete: 0,
    requestsUsed: 0,
    errors: 0,
  };

  let cursor: WalkCursor | undefined;
  let lastErrors: string[] = [];
  // Per-RING accumulated deletions (a "ring" = the chunks from rootOffset 0 back
  // to 0). Quiescence = a COMPLETE ring that deleted NOTHING. Tracking per-ring
  // (not per-chunk) is required because deletes shrink the listing: a forward
  // resume offset can land past delete-shifted survivors, so a single chunk may
  // delete 0 mid-ring while files remain. A full from-0 ring that deletes 0 is the
  // only correct "drained" signal (MERGE-gate Codex BLOCKING — the CLI must not
  // false-complete on a delete-shift mid-ring EOF). Convergence is guaranteed:
  // every ring with survivors deletes >=1, and the total is finite.
  let ringDeleted = 0;
  let errorStreak = 0;
  let stopped = "";

  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const stats = await sweepStagingUploads(sb, {
      ttlHours,
      dryRun: !CONFIRM,
      logFn: (m) => console.log(m),
      startCursor: cursor,
    });
    agg.chunks += 1;
    agg.orgsScanned += stats.orgsScanned;
    agg.draftsScanned += stats.draftsScanned;
    agg.filesScanned += stats.filesScanned;
    agg.expired += stats.expired;
    agg.deleted += stats.deleted;
    agg.wouldDelete += stats.wouldDelete.length;
    agg.requestsUsed += stats.requestsUsed;
    agg.errors += stats.errors.length;
    lastErrors = stats.errors;

    const prevCursor = cursor;
    cursor = stats.nextCursor;
    ringDeleted += stats.deleted;
    const hadErrors = stats.errors.length > 0;
    // Forward progress = a delete OR the cursor moved (listing advanced). Using
    // `deleted===0` alone as the no-progress signal was wrong (QA MAJOR): a chunk
    // can scan fresh/unparseable files or advance the ring without deleting.
    const movedCursor = JSON.stringify(prevCursor ?? null) !== JSON.stringify(cursor);
    const madeProgress = stats.deleted > 0 || movedCursor;

    // On an errored chunk, a list failure leaves the cursor UNTOUCHED, so a
    // transient root error at {rootOffset:0, orgResume:{}} would make
    // ringComplete() true on cursor SHAPE alone and falsely "complete" the drain
    // (QA MAJOR). So: never treat an errored chunk as terminal; instead retry,
    // and only abort if errors RECUR with no forward progress.
    if (hadErrors) {
      if (!madeProgress) {
        if (++errorStreak >= MAX_ERROR_STREAK) {
          stopped = `stopped after ${errorStreak} consecutive error chunks with no progress — investigate + re-run`;
          break;
        }
      } else {
        errorStreak = 0;
      }
      if (chunk + 1 < MAX_CHUNKS) await new Promise((r) => setTimeout(r, SLEEP_MS));
      continue; // do NOT evaluate ringComplete on an errored chunk
    }
    errorStreak = 0;

    if (ringComplete(cursor)) {
      // dry-run never deletes, so one full clean ring lists the whole tree → done.
      // confirm-mode: stop only when a full ring deleted nothing (true drain).
      if (!CONFIRM || ringDeleted === 0) break;
      ringDeleted = 0; // ring deleted something → run another ring (delete-shift may hide survivors)
    }
    if (chunk + 1 >= MAX_CHUNKS) {
      stopped = `chunk cap (${MAX_CHUNKS}) reached — re-run to continue`;
      break;
    }
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`  chunks (sweeps): ${agg.chunks}`);
  console.log(`  list requests:   ${agg.requestsUsed}`);
  console.log(`  orgs scanned:    ${agg.orgsScanned}`);
  console.log(`  drafts scanned:  ${agg.draftsScanned}`);
  console.log(`  files scanned:   ${agg.filesScanned}`);
  console.log(`  expired:         ${agg.expired}`);
  if (mode === "dry-run") {
    console.log(`  WOULD delete:    ${agg.wouldDelete}`);
  } else {
    console.log(`  deleted:         ${agg.deleted}`);
  }
  console.log(`  errors:          ${agg.errors}`);
  if (stopped) console.log(`  ⚠ ${stopped}`);

  if (agg.errors > 0) {
    console.log("");
    console.log("=== ERRORS (last chunk) ===");
    for (const e of lastErrors.slice(0, 20)) console.log(`  ${e}`);
    if (lastErrors.length > 20) {
      console.log(`  (… ${lastErrors.length - 20} more in the final chunk)`);
    }
    process.exit(1);
  }

  if (mode === "dry-run") {
    console.log("\nDRY-RUN complete. Re-run with --confirm to execute the DELETE.");
  } else {
    console.log("\nSweep complete.");
  }
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  if ((err as Error).stack) console.error((err as Error).stack);
  process.exit(1);
});
