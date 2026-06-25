/**
 * Studio-only regeneration (CE-3).
 *
 * Skips deep research entirely: regenerates NotebookLM Studio products
 * (audio / video / slides / report / infographic) against a PARENT run's
 * existing notebook, then uploads them to Supabase Storage under the
 * cloning run's own slug.
 *
 * The worker (agent/executor.ts) spawns this when a queue row has
 * pipeline_mode = "studio_only". It can also be run standalone for recovery.
 *
 *   node --env-file=.env --import=tsx scripts/regenerate-studio-products.ts <workDir> <manifestPath>
 *
 * Exit codes:
 *   0 — every selected product generated, downloaded, and uploaded
 *   1 — failure (reason ALSO written to <workDir>/<slug>-state.json
 *       phase_status so the worker can surface it without parsing stdout)
 *   2 — usage error
 *
 * Why a deterministic script and not a pipeline_mode branch inside the
 * /research-compare slash command: that command is a ~1000-line natural-
 * language prompt; a mode branch in it would be non-deterministic and drift
 * across Claude versions (feedback_workflow_drift_layer_3_gap.md). This path
 * bypasses Claude — it is just CLI calls + an upload.
 *
 * v1 scope (Documentation/clone-and-edit-design.md, CE-3): outputs upload
 * under the CLONE's own slug as v1-named files (conventions.studioFilename).
 * The parent_run_id pointer (CE-1) is the lineage link. Surfacing v1/v2 of a
 * product side-by-side in ONE gallery is a documented v2 enhancement.
 *
 * Resolution history (S129 → S142). This path once polled `notebooklm artifact
 *   poll <taskId>`, which lies `in_progress` even AFTER an artifact renders
 *   (S129/S135 cap-stall), and downloaded BARE `download <type>` = NLM
 *   default-latest = the S31 wrong-artifact bug. S141 replaced the lying poll
 *   with a SNAPSHOT-DIFF against `artifact list` + download-by-id; S142 then
 *   replaced the snapshot-diff ENTIRELY with an exact submit-task_id match (see
 *   the S142 note below), because the diff could not distinguish OUR artifact
 *   from a concurrent FOREIGN one on a shared notebook. The list+download seams
 *   are still reused verbatim from the worker's shipped, MERGE-gate-reviewed
 *   studio-completeness.ts (realListArtifacts / realDownloadArtifact —
 *   status_id===3, `-a`, backslash-path fallback).
 *
 *   Backstop difference vs the full pipeline: studio_only is its OWN executor
 *   exit path (runStudioOnly) and is NOT wrapped by the S136 Layer-2 cap-kill
 *   recovery. So the full-pipeline "leave unresolved → ride to the cap → Layer-2
 *   recovers" contract does NOT apply here. The safe adaptation is FAIL-CLOSED:
 *   an unresolved or AMBIGUOUS product rides its own per-product poll timeout and
 *   then fails the run (the executor failJobs it) — we NEVER guess an artifact id
 *   (that would reintroduce S31). A partial set is already a failed run below.
 *
 * S142 — concurrent-FOREIGN exact-1 CLOSED (Codex S141 CRITICAL + its residual).
 *   Resolution is an exact submit-task_id match ONLY: the NLM
 *   `generate <type> --json` task_id IS the eventual Artifact.id for every product
 *   type (grounded-verified in the CLI source — all types route through
 *   `_call_generate`; `_parse_generation_result` returns `task_id = result[0][0]`;
 *   `Artifact.from_api_response` sets `id = data[0]`; the full-pipeline poll loop
 *   resolves identically). Since that id is unique per generation, a CONCURRENT or
 *   FOREIGN artifact on the SHARED parent notebook can never equal ours — matching
 *   by id is immune to the entire concurrent-foreign class (both the
 *   already-in-flight-at-snapshot one AND the starts-after-snapshot residual). The
 *   S141 snapshot-diff was REMOVED: without our submit id it cannot prove
 *   ours-vs-foreign, so it could only ever guess (a guess that grabs a foreign
 *   exactly-1 is the bug). If `generate --json` ever yields no parseable task_id,
 *   that product FAILS CLOSED at launch (we never guess) — see §5.
 */

