/**
 * S197 — Studio Product Checker: 5-minute per-product render-liveness watchdog.
 *
 * Design (v4, DESIGN-gate cleared S196):
 *   Documentation/studio-product-checker-design-gate.md
 *
 * WHAT: an INDEPENDENT, READ-ONLY, ALERT-ONLY pass fired every 5 min by the
 * Windows Scheduled Task "DynamicResearchStudioChecker". For every
 * status='running' job it verifies each DB-selected Studio product is actually
 * progressing on the NotebookLM side (status-aware `artifact list` — never the
 * lying `artifact poll`), plus child/worker liveness via the §4.2 breadcrumb
 * and `.worker.pid`. Findings are dedup'd through per-job latch files and
 * batched into ONE operator email per invocation (notify.ts channel).
 *
 * WHAT IT NEVER DOES (§6): no kill, no re-render, no park/complete, no DB
 * writes, no NLM mutations, no prompt-side feedback into the running agent.
 * Read-only is enforced by construction — this module imports NO job-mutation
 * helper (updateJob/failJob/completeJob/api-client are absent; a grep-guard
 * test pins that). Its only writes are its own latch dir + log under
 * agentRuntimeDir().
 *
 * FAILURE CONTAINMENT (§9): whole-run try/catch → exit 0 always; per-job
 * try/catch so one malformed workdir can't blind the fleet; per-product
 * guards; a liveness PROBE failure (PowerShell blip) is INDETERMINATE — it
 * must never masquerade as "child dead".
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { agentRuntimeDir } from "../lib/runtime-paths.js";
import {
  breadcrumbPath,
  isValidJobId,
  type ChildBreadcrumb,
} from "../lib/child-breadcrumb.js";
import { findStateFile, STUDIO_BEFORE_IDS_NAME } from "../lib/find-state-file.js";
import {
  PRODUCT_TO_NLM_TYPE,
  obligedProducts,
} from "../lib/studio-completeness.js";
import {
  realListArtifactsWithStatusDetailed,
  type DetailedListResult,
} from "../lib/nlm-artifact-cli.js";
import { artifactCreatedAtMs } from "../lib/artifact-timestamps.js";
import { sendStudioStallAlert, type StudioCheckerFinding } from "../lib/notify.js";
import { WORKING_DIR, STUDIO_VIDEO_RENDER_ENABLED } from "../lib/worker-config.js";
import type { SelectedProducts } from "../types.js";

// ── Config (env-guarded; NaN-safe per the sweep's envInt/envMs pattern) ──

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type AlertClass =
  | "STALLED_PRODUCT"
  | "RENDER_FAILED_STATUS"
  | "NO_ARTIFACT_AFTER_LAUNCH"
  | "AMBIGUOUS_ARTIFACT"
  | "CHILD_DEAD_JOB_RUNNING"
  | "WORKER_DEAD_JOB_RUNNING"
  | "WORKER_LOCATION_MISMATCH"
  | "NLM_AUTH_DEGRADED"
  | "NLM_CLI_BLIND"
  | "CHILD_WEDGED_POST_STUDIO"
  | "PROCESS_PROBE_BLIND";

/** Consecutive ≥5-min-apart sightings before a condition alerts (§5.2). */
export const CONFIRM_SIGHTINGS: Record<AlertClass, number> = {
  STALLED_PRODUCT: 2,
  RENDER_FAILED_STATUS: 1,
  NO_ARTIFACT_AFTER_LAUNCH: 2,
  AMBIGUOUS_ARTIFACT: 2,
  CHILD_DEAD_JOB_RUNNING: 2,
  WORKER_DEAD_JOB_RUNNING: 2,
  WORKER_LOCATION_MISMATCH: 2,
  NLM_AUTH_DEGRADED: 2,
  NLM_CLI_BLIND: 3,
  // Overridden dynamically in the latch pass (fresh-lens M-2, spec v4.1):
  // the wedge confirms at ceil(wedgeQuietMs/cadence)+1 spaced sightings —
  // the quiet period is CHECKER-OBSERVED, never artifact created_at age.
  CHILD_WEDGED_POST_STUDIO: 2,
  // S197 MERGE-gate addition (Codex MAJOR-4, mirrors row 9's philosophy): a
  // checker whose PID probes persistently fail must say "I am blind on
  // process liveness", not silently lose rows #6/#7.
  PROCESS_PROBE_BLIND: 3,
};

/** FYI classes alert with kind:'fyi' (informational, not actionable-critical). */
const FYI_CLASSES: ReadonlySet<AlertClass> = new Set([
  "AMBIGUOUS_ARTIFACT",
  "WORKER_LOCATION_MISMATCH",
  "CHILD_WEDGED_POST_STUDIO",
]);

/** Soft conditions requiring a FRESH sighting after a missed-tick gap
 * (sleep/downtime — §5.2 notes post-wake grace: #2,#4,#6,#7,#10). */
const SOFT_CLASSES: ReadonlySet<AlertClass> = new Set([
  "STALLED_PRODUCT",
  "NO_ARTIFACT_AFTER_LAUNCH",
  "CHILD_DEAD_JOB_RUNNING",
  "WORKER_DEAD_JOB_RUNNING",
  "CHILD_WEDGED_POST_STUDIO",
]);

export interface CheckerConfig {
  workingDir: string;
  cadenceMs: number;
  lockTtlMs: number;
  maxJobDurationMs: number;
  /** Launch-evidence → artifact-appearance threshold per product (§5.4). */
  tAppearMs: Record<string, number>;
  /** In-progress-render → stall-alert threshold per product (§5.4, video cap-clamped). */
  tRenderMs: Record<string, number>;
  /** #10: CHECKER-OBSERVED all-complete duration before the wedge confirms
   * (25 min) — realized as ceil(wedgeQuietMs/cadence)+1 spaced sightings,
   * never as artifact created_at age (that is submit time; fresh-lens M-2). */
  wedgeQuietMs: number;
  /** ± window for breadcrumb spawnedAt vs process CreationDate (§4.2). */
  pidCreationSlackMs: number;
  videoRenderFlagArmed: boolean;
}

/**
 * §5.4 defaults + the cap-aware video clamp: on a 90-min-cap deployment a flat
 * 75-min video threshold + 2 sightings alerts AFTER the cap has decided the
 * job, so T_render_effective(video) = min(T, cap − 30 min), floored at 20 min.
 * Wall-clock ≥ activeMs always, so the clamp biases toward alerting EARLY —
 * the safe direction (Codex MAJOR).
 */
