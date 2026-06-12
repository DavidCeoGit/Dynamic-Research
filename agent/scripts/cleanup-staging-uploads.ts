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
 * S112/S113 — the worker sweep is per-tick budget-bounded (so the GC walk can't
 * delay job polling). A human-invoked CLI run wants ONE complete drain, so this
 * wrapper LOOPS the bounded sweep, feeding each chunk's nextCursor into the
 * next. Ring completion is detected by the cursor's GENERATION advancing
 * (ringGen increments at every root-EOF wrap); quiescence = a complete ring
 * with zero deletes AND zero errors. A small inter-chunk sleep paces the
 * storage API (Gemini Q4 — an unbounded single pass risks rate-limit / memory
 * on a massive tree).
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
// Delete-phase window per chunk (S113). The WORKER uses the module's 10s
// default because it must protect its 30s poll tick; a manual CLI run has no
// tick to protect, so slow-but-working remove() batches (large trees, slow
// networks) get 2 minutes per chunk before the per-call timeout treats them
// as hung — without this, every chunk on a slow link would time out, errors
// would recur, and the ring loop would grind without deleting.
const CLI_DELETE_WINDOW_MS = 120_000;

/**
 * Traversal-position shape for the stuck-loop check, with the volatile
 * generation fields STRIPPED (v3, Gemini gate BLOCKING): ringGen increments at
 * every ring EOF and entry gens re-stamp on every org visit, so a raw cursor
 * compare reads "progress" on every chunk even when the walk is going nowhere
 * — which would defeat the error-streak backstop forever.
 */
function traversalShape(c: WalkCursor | undefined): string {
  if (!c) return "null";
  const orgResume: Record<string, { draftOffset: number; fileOffset: number }> = {};
  for (const k of Object.keys(c.orgResume).sort()) {
    const v = c.orgResume[k];
    orgResume[k] = { draftOffset: v.draftOffset, fileOffset: v.fileOffset };
  }
  return JSON.stringify({ rootOffset: c.rootOffset, orgResume });
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
  // Per-RING accumulated deletions + errors. A "ring" is detected by the
  // GENERATION ADVANCING (cursor.ringGen increments at every root-EOF wrap) —
  // NOT by orgResume emptying (v3, Gemini gate BLOCKING: a persistently-errored
  // org keeps an orgResume entry forever, so the old emptiness test never fired
  // and the loop spun toward the chunk cap). Quiescence = a COMPLETE ring with
  // ZERO deletes AND ZERO errors. Per-ring (not per-chunk) tracking is required
  // because deletes shrink the listing: a delete-shift can make a single
  // mid-ring chunk delete 0 while files remain (MERGE-gate Codex BLOCKING). A
  // ring that deleted nothing but HAD errors is a loud stop (exit 1), never a
  // false "Sweep complete."
  let ringDeleted = 0;
  let ringErrors = 0;
  let errorStreak = 0;
  let stopped = "";

  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const stats = await sweepStagingUploads(sb, {
      ttlHours,
      dryRun: !CONFIRM,
      logFn: (m) => console.log(m),
      startCursor: cursor,
      maxDeleteMillis: CLI_DELETE_WINDOW_MS,
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
    ringErrors += stats.errors.length;
    const hadErrors = stats.errors.length > 0;
    // Forward progress = a delete OR the TRAVERSAL position moved. The compare
    // strips the volatile generation fields (see traversalShape) so gen churn
    // cannot mask a genuinely stuck loop. Using `deleted===0` alone was wrong
    // (S112 QA MAJOR): a chunk can advance the ring without deleting.
    const movedCursor = traversalShape(prevCursor) !== traversalShape(cursor);
    const madeProgress = stats.deleted > 0 || movedCursor;

    // Recurring errors with NO forward progress (e.g. a persistent ROOT list
    // failure pins the cursor in place) abort fast instead of retrying to the
    // chunk cap (S112 Codex MAJOR).
    if (hadErrors && !madeProgress) {
      if (++errorStreak >= MAX_ERROR_STREAK) {
        stopped = `stopped after ${errorStreak} consecutive error chunks with no progress — investigate + re-run`;
        break;
      }
    } else {
      errorStreak = 0;
    }

    // Ring boundary = the generation advanced (root-EOF wrap; a transient root
    // error leaving the cursor at its seeded shape does not advance the gen —
    // no false-complete, S112 QA MAJOR). Two distinct checks at a wrap:
    //  - LOUD STOP: a whole accumulation window with errors and zero deletes —
    //    a persistently-failing prefix keeps its orgResume entry forever, so
    //    waiting for an "empty" evaluation point would spin to the chunk cap
    //    (v3 Gemini BLOCKING). Exit 1 via the summary's error count.
    //  - EVALUATION POINT: a wrap with NO org mid-drain. Only here do the
    //    per-window accumulators reset, and only here can the drain succeed:
    //    a wrap with in-flight orgResume entries (tight budgets) or a window
    //    whose deletes happened before a delete-shift cleared entries at a
    //    false-EOF must keep accumulating — resetting at every wrap was the
    //    v3b false-drain (210/240 in the suite's delete-shift replication).
    const ringWrapped = (cursor.ringGen ?? 0) > (prevCursor?.ringGen ?? 0);
    if (ringWrapped) {
      if (ringDeleted === 0 && ringErrors > 0) {
        stopped = `completed a full ring with ${ringErrors} error(s) and no deletes — investigate + re-run`;
        break;
      }
      if (Object.keys(cursor.orgResume).length === 0) {
        if (ringDeleted === 0 && ringErrors === 0) {
          // True drain: an error-free window reclaimed nothing and no org is
          // mid-drain. (dry-run never deletes, so its first error-free
          // in-progress-free ring — a full listing — ends here.)
          break;
        }
        ringDeleted = 0; // evaluation point → next window (delete-shift may hide survivors)
        ringErrors = 0;
      }
      // wrap with in-flight orgs → keep accumulating, no reset
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

  // ANY premature stop (chunk cap, error-streak — even with agg.errors==0) is
  // a partial sweep, not a success: the loop did not reach an evaluation-point
  // drain, so exit 1 per the header's exit-code contract (v4, Codex MAJOR —
  // a capped no-error run previously printed "Sweep complete." and exited 0).
  if (stopped) {
    console.log(`\nPartial sweep — ${stopped}`);
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
