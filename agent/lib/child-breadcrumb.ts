/**
 * S197 — job→child-PID breadcrumb (studio-product-checker design §4.2).
 *
 * The ONLY worker-side state the independent 5-min checker consumes to judge
 * child liveness. Semantics are strict and load-bearing:
 *
 *   A breadcrumb at `agentRuntimeDir()/.run/<job-id>.json` means "the claude
 *   child for <job-id> was spawned, and its exit has NOT yet been observed by
 *   the worker."
 *
 * Lifecycle (all seams in executor.ts):
 *   - DELETED at the top of executeJob (claim time) — a hard worker death
 *     (power loss, kill -9) orphans the breadcrumb; when the SAME job id is
 *     later re-queued, the new claim's pre-spawn window (attachments,
 *     manifest, plan-review gate) must not present a stale crumb as a live
 *     child (fresh-Claude MAJOR M-1). The checker ALSO freshness-gates on
 *     spawnedAt >= claimed_at; this delete is the belt.
 *   - WRITTEN immediately after spawnClaude succeeds.
 *   - DELETED immediately after waitForProcess resolves — NOT at the end of
 *     executeJob. The S129 gate + uploads legitimately run 15+ min after
 *     child exit; a lingering crumb would false-storm CHILD_DEAD_JOB_RUNNING
 *     on every healthy run (Gemini CRITICAL-1).
 *   - A `finally` failsafe delete covers throw paths.
 *   - GC'd on worker idle ticks for jobs no longer status='running'
 *     (breadcrumbs orphaned by hard death whose jobs later left `running`
 *     would otherwise accumulate — fresh-Claude INFO). A crumb whose job IS
 *     still `running` is NEVER GC'd: it is exactly the checker's #6 evidence.
 *
 * Every IO path here is best-effort and never throws — a breadcrumb failure
 * must never affect job execution (the checker degrades gracefully without
 * it). The worker itself never READS breadcrumbs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { agentRuntimeDir } from "./runtime-paths.js";

export interface ChildBreadcrumb {
  pid: number;
  /** ISO timestamp taken immediately after spawn. */
  spawnedAt: string;
  workDir: string;
  projectsDir: string;
}

/** Strict uuid shape — job ids come from the DB row; anything else must never
 * reach a filesystem path (defense-in-depth against a forged row). */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidJobId(jobId: string): boolean {
  return UUID_RE.test(jobId);
}

export function breadcrumbDir(): string {
  return path.join(agentRuntimeDir(), ".run");
}

/** Null when the job id fails the uuid shape check (caller logs + skips). */
export function breadcrumbPath(jobId: string): string | null {
  if (!isValidJobId(jobId)) return null;
  return path.join(breadcrumbDir(), `${jobId}.json`);
}

/** Write the breadcrumb. Never throws; a failed write logs and continues. */
export async function writeChildBreadcrumb(
  jobId: string,
  crumb: ChildBreadcrumb,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const p = breadcrumbPath(jobId);
  if (!p) {
    log(`[breadcrumb] refusing write: job id fails uuid shape (${jobId.slice(0, 40)})`);
    return;
  }
  try {
    await fs.mkdir(breadcrumbDir(), { recursive: true });
    await fs.writeFile(p, JSON.stringify(crumb));
  } catch (err) {
    log(`[breadcrumb] write failed (non-fatal): ${(err as Error).message}`);
  }
}

/** Delete the breadcrumb. Never throws; missing file is a no-op. */
export async function deleteChildBreadcrumb(
  jobId: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const p = breadcrumbPath(jobId);
  if (!p) return;
  try {
    await fs.rm(p, { force: true });
  } catch (err) {
    log(`[breadcrumb] delete failed (non-fatal): ${(err as Error).message}`);
  }
}

// ── Idle-tick GC ─────────────────────────────────────────────────────

