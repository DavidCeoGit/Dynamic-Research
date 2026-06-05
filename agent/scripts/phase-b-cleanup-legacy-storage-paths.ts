/**
 * Phase B / S51 — Legacy storage path cleanup: DELETE flat-layout objects
 * after the 30-day soak window completes.
 *
 * DELETES every object under the legacy flat layout
 *     research-projects/<topic_slug>/<file>
 * AFTER confirming that the org-prefixed copy exists at matching size:
 *     research-projects/<organization_id>/<topic_slug>/<file>
 *
 * Pairs with `phase-b-migrate-storage-paths.ts` (S50). The migrate script
 * COPIED legacy → scoped. This script deletes the legacy half after the
 * soak window confirms readers/writers no longer touch flat paths.
 *
 * SAFETY MODEL:
 *   1. Default mode is --dry-run: print the plan, do nothing.
 *   2. --confirm required for real DELETE.
 *   3. Soak window gate: refuses to run before SOAK_CUTOFF (default
 *      2026-06-23, exactly 30 days after S50 migration on 2026-05-24).
 *      --override-soak flag can bypass with an audit-logged warning.
 *   4. Per-object verification ALWAYS runs at DELETE time, even if a prior
 *      --verify-only pass succeeded. State drifts; trust verification at
 *      the moment of irreversible action.
 *   5. Idempotent: re-running after a partial DELETE picks up where it
 *      left off (Supabase DELETE on a missing key is a no-op).
 *   6. Org-prefixed objects (already-scoped) are NEVER candidates for
 *      deletion. Only the flat-layout pool is targeted.
 *
 * Usage:
 *   node --env-file=.env --import=tsx scripts/phase-b-cleanup-legacy-storage-paths.ts [--confirm] [--override-soak]
 *
 * Flags:
 *   (default)        Dry-run: print the plan (objects that WOULD be deleted),
 *                    do nothing.
 *   --confirm        Execute real DELETE. Mutually exclusive with --dry-run.
 *   --override-soak  Bypass the 2026-06-23 soak-window gate. Requires
 *                    --confirm and emits a stderr audit warning.
 *
 * Exit codes:
 *   0 — success
 *   1 — runtime failure (partial DELETE; safe to re-run)
 *   2 — soak-window gate refused (today < SOAK_CUTOFF, no override)
 *   3 — usage error
 *   4 — verification failure: at least one legacy object had NO matching
 *       org-prefixed copy. Refuses to DELETE that object; refuses to
 *       continue (manual recovery required — the COPY half may have failed
 *       silently on that object during migration).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "research-projects";

// SOAK_CUTOFF: the earliest date this script will DELETE without --override-soak.
// 30 days after the S50 migration ran (2026-05-24).
const SOAK_CUTOFF = new Date("2026-06-23T00:00:00Z");

// ── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const OVERRIDE_SOAK = args.includes("--override-soak");

const unknown = args.filter((a) => !["--confirm", "--override-soak"].includes(a));
if (unknown.length > 0) {
  console.error(`unknown args: ${unknown.join(" ")}`);
  console.error(
    "usage: phase-b-cleanup-legacy-storage-paths.ts [--confirm] [--override-soak]",
  );
  process.exit(3);
}

if (OVERRIDE_SOAK && !CONFIRM) {
  console.error("refusing: --override-soak requires --confirm (no-op without --confirm)");
  process.exit(3);
}

// ── Soak-window gate ────────────────────────────────────────────────

const now = new Date();
if (now < SOAK_CUTOFF) {
  const daysLeft = Math.ceil((SOAK_CUTOFF.getTime() - now.getTime()) / 86_400_000);
  if (!OVERRIDE_SOAK) {
    console.error(
      `\nSOAK WINDOW GATE: refusing to run.\n` +
        `  Today:  ${now.toISOString()}\n` +
        `  Cutoff: ${SOAK_CUTOFF.toISOString()}\n` +
        `  Days remaining: ${daysLeft}\n` +
        `\nThe migration COPYed flat→scoped on 2026-05-24. Reader code now\n` +
        `uses ONLY the scoped layout, but the flat-layout objects are\n` +
        `retained as a safety net during the 30-day soak window. If\n` +
        `something regresses, the legacy half is still in place.\n` +
        `\nTo bypass for a genuine emergency, re-run with both flags:\n` +
        `  --confirm --override-soak\n`,
    );
    process.exit(2);
  }
  console.warn(
    `\n⚠ SOAK OVERRIDE ACTIVE — deleting ${daysLeft} days before cutoff.\n` +
      `  Today:  ${now.toISOString()}\n` +
      `  Cutoff: ${SOAK_CUTOFF.toISOString()}\n` +
      `  Reason: must be supplied by operator via commit/PR description.\n`,
  );
}

// ── Env ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(3);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Types ───────────────────────────────────────────────────────────

interface QueueRow {
  id: string;
  organization_id: string;
  topic_slug: string;
  result_slug: string | null;
}

interface ObjectMeta {
  name: string;
  size: number;
}

interface CleanupStats {
  rowsProcessed: number;
  flatObjectsFound: number;
  flatObjectsAlreadyMissing: number;
  flatObjectsDeleted: number;
  flatObjectsVerifiedDeleteFailed: number;
  verificationFailures: Array<{ slug: string; object: string; reason: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scopedPath(orgId: string, slug: string, file: string): string {
  if (!UUID_V4_REGEX.test(orgId)) {
    throw new Error(`scopedPath: invalid orgId "${orgId}"`);
  }
  if (!slug || slug.includes("/")) {
    throw new Error(`scopedPath: invalid slug "${slug}"`);
  }
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error(`scopedPath: invalid file name components "${file}"`);
  }
  return `${orgId}/${slug}/${file}`;
}

async function listFolder(prefix: string): Promise<ObjectMeta[]> {
  const { data, error } = await sb.storage
    .from(BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error(`list(${prefix}) failed: ${error.message}`);
  return (data ?? [])
    .filter((item) => item.metadata !== null)
    .map((item) => ({
      name: item.name,
      size: (item.metadata?.size as number | undefined) ?? 0,
    }));
}

async function queryQueueRows(): Promise<QueueRow[]> {
  const { data, error } = await sb
    .from("research_queue")
    .select("id, organization_id, topic_slug, result_slug")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`research_queue query failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

// ── Verify + delete one row's legacy objects ────────────────────────

async function cleanupRowLegacyObjects(
  row: QueueRow,
  stats: CleanupStats,
  mode: "dry-run" | "delete",
): Promise<void> {
  const slug = row.topic_slug;
  const orgId = row.organization_id;

  // List the legacy flat-layout folder. If it's empty, we're already done.
  let legacyObjects: ObjectMeta[];
  try {
    legacyObjects = await listFolder(slug);
  } catch (err) {
    stats.verificationFailures.push({
      slug,
      object: "<list>",
      reason: (err as Error).message,
    });
    return;
  }

  if (legacyObjects.length === 0) {
    stats.flatObjectsAlreadyMissing += 1;
    return;
  }

  // List the scoped folder so we can verify counterparts exist at matching size.
  let scopedObjects: ObjectMeta[];
  try {
    scopedObjects = await listFolder(`${orgId}/${slug}`);
  } catch (err) {
    stats.verificationFailures.push({
      slug,
      object: `<list ${orgId}/${slug}>`,
      reason: (err as Error).message,
    });
    return;
  }
  const scopedByName = new Map(scopedObjects.map((o) => [o.name, o.size]));

  // Per-object verification + delete.
  const pathsToDelete: string[] = [];
  for (const obj of legacyObjects) {
    stats.flatObjectsFound += 1;

    const scopedSize = scopedByName.get(obj.name);
    if (scopedSize === undefined) {
      stats.verificationFailures.push({
        slug,
        object: obj.name,
        reason: `scoped counterpart MISSING at ${orgId}/${slug}/${obj.name}`,
      });
      continue;
    }
    if (scopedSize !== obj.size) {
      stats.verificationFailures.push({
        slug,
        object: obj.name,
        reason: `size mismatch: flat=${obj.size}, scoped=${scopedSize}`,
      });
      continue;
    }

    pathsToDelete.push(`${slug}/${obj.name}`);
  }

  if (pathsToDelete.length === 0) return;

  if (mode === "dry-run") {
    for (const p of pathsToDelete) {
      console.log(`  WOULD DELETE: ${p}`);
    }
    return;
  }

  // Real DELETE — Supabase bulk endpoint accepts an array.
  const { error: rmErr } = await sb.storage.from(BUCKET).remove(pathsToDelete);
  if (rmErr) {
    stats.flatObjectsVerifiedDeleteFailed += pathsToDelete.length;
    stats.verificationFailures.push({
      slug,
      object: `<bulk delete ${pathsToDelete.length} paths>`,
      reason: rmErr.message,
    });
    return;
  }
  stats.flatObjectsDeleted += pathsToDelete.length;
  for (const p of pathsToDelete) console.log(`  DELETED:      ${p}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = CONFIRM ? "delete" : "dry-run";
  console.log(`=== CLEANUP — legacy flat-layout objects (mode=${mode}) ===`);

  const rows = await queryQueueRows();
  console.log(`Queried ${rows.length} research_queue rows.`);

  const stats: CleanupStats = {
    rowsProcessed: 0,
    flatObjectsFound: 0,
    flatObjectsAlreadyMissing: 0,
    flatObjectsDeleted: 0,
    flatObjectsVerifiedDeleteFailed: 0,
    verificationFailures: [],
  };

  for (const row of rows) {
    await cleanupRowLegacyObjects(row, stats, mode);
    stats.rowsProcessed += 1;
  }

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`  rows processed:                  ${stats.rowsProcessed}`);
  console.log(`  legacy flat-layout folders empty: ${stats.flatObjectsAlreadyMissing}`);
  console.log(`  flat objects found in legacy:    ${stats.flatObjectsFound}`);
  if (mode === "dry-run") {
    console.log(
      `  flat objects that WOULD be deleted: ${
        stats.flatObjectsFound - stats.verificationFailures.length
      }`,
    );
  } else {
    console.log(`  flat objects DELETED:            ${stats.flatObjectsDeleted}`);
    console.log(`  flat objects DELETE failed:      ${stats.flatObjectsVerifiedDeleteFailed}`);
  }
  console.log(`  verification failures:           ${stats.verificationFailures.length}`);

  if (stats.verificationFailures.length > 0) {
    console.log("");
    console.log("=== VERIFICATION FAILURES ===");
    for (const f of stats.verificationFailures.slice(0, 20)) {
      console.log(`  slug=${f.slug} object=${f.object}`);
      console.log(`    reason: ${f.reason}`);
    }
    if (stats.verificationFailures.length > 20) {
      console.log(`  (… ${stats.verificationFailures.length - 20} more)`);
    }
    console.error(
      "\nFAIL: at least one legacy object had no verified scoped counterpart.\n" +
        "Refusing to consider this run a success. Investigate before re-running.\n" +
        "Run `phase-b-migrate-storage-paths.ts --verify-only` to check overall integrity.\n",
    );
    process.exit(4);
  }

  if (mode === "dry-run") {
    console.log(
      "\nDRY-RUN complete. Re-run with --confirm to execute the DELETE.\n" +
        "(If today is before 2026-06-23, also pass --override-soak with a\n" +
        "documented reason.)",
    );
  } else {
    console.log("\nCleanup complete. Legacy flat-layout objects removed.");
    console.log("Migration safety net retired — scoped layout is now the\n" +
                "single source of truth for storage.");
  }
}

main().catch((err) => {
  console.error(`FATAL: ${(err as Error).message}`);
  if ((err as Error).stack) console.error((err as Error).stack);
  process.exit(1);
});