import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BUCKET, STUDIO_PRODUCTS, studioFilename, getContentType } from "../lib/conventions.js";
import { STUDIO_PRODUCT_LIST } from "../lib/plan-types.js";
import { PHASE_CHECKS } from "../lib/workflow-conventions.js";
import { scopedStoragePath, uploadWithAudit } from "../lib/storage-paths.js";
import { isStateFileName, selectNewestStateFile } from "../lib/find-state-file.js";
import {
  realListArtifacts,
  realDownloadArtifact,
  type NlmArtifactRef,
} from "../lib/studio-completeness.js";
import { resolveBySubmitId, hasUsableSubmitId } from "../lib/studio-snapshot-diff.js";

// ── Args ────────────────────────────────────────────────────────────

const [workDirArg, manifestPathArg] = process.argv.slice(2);

// Node's fs handles C:/ paths; NLM download is happier with Windows-native
// paths too (skill Bug 12). Normalise any /c/ MSYS form up front.
function toWinPath(p: string): string {
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p.replace(/\\/g, "/");
}
// Tolerate absent argv on import: the arg-validation + main() run ONLY under the
// import.meta.main guard at the bottom (S160 C-A testability), so importing this
// module for a unit test never process.exit(2)s or auto-runs the studio-only job.
const workDir = toWinPath(workDirArg ?? "");
const manifestPath = toWinPath(manifestPathArg ?? "");

// ── Env ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const NLM_BIN =
  process.env.NOTEBOOKLM_BIN ??
  (process.platform === "win32"
    ? "C:/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe"
    : `${process.env.HOME}/.notebooklm-venv/bin/notebooklm`);

// ── Product → CLI mapping ───────────────────────────────────────────
//
// `product` is the state key (audio/video/slides/report/infographic) and is
// also the conventions.json STUDIO_PRODUCTS key (→ correct file extension).
// `cliType` is the NLM CLI argument — note slides ↔ slide-deck. It is ALSO the
// `--type` value `artifact list`/`download` take (mirrors PRODUCT_TO_NLM_TYPE
// in studio-completeness.ts). genFlags are the per-product format flags from
// the notebooklm-cli skill. maxPollMin is the per-product timeout.

interface ProductDef {
  cliType: string;
  genFlags: string[];
  maxPollMin: number;
}
const PRODUCT_DEFS: Record<string, ProductDef> = {
  audio: { cliType: "audio", genFlags: ["--format", "deep-dive"], maxPollMin: 45 },
  video: { cliType: "video", genFlags: ["--format", "cinematic"], maxPollMin: 45 },
  slides: { cliType: "slide-deck", genFlags: ["--format", "presenter"], maxPollMin: 25 },
  report: { cliType: "report", genFlags: [], maxPollMin: 25 },
  infographic: { cliType: "infographic", genFlags: ["--orientation", "landscape"], maxPollMin: 25 },
};

// Single-source guard (S169): Object.keys(PRODUCT_DEFS) IS the studio_only product
// set (see the `products` filter in main()). Assert it matches the canonical
// STUDIO_PRODUCT_LIST (conventions.json) so a product added to conventions can
// never SILENTLY drop out of studio_only regen — drift fails LOUD at script
// startup (this script is spawned fresh per studio_only job) and in
// agent/test/studio-products-single-source.test.ts. The default params exist so
// the test can feed drifted inputs and prove the guard is non-vacuous.
export function assertProductDefsInSync(
  defKeys: readonly string[] = Object.keys(PRODUCT_DEFS),
  canonical: readonly string[] = STUDIO_PRODUCT_LIST,
): void {
  const a = defKeys.slice().sort();
  const b = canonical.slice().sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
    throw new Error(
      `PRODUCT_DEFS drift: keys [${a.join(", ")}] != conventions STUDIO_PRODUCT_LIST ` +
        `[${b.join(", ")}]. Add the new product's CLI def to PRODUCT_DEFS ` +
        `(regenerate-studio-products.ts) or update conventions.json.`,
    );
  }
}
assertProductDefsInSync();

