/**
 * Job executor — takes a claimed ResearchJob and runs the pipeline.
 *
 * 1. Prepares working directory with a job manifest
 * 2. Spawns `claude` CLI to run /research-compare non-interactively
 * 3. Watches state.json for progress, relays updates via API
 * 4. Uploads final outputs to Supabase Storage
 * 5. Returns result slug on success
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { updateJob, completeJob, failJob } from "./api-client.js";
import type { ResearchJob, PipelineState } from "./types.js";

// ── Config ──────────────────────────────────────────────────────────

const WORKING_DIR = process.env.WORKING_DIR ?? "/c/tmp/research-compare";
const PROJECTS_DIR = process.env.PROJECTS_DIR ??
  "/c/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = "research-projects";
const DRY_RUN = process.env.DRY_RUN === "true";

// Phase number → { name, progressPct } mapping from /research-compare
const PHASE_MAP: Record<string, { name: string; pct: number }> = {
  "0":   { name: "Preflight",           pct: 5 },
  "0.5": { name: "Research Brief",      pct: 8 },
  "1":   { name: "Perplexity Research", pct: 15 },
  "1.5": { name: "CI Tier 1 Scoring",   pct: 25 },
  "2":   { name: "NotebookLM Import",   pct: 30 },
  "3":   { name: "NotebookLM Research", pct: 40 },
  "4":   { name: "Extraction",          pct: 50 },
  "5":   { name: "Synthesis",           pct: 60 },
  "5.5": { name: "Studio Products",     pct: 70 },
  "6":   { name: "Vendor Evaluation",   pct: 85 },
  "7":   { name: "Finalization",        pct: 95 },
};

// ── Supabase client (lazy) ──────────────────────────────────────────

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase credentials not configured");
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

// ── Main executor ───────────────────────────────────────────────────

export async function executeJob(job: ResearchJob): Promise<string> {
  const slug = job.topic_slug;
  const workDir = path.join(WORKING_DIR, slug);
  const projectsDir = path.join(PROJECTS_DIR, slug);

  log(job.id, `Starting job: "${job.topic}" (slug: ${slug})`);

  // 1. Prepare working directory
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });

  // 2. Write job manifest (used by the non-interactive prompt)
  const manifestPath = path.join(workDir, "job-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(buildManifest(job), null, 2));
  log(job.id, `Manifest written to ${manifestPath}`);

  // 3. Update job status to running with initial phase
  await updateJob(job.id, {
    status: "running",
    current_phase: "Preflight",
    phase_status: "Preparing workspace",
    progress_pct: 2,
  });

  if (DRY_RUN) {
    log(job.id, "[DRY RUN] Skipping Claude CLI execution");
    await simulateDryRun(job);
    return slug;
  }

  // 4. Write full prompt to file; spawn Claude CLI with a short directive
  //    that tells it to read the prompt file. Avoids Windows cmd.exe
  //    mangling multi-line argv (newlines terminate cmd commands).
  const fullPrompt = buildPrompt(job, manifestPath);
  const promptPath = path.join(workDir, "claude-prompt.md");
  await fs.writeFile(promptPath, fullPrompt);

  const spawnPrompt =
    `Read the full execution brief at ${promptPath} and then execute it. ` +
    `Do not ask the user any questions — all inputs are in the brief and the referenced manifest.`;

  let claudeProcess: ChildProcess;

  try {
    claudeProcess = spawnClaude(spawnPrompt, workDir);
  } catch (err) {
    await failJob(job.id, `Failed to spawn claude: ${err}`);
    throw err;
  }

  // 5. Monitor state.json for progress + relay to API
  const stateWatcher = watchStateFile(job, workDir);

  // 6. Wait for Claude process to complete
  const exitCode = await waitForProcess(claudeProcess, job);

  // 7. Stop watching
  stateWatcher.stop();

  if (exitCode !== 0) {
    const errMsg = `Claude process exited with code ${exitCode}`;
    log(job.id, errMsg);
    await failJob(job.id, errMsg);
    throw new Error(errMsg);
  }

  // Bug 35: exit 0 ≠ success. /research-compare can write a remediation
  // message to state.json and exit cleanly when it hits a recoverable error
  // (e.g. expired NLM auth at Phase 0). Verify the pipeline actually reached
  // Finalization before treating this as a successful run.
  const verdict = await verifyPipelineCompletion(workDir);
  if (!verdict.success) {
    log(job.id, `Pipeline did not complete: ${verdict.reason}`);
    await failJob(job.id, verdict.reason);
    throw new Error(verdict.reason);
  }
  log(job.id, verdict.reason);

  // 8. Upload outputs to Supabase Storage
  log(job.id, "Pipeline complete — uploading outputs to Supabase Storage");
  await uploadOutputs(job, workDir, projectsDir);

  // 9. Mark complete
  await completeJob(job.id, slug);
  log(job.id, "Job completed successfully");

  return slug;
}

// ── Manifest builder ────────────────────────────────────────────────

/**
 * Translates the queue job into the state file format that
 * /research-compare uses internally. This lets the CLI skip
 * all interactive prompts and jump straight to execution.
 */
