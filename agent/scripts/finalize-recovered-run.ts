/**
 * Finalize a recovered/interrupted research run.
 *
 * Uploads all on-disk artifacts to Supabase Storage under the topic_slug
 * folder, then optionally PATCHes the queue row to a final status.
 *
 * Usage:
 *   node --env-file=.env --import=tsx scripts/finalize-recovered-run.ts \
 *     <job-id> <workdir> <slug> <status> [error_message]
 *
 * Status: 'failed' or 'completed'
 *
 * One-shot operator script for cases where the executor's auto-upload
 * never ran (e.g. timeout-killed run + post-wake fetch-failed). Does NOT
 * forge pipeline completion: status=failed is the honest call when the
 * run didn't reach phase 7 cleanly. completed is allowed only if the
 * caller is explicitly closing out a verified-good run.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const [, , jobId, workDir, slug, status, ...errorParts] = process.argv;
const errorMessage = errorParts.join(" ") || null;

if (!jobId || !workDir || !slug || !status) {
  console.error(
    "usage: finalize-recovered-run.ts <job-id> <workdir> <slug> <status> [error_message]",
  );
  process.exit(2);
}

if (!["failed", "completed", "cancelled"].includes(status)) {
  console.error(`refusing: status must be failed | completed | cancelled, got "${status}"`);
  process.exit(2);
}

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
  console.error(`refusing: "${jobId}" is not a UUID`);
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

// Files to skip (internal pipeline state, not user-facing artifacts)
const SKIP = new Set([
  "claude-prompt.md",
  "job-manifest.json",
]);

const SKIP_PREFIX = ["instr-", "nlm_", "."];

function shouldSkip(name: string): boolean {
  if (SKIP.has(name)) return true;
  for (const p of SKIP_PREFIX) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function guessContentType(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

console.log(`Finalizing job ${jobId}`);
console.log(`  workdir: ${workDir}`);
console.log(`  slug: ${slug}`);
console.log(`  status: ${status}`);

// 1. Upload artifacts
const entries = await fs.readdir(workDir);
let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const name of entries) {
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
    .upload(`${slug}/${name}`, buf, {
      contentType,
      upsert: true,
    });

  if (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed++;
  } else {
    console.log(`  ✓ ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${contentType})`);
    uploaded++;
  }
}

console.log(`\nUpload summary: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed`);

// 2. Patch DB row
const patchBody: Record<string, unknown> = {
  status,
  completed_at: new Date().toISOString(),
};
if (errorMessage) patchBody.error_message = errorMessage;
if (status === "completed") patchBody.result_slug = slug;

const res = await fetch(`${url}/rest/v1/research_queue?id=eq.${jobId}`, {
  method: "PATCH",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify(patchBody),
});

const text = await res.text();
console.log(`\nDB PATCH: HTTP ${res.status}`);
if (!res.ok) {
  console.log(text);
  process.exit(1);
}

const rows = JSON.parse(text);
console.log(`Updated row: status=${rows[0]?.status} error_message=${rows[0]?.error_message?.slice(0, 100)}`);

export {};