// ── State file (worker progress relay) ──────────────────────────────
//
// The worker's watchStateFile() polls <workDir>/*-state.json and maps the
// `phase` field through PHASE_MAP. We keep phase = "5.5" (Studio Products,
// 70%) for the duration and move phase_status as products land, then write
// phase = "7" at the very end so the bar reaches Finalization.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let manifestTopic = "";
let manifestSlug = "";
// Phase B / S50 — the CLONE's org_id is read from the manifest in main();
// the PARENT's org_id is resolved from the parent research_queue row when we
// look up the parent slug. Both are scoped to authenticated uploads.
let manifestOrgId = "";
let parentOrgId = "";
let stateFilePath = "";
// S141 — the parent notebook id (resolved in main); module-level so the
// list/download seams in the poll loop + downloadAndUpload can scope every NLM
// read/write with `-n notebookId` (never the ambient "current notebook").
let notebookId = "";
// S141 — resolved list-canonical artifact ids, product → {task_id}. Persisted
// into every state.json write so a future reader (e.g. a studio_only
// completeness gate) has the exact id the run produced, never default-latest.
const resolvedArtifacts: Record<string, { task_id: string; status?: string; version?: number }> = {};

async function writeState(phase: string, phaseStatus: string): Promise<void> {
  if (!stateFilePath) return;
  const state = {
    timestamp: new Date().toISOString(),
    topic: manifestTopic,
    topic_slug: manifestSlug,
    version: 1,
    phase,
    phase_status: phaseStatus,
    pipeline_mode: "studio_only",
    notebook_id: notebookId || undefined,
    artifacts: resolvedArtifacts,
  };
  try {
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[warn] could not write state file: ${(err as Error).message}`);
  }
}

async function fail(reason: string): Promise<never> {
  console.error(`\n✗ ${reason}`);
  await writeState("5.5", `ERROR: ${reason}`);
  process.exit(1);
}

// ── NLM CLI helper (generate + notebook-select only) ────────────────
//
// Calls the venv notebooklm.exe directly (no `source activate` needed — the
// venv binary is already wired to its interpreter). PYTHONIOENCODING=utf-8
// prevents the cp1252 crash on Windows (skill Bug 3). spawnSync with an args
// array means no shell — multi-line instruction strings need no escaping.
//
// NOTE: artifact LISTING and DOWNLOADING are NOT done through this helper —
// they go through realListArtifacts / realDownloadArtifact (studio-completeness.ts)
// so the status_id===3 filter, `-a <id>` download, and Bug-12 backslash fallback
// are the SAME shipped, reviewed code the worker's completeness gate uses.

interface NlmResult {
  stdout: string;
  stderr: string;
  status: number;
}
function nlm(args: string[], timeoutMs = 120_000): NlmResult {
  const r = spawnSync(NLM_BIN, args, {
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: typeof r.status === "number" ? r.status : -1,
  };
}

// ── Instruction builder ─────────────────────────────────────────────
//
// Renders per-product instructions in the PERSONA / PRIORITIES / GOALS /
// CONSTANTS / QUALITY structure (feedback_nlm_artifact_customization_structure
// + feedback_date_aware_constants_every_artifact). customizations.studio.<type>
// is a free-form Record — every non-empty entry becomes a GOALS line.

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).join("; ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildInstruction(
  product: string,
  customizations: Record<string, unknown>,
  todayHuman: string,
  today: string,
): string {
  const nlmCust = (customizations.notebookLM ?? {}) as Record<string, unknown>;
  const studioAll = (customizations.studio ?? {}) as Record<string, Record<string, unknown>>;
  const studio = studioAll[product] ?? {};

  const persona =
    renderValue(nlmCust.persona) ||
    "Expert analyst presenting to an informed executive audience.";
  const priorities = Array.isArray(nlmCust.priorities)
    ? (nlmCust.priorities as unknown[]).map((p) => String(p)).filter(Boolean)
    : [];

  const goalLines = Object.entries(studio)
    .filter(([, v]) => v != null && renderValue(v).trim() !== "")
    .map(([k, v]) => `- ${k}: ${renderValue(v)}`);

  const parts: string[] = [];
  parts.push(`PERSONA: ${persona}`);
  if (priorities.length > 0) {
    parts.push(`PRIORITIES: ${priorities.join("; ")}`);
  }
  parts.push(
    goalLines.length > 0
      ? `GOALS:\n${goalLines.join("\n")}`
      : `GOALS:\n- Produce a polished, accurate ${product} deliverable on the notebook's research topic.`,
  );
  parts.push(
    `CONSTANTS: TODAY is ${todayHuman} (${today}). Treat any date before today as in the past — ` +
      `use past tense for completed events and elapsed deadlines. Never describe past events as ` +
      `'upcoming', 'future', or 'next quarter'. Do not assume your training-cutoff date is 'now'.`,
  );
  parts.push(
    `QUALITY: Correct spelling, grammar, and punctuation throughout. Proper nouns, technical terms, ` +
      `and domain-specific terminology must be spelled accurately. No typos or sentence fragments.`,
  );
  return parts.join("\n\n");
}