function buildManifest(job: ResearchJob) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    timestamp: ts,
    topic: job.topic,
    topic_slug: job.topic_slug,
    version: 1,
    phase: "0",
    phase_status: "queued",
    notebook_id: null,
    notebook_title: null,
    projects_path: path.join(PROJECTS_DIR, job.topic_slug),
    perplexity_mcp_available: true,
    aji_dna_enabled: job.aji_dna_enabled,
    persona_configured: false,
    topic_half_life: null,
    userContext: {
      contextFilePath: null,
      additionalUrls: job.user_context.additionalUrls,
      claimsToVerify: job.user_context.claimsToVerify,
      domainKnowledge: job.user_context.domainKnowledge,
      constraints: job.user_context.constraints,
      localSourcePath: null,
    },
    selectedProducts: job.selected_products,
    customizations: job.customizations,
    vendorEvaluation: {
      ...job.vendor_evaluation,
      vendorsDiscovered: [],
      vendorsShortlisted: [],
      vendorsExcluded: [],
      preScreeningComplete: false,
    },
    artifacts: {},
    files_written: [],
  };
}

// ── Prompt builder ──────────────────────────────────────────────────

/**
 * Build the non-interactive prompt for Claude CLI.
 *
 * This tells Claude to run /research-compare in "queue mode":
 * all user answers are pre-collected in the manifest, skip all
 * AskUserQuestion prompts, and execute the full pipeline.
 */
function buildPrompt(job: ResearchJob, manifestPath: string): string {
  const products = Object.entries(job.selected_products)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  return `You are executing a queued research job non-interactively. All user input has been pre-collected.

CRITICAL: Do NOT use AskUserQuestion at any point. All parameters are provided below.

Read the job manifest at: ${manifestPath}

Then execute the /research-compare pipeline for topic: "${job.topic}"

Pre-collected parameters (DO NOT ask the user for these):
- Topic: ${job.topic}
- Domain knowledge: ${JSON.stringify(job.user_context.domainKnowledge)}
- Constraints: ${JSON.stringify(job.user_context.constraints)}
- Additional URLs: ${JSON.stringify(job.user_context.additionalUrls)}
- Claims to verify: ${JSON.stringify(job.user_context.claimsToVerify)}
- Vendor evaluation: ${job.vendor_evaluation.enabled ? "ENABLED" : "DISABLED"}${job.vendor_evaluation.enabled ? `
  - Vendor type: ${job.vendor_evaluation.vendorType}
  - Service area: ${job.vendor_evaluation.serviceArea}
  - Service address: ${job.vendor_evaluation.serviceAddress}
  - Job description: ${job.vendor_evaluation.jobDescription}
  - Max vendors discovered: ${job.vendor_evaluation.maxVendorsDiscovered}
  - Max vendors enriched: ${job.vendor_evaluation.maxVendorsEnriched}` : ""}
- Aji DNA: ${job.aji_dna_enabled ? "ENABLED" : "DISABLED"}
- Selected products: ${products}
- Perplexity customization: ${JSON.stringify(job.customizations.perplexity)}
- NotebookLM customization: ${JSON.stringify(job.customizations.notebookLM)}
- Studio customizations: ${JSON.stringify(job.customizations.studio)}

Execution rules:
1. Skip Phase 0.5 Steps A-E (interactive discussion, product selection, customization design) — use the parameters above
2. Start from Phase 0 (Preflight Setup) using the pre-built manifest
3. Execute all phases through completion
4. Write all outputs to the working directory and projects directory
5. Update the state.json file at every checkpoint (the worker monitors this)
6. On error, write error details to state.json phase_status before exiting`;
}

// ── Claude CLI spawner ──────────────────────────────────────────────

