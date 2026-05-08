/**
 * Rename existing research files with topic-prefix names + delete old
 * bare-timestamp uploads from Supabase Storage + upload v2 with the new
 * naming. Used after v2 Studio regen with title-prefix naming.
 *
 * Usage:
 *   cd agent && node --env-file=.env --import=tsx scripts/rename-and-finalize.ts \
 *     <slug> <workdir> <topic-prefix>
 *
 * Where <topic-prefix> is the human-readable slug to use for research
 * files (e.g. "cam-ai-quickbase-platform"). Studio files keep their
 * NLM-title-derived prefix already in their local filenames.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const [, , slug, workDir, topicPrefix] = process.argv;
if (!slug || !workDir || !topicPrefix) {
  console.error("usage: rename-and-finalize.ts <slug> <workdir> <topic-prefix>");
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BUCKET = "research-projects";

const SKIP = new Set([
  "claude-prompt.md",
  "job-manifest.json",
  "studio-task-ids.json",
  "nlm_discovered_sources.json",
]);

const SKIP_PREFIX = ["instr-", "nlm_", "write_", "test_", "."];

// Research-file role mapping. Files matching `{TIMESTAMP}-{role}.{ext}`
// where role is in this list get renamed to `{topicPrefix}-{role}.{ext}`.
// Studio files (audio/video/etc) won't match because their filenames
// already have a title-prefix from the orchestrator.
const RESEARCH_ROLES = new Set([
  "brief",
  "perplexity",
  "comparison",
  "vendor-evaluation",
  "notebooklm",
  "state",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function guessContentType(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function shouldSkip(name: string): boolean {
  if (SKIP.has(name)) return true;
  for (const p of SKIP_PREFIX) if (name.startsWith(p)) return true;
  return false;
}

/** Parse a file matching {TIMESTAMP}-{role}.{ext} → returns {role, ext} or null. */
function parseResearchFile(name: string): { role: string; ext: string } | null {
  const m = name.match(/^\d{8}-\d{6}-(.+)\.([^.]+)$/);
  if (!m) return null;
  const role = m[1];
  const ext = m[2];
  if (RESEARCH_ROLES.has(role)) return { role, ext };
  return null;
}

console.log(`Finalizing slug=${slug} workdir=${workDir} topic-prefix=${topicPrefix}`);
console.log();

// ── 1. Delete OLD bare-timestamp files from Supabase Storage ──────────
console.log("Step 1: Listing existing Storage files for cleanup...");
const { data: existingFiles, error: listErr } = await sb.storage
  .from(BUCKET)
  .list(slug, { limit: 200, sortBy: { column: "name", order: "asc" } });

if (listErr) {
  console.error(`  list-err: ${listErr.message}`);
  process.exit(1);
}

const filesToDelete: string[] = [];
for (const f of existingFiles ?? []) {
  if (!f.name) continue;
  // Old bare-timestamp pattern: {TIMESTAMP}-{anything}
  // We're replacing these wholesale, since v2 has new (titled) names.
  if (/^\d{8}-\d{6}-/.test(f.name)) {
    filesToDelete.push(`${slug}/${f.name}`);
  }
}

if (filesToDelete.length > 0) {
  console.log(`  Deleting ${filesToDelete.length} old files...`);
  const { error: delErr } = await sb.storage.from(BUCKET).remove(filesToDelete);
  if (delErr) {
    console.error(`  delete-err: ${delErr.message}`);
    process.exit(1);
  }
  console.log(`  ✓ Deleted ${filesToDelete.length} old files`);
} else {
  console.log("  No old files to delete");
}
console.log();

// ── 2. Rename research files locally ──────────────────────────────────
console.log("Step 2: Renaming research files locally with topic prefix...");
const entries = await fs.readdir(workDir);
const renames: Array<{ from: string; to: string }> = [];

for (const name of entries) {
  if (shouldSkip(name)) continue;
  const parsed = parseResearchFile(name);
  if (!parsed) continue;
  const newName = `${topicPrefix}-${parsed.role}.${parsed.ext}`;
  if (newName === name) continue;
  const fromPath = path.join(workDir, name);
  const toPath = path.join(workDir, newName);
  try {
    await fs.stat(fromPath);
  } catch {
    continue;
  }
  // Don't clobber if target exists (e.g. .docx already has nice name)
  try {
    await fs.stat(toPath);
    console.log(`  SKIP (target exists): ${name} → ${newName}`);
    continue;
  } catch {
    // OK to rename
  }
  await fs.rename(fromPath, toPath);
  renames.push({ from: name, to: newName });
  console.log(`  ✓ ${name} → ${newName}`);
}
console.log(`  ${renames.length} files renamed`);
console.log();

// ── 3. Upload all current files to Supabase Storage ───────────────────
console.log("Step 3: Uploading current files...");
const finalEntries = await fs.readdir(workDir);
let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const name of finalEntries) {
  if (shouldSkip(name)) {
    skipped++;
    continue;
  }
  const local = path.join(workDir, name);
  const stat = await fs.stat(local);
  if (!stat.isFile()) {
    skipped++;
    continue;
  }

  const buf = await fs.readFile(local);
  const contentType = guessContentType(name);
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(`${slug}/${name}`, buf, { contentType, upsert: true });

  if (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed++;
  } else {
    console.log(`  ✓ ${name} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    uploaded++;
  }
}

console.log();
console.log(`Final: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);
console.log(`Old Storage files deleted: ${filesToDelete.length}`);

export {};