export interface BreadcrumbGcDeps {
  /** Breadcrumb job ids currently on disk (filenames minus .json). */
  listBreadcrumbIds: () => Promise<string[]>;
  /** id → status for the given job ids; a missing id means the row is gone. */
  fetchStatuses: (ids: string[]) => Promise<Map<string, string>>;
  deleteBreadcrumb: (jobId: string) => Promise<void>;
  log: (msg: string) => void;
}

/** Bound per tick — the dir holds 0–1 files in practice; 50 is a hard cap so a
 * pathological accumulation can't stall an idle tick. */
const GC_MAX_PER_TICK = 50;

/**
 * Delete breadcrumbs whose jobs are NOT status='running' (or whose rows are
 * gone). A crumb with a malformed (non-uuid) filename is deleted outright —
 * nothing legitimate writes one. Never throws.
 */
export async function gcChildBreadcrumbsOnce(deps: BreadcrumbGcDeps): Promise<void> {
  try {
    const ids = (await deps.listBreadcrumbIds()).slice(0, GC_MAX_PER_TICK);
    if (ids.length === 0) return;

    const malformed = ids.filter((id) => !isValidJobId(id));
    for (const id of malformed) {
      await deps.deleteBreadcrumb(id).catch(() => undefined);
      deps.log(`[breadcrumb-gc] removed malformed breadcrumb name: ${id.slice(0, 40)}`);
    }

    const valid = ids.filter(isValidJobId);
    if (valid.length === 0) return;
    const statuses = await deps.fetchStatuses(valid);
    for (const id of valid) {
      const status = statuses.get(id);
      if (status === "running") continue; // the checker's #6 evidence — keep
      await deps.deleteBreadcrumb(id).catch(() => undefined);
      deps.log(
        `[breadcrumb-gc] removed orphaned breadcrumb for ${id} (status=${status ?? "row-gone"})`,
      );
    }
  } catch (err) {
    deps.log(`[breadcrumb-gc] error (non-fatal): ${(err as Error).message}`);
  }
}

export interface MaybeBreadcrumbGcOptions {
  logFn?: (msg: string) => void;
  /** Injected deps (tests). When set, the env/creds path is skipped. */
  deps?: BreadcrumbGcDeps;
}

/**
 * Worker idle-tick entry point. Best-effort, never throws. Cheap by
 * construction: the readdir is the only cost when no breadcrumbs exist (the
 * overwhelmingly common case); the DB SELECT fires only when one does.
 */
export async function maybeGcChildBreadcrumbs(
  opts: MaybeBreadcrumbGcOptions = {},
): Promise<void> {
  const log = opts.logFn ?? (() => {});
  try {
    let deps = opts.deps;
    if (!deps) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      if (!url || !key) return; // silently skip — GC is pure hygiene
      deps = buildDefaultGcDeps(url, key, log);
    }
    await gcChildBreadcrumbsOnce(deps);
  } catch (err) {
    log(`[breadcrumb-gc] unexpected error (non-fatal): ${(err as Error).message}`);
  }
}

function buildDefaultGcDeps(
  url: string,
  key: string,
  log: (msg: string) => void,
): BreadcrumbGcDeps {
  return {
    listBreadcrumbIds: async () => {
      try {
        const names = await fs.readdir(breadcrumbDir());
        return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
      } catch {
        return []; // .run/ absent — nothing to GC
      }
    },
    fetchStatuses: async (ids) => {
      const sb = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await sb
        .from("research_queue")
        .select("id, status")
        .in("id", ids);
      if (error) {
        // Fail SAFE for GC: report every id as running so nothing is deleted
        // on a flaky read (a kept orphan is dust; a wrongly-deleted crumb
        // erases the checker's #6 evidence).
        log(`[breadcrumb-gc] status query failed (non-fatal): ${error.message}`);
        return new Map(ids.map((id) => [id, "running"]));
      }
      return new Map(
        ((data ?? []) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
      );
    },
    deleteBreadcrumb: (jobId) => deleteChildBreadcrumb(jobId, log),
    log,
  };
}
