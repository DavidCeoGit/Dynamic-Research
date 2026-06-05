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
 *
 * S64 (preflight-cost-architecture v3.1): three new orchestration points:
 *   1. Startup backoff probe — read .preflight-backoff before preflight;
 *      if Open (backoffUntil > now), exit 0 cheaply so cron keeps observing.
 *   2. Preflight outcome -> advancePreflightCircuit — writes backoff state +
 *      sends Resend operator-alert on N>=3 transition or recovery.
 *   3. Post-poll terminal-exit handler — consumePendingTerminalExit() after
 *      executeJob() finishes naturally (preserves finally + usage telemetry);
 *      if a TerminalError was marked by executor.ts/plan-reviewer.ts, write
 *      backoff state, fire notification, exit 1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { claimJob } from "./api-client.js";
import { executeJob } from "./executor.js";
import { runPreflight, advancePreflightCircuit } from "./preflight.js";
import {
  readBackoff,
  consumePendingTerminalExit,
  recordFailureFromTerminalError,
  remediationForKind,
  NOTIFY_THRESHOLD,
} from "./lib/preflight-backoff.js";
import { sendPreflightBackoffEmail } from "./lib/notify.js";
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

function ensureSingleton(): void {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const existingPid = Number(raw);

    if (existingPid && existingPid !== process.pid) {
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
        log(`Stale .worker.pid (PID ${existingPid} no longer alive) — taking over`);
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
  }

  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`PID file claimed: ${PID_FILE} (PID ${process.pid})`);
}

function releasePidFile(): void {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
    const recorded = Number(raw);
    if (recorded === process.pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // PID file gone or unreadable — nothing to clean
  }
}

// ── S64 backoff probe ──────────────────────────────────────────────

/**
 * Read .preflight-backoff. If Open (backoffUntil > now), exit 0 immediately
 * with the operator-friendly log line. Cron continues to fire every 5 min;
 * each tick observes Open + exits cheaply. Half-Open (window expired) falls
 * through to normal preflight.
 *
 * Exit-0 is intentional per design §3.2.E + §6.E: a known-idle cron tick
 * during backoff should NOT trigger LastTaskResult != 0 escalation/alerting.
 * Only NEW failures (preflight or terminal) set non-zero exit.
 */
async function probeBackoff(): Promise<void> {
  const backoff = await readBackoff();
  if (!backoff) {
    return;
  }
  const now = new Date();
  const until = new Date(backoff.backoffUntil);
  if (until > now) {
    const minutesLeft = Math.max(0, Math.round((until.getTime() - now.getTime()) / 60000));
    log(
      `[preflight] backoff-action: backoff-skip — active until ${backoff.backoffUntil} ` +
      `(${backoff.consecutiveFailures} consecutive failures, last kind: ${backoff.lastFailureKind}, ` +
      `~${minutesLeft} min remaining). Exiting 0.`,
    );
    releasePidFile();
    process.exit(0);
  }
  log(
    `[preflight] backoff-action: half-open — window expired (${backoff.consecutiveFailures} prior failures); running checks`,
  );
}

// ── S64 terminal-exit finalizer ────────────────────────────────────

/**
 * Called AFTER each poll() iteration returns (success OR caught error).
 * If executor.ts/plan-reviewer.ts marked a pending TerminalError via
 * markPendingTerminalExit(), advance the circuit breaker + fire notification
 * + exit 1. If not, return cleanly so the next poll can be scheduled.
 *
 * Decoupling exit from inline catch sites (per Codex C-C1) preserves the
 * existing executor.ts finally block — recordUsage telemetry runs, failJob
 * runs, notifyTerminal runs, all before this finalizer sees the flag.
 */