export function buildConfigFromEnv(): CheckerConfig {
  const maxJobDurationMs = envMs("MAX_JOB_DURATION_MS", 5_400_000);
  const tAppearAll = envMs("STUDIO_CHECKER_T_APPEAR_MS", 0);
  const appearDefault = (d: number) => (tAppearAll > 0 ? tAppearAll : d);
  const renderDefault = (p: string, d: number) =>
    envMs(`STUDIO_CHECKER_T_RENDER_${p.toUpperCase()}_MS`, d);
  const videoRaw = renderDefault("video", 4_500_000); // 75 min
  const videoClamped = Math.max(
    1_200_000, // 20 min floor
    Math.min(videoRaw, maxJobDurationMs - 1_800_000), // cap − 30 min
  );
  return {
    workingDir: WORKING_DIR,
    cadenceMs: 300_000,
    lockTtlMs: envMs("STUDIO_CHECKER_LOCK_TTL_MS", 600_000),
    maxJobDurationMs,
    tAppearMs: {
      audio: appearDefault(600_000),
      video: appearDefault(900_000), // 15 min
      slides: appearDefault(600_000),
      report: appearDefault(600_000),
      infographic: appearDefault(600_000),
    },
    tRenderMs: {
      report: renderDefault("report", 1_800_000), // 30 min
      infographic: renderDefault("infographic", 1_800_000), // 30 min
      slides: renderDefault("slides", 2_100_000), // 35 min
      audio: renderDefault("audio", 3_300_000), // 55 min
      video: videoClamped,
    },
    wedgeQuietMs: 1_500_000, // 25 min (§5.2 #10)
    pidCreationSlackMs: 120_000, // ±2 min (§4.2)
    videoRenderFlagArmed: STUDIO_VIDEO_RENDER_ENABLED,
  };
}

// ── Shapes ──────────────────────────────────────────────────────────

