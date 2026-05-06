/**
 * Research Worker Daemon
 *
 * Long-running Node.js process that polls the research queue for
 * pending jobs, claims them atomically, and executes the
 * /research-compare pipeline via Claude CLI.
 *
 * Usage:
 *   pnpm start          — run daemon (polls every 30s)
 *   pnpm dev            — run with file watching (auto-restart on changes)
 *   DRY_RUN=true pnpm start — simulate pipeline without spawning Claude
 *
 * Environment variables: see .env.example
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { claimJob } from "./api-client.js";
import { executeJob } from "./executor.js";
import { runPreflight } from "./preflight.js";
import type { ResearchJob } from "./types.js";

// ── Config ──────────────────────────────────────────────────────────

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 30_000;
const DRY_RUN = process.env.DRY_RUN === "true";
const PID_FILE = path.join(process.cwd(), ".worker.pid");

// ── State ───────────────────────────────────────────────────────────

let running = true;
let currentJob: ResearchJob | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ── Singleton enforcement ───────────────────────────────────────────

/**
 * Refuse to start if another worker.ts process is already running.
 *
 * Windows TaskStop and Ctrl+C-via-Bash do not reliably propagate signals
 * through `bash → cmd → node`, so prior worker daemons can survive as
 * orphan processes. Multiple orphans then claim jobs in parallel from
 * the shared Supabase queue, leading to non-deterministic claim arrival
 * and (worse) DLL-init failures from spawning claude.exe out of stale
 * Node process state — see error 3221225794 (STATUS_DLL_INIT_FAILED) at
 * ASC session 27, 2026-05-06.
 *
 * Approach: PID file at .worker.pid in cwd. On start, check if it exists
 * and the recorded PID is still alive. If alive, refuse. If dead, take
 * over. The handler in shutdown() removes the file on graceful exit.
 */
function ensureSingleton(): void {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const existingPid = Number(raw);

    if (existingPid && existingPid !== process.pid) {
      // signal 0 doesn't deliver — just probes whether the PID is alive
      try {
        process.kill(existingPid, 0);
        console.error(
          `\n[worker] Another worker.ts is already running (PID ${existingPid}).\n` +
          `[worker] Refusing to start a second instance.\n` +
          `[worker] To stop the existing worker:\n` +
          `[worker]   bash scripts/cleanup-orphans.sh\n` +
          `[worker]   # OR if you're sure it's a stale PID file, delete .worker.pid and retry.\n`,
        );
        process.exit(2);
      } catch {
        // Process is dead — stale PID file, safe to take over
        log(`Stale .worker.pid (PID ${existingPid} no longer alive) — taking over`);
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
    // No PID file — first start, fall through to write
  }

  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`PID file claimed: ${PID_FILE} (PID ${process.pid})`);
}

function releasePidFile(): void {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const recorded = Number(raw);
    // Only remove if we own it (don't delete a successor's PID file)
    if (recorded === process.pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // PID file gone or unreadable — nothing to clean
  }
}

// ── Main loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Worker starting" + (DRY_RUN ? " [DRY RUN MODE]" : ""));
  log(`Poll interval: ${POLL_INTERVAL}ms`);
  log(`API: ${process.env.API_BASE_URL ?? "https://dynamic-research.vercel.app"}`);

  // Singleton check: bail if another worker.ts is already running.
  // Must run BEFORE preflight so we don't waste 5-10s on probes when
  // we're going to refuse to start anyway.
  ensureSingleton();

  // Pre-flight checks: fail loudly BEFORE claiming any jobs. Covers env sanity,
  // claude-CLI spawn health, and NLM auth freshness. Without this, a broken
  // spawn or expired NLM cookie is only discovered AFTER a job is claimed
  // and marked running in the DB. Dry-run skips the spawn+NLM checks because
  // the pipeline never touches those in simulated mode.
  if (!DRY_RUN) {
    await runPreflight();
  }

  // Start polling
  await poll();
}

async function poll(): Promise<void> {
  if (!running) return;

  try {
    log("Polling for pending jobs...");
    const job = await claimJob();

    if (!job) {
      log("No pending jobs");
      return;
    }

    log(`Claimed job: ${job.id} — "${job.topic}"`);
    currentJob = job;

    await executeJob(job);

    log(`Job ${job.id} finished successfully`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Job execution error: ${msg}`);

    // If the job was claimed but failed, it's already marked as failed
    // by the executor. If claiming itself failed, just log and continue.
  } finally {
    currentJob = null;
    schedulePoll();
  }
}

function schedulePoll(): void {
  if (!running) return;
  pollTimer = setTimeout(poll, POLL_INTERVAL);
}

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal: string): void {
  log(`Received ${signal} — shutting down gracefully`);
  running = false;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  if (currentJob) {
    log(`Job ${currentJob.id} is still running — it will be marked failed on next restart`);
    // The job's status is "running" in the DB. On next daemon start,
    // a separate cleanup routine could detect stale running jobs.
    // For now, manual intervention is needed.
  }

  releasePidFile();

  // Give in-flight HTTP requests a moment to complete
  setTimeout(() => {
    log("Shutdown complete");
    process.exit(0);
  }, 2_000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Windows: handle Ctrl+C
if (process.platform === "win32") {
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}

// Last-ditch PID-file cleanup if process exits without going through
// shutdown() (e.g. uncaught exception path or hard kill). Best-effort.
process.on("exit", () => {
  releasePidFile();
});

// ── Unhandled error safety net ──────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason}`);
  // Don't crash — log and continue polling
});

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  log(err.stack ?? "(no stack)");
  releasePidFile();
  // Crash on uncaught exceptions — something is seriously wrong
  process.exit(1);
});

// ── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] [worker] ${msg}`);
}

// ── Start ───────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal error:", err);
  releasePidFile();
  process.exit(1);
});
