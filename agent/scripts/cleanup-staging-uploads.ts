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
 * Usage:
 *   node --env-file=.env --import=tsx scripts/cleanup-staging-uploads.ts [--confirm] [--ttl-hours=N]
 *
 * Exit codes:
 *   0 — success (including zero candidates)
 *   1 — completed with errors (partial sweep; safe to re-run) or fatal
 *   3 — usage / env error
 */

import { createClient } from "@supabase/supabase-js";
import { sweepStagingUploads } from "../lib/staging-sweep.js";
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

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = CONFIRM ? "delete" : "dry-run";
  console.log(
    `=== STAGING SWEEP — expired attachment drafts (mode=${mode}, ttl=${ttlHours}h) ===`,
  );

  const stats = await sweepStagingUploads(sb, {
    ttlHours,
    dryRun: !CONFIRM,
    logFn: (m) => console.log(m),
  });

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`  orgs scanned:    ${stats.orgsScanned}`);
  console.log(`  drafts scanned:  ${stats.draftsScanned}`);
  console.log(`  files scanned:   ${stats.filesScanned}`);
  console.log(`  expired:         ${stats.expired}`);
  if (mode === "dry-run") {
    console.log(`  WOULD delete:    ${stats.wouldDelete.length}`);
  } else {
    console.log(`  deleted:         ${stats.deleted}`);
  }
  console.log(`  errors:          ${stats.errors.length}`);
  if (stats.truncated) {
    console.log(
      "  ⚠ TRUNCATED: at least one storage list() hit its page limit — " +
        "re-run after this pass to catch the remainder.",
    );
  }

  if (stats.errors.length > 0) {
    console.log("");
    console.log("=== ERRORS ===");
    for (const e of stats.errors.slice(0, 20)) console.log(`  ${e}`);
    if (stats.errors.length > 20) {
      console.log(`  (… ${stats.errors.length - 20} more)`);
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