export interface CheckerJobRow {
  id: string;
  topic_slug: string;
  organization_id: string;
  selected_products: unknown;
  pipeline_mode?: string | null;
  claimed_at: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** Result of the Get-CimInstance PID probe. `ok:false` = the PROBE itself
 * failed (PowerShell blip) — INDETERMINATE, never "process dead" (§9). */
export interface PidProbe {
  ok: boolean;
  exists: boolean;
  commandLine?: string;
  creationMs?: number | null;
}

export interface ConditionLatch {
  consecutive: number;
  firstSeenMs: number;
  lastSeenMs: number;
  alerted: boolean;
  escalated: boolean;
  measureMs?: number;
  thresholdMs?: number;
}

export interface JobLatch {
  slug?: string;
  conditions: Record<string, ConditionLatch>;
}

export interface CheckerMeta {
  lastInvocationMs?: number;
  /** Global (non-job) condition latches: NLM_AUTH_DEGRADED / NLM_CLI_BLIND. */
  global?: Record<string, ConditionLatch>;
}

export interface Observation {
  cls: AlertClass;
  jobId: string; // "" for global conditions
  slug: string;
  product?: string;
  detail: string;
  measureMs?: number;
  thresholdMs?: number;
}

export interface CheckerDeps {
  fetchRunningJobs: () => Promise<CheckerJobRow[]>;
  /** §5.1's second bounded read (Codex MERGE M-1): status per tracked job id,
   * used ONLY to confirm a latch's row really left 'running' before closing
   * it. NULL on read error — the caller must then keep every latch untouched
   * (dedup state must never be wiped on a transient SELECT failure). */
  fetchTrackedJobStatuses: (ids: string[]) => Promise<Map<string, string> | null>;
  /** findStateFile mirror — absolute path of the newest state file, or null. */
  findState: (workDir: string) => Promise<string | null>;
  /** File content, or null on ANY error (absent/unreadable). */
  readTextFile: (p: string) => Promise<string | null>;
  statMtimeMs: (p: string) => Promise<number | null>;
  listArtifactsDetailed: (notebookId: string, nlmType: string) => DetailedListResult;
  probePid: (pid: number) => Promise<PidProbe>;
  /** Live node processes whose command line mentions the worker (§4.3 belt). */
  findWorkerProcesses: () => Promise<Array<{ pid: number; commandLine: string }>>;
  readBreadcrumb: (jobId: string) => Promise<ChildBreadcrumb | null>;
  readWorkerPidFile: () => Promise<number | null>;
  readLatch: (jobId: string) => Promise<JobLatch | null>;
  writeLatch: (jobId: string, latch: JobLatch) => Promise<void>;
  listLatchJobIds: () => Promise<string[]>;
  deleteLatch: (jobId: string) => Promise<void>;
  readMeta: () => Promise<CheckerMeta | null>;
  writeMeta: (meta: CheckerMeta) => Promise<void>;
  sendAlert: (args: { findings: StudioCheckerFinding[] }) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
}

export interface CheckerRunResult {
  ran: boolean;
  skippedReason?: string;
  jobsChecked: number;
  observations: Observation[];
  findings: StudioCheckerFinding[];
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Same slug-shape discipline the sweep applies before filesystem use (§9). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/i;

function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

interface StudioMarker {
  runFloorMs: number | null;
  before: Record<string, Set<string>>;
  mtimeMs: number | null;
}

function parseStudioMarker(raw: string, mtimeMs: number | null): StudioMarker | null {
  try {
    const j = JSON.parse(raw) as { run_floor_ms?: unknown; before?: unknown };
    if (!j || typeof j !== "object") return null;
    const floor =
      typeof j.run_floor_ms === "number" && Number.isFinite(j.run_floor_ms)
        ? j.run_floor_ms
        : null;
    const before: Record<string, Set<string>> = {};
    if (j.before && typeof j.before === "object" && !Array.isArray(j.before)) {
      for (const [k, v] of Object.entries(j.before as Record<string, unknown>)) {
        before[k] = new Set(
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [],
        );
      }
    }
    return { runFloorMs: floor, before, mtimeMs };
  } catch {
    return null;
  }
}

/** state.artifacts[<p>].task_id (or .id) — the exact-id launch marker (§3). */
function expectedArtifactId(artifacts: unknown, product: string): string | null {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  const e = (artifacts as Record<string, unknown>)[product];
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const rec = e as { task_id?: unknown; id?: unknown };
  const v =
    (typeof rec.task_id === "string" && rec.task_id) ||
    (typeof rec.id === "string" && rec.id) ||
    "";
  return v || null;
}

// ── The pass (§5) ───────────────────────────────────────────────────

export async function runStudioCheckerOnce(
  deps: CheckerDeps,
  cfg: CheckerConfig,
): Promise<CheckerRunResult> {
  const now = deps.now();
  const observations: Observation[] = [];
  const findings: StudioCheckerFinding[] = [];

  // Missed-tick / post-wake grace (§5.2 notes, fresh-Claude m-2): detected
  // from the checker's OWN latch (no uptime-since-wake API exists — os.uptime
  // counts from boot and includes sleep). A gap > 2× cadence means ticks were
  // missed; soft conditions must re-earn their sightings from scratch.
  const meta = (await deps.readMeta()) ?? {};
  const lastMs = meta.lastInvocationMs;
  const graceActive =
    typeof lastMs === "number" && Number.isFinite(lastMs) && now - lastMs > 2 * cfg.cadenceMs;
  if (graceActive) {
    deps.log(
      `[checker] missed-tick gap detected (${minutes(now - (lastMs as number))}min since last invocation) — post-wake grace: soft-condition sightings reset`,
    );
  }

  // 1. Running rows (per-element validated — a forged row must not reach the
  // filesystem or a PowerShell filter).
  const rawJobs = await deps.fetchRunningJobs();
  const jobs: CheckerJobRow[] = [];
  for (const j of rawJobs) {
    if (!j || typeof j !== "object" || !isValidJobId(String(j.id ?? ""))) {
      deps.log(`[checker] skipping row with invalid id shape`);
      continue;
    }
    if (typeof j.topic_slug !== "string" || !SLUG_RE.test(j.topic_slug)) {
      deps.log(`[checker] ${j.id}: skipping — slug fails shape validation`);
      continue;
    }
    if (j.pipeline_mode === "studio_only") {
      // §7: studio_only has no launch markers / breadcrumb — EXCLUDED in v1.
      deps.log(`[checker] ${j.id}: studio_only — skipped (v1 exclusion)`);
      continue;
    }
    jobs.push(j);
  }

  // 2. Latch close-out: jobs that left status='running' (the sweep/gate own
  // them now — §7). Log the transition; no RECOVERED email (the job's own
  // terminal path already notifies).
  // Codex MERGE M-1: never close dedup state on the say-so of the running-page
  // read alone — a transient SELECT failure (fetchRunningJobs → []) or a page
  // miss would wipe alerted latches and re-arm alert spam on the next real
  // sighting. §5.1's second bounded tracked-id read confirms each candidate's
  // row really left 'running' (or is gone); a failed read keeps every latch.
  const runningIds = new Set(jobs.map((j) => j.id));
  const staleLatchIds = (await deps.listLatchJobIds()).filter((id) => !runningIds.has(id));
  if (staleLatchIds.length > 0) {
    const statuses = await deps.fetchTrackedJobStatuses(staleLatchIds);
    if (statuses === null) {
      deps.log(
        `[checker] tracked-id close-out read failed — keeping ${staleLatchIds.length} latch(es) this invocation`,
      );
    } else {
      for (const latchId of staleLatchIds) {
        const st = statuses.get(latchId);
        if (st === "running") continue; // running-page miss — the row IS still live
        deps.log(
          `[checker] ${latchId}: left status='running' (${st ?? "row-gone"}) — closing latch`,
        );
        await deps.deleteLatch(latchId);
      }
    }
  }

  // 3. Worker liveness — probed ONCE per invocation (§5.2 #7 + §4.3 belt).
  let workerCondition: "alive" | "dead" | "elsewhere" | "indeterminate" = "alive";
  let workerDetail = "";
  let workerProbeFailed = false;
  let workerProbeAttempted = false;
  if (jobs.length > 0) {
    const workerPid = await deps.readWorkerPidFile();
    if (workerPid === null) {
      // No .worker.pid at agentRuntimeDir() — either never started here or a
      // location mismatch; the belt below decides which story to tell.
      workerCondition = "dead";
      workerDetail = `.worker.pid absent at agentRuntimeDir()`;
    } else {
      workerProbeAttempted = true;
      const probe = await deps.probePid(workerPid);
      if (!probe.ok) {
        workerCondition = "indeterminate";
        workerProbeFailed = true;
        workerDetail = `worker PID probe failed — skipping worker-liveness conditions this invocation`;
        // fresh-lens m-6: require the script name, not the bare word "worker" —
        // this box runs other projects' node workers too.
      } else if (probe.exists && /worker\.(ts|js)/i.test(probe.commandLine ?? "")) {
        workerCondition = "alive";
      } else {
        workerCondition = "dead";
        workerDetail = probe.exists
          ? `.worker.pid ${workerPid} is alive but its command line does not mention the worker (PID reuse)`
          : `.worker.pid ${workerPid} has no live process`;
      }
    }
    if (workerCondition === "dead") {
      // §4.3 belt (fresh-Claude M-3): a live worker running from ANOTHER tree
      // (dev-tree dogfood, un-fixed launcher) is a location mismatch, not an
      // outage.
      const others = await deps.findWorkerProcesses();
      if (others.length > 0) {
        workerCondition = "elsewhere";
        workerDetail += `; found live worker process(es) elsewhere: ${others
          .map((o) => o.pid)
          .join(", ")}`;
      } else {
        workerDetail += `; no live worker process found anywhere`;
      }
    } else if (workerCondition === "indeterminate") {
      deps.log(`[checker] ${workerDetail}`);
    }
  }

  // 4. Per-job pass (§5.1/§5.2). One malformed workdir must not blind the rest.
  let listCalls = 0;
  let authFailures = 0;
  let nonAuthFailures = 0;
  let probeFailures = workerProbeFailed ? 1 : 0;
  let probesAttempted = workerProbeAttempted ? 1 : 0;
  // Codex MERGE M-2: keys whose check was SKIPPED this invocation (list
  // failure, missing state/notebook, probe failure, per-job throw). A frozen
  // key is neither incremented nor RECOVERED — "unobservable" must never
  // masquerade as "absent", or a one-tick auth blip clears a real stall's
  // dedup state and re-arms alert spam. "*" freezes the whole job.
  const unobservable = new Map<string, Set<string>>();
  const productKeys = (p: string) => [
    `STALLED_PRODUCT:${p}`,
    `RENDER_FAILED_STATUS:${p}`,
    `NO_ARTIFACT_AFTER_LAUNCH:${p}`,
    `AMBIGUOUS_ARTIFACT:${p}`,
  ];

  for (const job of jobs) {
    const unobs = new Set<string>();
    unobservable.set(job.id, unobs);
    try {
      const claimedMs = parseMs(job.claimed_at) ?? parseMs(job.created_at);
      if (claimedMs === null) {
        deps.log(`[checker] ${job.id}: no parseable claimed_at/created_at — skipped`);
        unobs.add("*");
        continue;
      }
      if (workerCondition === "indeterminate") {
        unobs.add("WORKER_DEAD_JOB_RUNNING");
        unobs.add("WORKER_LOCATION_MISMATCH");
      }

      // Worker-level conditions attach to every running row.
      if (workerCondition === "dead") {
        observations.push({
          cls: "WORKER_DEAD_JOB_RUNNING",
          jobId: job.id,
          slug: job.topic_slug,
          detail: `row running since ${job.claimed_at}; ${workerDetail}. Next move: check DynamicResearchWorker task + worker.log; the row will not progress until a worker returns.`,
        });
      } else if (workerCondition === "elsewhere") {
        observations.push({
          cls: "WORKER_LOCATION_MISMATCH",
          jobId: job.id,
          slug: job.topic_slug,
          detail: `${workerDetail}. FYI — a worker IS alive but not the one this checker's agentRuntimeDir() expects (dev-tree run or launcher drift).`,
        });
      }

      const workDir = path.join(cfg.workingDir, job.topic_slug);

      // State file (already claim-time-archived ⇒ current-run by construction).
      let statePhase = "";
      let notebookId: string | null = null;
      let artifacts: unknown = null;
      const statePath = await deps.findState(workDir).catch(() => null);
      if (statePath) {
        const raw = await deps.readTextFile(statePath);
        if (raw) {
          try {
            const st = JSON.parse(raw) as Record<string, unknown>;
            if (st && typeof st === "object" && !Array.isArray(st)) {
              notebookId =
                typeof st.notebook_id === "string" && st.notebook_id ? st.notebook_id : null;
              artifacts = st.artifacts ?? null;
              statePhase = `phase=${String(st.phase ?? "?")} status="${String(st.phase_status ?? "").slice(0, 120)}"`;
            }
          } catch {
            deps.log(`[checker] ${job.id}: state.json unparseable — product checks degraded`);
          }
        }
      }

      // Launch marker, freshness-gated vs claimed_at (§3, fresh-Claude C-1):
      // a marker whose mtime AND embedded floor both predate the claim is a
      // prior attempt's leftover — ignored as launch evidence, floor unused.
      let marker: StudioMarker | null = null;
      const markerPath = path.join(workDir, STUDIO_BEFORE_IDS_NAME);
      const markerRaw = await deps.readTextFile(markerPath);
      if (markerRaw !== null) {
        const mtimeMs = await deps.statMtimeMs(markerPath);
        const parsed = parseStudioMarker(markerRaw, mtimeMs);
        if (parsed) {
          // Codex MERGE C-1: the spec (§3) disqualifies a marker when ANY
          // present freshness anchor predates claimed_at, and the embedded
          // floor must EXIST to be usable — the prior OR-gate accepted a
          // stale-floor/fresh-mtime marker and then fell back to floor=0 in
          // matching, which resolves PRIOR-RUN artifacts as "ours" and masks
          // an attempt-2 stall. AND-gate: floor required + fresh; mtime, when
          // present, must corroborate.
          const floorOk = parsed.runFloorMs !== null && parsed.runFloorMs >= claimedMs;
          const mtimeOk = mtimeMs === null || mtimeMs >= claimedMs;
          if (floorOk && mtimeOk) {
            marker = parsed;
          } else {
            deps.log(
              `[checker] ${job.id}: ${STUDIO_BEFORE_IDS_NAME} fails freshness vs claimed_at ` +
                `(floorOk=${floorOk} mtimeOk=${mtimeOk}) — ignored as launch evidence, floor unused`,
            );
          }
        }
      }

      // Child liveness via the §4.2 breadcrumb (freshness-gated, M-1).
      let childAliveConfirmed = false;
      const crumb = await deps.readBreadcrumb(job.id);
      const spawnedMs = crumb ? parseMs(crumb.spawnedAt) : null;
      const crumbFresh =
        !!crumb &&
        Number.isInteger(crumb.pid) &&
        crumb.pid > 0 &&
        spawnedMs !== null &&
        spawnedMs >= claimedMs;
      if (crumbFresh && crumb) {
        probesAttempted++;
        const probe = await deps.probePid(crumb.pid);
        if (!probe.ok) {
          probeFailures++;
          unobs.add("CHILD_DEAD_JOB_RUNNING");
          unobs.add("CHILD_WEDGED_POST_STUDIO");
          deps.log(
            `[checker] ${job.id}: child PID probe failed — child-liveness indeterminate this invocation`,
          );
        } else {
          // §4.2 guard: exists AND cmdline mentions claude (loose — cross-spawn
          // may interpose a cmd.exe shim) AND CreationDate ≈ spawnedAt (±2 min).
          // Any GUARD miss (probe ran, checks failed) ⇒ child-dead.
          const cmdlineOk = /claude/i.test(probe.commandLine ?? "");
          const creationOk =
            typeof probe.creationMs === "number" &&
            Math.abs(probe.creationMs - spawnedMs) <= cfg.pidCreationSlackMs;
          if (probe.exists && cmdlineOk && creationOk) {
            childAliveConfirmed = true;
          } else {
            const why = !probe.exists
              ? "no live process"
              : !cmdlineOk
                ? "command line does not mention claude (PID reuse)"
                : "CreationDate drifts >2min from breadcrumb spawnedAt (PID reuse)";
            observations.push({
              cls: "CHILD_DEAD_JOB_RUNNING",
              jobId: job.id,
              slug: job.topic_slug,
              detail:
                `breadcrumb pid ${crumb.pid} (spawned ${crumb.spawnedAt}): ${why}; the worker never observed the exit ` +
                `(hard death) yet the row is still running. ${statePhase} Next move: check worker.log tail + the workdir; ` +
                `expect manual recovery (finalize-recovered-run.ts) if deliverables exist.`,
            });
          }
        }
      }

      // Per-product NLM checks (§5.2 rows 1–5, 10).
      const selected = obligedProducts(job.selected_products as SelectedProducts | null);
      const completedAtMs: Record<string, number> = {};
      let productsChecked = 0;

      for (const product of selected) {
        const nlmType = PRODUCT_TO_NLM_TYPE[product];
        if (!nlmType) continue; // unknown product name — parity test pins the map
        const exactId = expectedArtifactId(artifacts, product);
        const launchEvidence = exactId !== null || marker !== null;
        if (!launchEvidence || !notebookId) {
          // Pre-studio — healthy silence. Also freeze the product's latch keys
          // (Codex M-2): a mid-run state/marker read blip must not "recover" a
          // previously-alerted product condition.
          for (const k of productKeys(product)) unobs.add(k);
          continue;
        }

        const res = deps.listArtifactsDetailed(notebookId, nlmType);
        listCalls++;
        if (!res.ok) {
          // Construction-level suppression (§5.2 notes): a failed list produces
          // NO per-product observation — rows 2–5/10 evaluate only on ok:true.
          // Codex M-2: the product's latch keys are frozen, not "absent" — a
          // one-tick auth/CLI blip must not emit RECOVERED for a real stall.
          if (res.reason === "auth") authFailures++;
          else nonAuthFailures++;
          for (const k of productKeys(product)) unobs.add(k);
          unobs.add("CHILD_WEDGED_POST_STUDIO"); // wedge needs ALL products' status
          deps.log(
            `[checker] ${job.id}/${product}: list failed (${res.reason}): ${res.detail.slice(0, 160)}`,
          );
          continue;
        }
        productsChecked++;

        // Ours-not-foreign matching (§3): exact persisted id when present,
        // else snapshot-diff (not in `before`) + created_at ≥ run floor.
        let matches = res.artifacts.filter((a) => a.id === exactId);
        if (exactId === null && marker) {
          const beforeSet = marker.before[product] ?? new Set<string>();
          // Non-null by the C-1 freshness gate above; the Infinity belt means
          // "if that invariant is ever violated, resolve NOTHING as ours"
          // (fail toward NO_ARTIFACT, never toward masking via a 0 floor).
          const floor = marker.runFloorMs ?? Number.POSITIVE_INFINITY;
          matches = res.artifacts.filter((a) => {
            if (beforeSet.has(a.id)) return false;
            const cms = artifactCreatedAtMs(a);
            return cms !== null && cms >= floor;
          });
        }

        if (matches.length === 0) {
          // T_appear anchor: max(marker mtime, claimed_at) (fresh-Claude m-4).
          const anchor = Math.max(marker?.mtimeMs ?? 0, claimedMs);
          const elapsed = now - anchor;
          const thr = cfg.tAppearMs[product] ?? 600_000;
          if (elapsed >= thr) {
            observations.push({
              cls: "NO_ARTIFACT_AFTER_LAUNCH",
              jobId: job.id,
              slug: job.topic_slug,
              product,
              detail:
                `launch evidence (${exactId ? "persisted task_id" : "pre-submit snapshot"}) is ${minutes(elapsed)}min old ` +
                `(T_appear ${minutes(thr)}min) but no matching NLM artifact ≥ run floor. ${statePhase} ` +
                `Next move: the generate may have failed to submit; check the child's poll output in worker.log.`,
              measureMs: elapsed,
              thresholdMs: thr,
            });
          }
        } else if (matches.length > 1 && exactId === null) {
          observations.push({
            cls: "AMBIGUOUS_ARTIFACT",
            jobId: job.id,
            slug: job.topic_slug,
            product,
            detail:
              `${matches.length} post-floor candidates and no persisted task_id — the checker reports, never resolves ` +
              `(S142 exact-1 trap). FYI only.`,
          });
        } else {
          const a = matches[0];
          const st = a.status_id;
          const cms = artifactCreatedAtMs(a);
          if (st === 4) {
            observations.push({
              cls: "RENDER_FAILED_STATUS",
              jobId: job.id,
              slug: job.topic_slug,
              product,
              detail:
                `artifact ${a.id} status_id=4 (FAILED per notebooklm-py v0.3.4 — unofficial enum; report-only per §3). ` +
                `Nothing in the pipeline acts on 4 yet (S191 Design B unimplemented) ⇒ expect the render window to burn; ` +
                `consider manual intervention.`,
            });
          } else if (st === 1 || st === 2) {
            // T_render anchor: the artifact's own server-side created_at
            // (sleep-immune — fresh-Claude m-4).
            const elapsed = cms !== null ? now - cms : 0;
            const thr = cfg.tRenderMs[product] ?? 1_800_000;
            if (cms !== null && elapsed >= thr) {
              const videoNote =
                product === "video"
                  ? cfg.videoRenderFlagArmed
                    ? " Best-effort parking (STUDIO_VIDEO_RENDER_ENABLED) is ARMED — a cap-kill parks the video for the sweep."
                    : " STUDIO_VIDEO_RENDER_ENABLED is OFF — a cap-kill will hard-fail the run."
                  : "";
              observations.push({
                cls: "STALLED_PRODUCT",
                jobId: job.id,
                slug: job.topic_slug,
                product,
                detail:
                  `artifact ${a.id} still status_id=${st} after ${minutes(elapsed)}min ` +
                  `(threshold ${minutes(thr)}min${product === "video" ? ", cap-clamped" : ""}).${videoNote} ${statePhase}`,
                measureMs: elapsed,
                thresholdMs: thr,
              });
            } else {
              deps.log(
                `[checker] ${job.id}/${product}: healthy — status_id=${st}, ${minutes(elapsed)}/${minutes(thr)}min`,
              );
            }
          } else {
            // status 3 (or undefined ⇒ completed, the repo-wide convention).
            if (cms !== null) completedAtMs[product] = cms;
          }
        }
      }

      // §5.2 #10 (fresh-Claude M-2, the S133 signature): everything rendered,
      // child alive, row still running, ≥25 min of quiet.
      if (
        selected.length > 0 &&
        productsChecked > 0 &&
        selected.every((p) => completedAtMs[p] !== undefined) &&
        childAliveConfirmed
      ) {
        // fresh-lens MERGE M-2: "quiet" must be CHECKER-OBSERVED time, not
        // artifact created_at age — NLM stamps created_at at SUBMIT, so a
        // healthy 40-min render is already "25 min quiet" the instant it
        // completes, and the child is legitimately alive downloading + running
        // Phase 6/7 (the S130 cry-wolf class). The observation therefore fires
        // on every all-complete sighting and the QUIET requirement lives in
        // the confirmation count: ceil(wedgeQuietMs/cadence)+1 consecutive
        // sightings (~25+ min of observed all-complete) — see the confirm
        // override in the latch pass. Spec §5.2 #10 amended accordingly (v4.1).
        const newest = Math.max(...selected.map((p) => completedAtMs[p]));
        observations.push({
          cls: "CHILD_WEDGED_POST_STUDIO",
          jobId: job.id,
          slug: job.topic_slug,
          detail:
            `all ${selected.length} selected products completed in NLM (newest submitted ` +
            `${minutes(now - newest)}min ago), child pid alive, row still running — sustained ` +
            `across ~${minutes(cfg.wedgeQuietMs)}min of checker observation (S133 wedged-child ` +
            `signature). ${statePhase} FYI — the duration cap is the backstop.`,
        });
      }
    } catch (err) {
      // Codex M-2: an errored job is UNOBSERVED, not condition-free — freeze
      // its entire latch so a transient throw can't emit RECOVERED storms.
      unobs.add("*");
      deps.log(`[checker] ${job.id}: per-job pass errored (contained): ${(err as Error).message}`);
    }
  }

  // 5. Global observability conditions (§5.2 #8/#9).
  if (listCalls > 0 && authFailures === listCalls && authFailures > 0) {
    observations.push({
      cls: "NLM_AUTH_DEGRADED",
      jobId: "",
      slug: "(global)",
      detail:
        `ALL ${listCalls} artifact-list calls this invocation failed with the auth-expiry signature. ` +
        `Per-product conditions suppressed. NOTE (§3): the child's own poll loop may sys.exit(3) on auth expiry — ` +
        `a child-exit/gate-fail presentation alongside this is expected, not a contradiction. ` +
        `Next move: check the RefreshNotebookLMAuth task + storage_state.json freshness.`,
    });
  } else if (nonAuthFailures > 0) {
    observations.push({
      cls: "NLM_CLI_BLIND",
      jobId: "",
      slug: "(global)",
      detail:
        `${nonAuthFailures}/${listCalls} artifact-list calls failed with non-auth errors (cli-crash/timeout/parse). ` +
        `The observability layer itself is failing — per-product conditions for the affected products are suppressed ` +
        `by construction. Next move: run the list manually (cp1252/emoji crash is the known class).`,
    });
  }
  if (probeFailures > 0) {
    // S197 MERGE-gate matrix addition (Codex MAJOR-4): persistent PID-probe
    // failure (PowerShell error/timeout/CIM access-denied under the task
    // principal) silently blinds rows #6/#7 — say so instead.
    observations.push({
      cls: "PROCESS_PROBE_BLIND",
      jobId: "",
      slug: "(global)",
      detail:
        `${probeFailures} Get-CimInstance PID probe(s) failed this invocation — process-liveness ` +
        `rows (#6 child-dead / #7 worker-dead) are BLIND while this persists. Next move: run the ` +
        `probe manually under the checker task's principal (CIM access / PowerShell health).`,
    });
  }

  // fresh-lens MERGE M-1: the global latches need the SAME blind≠absent freeze
  // as per-product keys. When zero list calls happened this invocation (no
  // running rows, all rows pre-studio, or a fetch error), the NLM_* conditions
  // were UNOBSERVABLE — a real auth outage whose job died must not emit a
  // false "RECOVERED: NLM_AUTH_DEGRADED" mid-incident. Likewise zero PID
  // probes freezes PROCESS_PROBE_BLIND.
  const globalUnobs = new Set<string>();
  if (listCalls === 0) {
    globalUnobs.add("NLM_AUTH_DEGRADED");
    globalUnobs.add("NLM_CLI_BLIND");
  }
  if (probesAttempted === 0) {
    globalUnobs.add("PROCESS_PROBE_BLIND");
  }
  unobservable.set("", globalUnobs);

  // 6. Latch + dedup + escalation + recovered (§5.3).
  const byJob = new Map<string, Observation[]>();
  for (const o of observations) {
    const list = byJob.get(o.jobId) ?? [];
    list.push(o);
    byJob.set(o.jobId, list);
  }

  const jobIdsToProcess = new Set<string>([...byJob.keys()]);
  for (const j of jobs) jobIdsToProcess.add(j.id); // absent-condition jobs still need recovered/reset processing
  jobIdsToProcess.add(""); // global latch

  for (const jobId of jobIdsToProcess) {
    const isGlobal = jobId === "";
    const latch: JobLatch = isGlobal
      ? { conditions: meta.global ?? {} }
      : (await deps.readLatch(jobId)) ?? { conditions: {} };
    const obs = byJob.get(jobId) ?? [];
    const slug = obs[0]?.slug ?? latch.slug ?? (isGlobal ? "(global)" : "");
    latch.slug = slug;

    if (graceActive) {
      for (const [key, c] of Object.entries(latch.conditions)) {
        const cls = key.split(":")[0] as AlertClass;
        if (SOFT_CLASSES.has(cls) && !c.alerted) c.consecutive = 0;
      }
    }

    const seenKeys = new Set<string>();
    for (const o of obs) {
      const key = o.product ? `${o.cls}:${o.product}` : o.cls;
      seenKeys.add(key);
      const c: ConditionLatch = latch.conditions[key] ?? {
        consecutive: 0,
        firstSeenMs: now,
        lastSeenMs: now,
        alerted: false,
        escalated: false,
      };
      // fresh-lens m-3: "consecutive sightings" are only meaningful when
      // spaced ~a cadence apart — a manual run adjacent to the scheduled tick
      // (or a Task Scheduler catch-up double-fire) must not double-count one
      // moment in time and confirm a 2-sighting condition instantly.
      if (c.consecutive === 0 || now - c.lastSeenMs >= 0.8 * cfg.cadenceMs) {
        c.consecutive += 1;
        c.lastSeenMs = now;
      }
      if (o.measureMs !== undefined) c.measureMs = o.measureMs;
      if (o.thresholdMs !== undefined) c.thresholdMs = o.thresholdMs;
      latch.conditions[key] = c;

      // fresh-lens M-2: the wedge's quiet period IS its confirmation count —
      // ceil(wedgeQuietMs / cadence) + 1 spaced sightings ≈ ≥wedgeQuietMs of
      // checker-observed all-complete (spec §5.2 #10, v4.1).
      const confirm =
        o.cls === "CHILD_WEDGED_POST_STUDIO"
          ? Math.max(2, Math.ceil(cfg.wedgeQuietMs / cfg.cadenceMs) + 1)
          : CONFIRM_SIGHTINGS[o.cls];
      if (!c.alerted && c.consecutive >= confirm) {
        c.alerted = true;
        findings.push({
          jobId: jobId || "(global)",
          slug,
          condition: o.cls,
          product: o.product,
          kind: FYI_CLASSES.has(o.cls) ? "fyi" : "alert",
          detail: o.detail,
        });
      } else if (c.alerted && !c.escalated) {
        // One escalation re-alert (§5.3): threshold conditions escalate when
        // the MEASURE doubles; sighting conditions when sightings double.
        const escalates =
          c.measureMs !== undefined && c.thresholdMs !== undefined
            ? c.measureMs >= 2 * c.thresholdMs
            : c.consecutive >= 2 * confirm;
        if (escalates) {
          c.escalated = true;
          findings.push({
            jobId: jobId || "(global)",
            slug,
            condition: o.cls,
            product: o.product,
            kind: "escalation",
            detail: `still present at 2× threshold. ${o.detail}`,
          });
        }
      }
    }

    // Not-seen keys: recovered (if previously alerted) or plain reset — but a
    // key that was UNOBSERVABLE this invocation (Codex M-2) is FROZEN: neither
    // incremented nor recovered. Blind ≠ absent.
    const unobsSet = unobservable.get(jobId);
    for (const key of Object.keys(latch.conditions)) {
      if (seenKeys.has(key)) continue;
      if (unobsSet && (unobsSet.has("*") || unobsSet.has(key))) continue;
      const c = latch.conditions[key];
      if (c.alerted) {
        const [cls, product] = key.split(":");
        findings.push({
          jobId: jobId || "(global)",
          slug,
          condition: cls,
          product: product || undefined,
          kind: "recovered",
          detail: `previously-alerted condition no longer observed this invocation.`,
        });
      }
      delete latch.conditions[key];
    }

    if (isGlobal) {
      meta.global = latch.conditions;
    } else if (Object.keys(latch.conditions).length > 0) {
      await deps.writeLatch(jobId, latch);
    } else {
      // Nothing latched for a healthy job — no dust file (and clear any
      // now-empty prior latch).
      await deps.deleteLatch(jobId);
    }
  }

  meta.lastInvocationMs = now;
  await deps.writeMeta(meta);

  if (findings.length > 0) {
    await deps.sendAlert({ findings }).catch((err) => {
      deps.log(`[checker] alert send failed (non-fatal): ${(err as Error).message}`);
    });
  }

  deps.log(
    `[checker] pass complete: ${jobs.length} running job(s), ${observations.length} observation(s), ${findings.length} finding(s)`,
  );
  return { ran: true, jobsChecked: jobs.length, observations, findings };
}

// ── Real deps ───────────────────────────────────────────────────────

const CHECKER_DIR_NAME = ".studio-checker";
const META_NAME = "checker-meta.json";
const LOCK_NAME = "checker.lock";
const LOG_NAME = "studio-checker.log";
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function checkerDir(): string {
  return path.join(agentRuntimeDir(), CHECKER_DIR_NAME);
}

/** Parse a PowerShell ConvertTo-Json CreationDate: "/Date(ms)/" (PS 5.1) or an
 * ISO-ish string (PS 7). Null when unparseable. */
export function parsePsDateMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  // Tolerate both the JSON.parse'd form (/Date(ms)/) and the raw-escaped
  // bytes (\/Date(ms)\/) in case a caller ever hands us the unparsed string.
  const m = v.match(/\\?\/Date\((\d+)\)\\?\//);
  if (m) return Number(m[1]);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function realProbePid(pid: number): PidProbe {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, exists: false };
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf-8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (r.status !== 0) return { ok: false, exists: false };
    const out = (r.stdout ?? "").trim();
    if (!out) return { ok: true, exists: false };
    const j = JSON.parse(out) as {
      ProcessId?: number;
      CommandLine?: string | null;
      CreationDate?: unknown;
    };
    return {
      ok: true,
      exists: j?.ProcessId === pid,
      commandLine: typeof j?.CommandLine === "string" ? j.CommandLine : "",
      creationMs: parsePsDateMs(j?.CreationDate),
    };
  } catch {
    return { ok: false, exists: false };
  }
}

function realFindWorkerProcesses(): Array<{ pid: number; commandLine: string }> {
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker\\.(ts|js)' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf-8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (r.status !== 0) return [];
    const out = (r.stdout ?? "").trim();
    if (!out) return [];
    const parsed = JSON.parse(out) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((x): x is { ProcessId?: number; CommandLine?: string } => !!x && typeof x === "object")
      .filter((x) => Number.isInteger(x.ProcessId))
      .map((x) => ({ pid: x.ProcessId as number, commandLine: x.CommandLine ?? "" }));
  } catch {
    return [];
  }
}