// ── task_id extraction ──────────────────────────────────────────────
//
// `generate <type> ... --json` returns a task id; the exact JSON shape isn't
// contractually fixed, so try the common field names, then fall back to a
// raw-text regex before giving up. S142: this submit task_id IS the eventual
// Artifact.id (CLI source: `_parse_generation_result` returns `result[0][0]`,
// the same value `Artifact.from_api_response` sets as `id = data[0]`), so it is
// the SOLE resolution key — the completed artifact whose `id` equals it is ours.
// (The S129/S135 "lying poll" was the `artifact poll` ENDPOINT returning stale
// `in_progress`; it never meant the id itself differed.)

function extractTaskId(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const candidates = [
      j.task_id,
      j.taskId,
      j.artifact_id,
      j.artifactId,
      j.id,
      (j.artifact as Record<string, unknown> | undefined)?.id,
      (j.data as Record<string, unknown> | undefined)?.task_id,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  } catch {
    // not JSON — fall through to regex
  }
  const m =
    stdout.match(/task[_-]?id["'\s:=]+([A-Za-z0-9_-]{6,})/i) ??
    stdout.match(/"id"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// ── Timestamp (conventions: YYYYMMDD-HHMMSS) ────────────────────────

function compactTimestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ── Artifact resolution ─────────────────────────────────────────────
//
// realListArtifacts returns ONLY status_id===3 (COMPLETED) artifacts. The one
// whose `id` equals our submit task_id is, in one shot, both resolved (it is
// ours) and done (it is in the completed list). We never trust the lying
// `artifact poll`. The pure decision logic lives in
// ../lib/studio-snapshot-diff.ts (unit-tested without self-executing this
// script); `resolveBySubmitId` is imported above.

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    await fail("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  // 1. Read the manifest the executor wrote.
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    await fail(`cannot read job manifest at ${manifestPath}: ${(err as Error).message}`);
    return;
  }

  manifestTopic = String(manifest.topic ?? "");
  manifestSlug = String(manifest.topic_slug ?? "");
  manifestOrgId = String(manifest.organization_id ?? "");
  if (!manifestSlug) await fail("manifest has no topic_slug");
  // Phase B / S50 — org_id is required for scoped uploads. Executor writes
  // it via buildManifest() starting S50. In-flight studio-only jobs whose
  // manifest was written by a pre-S50 executor will lack the field; fall
  // back to querying research_queue by the clone's job_id (which manifests
  // have carried since CE-3). Per S50 Gemini MERGE M3 — closes the
  // deploy-window failure-mode where one in-flight job dies at S50 cutover.
  if (!manifestOrgId) {
    const cloneJobId = String(manifest.job_id ?? "");
    if (!cloneJobId) {
      await fail(
        "manifest has neither organization_id nor job_id — cannot resolve clone's org. " +
          "Re-submit the studio-only run through /api/queue so a fresh manifest is written.",
      );
    }
    console.log(
      `[studio-only] manifest missing organization_id; fallback query by job_id ${cloneJobId}`,
    );
    const fbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/research_queue?id=eq.${cloneJobId}&select=organization_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!fbRes.ok) {
      await fail(`fallback research_queue query failed: HTTP ${fbRes.status}`);
    }
    const fbRows = (await fbRes.json()) as Array<{ organization_id?: string }>;
    manifestOrgId = String(fbRows[0]?.organization_id ?? "");
    if (!manifestOrgId) {
      await fail(`fallback could not resolve organization_id for clone job ${cloneJobId}`);
    }
    console.log(`[studio-only] fallback resolved org_id: ${manifestOrgId}`);
  }
  stateFilePath = `${workDir}/${manifestSlug}-state.json`;

  const parentRunId = manifest.parent_run_id ? String(manifest.parent_run_id) : "";
  if (!parentRunId) {
    await fail(
      "studio_only mode requires parent_run_id on the manifest — there is no parent " +
        "run to resolve a notebook from. Re-submit with full pipeline mode.",
    );
  }

  const selected = (manifest.selectedProducts ?? {}) as Record<string, boolean>;
  const products = Object.keys(PRODUCT_DEFS).filter((p) => selected[p] === true);
  if (products.length === 0) {
    await fail("no products selected — nothing to regenerate");
  }

  const customizations = (manifest.customizations ?? {}) as Record<string, unknown>;
  const today = String(manifest.today ?? new Date().toISOString().slice(0, 10));
  const todayHuman = String(
    manifest.today_human ??
      new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
  );
  const timestamp = compactTimestamp();

  console.log(`[studio-only] clone slug   : ${manifestSlug}`);
  console.log(`[studio-only] parent run   : ${parentRunId}`);
  console.log(`[studio-only] products     : ${products.join(", ")}`);

  await writeState("5.5", "Resolving parent notebook");

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. Resolve the parent run → its slug → its state.json → notebook_id.
  //    Phase B / S50 — also pull parent's organization_id; the parent's
  //    storage objects live at scopedStoragePath(parentOrgId, parentSlug, …).
  //    Don't assume parent shares the clone's org — Phase A immutable-org_id
  //    trigger forbids changes, but a clone can in principle reference a
  //    parent in another org via the FK (though our v1 surface doesn't expose
  //    cross-org cloning, defensive coding here is cheap).
  const parentRes = await fetch(
    `${SUPABASE_URL}/rest/v1/research_queue?id=eq.${parentRunId}` +
      `&select=topic_slug,result_slug,topic,organization_id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!parentRes.ok) {
    await fail(`could not query parent run ${parentRunId}: HTTP ${parentRes.status}`);
  }
  const parentRows = (await parentRes.json()) as Array<{
    topic_slug?: string;
    result_slug?: string | null;
    topic?: string;
    organization_id?: string;
  }>;
  if (parentRows.length === 0) {
    await fail(`parent run ${parentRunId} not found in research_queue`);
  }
  const parentSlug = parentRows[0].result_slug ?? parentRows[0].topic_slug ?? "";
  if (!parentSlug) {
    await fail(`parent run ${parentRunId} has neither result_slug nor topic_slug`);
  }
  parentOrgId = String(parentRows[0].organization_id ?? "");
  if (!parentOrgId) {
    await fail(`parent run ${parentRunId} has no organization_id — cannot resolve parent storage path`);
  }
  console.log(`[studio-only] parent slug  : ${parentSlug}`);
  console.log(`[studio-only] parent org   : ${parentOrgId}`);

  // Find the parent's state.json in Supabase Storage and read notebook_id.
  // Phase B / S50 — list under the org-prefixed path scopedStoragePath(parentOrgId, parentSlug).
  const { data: parentFiles, error: listErr } = await sb.storage
    .from(BUCKET)
    .list(scopedStoragePath(parentOrgId, parentSlug), { limit: 200 });
  if (listErr) {
    await fail(`could not list parent storage folder ${parentSlug}/: ${listErr.message}`);
  }
  // S87: select the NEWEST state file (by embedded run timestamp; created_at is
  // only a fallback for plain/slug-named files). A reused parent prefix can hold
  // stale "<ts>-state.json" files from earlier runs; the prior first-match
  // returned the oldest. Shared selector (find-state-file.ts) kills the drift
  // that false-failed e18e1931.
  const stateObj = selectNewestStateFile(
    (parentFiles ?? [])
      .filter((f) => isStateFileName(f.name))
      .map((f) => ({
        name: f.name,
        fallbackTimeMs: Date.parse(f.created_at ?? f.updated_at ?? "") || 0,
      })),
  );
  if (!stateObj) {
    await fail(
      `parent run ${parentSlug} has no state.json in Supabase Storage — cannot resolve its ` +
        `notebook. Re-run with full pipeline mode instead.`,
    );
  }
  const { data: stateBlob, error: dlErr } = await sb.storage
    .from(BUCKET)
    .download(scopedStoragePath(parentOrgId, parentSlug, stateObj!.name));
  if (dlErr || !stateBlob) {
    await fail(`could not download parent state.json: ${dlErr?.message ?? "empty"}`);
  }
  let parentState: Record<string, unknown>;
  try {
    parentState = JSON.parse(await stateBlob!.text()) as Record<string, unknown>;
  } catch (err) {
    await fail(`parent state.json is not valid JSON: ${(err as Error).message}`);
    return;
  }
  notebookId = parentState.notebook_id ? String(parentState.notebook_id) : "";
  if (!notebookId) {
    await fail(
      `parent run ${parentSlug} state.json has no notebook_id — its notebook was never recorded ` +
        `or has been removed. Re-run with full pipeline mode instead.`,
    );
  }
  console.log(`[studio-only] notebook id  : ${notebookId}`);

  // 3. Verify the notebook still exists in NotebookLM. Delegates to the
  //    reusable workflow-conventions check (single source of this gate —
  //    CE-3 acceptance criterion 4).
  await writeState("5.5", `Verifying notebook ${notebookId}`);
  const nbCheck = await PHASE_CHECKS["phase-0-existing-notebook"]({ notebookId });
  if (!nbCheck.ok) {
    await fail(nbCheck.remediation.join(" "));
  }

  // 4. Select the notebook (Bug 11 — generate/download act on the active one).
  //    All artifact list/download below ALSO pass `-n notebookId` explicitly,
  //    so resolution never depends on the ambient "current notebook" drifting.
  const useOut = nlm(["use", notebookId]);
  if (useOut.status !== 0) {
    await fail(
      `notebooklm use ${notebookId} failed (exit ${useOut.status}): ` +
        `${(useOut.stderr || useOut.stdout).slice(0, 300)}`,
    );
  }

  // 5. Launch every selected product's generate (fast — returns a task_id).
  //    5s spacing between launches avoids server-side queue congestion (Bug 20).
  //    The returned task_id IS the eventual Artifact.id (S142) — it is the sole
  //    resolution key. A generate that succeeds but yields NO parseable task_id
  //    cannot be safely resolved on a shared parent notebook (snapshot-diff would
  //    have to guess and could grab a concurrent foreign artifact), so that product
  //    FAILS CLOSED here rather than risk the S31 wrong-artifact bug.
  await writeState("5.5", `Launching ${products.length} Studio product(s)`);
  interface Task {
    product: string;
    cliType: string;
    taskId: string;
    maxPolls: number;
  }
  const tasks: Task[] = [];
  const launchFailures: string[] = [];
  for (const product of products) {
    const def = PRODUCT_DEFS[product];
    const instruction = buildInstruction(product, customizations, todayHuman, today);
    const args = ["generate", def.cliType, instruction, ...def.genFlags, "--json", "--retry", "3"];
    console.log(`[studio-only] generate ${product} (${def.cliType})`);
    const gen = nlm(args, 180_000);
    if (gen.status !== 0) {
      launchFailures.push(`${product}: generate exited ${gen.status} — ${(gen.stderr || gen.stdout).slice(0, 200)}`);
      continue;
    }
    const taskId = extractTaskId(gen.stdout);
    if (!hasUsableSubmitId(taskId)) {
      // No id to match → fail-closed (never guess via snapshot-diff). Should be
      // rare: generate --json returns {task_id} via _parse_generation_result.
      launchFailures.push(
        `${product}: generate succeeded but --json had no parseable task_id — cannot resolve safely (fail-closed)`,
      );
      console.error(`[studio-only]   ✗ ${product}: no parseable submit task_id — failing closed`);
      continue;
    }
    // 30s poll interval → polls needed = minutes * 2.
    tasks.push({ product, cliType: def.cliType, taskId: taskId!, maxPolls: def.maxPollMin * 2 });
    console.log(`[studio-only]   → launched ${product} (submit task ${taskId})`);
    await sleep(5_000);
  }

  if (tasks.length === 0) {
    await fail(`no products could be launched. ${launchFailures.join(" | ")}`);
  }

  // 6. Poll loop (S142 id-only). Each cycle, for every still-running task: list
  //    the type's COMPLETED artifacts and resolve the one whose id EQUALS our
  //    submit task_id (the generate-submit id IS the Artifact.id for every product
  //    type — a unique per-generation id that can never collide with a foreign/
  //    concurrent artifact on the shared parent notebook → immune to the S141
  //    concurrent-foreign CRITICAL and its starts-after-snapshot residual). Our id
  //    not yet in the completed list means OUR artifact is still rendering → keep
  //    waiting; a product still unresolved at its per-product timeout FAILS CLOSED.
  //    There is NO snapshot-diff guess — that is what reintroduced S31. (Every task
  //    here has a usable submit id; §5 fails closed at launch on an unparsed one.)
  const POLL_INTERVAL_MS = 30_000;
  const done = new Set<string>();
  const failedProducts: string[] = [...launchFailures];
  const uploaded: string[] = [];
  let cycle = 0;
  const maxCycles = Math.max(...tasks.map((t) => t.maxPolls));

  while (done.size < tasks.length && cycle < maxCycles) {
    cycle++;
    for (const task of tasks) {
      if (done.has(task.product)) continue;
      if (cycle > task.maxPolls) {
        console.error(`[studio-only] ${task.product}: TIMEOUT after ${task.maxPolls} polls`);
        failedProducts.push(`${task.product}: timed out after ~${task.maxPolls / 2} min`);
        done.add(task.product);
        continue;
      }

      const arts = realListArtifacts(notebookId, task.cliType);
      if (arts === null) {
        // Transient list/auth error: don't fail — ride to this product's timeout.
        console.error(`[studio-only] cycle ${cycle} | ${task.product}: artifact list error — retry next cycle`);
        continue;
      }

      // Exact submit-id match (deterministic; immune to concurrent-foreign).
      const winner = resolveBySubmitId(arts, task.taskId);
      if (!winner) {
        console.log(
          `[studio-only] cycle ${cycle} | ${task.product}: awaiting completion ` +
            `(submit id ${task.taskId} not yet in completed list)`,
        );
        continue;
      }
      console.log(
        `[studio-only] cycle ${cycle} | ${task.product}: completed → artifact ${winner.id} (submit-id match)`,
      );

      // Persist the resolved id immediately (fail-closed diagnostics + the
      // expectedArtifactId a future studio_only completeness gate would read).
      resolvedArtifacts[task.product] = { task_id: winner.id };
      const result = await downloadAndUpload(task, winner, sb, timestamp);
      if (result.ok) {
        // Only on successful UPLOAD does the gallery count this product complete.
        // status/version mirror the full-pipeline ArtifactState shape the
        // frontend's "Artifacts Completed" counter reads (VendorTabs).
        resolvedArtifacts[task.product] = { task_id: winner.id, status: "completed", version: 1 };
        uploaded.push(result.remoteName!);
        await writeState(
          "5.5",
          `${task.product} ✓ (${uploaded.length}/${tasks.length} uploaded)`,
        );
      } else {
        failedProducts.push(`${task.product}: ${result.reason}`);
      }
      done.add(task.product);
    }
    if (done.size < tasks.length) await sleep(POLL_INTERVAL_MS);
  }

  // Any task that never resolved within maxCycles.
  for (const task of tasks) {
    if (!done.has(task.product)) {
      failedProducts.push(`${task.product}: still running after ~${maxCycles / 2} min — abandoned`);
    }
  }

  // 7. Verdict. Partial success is still a FAILED run (matches the executor's
  //    full-pipeline discipline — a partial deliverable set is not "complete").
  console.log(
    `\n[studio-only] uploaded ${uploaded.length}/${products.length}: ${uploaded.join(", ") || "(none)"}`,
  );
  if (failedProducts.length > 0) {
    await fail(
      `${uploaded.length}/${products.length} products uploaded; ` +
        `${failedProducts.length} failed: ${failedProducts.join(" | ")}`,
    );
  }

  await writeState("7", "complete");
  console.log(`[studio-only] all ${products.length} products regenerated and uploaded.`);
  process.exit(0);
}

// ── Download + upload one completed artifact ────────────────────────
//
// S141: downloads the SPECIFIC resolved artifact BY ID via realDownloadArtifact
// (`download <type> -n <nb> -a <id> <path> --force`, with the Bug-12 backslash
// fallback + non-empty check) — never bare default-latest (S31). The artifact's
// canonical NLM title (from `artifact list`) names the file, replacing the old
// stdout-regex title parse.

async function downloadAndUpload(
  task: { product: string; cliType: string },
  // Bare SupabaseClient (the exact type uploadWithAudit accepts) rather than
  // ReturnType<typeof createClient>: the latter resolves to the schema-less
  // `never` default under some program compositions, which then rejects the
  // `<…,"public",…>` client createClient() actually returns (S160 — exposed when
  // the new test imports this module into the tsc program).
  artifact: NlmArtifactRef,
  sb: SupabaseClient,
  timestamp: string,
  deps: { downloadArtifact?: typeof realDownloadArtifact } = {},
): Promise<{ ok: boolean; remoteName?: string; reason?: string }> {
  // S158 widened realDownloadArtifact from Promise<boolean> to
  // Promise<DownloadResult>; consume .ok (S160 C-A — the prior `if (!ok)` on the
  // object was always false, a DEAD failure guard that let truncated/failed
  // downloads upload as success). Injectable for the unit test.
  const downloadArtifact = deps.downloadArtifact ?? realDownloadArtifact;
  const ext = STUDIO_PRODUCTS[task.product]?.ext;
  if (!ext) return { ok: false, reason: `unknown product (no ext in conventions): ${task.product}` };

  // Name the local file with the conventions-compliant name up front; the
  // download writes straight to it (Windows-native path avoids the backslash-
  // directory bug, handled inside realDownloadArtifact).
  const title = artifact.title?.trim() || task.product;
  const remoteName = studioFilename(title, timestamp, task.product);
  const namedLocal = `${workDir}/${remoteName}`;

  const dl = await downloadArtifact(notebookId, artifact.id, task.cliType, namedLocal);
  if (!dl.ok) {
    return {
      ok: false,
      reason:
        `download of artifact ${artifact.id} failed or produced an empty file` +
        (dl.stderr ? `: ${dl.stderr.slice(0, 300)}` : ""),
    };
  }

  const buf = await fs.readFile(namedLocal);
  if (buf.length === 0) return { ok: false, reason: "downloaded file is empty" };

  const contentType = getContentType(remoteName);
  // Phase B / S50 — upload to the CLONE's org-prefixed path + write an audit
  // row. upsert: true preserves pre-S50 semantics (studio-only intentionally
  // overwrites prior v1 product files inside the clone's slug folder).
  // researchQueueId is null here because the script only knows the parent
  // run id (the clone's queue id is not on the manifest pre-S50); audit row
  // still records caller/org/path/bytes for the storage-write trail.
  const result = await uploadWithAudit({
    sb,
    caller: "regenerate-studio-products.ts",
    organizationId: manifestOrgId,
    researchQueueId: null,
    projectSlug: manifestSlug,
    filename: remoteName,
    content: buf,
    contentType,
    upsert: true,
  });
  if (!result.ok) {
    return { ok: false, reason: `Supabase upload failed: ${result.reason}` };
  }
  console.log(
    `[studio-only]   ✓ ${remoteName} (${(buf.length / 1024 / 1024).toFixed(1)} MB) → ${result.path}`,
  );
  return { ok: true, remoteName };
}

// ── CLI entry (runs ONLY when executed directly — never on import) ──────────
// Mirrors finalize-recovered-run.ts: the arg-validation + main() are gated so a
// unit test can import downloadAndUpload without process.exit(2) or auto-running
// the studio-only job (S160 C-A testability).
const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!workDirArg || !manifestPathArg) {
    console.error("usage: regenerate-studio-products.ts <workDir> <manifestPath>");
    process.exit(2);
  }
  main().catch(async (err) => {
    await fail(`unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
}

export { downloadAndUpload };