async function finalizeTerminalExitIfPending(): Promise<boolean> {
  const pending = consumePendingTerminalExit();
  if (!pending) return false;
  log(
    `Terminal provider error: kind=${pending.kind} from ${pending.source} (${pending.signature}). ` +
    `Advancing backoff + exiting 1.`,
  );
  // S64 Codex MERGE-gate C1: wrap the durable write in try/catch so a
  // backoff-write failure (disk full, EPERM exhaustion, etc) does NOT
  // swallow the terminal-exit decision. We still exit 1 on write failure
  // — the next cron tick (5 min) will re-run preflight; if the same
  // terminal cause persists, the next worker will write backoff cleanly.
  // Worst case: one missed backoff window, not infinite queue-burn.
  let state: import("./lib/preflight-backoff.js").BackoffState | null = null;
  let transitionedToNotify = false;
  try {
    const result = await recordFailureFromTerminalError(pending);
    state = result.state;
    transitionedToNotify = result.transitionedToNotify;
    log(
      `[preflight] backoff-state: failures=${state.consecutiveFailures} until=${state.backoffUntil} ` +
      `kind=${state.lastFailureKind} (terminal-origin: ${pending.source})`,
    );
  } catch (writeErr) {
    log(
      `[preflight] backoff-write FAILED (non-fatal): ${(writeErr as Error).message}. ` +
      `Exiting 1 anyway; cron will respawn and retry backoff write on next failure.`,
    );
  }
  if (transitionedToNotify && state) {
    log(`[preflight] backoff-state: crossed N=${NOTIFY_THRESHOLD} threshold — notification will fire`);
    await sendPreflightBackoffEmail({
      origin: "terminal",
      kind: pending.kind,
      source: pending.source,
      signature: pending.signature,
      consecutiveFailures: state.consecutiveFailures,
      backoffUntil: state.backoffUntil,
      detail: `Terminal provider error detected at ${pending.source} (${pending.signature}).`,
      remediation: remediationForKind(pending.kind),
    }).catch((err) => {
      log(`[notify] terminal-exit email threw (non-fatal): ${(err as Error).message}`);
    });
  }
  releasePidFile();
  process.exit(1);
}

// ── Main loop ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Worker starting" + (DRY_RUN ? " [DRY RUN MODE]" : ""));
  log(`Poll interval: ${POLL_INTERVAL}ms`);
  log(`API: ${process.env.API_BASE_URL ?? "https://dynamic-research.vercel.app"}`);

  ensureSingleton();

  if (!DRY_RUN) {
    // S64: backoff probe BEFORE preflight to avoid running checks during a
    // known outage window.
    await probeBackoff();

    const outcome = await runPreflight();
    const advanced = await advancePreflightCircuit(outcome);
    if (advanced.shouldExit) {
      log(`Preflight failed (kind=${advanced.failureKind}, notify=${advanced.transitionedToNotify}). Exiting 1.`);
      releasePidFile();
      process.exit(1);
    }
  }

  // First poll iteration — kicks off the recursive setTimeout chain via
  // schedulePoll() at the bottom of pollAndContinue().
  await pollAndContinue();
}

/**
 * Wraps poll() with the terminal-exit handler + scheduling. This is the
 * unit that the recursive setTimeout chain runs each tick. Sequencing:
 *   1. poll() executes one job (or skips if queue empty)
 *   2. finalize checks pending-exit flag — if set, process.exit(1) here
 *   3. otherwise schedule next tick
 */
async function pollAndContinue(): Promise<void> {
  await poll();
  if (!DRY_RUN) {
    await finalizeTerminalExitIfPending();
  }
  schedulePoll();
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
    // S64: pending-exit flag (if set by catch-site classifier) is read by
    // finalizeTerminalExitIfPending() AFTER this finally block runs.
  } finally {
    currentJob = null;
  }
}

function schedulePoll(): void {
  if (!running) return;
  pollTimer = setTimeout(() => {
    void pollAndContinue();
  }, POLL_INTERVAL);
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
  }

  releasePidFile();

  setTimeout(() => {
    log("Shutdown complete");
    process.exit(0);
  }, 2_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));

if (process.platform === "win32") {
  process.on("SIGINT", () => {
    log("Received SIGINT — ignoring (daemon, Bug 47)");
  });
  process.on("SIGHUP", () => {
    log("Received SIGHUP — ignoring (daemon, Bug 45)");
  });
} else {
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("exit", () => {
  releasePidFile();
});

// ── Unhandled error safety net ──────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`);
  log(err.stack ?? "(no stack)");
  releasePidFile();
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
