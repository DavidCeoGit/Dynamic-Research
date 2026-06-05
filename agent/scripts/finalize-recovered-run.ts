/**
 * Finalize a recovered/interrupted research run.
 *
 * Uploads all on-disk artifacts to Supabase Storage under the topic_slug
 * folder, then optionally PATCHes the queue row to a final status.
 *
 * Usage:
 *   node --env-file=.env --import=tsx scripts/finalize-recovered-run.ts \
 *     <job-id> <workdir> <slug> <status> [error_message] [--force]
 *
 * Status: 'failed' | 'completed' | 'cancelled'
 *
 * Lint gate (S30, hard): runs `lint-deliverables.ts <workdir> --strict` before
 * any upload. Refuses to proceed if lint fails. Pass --force to override (will
 * still print the violations and tag the upload with a warning). The gate
 * exists because S29 cam AI + Gunderson recovery surfaced repeated naming-
 * drift incidents (5 noise files + 32 wrongly-named files needed manual
 * cleanup) that the conventions module catches but only if a code path runs
 * it. See feedback_workflow_drift_layer_3_gap.md.
 *
 * One-shot operator script for cases where the executor's auto-upload
 * never ran (e.g. timeout-killed run + post-wake fetch-failed). Does NOT
 * forge pipeline completion: status=failed is the honest call when the
 * run didn't reach phase 7 cleanly. completed is allowed only if the
 * caller is explicitly closing out a verified-good run.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { BUCKET, isSkipFile, getContentType } from "../lib/conventions.js";
import { uploadWithAudit } from "../lib/storage-paths.js";

// Parse argv: pull --force out, leave the rest as positional
const rawArgs = process.argv.slice(2);
const force = rawArgs.includes("--force");
const positional = rawArgs.filter((a) => a !== "--force");
const [jobId, workDir, slug, status, ...errorParts] = positional;
const errorMessage = errorParts.join(" ") || null;

if (!jobId || !workDir || !slug || !status) {
  console.error(
    "usage: finalize-recovered-run.ts <job-id> <workdir> <slug> <status> [error_message] [--force]",
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

// ── Lint gate (S30) ─────────────────────────────────────────────────
// Run lint-deliverables.ts --strict against the workdir. Refuse to upload if
// it reports errors, unless --force is passed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lintScript = path.join(__dirname, "lint-deliverables.ts");

console.log(`\nLint gate: running ${path.basename(lintScript)} --strict on ${workDir}`);
const lint = spawnSync(
  process.execPath,
  ["--import=tsx", lintScript, workDir, "--strict"],
  { stdio: "inherit" },
);

if (lint.status !== 0) {
  if (!force) {
    console.error(
      "\n✗ LINT FAILED (exit " +
        lint.status +
        "). Refusing to upload.\n" +
        "  Fix the violations above (rename files in-place per conventions.json), then retry.\n" +
        "  To override after a deliberate review, pass --force.",
    );
    process.exit(1);
  } else {
    console.warn(
      "\n⚠  Lint failed (exit " +
        lint.status +
        ") but --force passed — proceeding with upload. Operator-owned override.",
    );
  }
} else {
  console.log("✓ Lint clean — proceeding with upload.");
}

// ── Upload + DB patch ────────────────────────────────────────────────

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`\nFinalizing job ${jobId}`);
console.log(`  workdir: ${workDir}`);
console.log(`  slug: ${slug}`);
console.log(`  status: ${status}`);

// Phase B / S50 — resolve org_id from the queue row. The CLI does not take
// org_id as a positional arg because the row owns the authoritative value
// (and the recovery operator should not be hand-typing UUIDs). Fail loudly
// if the row is missing — recovery against an absent queue row would write
// to an unowned org-prefixed path.
const orgRes = await fetch(
  `${url}/rest/v1/research_queue?id=eq.${jobId}&select=organization_id`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
if (!orgRes.ok) {
  console.error(`refusing: could not query research_queue for org_id (HTTP ${orgRes.status})`);
  process.exit(1);
}
const orgRows = (await orgRes.json()) as Array<{ organization_id?: string }>;
const organizationId = orgRows[0]?.organization_id ?? "";
if (!organizationId) {
  console.error(
    `refusing: research_queue row ${jobId} has no organization_id — cannot construct org-prefixed storage path`,
  );
  process.exit(1);
}
console.log(`  org_id: ${organizationId}`);

// 1. Upload artifacts
const entries = await fs.readdir(workDir);
let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const name of entries) {
  if (isSkipFile(name)) {
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
  const contentType = getContentType(name);

  // Phase B / S50 — org-prefixed path via scopedStoragePath + audit row.
  // upsert: true (recovery path explicitly intends to overwrite, mirroring
  // pre-S50 semantics — see executor.ts upload comment block).
  const result = await uploadWithAudit({
    sb,
    caller: "finalize-recovered-run.ts",
    organizationId,
    researchQueueId: jobId,
    projectSlug: slug,
    filename: name,
    content: buf,
    contentType,
    upsert: true,
  });

  if (!result.ok) {
    console.log(`  ✗ ${name}: ${result.reason}`);
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
const finalErrorMessage = force && lint.status !== 0
  ? `${errorMessage ?? ""}${errorMessage ? " | " : ""}lint=fail (forced)`.trim()
  : errorMessage;
if (finalErrorMessage) patchBody.error_message = finalErrorMessage;
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