function latchPath(jobId: string): string | null {
  if (!isValidJobId(jobId)) return null;
  return path.join(checkerDir(), `${jobId}.json`);
}

export function buildDefaultDeps(log: (msg: string) => void): CheckerDeps | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    log("[checker] skipped: Supabase credentials not configured");
    return null;
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    fetchRunningJobs: async () => {
      // Read-only by construction (§9): research_queue SELECTs only. On error
      // this returns [] — safe ONLY because latch close-out no longer trusts
      // this page (Codex M-1: it re-confirms via fetchTrackedJobStatuses).
      const { data, error } = await sb
        .from("research_queue")
        .select(
          "id, topic_slug, organization_id, selected_products, pipeline_mode, claimed_at, updated_at, created_at",
        )
        .eq("status", "running")
        .limit(100);
      if (error) {
        log(`[checker] running-rows query failed (non-fatal): ${error.message}`);
        return [];
      }
      const rows = (data ?? []) as CheckerJobRow[];
      if (rows.length === 100) {
        // No silent caps: the single-worker system should never approach this.
        log(`[checker] WARNING: running-rows page hit the 100-row cap — coverage may be partial`);
      }
      return rows;
    },
    fetchTrackedJobStatuses: async (ids) => {
      const { data, error } = await sb.from("research_queue").select("id, status").in("id", ids);
      if (error) {
        log(`[checker] tracked-id status query failed (non-fatal): ${error.message}`);
        return null; // caller keeps every latch — dedup state survives the blip
      }
      return new Map(
        ((data ?? []) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
      );
    },
    findState: (workDir) => findStateFile(workDir),
    readTextFile: async (p) => {
      try {
        return await fs.readFile(p, "utf-8");
      } catch {
        return null;
      }
    },
    statMtimeMs: async (p) => {
      try {
        return (await fs.stat(p)).mtimeMs;
      } catch {
        return null;
      }
    },
    listArtifactsDetailed: realListArtifactsWithStatusDetailed,
    probePid: async (pid) => realProbePid(pid),
    findWorkerProcesses: async () => realFindWorkerProcesses(),
    readBreadcrumb: async (jobId) => {
      const p = breadcrumbPath(jobId);
      if (!p) return null;
      try {
        const raw = await fs.readFile(p, "utf-8");
        const j = JSON.parse(raw) as ChildBreadcrumb;
        if (!j || typeof j !== "object" || !Number.isInteger(j.pid) || typeof j.spawnedAt !== "string") {
          return null;
        }
        return j;
      } catch {
        return null;
      }
    },
    readWorkerPidFile: async () => {
      try {
        const raw = await fs.readFile(path.join(agentRuntimeDir(), ".worker.pid"), "utf-8");
        const pid = Number(raw.trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    readLatch: async (jobId) => {
      const p = latchPath(jobId);
      if (!p) return null;
      try {
        const j = JSON.parse(await fs.readFile(p, "utf-8")) as JobLatch;
        return j && typeof j === "object" && j.conditions && typeof j.conditions === "object"
          ? j
          : null;
      } catch {
        return null;
      }
    },
    writeLatch: async (jobId, latch) => {
      const p = latchPath(jobId);
      if (!p) return;
      try {
        await fs.mkdir(checkerDir(), { recursive: true });
        await fs.writeFile(p, JSON.stringify(latch));
      } catch (err) {
        log(`[checker] latch write failed (non-fatal): ${(err as Error).message}`);
      }
    },
    listLatchJobIds: async () => {
      try {
        const names = await fs.readdir(checkerDir());
        return names
          .filter((n) => n.endsWith(".json") && n !== META_NAME)
          .map((n) => n.slice(0, -5))
          .filter(isValidJobId);
      } catch {
        return [];
      }
    },
    deleteLatch: async (jobId) => {
      const p = latchPath(jobId);
      if (!p) return;
      await fs.rm(p, { force: true }).catch(() => undefined);
    },
    readMeta: async () => {
      try {
        const j = JSON.parse(
          await fs.readFile(path.join(checkerDir(), META_NAME), "utf-8"),
        ) as CheckerMeta;
        return j && typeof j === "object" ? j : null;
      } catch {
        return null;
      }
    },
    writeMeta: async (m) => {
      try {
        await fs.mkdir(checkerDir(), { recursive: true });
        await fs.writeFile(path.join(checkerDir(), META_NAME), JSON.stringify(m));
      } catch (err) {
        log(`[checker] meta write failed (non-fatal): ${(err as Error).message}`);
      }
    },
    sendAlert: (args) => sendStudioStallAlert(args),
    now: () => Date.now(),
    log,
  };
}

// ── Entry point (lock + log rotation + never-throws — §9) ───────────

function makeLogger(): (msg: string) => void {
  const logPath = path.join(agentRuntimeDir(), LOG_NAME);
  try {
    const st = fsSync.statSync(logPath);
    if (st.size > LOG_MAX_BYTES) {
      // libuv rename replaces an existing destination on Windows
      // (MOVEFILE_REPLACE_EXISTING — the S161 doctrine), but pre-clearing the
      // old .1 costs nothing (Codex MINOR belt).
      fsSync.rmSync(`${logPath}.1`, { force: true });
      fsSync.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // absent / rotation failed — keep appending
  }
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      fsSync.appendFileSync(logPath, line + "\n");
    } catch {
      // log write failure must never crash the checker
    }
  };
}

/** Singleton lock (§4.3): an invocation overlapping a still-running prior one
 * exits 0 immediately; a lock older than the TTL is stale and is taken over.
 * Dir-parameterized for tests; main() passes checkerDir(). */
export async function acquireLock(
  dir: string,
  log: (m: string) => void,
  ttlMs: number,
  nowMs: number = Date.now(),
  pid: number = process.pid,
): Promise<boolean> {
  const lockPath = path.join(dir, LOCK_NAME);
  const payload = JSON.stringify({ pid, startedAtMs: nowMs });
  try {
    await fs.mkdir(dir, { recursive: true });
    // Codex MERGE M-3: exclusive-create ('wx') makes acquisition ATOMIC — the
    // prior read-then-write raced (two simultaneous starts both entered). On
    // EEXIST: a fresh lock yields; a stale one is removed and the atomic
    // create retried ONCE (the rm→create window is itself settled by 'wx' —
    // the loser of the second create yields).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await fs.open(lockPath, "wx");
        try {
          await fh.writeFile(payload);
        } finally {
          await fh.close();
        }
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      }
      try {
        const j = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
          pid?: number;
          startedAtMs?: number;
        };
        if (typeof j?.startedAtMs === "number" && nowMs - j.startedAtMs < ttlMs) {
          log(`[checker] prior invocation (pid ${j.pid}) still within lock TTL — exiting 0`);
          return false;
        }
      } catch {
        // vanished/corrupt lock — treat as stale
      }
      // fresh-lens m-4: take the stale lock over by ATOMIC rename-aside — an
      // rm-based takeover raced (contender B's rm could delete contender A's
      // freshly-created lock). Only ONE rename succeeds; the loser falls
      // through, retries the 'wx' create, and yields to whoever won it.
      try {
        await fs.rename(lockPath, `${lockPath}.stale`);
        await fs.rm(`${lockPath}.stale`, { force: true }).catch(() => undefined);
      } catch {
        // another contender renamed/removed it first — retry the atomic create
      }
    }
    log("[checker] lock contention persisted after stale takeover attempt — exiting 0");
    return false;
  } catch (err) {
    log(`[checker] lock handling failed (${(err as Error).message}) — proceeding without lock`);
    return true;
  }
}

export async function releaseLock(dir: string, pid: number = process.pid): Promise<void> {
  const lockPath = path.join(dir, LOCK_NAME);
  try {
    const j = JSON.parse(await fs.readFile(lockPath, "utf-8")) as { pid?: number };
    if (j?.pid === pid) await fs.rm(lockPath, { force: true });
  } catch {
    // gone/unreadable — nothing to release
  }
}

export async function main(): Promise<void> {
  const log = makeLogger();
  try {
    if (process.env.STUDIO_CHECKER_ENABLED === "false") {
      log("[checker] STUDIO_CHECKER_ENABLED=false — disarmed, exiting 0");
      return;
    }
    if (!(await acquireLock(checkerDir(), log, buildConfigFromEnv().lockTtlMs))) return;
    try {
      const deps = buildDefaultDeps(log);
      if (!deps) return;
      await runStudioCheckerOnce(deps, buildConfigFromEnv());
    } finally {
      await releaseLock(checkerDir());
    }
  } catch (err) {
    // §9: a crashing checker must not spam Task Scheduler failure states.
    log(`[checker] unexpected error (contained, exit 0): ${(err as Error).message}`);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main();
}
