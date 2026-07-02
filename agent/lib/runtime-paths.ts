/**
 * S197 — cwd-independent runtime anchor for worker-adjacent state files.
 *
 * Why this exists (studio-product-checker design §4.3, Codex CRITICAL):
 * ambient `process.cwd()` is a trap for anything that must agree with the
 * worker about where runtime state lives. The shipped launcher
 * `agent/worker-start.bat` cd's into its own directory (`cd /d "%~dp0"`)
 * before starting the worker, so `.worker.pid` — written under
 * `process.cwd()` (worker.ts) — lives at `agent/.worker.pid`. A sibling
 * process launched from a different cwd (repo root, Task Scheduler default,
 * a shell) would resolve those paths somewhere else entirely and go blind.
 *
 * `agentRuntimeDir()` anchors on THIS module's on-disk location
 * (`agent/lib/runtime-paths.ts` → `agent/`), never on cwd, so the breadcrumb
 * writer (executor), the breadcrumb GC (worker idle tick), and the
 * studio-product-checker all resolve `.run/` and `.studio-checker/` to the
 * SAME directory regardless of how each process was launched.
 *
 * ⚠️ LOAD-BEARING INVARIANT: `.worker.pid` itself is NOT moved (zero worker
 * behavior change) — it stays under the worker's cwd. The checker reads it at
 * `agentRuntimeDir()/.worker.pid`, which equals the worker's cwd ONLY because
 * `worker-start.bat` cd's into the agent/ dir it lives in (`%~dp0`). If the
 * launcher ever stops doing that, the checker's worker-liveness read (§5.2 #7)
 * degrades to its WORKER_LOCATION_MISMATCH belt — do not remove the belt.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** Absolute path of the agent/ runtime dir (this module's parent's parent). */
export function agentRuntimeDir(): string {
  // agent/lib/runtime-paths.ts → dirname = agent/lib → dirname = agent/
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