function spawnClaude(prompt: string, cwd: string): ChildProcess {
  // Claude Code CLI: `claude -p` for non-interactive (print) mode
  // --verbose for progress output, --output-format json for structured output
  const args = [
    "-p", prompt,
    "--verbose",
    "--allowedTools", [
      "Bash", "Read", "Write", "WebSearch", "WebFetch",
      "mcp__perplexity__perplexity_research",
      "mcp__perplexity__perplexity_ask",
      "mcp__perplexity__perplexity_search",
      "mcp__perplexity__perplexity_reason",
      "mcp__Chrome_DevTools_MCP__list_pages",
      "mcp__Chrome_DevTools_MCP__new_page",
      "mcp__Chrome_DevTools_MCP__select_page",
      "mcp__Chrome_DevTools_MCP__navigate_page",
      "mcp__Chrome_DevTools_MCP__take_snapshot",
      "mcp__Chrome_DevTools_MCP__fill",
      "mcp__Chrome_DevTools_MCP__click",
      "mcp__Chrome_DevTools_MCP__type_text",
      "mcp__Chrome_DevTools_MCP__press_key",
      "mcp__Chrome_DevTools_MCP__evaluate_script",
      "mcp__Chrome_DevTools_MCP__take_screenshot",
    ].join(","),
  ];

  log("spawn", `claude ${args.slice(0, 2).join(" ")} [... ${args.length} args]`);

  // Strip CLAUDECODE so the child Claude Code CLI doesn't refuse to start
  // with "cannot be launched inside another Claude Code session" when the
  // worker itself happens to be running as a descendant of a Claude Code
  // process (e.g. during local dev).
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "worker" };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_SSE_PORT;
  delete childEnv.CLAUDE_CODE_SESSION_ID;

  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: childEnv,
  });

  // Log stdout/stderr
  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      log("claude:out", line.slice(0, 200));
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      log("claude:err", line.slice(0, 200));
    }
  });

  return child;
}

// ── Process completion waiter ───────────────────────────────────────

function waitForProcess(child: ChildProcess, job: ResearchJob): Promise<number> {
  const maxDuration = Number(process.env.MAX_JOB_DURATION_MS) || 5_400_000; // 90 min

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      log(job.id, `Job exceeded max duration (${maxDuration}ms) — killing`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, maxDuration);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── State file watcher ──────────────────────────────────────────────

interface StateWatcher {
  stop: () => void;
}

function watchStateFile(job: ResearchJob, workDir: string): StateWatcher {
  let lastPhase = "";
  let lastPct = 0;
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      const stateFile = await findStateFile(workDir);
      if (!stateFile) return;

      const content = await fs.readFile(stateFile, "utf-8");
      const state: PipelineState = JSON.parse(content);

      // Map pipeline phase to progress percentage
      const mapped = PHASE_MAP[state.phase];
      const pct = mapped?.pct ?? lastPct;
      const phaseName = mapped?.name ?? state.phase;

      // Only update if something changed
      if (state.phase !== lastPhase || pct !== lastPct) {
        lastPhase = state.phase;
        lastPct = pct;

        log(job.id, `Phase: ${phaseName} (${pct}%) — ${state.phase_status}`);

        await updateJob(job.id, {
          current_phase: phaseName,
          phase_status: state.phase_status,
          progress_pct: pct,
        }).catch((err) => {
          log(job.id, `Failed to update progress: ${err}`);
        });
      }
    } catch {
      // State file doesn't exist yet or is being written — ignore
    }
  }, 5_000); // Check every 5 seconds

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function findStateFile(workDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(workDir);
    const stateFile = files.find((f) => f.endsWith("-state.json"));
    return stateFile ? path.join(workDir, stateFile) : null;
  } catch {
    return null;
  }
}

// ── Pipeline completion verifier (Bug 35) ──────────────────────────

interface CompletionVerdict {
  success: boolean;
  reason: string;
}

/**
 * After Claude CLI exits with code 0, verify the pipeline actually reached
 * Finalization (phase "7"). The CLI exits 0 even when /research-compare
 * gracefully handles in-run errors — e.g. expired NLM auth at Phase 0 prints
 * remediation steps and exits cleanly. Without this guard, those failed runs
 * land in the DB as `status: completed` (Bug 35, session 25 — ASC job
 * 619a7615 was marked complete despite Phase 0 failure).
 *
 * Primary signal: state.phase === "7" (Finalization). The phase progresses
 * 0 → 0.5 → 1 → ... → 7 and only reaches 7 when all earlier phases passed.
 * False positives on phase_status string-matching are too risky (e.g. "0
 * errors found" would match a naive /error/i), so we trust phase ordering.
 */
