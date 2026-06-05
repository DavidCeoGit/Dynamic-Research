/**
 * Phase B / S50 — Storage path migration: flat → org-prefixed.
 *
 * COPIES every object under the legacy flat layout
 *     research-projects/<topic_slug>/<file>
 * to the new org-prefixed layout
 *     research-projects/<organization_id>/<topic_slug>/<file>
 *
 * Per v3 plan §2.4.3:
 *   1. Drive by research_queue.id (NOT slug). After Phase A, slug uniqueness
 *      is org-scoped, so slug-only resolution is ambiguous. Querying by id
 *      gives an unambiguous (id, org_id, slug) tuple per row.
 *   2. COPY each legacy object to the org-prefixed path. Verify by listing
 *      the new path + comparing sizes.
 *   3. NO reactive fallback in reader code (Gemini G1). Readers must move to
 *      the new layout in the same deploy as this migration runs.
 *   4. 30-day soak: legacy objects retained but never read by application
 *      code. After soak, a separate cleanup script DELETEs the flat-path
 *      objects in one batch (NOT this script — keeps the safety net).
 *
 * IDEMPOTENT — if the destination already contains the file with the same
 * size, the COPY is skipped. Safe to re-run after a partial failure.
 *
 * Usage:
 *   node --env-file=.env --import=tsx scripts/phase-b-migrate-storage-paths.ts [--preflight] [--dry-run] [--verify-only]
 *
 * Flags:
 *   --preflight    Verify no slug collisions across orgs; exit 2 if any.
 *                  Read-only. Run this before --dry-run / real COPY.
 *   --dry-run      Print plan (what would be copied); no storage writes.
 *   --verify-only  Skip COPY; verify every legacy object has a matching
 *                  new-layout copy with the same size. Run after a real
 *                  COPY completes to confirm migration integrity.
 *   (default)      Execute COPY end-to-end. Idempotent.
 *
 * Exit codes:
 *   0 — success / preflight clean
 *   1 — runtime failure (partial COPY; safe to re-run)
 *   2 — preflight failure (slug collision across orgs)
 *   3 — usage error
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "research-projects";

// ── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const PREFLIGHT = args.includes("--preflight");
const DRY_RUN = args.includes("--dry-run");
const VERIFY_ONLY = args.includes("--verify-only");

const unknown = args.filter(
  (a) => !["--preflight", "--dry-run", "--verify-only"].includes(a),
);
if (unknown.length > 0) {
  console.error(`unknown args: ${unknown.join(" ")}`);
  console.error(
    "usage: phase-b-migrate-storage-paths.ts [--preflight] [--dry-run] [--verify-only]",
  );
  process.exit(3);
}

const mutuallyExclusive = [PREFLIGHT, DRY_RUN, VERIFY_ONLY].filter(Boolean).length;
if (mutuallyExclusive > 1) {
  console.error("refusing: --preflight, --dry-run, and --verify-only are mutually exclusive");
  process.exit(3);
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

interface MigrationStats {
  rowsProcessed: number;
  objectsCopied: number;
  objectsSkippedAlreadyPresent: number;
  objectsFailed: number;
  legacyEmptyFolders: number;
  errors: Array<{ slug: string; object: string; reason: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

// Strict canonical UUID v4 (8-4-4-4-12 hex). Matches the helper at
// agent/lib/storage-paths.ts; pair-edit if changing.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scopedPath(orgId: string, slug: string, file?: string): string {
  if (!UUID_V4_REGEX.test(orgId)) {
    throw new Error(`scopedPath: invalid orgId "${orgId}"`);
  }
  if (!slug || slug.includes("/")) {
    throw new Error(`scopedPath: invalid slug "${slug}"`);
  }
  // S50 Gemini MERGE C1 — filename traversal guard, in parity with the live
  // scopedStoragePath helper. Legacy storage that already contains paths
  // with `..` would surface here as an explicit error (which is the desired
  // signal — they should never have made it into the bucket).
  if (file && (file.includes("/") || file.includes("\\") || file.includes(".."))) {
    throw new Error(`scopedPath: invalid file name components "${file}"`);
  }
  return file ? `${orgId}/${slug}/${file}` : `${orgId}/${slug}`;
}

async function listFolder(prefix: string): Promise<ObjectMeta[]> {
  // Supabase storage.list takes a folder prefix and returns objects directly
  // in it (non-recursive). Files have non-null `metadata` (where `.size` lives).
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

// ── Preflight: detect slug collisions across orgs ───────────────────

async function preflight(): Promise<void> {
  console.log("=== PREFLIGHT — slug collision check ===");
  const rows = await queryQueueRows();
  console.log(`  Queried ${rows.length} research_queue rows.`);

  // Collisions: same topic_slug present in >1 distinct org.
  const slugToOrgs = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!slugToOrgs.has(r.topic_slug)) slugToOrgs.set(r.topic_slug, new Set());
    slugToOrgs.get(r.topic_slug)!.add(r.organization_id);
  }

  // Also check result_slug, since gallery resolution uses it.
  for (const r of rows) {
    if (!r.result_slug) continue;
    if (!slugToOrgs.has(r.result_slug)) slugToOrgs.set(r.result_slug, new Set());
    slugToOrgs.get(r.result_slug)!.add(r.organization_id);
  }

  const collisions = Array.from(slugToOrgs.entries())
    .filter(([_, orgs]) => orgs.size > 1)
    .map(([slug, orgs]) => ({ slug, orgs: Array.from(orgs) }));

  if (collisions.length > 0) {
    console.error(`\nFAIL: ${collisions.length} slug(s) exist in multiple orgs:`);
    for (const c of collisions) {
      console.error(`  ${c.slug} → orgs: ${c.orgs.join(", ")}`);
    }
    console.error(
      "\nMigration cannot proceed: COPY would have to choose one org and would silently lose the other.\n" +
        "Resolve by renaming slugs in conflicting research_queue rows before re-running.",
    );
    process.exit(2);
  }

  console.log(`  PASS: no slug collisions across orgs.`);
  console.log(`  Distinct slugs in research_queue: ${slugToOrgs.size}`);
  console.log(`  Distinct orgs in research_queue: ${new Set(rows.map((r) => r.organization_id)).size}`);
}

// ── Migrate / dry-run: COPY one row's objects ───────────────────────

async function copyRowObjects(
  row: QueueRow,
  stats: MigrationStats,
  mode: "migrate" | "dry-run",
): Promise<void> {
  const slug = row.topic_slug;
  // List the legacy flat-layout folder.
  let legacyObjects: ObjectMeta[];
  try {
    legacyObjects = await listFolder(slug);
  } catch (err) {
    stats.errors.push({
      slug,
      object: "<list>",
      reason: (err as Error).message,
    });
    stats.objectsFailed++;
    return;
  }

  if (legacyObjects.length === 0) {
    stats.legacyEmptyFolders++;
    return;
  }

  // Pre-list the destination once to determine which copies can be skipped.
  let destObjects: ObjectMeta[] = [];
  try {
    destObjects = await listFolder(scopedPath(row.organization_id, slug));
  } catch {
    // empty dest is expected on first run; tolerate listFolder error here
  }
  const destByName = new Map(destObjects.map((o) => [o.name, o]));

  for (const obj of legacyObjects) {
    const dest = destByName.get(obj.name);
    if (dest && dest.size === obj.size) {
      stats.objectsSkippedAlreadyPresent++;
      continue;
    }

    if (mode === "dry-run") {
      console.log(
        `  WOULD COPY  ${slug}/${obj.name} (${obj.size}B) -> ${row.organization_id}/${slug}/${obj.name}`,
      );
      stats.objectsCopied++;
      continue;
    }

    // Real COPY. Supabase storage.from(BUCKET).copy() copies inside the same
    // bucket without re-download/re-upload — server-side. The destination
    // path must NOT already exist (Supabase copy refuses overwrites); we
    // skipped same-size dups above, but a size-mismatched object at the
    // destination is treated as a runtime error and surfaces in stats.
    const srcPath = `${slug}/${obj.name}`;
    const destPath = scopedPath(row.organization_id, slug, obj.name);
    const { error } = await sb.storage.from(BUCKET).copy(srcPath, destPath);
    if (error) {
      stats.errors.push({ slug, object: obj.name, reason: error.message });
      stats.objectsFailed++;
      continue;
    }
    stats.objectsCopied++;
  }
}

// ── Verify-only: post-COPY integrity check ──────────────────────────

async function verifyOnly(): Promise<void> {
  console.log("=== VERIFY-ONLY — checking destination has every legacy object at same size ===");
  const rows = await queryQueueRows();
  let totalLegacy = 0;
  let totalVerified = 0;
  const mismatches: Array<{ slug: string; name: string; legacy: number; dest: number | null }> = [];

  for (const row of rows) {
    const slug = row.topic_slug;
    let legacy: ObjectMeta[];
    try {
      legacy = await listFolder(slug);
    } catch {
      continue;
    }
    if (legacy.length === 0) continue;
    totalLegacy += legacy.length;

    let dest: ObjectMeta[] = [];
    try {
      dest = await listFolder(scopedPath(row.organization_id, slug));
    } catch {
      // dest folder missing entirely
    }
    const destByName = new Map(dest.map((o) => [o.name, o]));

    for (const obj of legacy) {
      const d = destByName.get(obj.name);
      if (d && d.size === obj.size) {
        totalVerified++;
      } else {
        mismatches.push({
          slug,
          name: obj.name,
          legacy: obj.size,
          dest: d?.size ?? null,
        });
      }
    }
  }

  console.log(`  Legacy objects:   ${totalLegacy}`);
  console.log(`  Verified copies:  ${totalVerified}`);
  console.log(`  Mismatches:       ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches.slice(0, 25)) {
      console.log(
        `    ${m.slug}/${m.name}  legacy=${m.legacy}B  dest=${m.dest === null ? "MISSING" : `${m.dest}B`}`,
      );
    }
    if (mismatches.length > 25) console.log(`    ... and ${mismatches.length - 25} more`);
    console.log(
      "\nVerification incomplete. Re-run without --verify-only to retry the missing COPYs.",
    );
    process.exit(1);
  }
  console.log("PASS: every legacy object has a matching dest copy with same size.");
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (PREFLIGHT) {
    await preflight();
    return;
  }
  if (VERIFY_ONLY) {
    await verifyOnly();
    return;
  }

  const mode = DRY_RUN ? "dry-run" : "migrate";
  console.log(`=== ${mode.toUpperCase()} — COPY legacy storage to org-prefixed layout ===`);

  // Pre-check: catch collisions before doing any work. preflight() exits
  // process on collision, so reaching the next line means slugs are unique.
  await preflight();

  const rows = await queryQueueRows();
  console.log(`  Processing ${rows.length} research_queue rows...`);
  const stats: MigrationStats = {
    rowsProcessed: 0,
    objectsCopied: 0,
    objectsSkippedAlreadyPresent: 0,
    objectsFailed: 0,
    legacyEmptyFolders: 0,
    errors: [],
  };

  for (const row of rows) {
    await copyRowObjects(row, stats, mode);
    stats.rowsProcessed++;
    if (stats.rowsProcessed % 25 === 0) {
      console.log(
        `    progress: ${stats.rowsProcessed}/${rows.length} rows  copied=${stats.objectsCopied}  skipped=${stats.objectsSkippedAlreadyPresent}  failed=${stats.objectsFailed}`,
      );
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`  Rows processed:               ${stats.rowsProcessed}`);
  console.log(`  Objects ${mode === "dry-run" ? "would copy" : "copied"}:               ${stats.objectsCopied}`);
  console.log(`  Objects skipped (already at dest with same size): ${stats.objectsSkippedAlreadyPresent}`);
  console.log(`  Objects failed:               ${stats.objectsFailed}`);
  console.log(`  Slugs with empty legacy folder: ${stats.legacyEmptyFolders}`);

  if (stats.errors.length > 0) {
    console.log("\n=== ERRORS ===");
    for (const e of stats.errors.slice(0, 25)) {
      console.log(`  ${e.slug}/${e.object} — ${e.reason}`);
    }
    if (stats.errors.length > 25) {
      console.log(`  ... and ${stats.errors.length - 25} more`);
    }
    console.log("\nRe-run the script to retry failures (idempotent: skips already-copied objects).");
    process.exit(1);
  }

  if (mode === "migrate") {
    console.log("\nNext step: run with --verify-only to confirm destination has every legacy object.");
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});

export {};