async function verifyPipelineCompletion(workDir: string): Promise<CompletionVerdict> {
  const stateFile = await findStateFile(workDir);
  if (!stateFile) {
    return {
      success: false,
      reason: "Claude exited 0 but no state.json was written — cannot verify completion",
    };
  }

  let state: PipelineState;
  try {
    const content = await fs.readFile(stateFile, "utf-8");
    state = JSON.parse(content) as PipelineState;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      reason: `state.json unreadable after Claude exit: ${msg}`,
    };
  }

  if (state.phase !== "7") {
    const phaseLabel = PHASE_MAP[state.phase]?.name ?? state.phase;
    const status = (state.phase_status ?? "(empty)").slice(0, 200);
    return {
      success: false,
      reason: `Pipeline stopped at phase ${state.phase} (${phaseLabel}); expected phase 7 (Finalization). phase_status: "${status}"`,
    };
  }

  return { success: true, reason: "Pipeline reached Finalization (phase 7)" };
}

// ── Output uploader ─────────────────────────────────────────────────

/**
 * Upload all output files from the projects directory to Supabase Storage.
 * Skips state.json and manifest files.
 */
async function uploadOutputs(
  job: ResearchJob,
  workDir: string,
  projectsDir: string,
): Promise<void> {
  const sb = getSupabase();
  const slug = job.topic_slug;

  // Collect files from both directories
  const filesToUpload: Array<{ localPath: string; remoteName: string }> = [];

  // Projects dir has the final deliverables
  for (const source of [projectsDir, workDir]) {
    try {
      const files = await fs.readdir(source);
      for (const file of files) {
        // Skip manifests, node_modules, etc.
        if (file === "job-manifest.json" || file === "node_modules" || file.startsWith(".")) {
          continue;
        }
        const localPath = path.join(source, file);
        const stat = await fs.stat(localPath);
        if (!stat.isFile()) continue;

        filesToUpload.push({ localPath, remoteName: file });
      }
    } catch {
      log(job.id, `Directory not found for upload: ${source}`);
    }
  }

  // Deduplicate by filename (projects dir wins)
  const seen = new Set<string>();
  const deduped = filesToUpload.filter((f) => {
    if (seen.has(f.remoteName)) return false;
    seen.add(f.remoteName);
    return true;
  });

  log(job.id, `Uploading ${deduped.length} files to Supabase Storage`);

  for (const { localPath, remoteName } of deduped) {
    try {
      const content = await fs.readFile(localPath);
      const contentType = guessContentType(remoteName);

      const { error } = await sb.storage
        .from(BUCKET)
        .upload(`${slug}/${remoteName}`, content, {
          contentType,
          upsert: true,
        });

      if (error) {
        log(job.id, `Upload failed for ${remoteName}: ${error.message}`);
      } else {
        log(job.id, `Uploaded: ${remoteName} (${content.length} bytes)`);
      }
    } catch (err) {
      log(job.id, `Upload error for ${remoteName}: ${err}`);
    }
  }
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
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
  return map[ext] ?? "application/octet-stream";
}

// ── Dry run simulator ───────────────────────────────────────────────

async function simulateDryRun(job: ResearchJob): Promise<void> {
  const phases = [
    { name: "Preflight", pct: 5, delay: 1000 },
    { name: "Research Brief", pct: 8, delay: 1000 },
    { name: "Perplexity Research", pct: 15, delay: 2000 },
    { name: "CI Tier 1 Scoring", pct: 25, delay: 1000 },
    { name: "NotebookLM Import", pct: 30, delay: 1000 },
    { name: "NotebookLM Research", pct: 40, delay: 2000 },
    { name: "Extraction", pct: 50, delay: 1000 },
    { name: "Synthesis", pct: 60, delay: 2000 },
    { name: "Studio Products", pct: 70, delay: 3000 },
    { name: "Finalization", pct: 95, delay: 1000 },
    { name: "Complete", pct: 100, delay: 500 },
  ];

  for (const phase of phases) {
    log(job.id, `[DRY RUN] Phase: ${phase.name} (${phase.pct}%)`);
    await updateJob(job.id, {
      current_phase: phase.name,
      phase_status: `[DRY RUN] ${phase.name}`,
      progress_pct: phase.pct,
    }).catch((err) => log(job.id, `Progress update failed: ${err}`));
    await sleep(phase.delay);
  }

  await completeJob(job.id, job.topic_slug);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Logging ─────────────────────────────────────────────────────────

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}
