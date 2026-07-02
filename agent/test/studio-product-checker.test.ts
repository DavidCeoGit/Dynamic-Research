/**
 * S197 — studio-product-checker test battery (design §10.12).
 *
 * Table-driven over the §5.2 detection matrix plus: freshness gates (stale
 * marker / stale breadcrumb vs claimed_at), detailed-list error
 * classification, PID-reuse guard (recycled PID, cmd.exe shim cmdline,
 * CreationDate drift), worker-location-mismatch belt, lock contention +
 * stale-lock takeover, latch dedup + escalation + recovered, auth/blind
 * suppression, missed-tick post-wake grace, malformed-input degrade paths,
 * breadcrumb GC, PRODUCT_TO_NLM_TYPE parity, and the read-only grep guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  runStudioCheckerOnce,
  acquireLock,
  releaseLock,
  parsePsDateMs,
  buildConfigFromEnv,
  type CheckerConfig,
  type CheckerDeps,
  type CheckerJobRow,
  type JobLatch,
  type CheckerMeta,
  type PidProbe,
} from "../scripts/studio-product-checker.js";
import {
  classifyDetailedList,
  type DetailedListResult,
} from "../lib/nlm-artifact-cli.js";
import { PRODUCT_TO_NLM_TYPE } from "../lib/studio-completeness.js";
import { STUDIO_PRODUCT_LIST } from "../lib/plan-types.js";
import {
  isValidJobId,
  breadcrumbPath,
  gcChildBreadcrumbsOnce,
  type ChildBreadcrumb,
  type BreadcrumbGcDeps,
} from "../lib/child-breadcrumb.js";
import type { StudioCheckerFinding } from "../lib/notify.js";

// ── Harness ─────────────────────────────────────────────────────────

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";
const SLUG = "test-topic-abc12345";
const NB = "nb-1";
const CHILD_PID = 4242;
const WORKER_PID = 9999;

const NOW0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function makeCfg(over: Partial<CheckerConfig> = {}): CheckerConfig {
  return {
    workingDir: "/w",
    cadenceMs: 5 * MIN,
    lockTtlMs: 10 * MIN,
    maxJobDurationMs: 9_000_000,
    tAppearMs: {
      audio: 10 * MIN,
      video: 15 * MIN,
      slides: 10 * MIN,
      report: 10 * MIN,
      infographic: 10 * MIN,
    },
    tRenderMs: {
      report: 30 * MIN,
      infographic: 30 * MIN,
      slides: 35 * MIN,
      audio: 55 * MIN,
      video: 75 * MIN,
    },
    wedgeQuietMs: 25 * MIN,
    pidCreationSlackMs: 2 * MIN,
    videoRenderFlagArmed: false,
    ...over,
  };
}

interface World {
  deps: CheckerDeps;
  cfg: CheckerConfig;
  setNow: (ms: number) => void;
  latches: Map<string, JobLatch>;
  meta: { value: CheckerMeta | null };
  alerts: StudioCheckerFinding[][];
  logs: string[];
  listCalls: Array<{ notebookId: string; nlmType: string }>;
  deletedLatches: string[];
}

interface WorldOpts {
  claimedMs?: number;
  jobs?: CheckerJobRow[] | null; // null → default single job
  selected?: Record<string, boolean>;
  stateJson?: string | null; // null → no state file
  markerJson?: string | null;
  markerMtimeMs?: number | null;
  breadcrumb?: ChildBreadcrumb | null;
  probePid?: (pid: number) => PidProbe;
  workerPid?: number | null;
  workerProcessesElsewhere?: Array<{ pid: number; commandLine: string }>;
  listResult?: (notebookId: string, nlmType: string) => DetailedListResult;
  meta?: CheckerMeta | null;
  latches?: Record<string, JobLatch>;
  /** Codex M-1: tracked-id close-out read. undefined → every stale id reports
   * "completed" (close-out proceeds); null → simulated read failure. */
  trackedStatuses?: Map<string, string> | null;
}

function makeWorld(opts: WorldOpts = {}): World {
  const cfg = makeCfg();
  const claimedMs = opts.claimedMs ?? NOW0 - 90 * MIN;
  const spawnedMs = claimedMs + MIN;
  const workDir = path.join(cfg.workingDir, SLUG);
  const statePath = path.join(workDir, "20260701-100000-state.json");
  const markerPath = path.join(workDir, "studio_before_ids.json");

  const selected = opts.selected ?? {
    audio: false,
    video: true,
    slides: false,
    report: false,
    infographic: false,
  };

  const defaultJob: CheckerJobRow = {
    id: JOB_ID,
    topic_slug: SLUG,
    organization_id: "org-1",
    selected_products: selected,
    pipeline_mode: "full",
    claimed_at: iso(claimedMs),
    created_at: iso(claimedMs - MIN),
  };
  const jobs = opts.jobs === undefined ? [defaultJob] : (opts.jobs ?? []);

  const stateJson =
    opts.stateJson === undefined
      ? JSON.stringify({
          notebook_id: NB,
          phase: "5.5",
          phase_status: "studio underway",
          artifacts: { video: { task_id: "vid-1" } },
        })
      : opts.stateJson;
  const markerJson =
    opts.markerJson === undefined
      ? JSON.stringify({ run_floor_ms: claimedMs + 30_000, before: { video: ["old-1"] } })
      : opts.markerJson;
  const markerMtimeMs =
    opts.markerMtimeMs === undefined ? claimedMs + 30_000 : opts.markerMtimeMs;

  const breadcrumb =
    opts.breadcrumb === undefined
      ? { pid: CHILD_PID, spawnedAt: iso(spawnedMs), workDir, projectsDir: "/p" }
      : opts.breadcrumb;

  const probePid =
    opts.probePid ??
    ((pid: number): PidProbe => {
      if (pid === CHILD_PID) {
        return {
          ok: true,
          exists: true,
          commandLine: `cmd.exe /c ""C:\\...\\claude.cmd" -p ..."`,
          creationMs: spawnedMs,
        };
      }
      if (pid === WORKER_PID) {
        return { ok: true, exists: true, commandLine: "node --import=tsx worker.ts" };
      }
      return { ok: true, exists: false };
    });

  const listResult =
    opts.listResult ??
    (() =>
      ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 10 * MIN), status_id: 1 }],
      }) as DetailedListResult);

  let now = NOW0;
  const latches = new Map<string, JobLatch>(Object.entries(opts.latches ?? {}));
  const meta = { value: (opts.meta === undefined ? null : opts.meta) as CheckerMeta | null };
  const alerts: StudioCheckerFinding[][] = [];
  const logs: string[] = [];
  const listCalls: Array<{ notebookId: string; nlmType: string }> = [];
  const deletedLatches: string[] = [];

  const deps: CheckerDeps = {
    fetchRunningJobs: async () => jobs,
    fetchTrackedJobStatuses: async (ids) =>
      opts.trackedStatuses === undefined
        ? new Map(ids.map((id) => [id, "completed"]))
        : opts.trackedStatuses,
    findState: async () => (stateJson === null ? null : statePath),
    readTextFile: async (p) => {
      if (p === statePath) return stateJson;
      if (p === markerPath) return markerJson;
      return null;
    },
    statMtimeMs: async (p) => (p === markerPath ? markerMtimeMs : null),
    listArtifactsDetailed: (notebookId, nlmType) => {
      listCalls.push({ notebookId, nlmType });
      return listResult(notebookId, nlmType);
    },
    probePid: async (pid) => probePid(pid),
    findWorkerProcesses: async () => opts.workerProcessesElsewhere ?? [],
    readBreadcrumb: async (jobId) => (jobId === JOB_ID ? breadcrumb : null),
    readWorkerPidFile: async () =>
      opts.workerPid === undefined ? WORKER_PID : opts.workerPid,
    readLatch: async (jobId) => latches.get(jobId) ?? null,
    writeLatch: async (jobId, latch) => {
      latches.set(jobId, JSON.parse(JSON.stringify(latch)) as JobLatch);
    },
    listLatchJobIds: async () => [...latches.keys()],
    deleteLatch: async (jobId) => {
      deletedLatches.push(jobId);
      latches.delete(jobId);
    },
    readMeta: async () => meta.value,
    writeMeta: async (m) => {
      meta.value = JSON.parse(JSON.stringify(m)) as CheckerMeta;
    },
    sendAlert: async (args) => {
      alerts.push(args.findings);
    },
    now: () => now,
    log: (m) => logs.push(m),
  };

  return {
    deps,
    cfg,
    setNow: (ms) => {
      now = ms;
    },
    latches,
    meta,
    alerts,
    logs,
    listCalls,
    deletedLatches,
  };
}

/** Run N invocations spaced one cadence apart; returns all findings emitted. */
async function runN(w: World, n: number, startMs = NOW0): Promise<StudioCheckerFinding[]> {
  const out: StudioCheckerFinding[] = [];
  for (let i = 0; i < n; i++) {
    w.setNow(startMs + i * w.cfg.cadenceMs);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    out.push(...r.findings);
  }
  return out;
}

const byClass = (fs2: StudioCheckerFinding[], cls: string) =>
  fs2.filter((f) => f.condition === cls);

// ── Matrix rows ─────────────────────────────────────────────────────

describe("detection matrix (§5.2)", () => {
  it("row 1: healthy run → zero observations, zero findings, no alert email", async () => {
    const w = makeWorld();
    const f = await runN(w, 3);
    assert.equal(f.length, 0);
    assert.equal(w.alerts.length, 0);
  });

  it("row 2: stalled render alerts on the 2nd consecutive sighting, not the 1st", async () => {
    const w = makeWorld({
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 80 * MIN), status_id: 1 }],
      }),
    });
    w.setNow(NOW0);
    const r1 = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(byClass(r1.findings, "STALLED_PRODUCT").length, 0);
    assert.equal(r1.observations.filter((o) => o.cls === "STALLED_PRODUCT").length, 1);
    w.setNow(NOW0 + 5 * MIN);
    const r2 = await runStudioCheckerOnce(w.deps, w.cfg);
    const stalled = byClass(r2.findings, "STALLED_PRODUCT");
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].kind, "alert");
    assert.equal(stalled[0].product, "video");
    assert.equal(w.alerts.length, 1);
  });

  it("row 2 escalation: one re-alert when the measure reaches 2× threshold", async () => {
    const w = makeWorld({
      listResult: () => ({
        ok: true,
        artifacts: [
          { id: "vid-1", title: "t", created_at: iso(NOW0 - 160 * MIN), status_id: 1 },
        ],
      }),
    });
    const f = await runN(w, 4);
    assert.equal(byClass(f, "STALLED_PRODUCT").filter((x) => x.kind === "alert").length, 1);
    assert.equal(
      byClass(f, "STALLED_PRODUCT").filter((x) => x.kind === "escalation").length,
      1,
    );
  });

  it("row 3: status_id 4 alerts on ONE sighting (report-only wording)", async () => {
    const w = makeWorld({
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 10 * MIN), status_id: 4 }],
      }),
    });
    w.setNow(NOW0);
    const r1 = await runStudioCheckerOnce(w.deps, w.cfg);
    const failed = byClass(r1.findings, "RENDER_FAILED_STATUS");
    assert.equal(failed.length, 1);
    assert.match(failed[0].detail, /unofficial enum/i);
  });

  it("row 4: launched-but-no-artifact fires after T_appear, 2 sightings", async () => {
    const w = makeWorld({
      stateJson: JSON.stringify({ notebook_id: NB, phase: "5.5", artifacts: {} }),
      markerMtimeMs: NOW0 - 16 * MIN,
      markerJson: JSON.stringify({ run_floor_ms: NOW0 - 16 * MIN, before: { video: [] } }),
      listResult: () => ({ ok: true, artifacts: [] }),
    });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "NO_ARTIFACT_AFTER_LAUNCH").length, 1);
  });

  it("row 4 boundary: under T_appear → silent", async () => {
    const w = makeWorld({
      stateJson: JSON.stringify({ notebook_id: NB, phase: "5.5", artifacts: {} }),
      markerMtimeMs: NOW0 - 5 * MIN,
      markerJson: JSON.stringify({ run_floor_ms: NOW0 - 5 * MIN, before: { video: [] } }),
      listResult: () => ({ ok: true, artifacts: [] }),
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.observations.length, 0);
  });

  it("row 5: >1 post-floor candidate with no exact id → AMBIGUOUS FYI, never resolved", async () => {
    const floor = NOW0 - 40 * MIN;
    const w = makeWorld({
      stateJson: JSON.stringify({ notebook_id: NB, phase: "5.5", artifacts: {} }),
      markerMtimeMs: floor,
      markerJson: JSON.stringify({ run_floor_ms: floor, before: { video: ["old-1"] } }),
      listResult: () => ({
        ok: true,
        artifacts: [
          { id: "new-1", title: "a", created_at: iso(NOW0 - 30 * MIN), status_id: 1 },
          { id: "new-2", title: "b", created_at: iso(NOW0 - 20 * MIN), status_id: 1 },
        ],
      }),
    });
    const f = await runN(w, 2);
    const amb = byClass(f, "AMBIGUOUS_ARTIFACT");
    assert.equal(amb.length, 1);
    assert.equal(amb[0].kind, "fyi");
  });

  it("row 6: dead child (breadcrumb present, PID gone) → alert after 2 sightings", async () => {
    const w = makeWorld({
      probePid: (pid) =>
        pid === WORKER_PID
          ? { ok: true, exists: true, commandLine: "node worker.ts" }
          : { ok: true, exists: false },
    });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 1);
  });

  it("row 7: dead worker with no live worker anywhere → WORKER_DEAD after 2 sightings", async () => {
    const w = makeWorld({ workerPid: null, workerProcessesElsewhere: [] });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "WORKER_DEAD_JOB_RUNNING").length, 1);
    assert.equal(byClass(f, "WORKER_LOCATION_MISMATCH").length, 0);
  });

  it("row 7 belt (§4.3): live worker ELSEWHERE → LOCATION_MISMATCH FYI, not WORKER_DEAD", async () => {
    const w = makeWorld({
      workerPid: null,
      workerProcessesElsewhere: [{ pid: 777, commandLine: "node --import=tsx worker.ts" }],
    });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "WORKER_DEAD_JOB_RUNNING").length, 0);
    const mm = byClass(f, "WORKER_LOCATION_MISMATCH");
    assert.equal(mm.length, 1);
    assert.equal(mm[0].kind, "fyi");
  });

  it("row 8: ALL list calls auth-failing → NLM_AUTH_DEGRADED after 2 sightings; per-product rows suppressed", async () => {
    const w = makeWorld({
      listResult: () => ({ ok: false, reason: "auth", detail: "Authentication expired" }),
    });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "NLM_AUTH_DEGRADED").length, 1);
    assert.equal(byClass(f, "NO_ARTIFACT_AFTER_LAUNCH").length, 0);
    assert.equal(byClass(f, "STALLED_PRODUCT").length, 0);
  });

  it("row 9: non-auth list failures → NLM_CLI_BLIND after 3 sightings, not 2", async () => {
    const w = makeWorld({
      listResult: () => ({ ok: false, reason: "timeout", detail: "timed out" }),
    });
    const f2 = await runN(w, 2);
    assert.equal(byClass(f2, "NLM_CLI_BLIND").length, 0);
    w.setNow(NOW0 + 2 * 5 * MIN);
    const r3 = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(byClass(r3.findings, "NLM_CLI_BLIND").length, 1);
  });

  it("row 10: all products completed ≥25min, child alive, row running → WEDGED FYI after 2 sightings", async () => {
    const w = makeWorld({
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 30 * MIN), status_id: 3 }],
      }),
    });
    const f = await runN(w, 2);
    const wedged = byClass(f, "CHILD_WEDGED_POST_STUDIO");
    assert.equal(wedged.length, 1);
    assert.equal(wedged[0].kind, "fyi");
  });

  it("row 10 guard: wedge does NOT fire when the child is dead (that's row 6's story)", async () => {
    const w = makeWorld({
      probePid: (pid) =>
        pid === WORKER_PID
          ? { ok: true, exists: true, commandLine: "node worker.ts" }
          : { ok: true, exists: false },
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 30 * MIN), status_id: 3 }],
      }),
    });
    const f = await runN(w, 2);
    assert.equal(byClass(f, "CHILD_WEDGED_POST_STUDIO").length, 0);
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 1);
  });
});

// ── Freshness gates ─────────────────────────────────────────────────

describe("freshness gates (fresh-Claude C-1 / M-1)", () => {
  it("stale studio_before_ids.json (mtime + floor predate claimed_at) is IGNORED as launch evidence", async () => {
    const claimedMs = NOW0 - 90 * MIN;
    const w = makeWorld({
      claimedMs,
      stateJson: JSON.stringify({ notebook_id: NB, phase: "3", artifacts: {} }),
      markerJson: JSON.stringify({
        run_floor_ms: claimedMs - 60 * MIN,
        before: { video: [] },
      }),
      markerMtimeMs: claimedMs - 60 * MIN,
      listResult: () => ({ ok: true, artifacts: [] }),
    });
    const f = await runN(w, 3);
    assert.equal(byClass(f, "NO_ARTIFACT_AFTER_LAUNCH").length, 0);
    // no launch evidence ⇒ the NLM list is never even called
    assert.equal(w.listCalls.length, 0);
  });

  it("Codex C-1: stale floor + fresh mtime is REJECTED (AND-gate; no floor-0 fallback masking)", async () => {
    const claimedMs = NOW0 - 90 * MIN;
    const w = makeWorld({
      claimedMs,
      stateJson: JSON.stringify({ notebook_id: NB, phase: "5.5", artifacts: {} }),
      // floor predates the claim (prior attempt) but the file was touched fresh
      markerJson: JSON.stringify({
        run_floor_ms: claimedMs - 60 * MIN,
        before: { video: [] },
      }),
      markerMtimeMs: claimedMs + 10 * MIN,
      listResult: () => ({
        ok: true,
        // a PRIOR-run artifact that a 0/stale floor would wrongly resolve as ours
        artifacts: [
          { id: "prior-run", title: "t", created_at: iso(claimedMs - 30 * MIN), status_id: 3 },
        ],
      }),
    });
    const f = await runN(w, 3);
    // marker rejected ⇒ no launch evidence ⇒ no list call, no wedge, no masking
    assert.equal(w.listCalls.length, 0);
    assert.equal(f.length, 0);
    assert.ok(w.logs.some((l) => l.includes("fails freshness")));
  });

  it("Codex C-1: missing run_floor_ms disqualifies the marker even with fresh mtime", async () => {
    const w = makeWorld({
      stateJson: JSON.stringify({ notebook_id: NB, phase: "5.5", artifacts: {} }),
      markerJson: JSON.stringify({ before: { video: [] } }), // no floor at all
      markerMtimeMs: NOW0 - 5 * MIN,
      listResult: () => ({ ok: true, artifacts: [] }),
    });
    const f = await runN(w, 3);
    assert.equal(w.listCalls.length, 0);
    assert.equal(byClass(f, "NO_ARTIFACT_AFTER_LAUNCH").length, 0);
  });

  it("stale breadcrumb (spawnedAt < claimed_at) never fires CHILD_DEAD in the re-claim pre-spawn window", async () => {
    const claimedMs = NOW0 - 90 * MIN;
    const w = makeWorld({
      claimedMs,
      breadcrumb: {
        pid: 31337, // dead pid — would fail the guard if the crumb were trusted
        spawnedAt: iso(claimedMs - 120 * MIN),
        workDir: "/w/x",
        projectsDir: "/p",
      },
    });
    const f = await runN(w, 3);
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 0);
  });
});

// ── PID guard (§4.2) ────────────────────────────────────────────────

describe("PID-reuse guard", () => {
  const deadChild = (probe: PidProbe) => async () => {
    const w = makeWorld({
      probePid: (pid) =>
        pid === WORKER_PID ? { ok: true, exists: true, commandLine: "node worker.ts" } : probe,
    });
    return { w, f: await runN(w, 2) };
  };

  it("recycled PID: exists but command line has no 'claude' → child-dead", async () => {
    const { f } = await deadChild({
      ok: true,
      exists: true,
      commandLine: "notepad.exe",
      creationMs: NOW0 - 89 * MIN,
    })();
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 1);
    assert.match(byClass(f, "CHILD_DEAD_JOB_RUNNING")[0].detail, /PID reuse/);
  });

  it("cmd.exe shim wrapper WITH claude in the cmdline passes (cross-spawn, Gemini MAJOR-4)", async () => {
    const w = makeWorld(); // default probe returns the cmd.exe /c ...claude... shim
    const f = await runN(w, 3);
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 0);
  });

  it("CreationDate drifting >2min from spawnedAt → child-dead (recycled PID)", async () => {
    const { f } = await deadChild({
      ok: true,
      exists: true,
      commandLine: "claude -p",
      creationMs: NOW0, // spawned ~89min earlier — way past the ±2min slack
    })();
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 1);
  });

  it("probe FAILURE (ok:false) is indeterminate — never counted as child-dead (§9)", async () => {
    const { f } = await deadChild({ ok: false, exists: false })();
    assert.equal(byClass(f, "CHILD_DEAD_JOB_RUNNING").length, 0);
  });
});

// ── Latch mechanics ─────────────────────────────────────────────────

describe("latch: dedup, recovered, grace, close-out", () => {
  it("dedup: an alerted condition does not re-alert on later sightings (one alert + one escalation max)", async () => {
    const w = makeWorld({
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 80 * MIN), status_id: 1 }],
      }),
    });
    const f = await runN(w, 6);
    const alerts = byClass(f, "STALLED_PRODUCT").filter((x) => x.kind === "alert");
    assert.equal(alerts.length, 1);
  });

  it("recovered: a previously-alerted condition that clears emits ONE recovered info + latch is cleaned", async () => {
    const w = makeWorld({
      latches: {
        [JOB_ID]: {
          slug: SLUG,
          conditions: {
            "STALLED_PRODUCT:video": {
              consecutive: 2,
              firstSeenMs: NOW0 - 10 * MIN,
              lastSeenMs: NOW0 - 5 * MIN,
              alerted: true,
              escalated: false,
            },
          },
        },
      },
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg); // healthy world
    const rec = r.findings.filter((x) => x.kind === "recovered");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].condition, "STALLED_PRODUCT");
    assert.equal(w.latches.has(JOB_ID), false); // empty latch → deleted, no dust
  });

  it("missed-tick grace (fresh-Claude m-2): a >2×cadence gap resets soft-condition sightings", async () => {
    const w = makeWorld({
      meta: { lastInvocationMs: NOW0 - 20 * MIN }, // 20min gap > 2×5min
      latches: {
        [JOB_ID]: {
          slug: SLUG,
          conditions: {
            "STALLED_PRODUCT:video": {
              consecutive: 1,
              firstSeenMs: NOW0 - 25 * MIN,
              lastSeenMs: NOW0 - 25 * MIN,
              alerted: false,
              escalated: false,
            },
          },
        },
      },
      listResult: () => ({
        ok: true,
        artifacts: [{ id: "vid-1", title: "t", created_at: iso(NOW0 - 80 * MIN), status_id: 1 }],
      }),
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    // without grace this would be the confirming 2nd sighting — grace resets it
    assert.equal(byClass(r.findings, "STALLED_PRODUCT").length, 0);
    // and a normal-cadence follow-up then confirms
    w.setNow(NOW0 + 5 * MIN);
    const r2 = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(byClass(r2.findings, "STALLED_PRODUCT").length, 1);
  });

  it("Codex M-1: a FAILED tracked-id read keeps every stale latch (dedup state survives the blip)", async () => {
    const w = makeWorld({
      trackedStatuses: null, // simulated SELECT failure
      latches: {
        [OTHER_ID]: {
          slug: "gone-job",
          conditions: {
            STALLED_PRODUCT: {
              consecutive: 3,
              firstSeenMs: NOW0 - 30 * MIN,
              lastSeenMs: NOW0 - 5 * MIN,
              alerted: true,
              escalated: false,
            },
          },
        },
      },
    });
    w.setNow(NOW0);
    await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(w.latches.has(OTHER_ID), true);
    assert.equal(w.deletedLatches.includes(OTHER_ID), false);
  });

  it("Codex M-1: a running-page MISS does not close a latch whose row is still 'running'", async () => {
    const w = makeWorld({
      trackedStatuses: new Map([[OTHER_ID, "running"]]),
      latches: {
        [OTHER_ID]: { slug: "paged-out", conditions: {} },
      },
    });
    w.setNow(NOW0);
    await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(w.latches.has(OTHER_ID), true);
  });

  it("Codex M-2: an auth-blip invocation FREEZES a previously-alerted product latch (no false RECOVERED)", async () => {
    const stalledLatch: JobLatch = {
      slug: SLUG,
      conditions: {
        "STALLED_PRODUCT:video": {
          consecutive: 2,
          firstSeenMs: NOW0 - 10 * MIN,
          lastSeenMs: NOW0 - 5 * MIN,
          alerted: true,
          escalated: false,
        },
      },
    };
    const w = makeWorld({
      latches: { [JOB_ID]: stalledLatch },
      listResult: () => ({ ok: false, reason: "auth", detail: "Authentication expired" }),
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.findings.filter((x) => x.kind === "recovered").length, 0);
    assert.equal(
      w.latches.get(JOB_ID)?.conditions["STALLED_PRODUCT:video"]?.alerted,
      true,
    );
    // and a later HEALTHY sighting is what emits the real RECOVERED
    const w2 = makeWorld({ latches: { [JOB_ID]: stalledLatch } }); // default healthy list
    w2.setNow(NOW0 + 5 * MIN);
    const r2 = await runStudioCheckerOnce(w2.deps, w2.cfg);
    assert.equal(r2.findings.filter((x) => x.kind === "recovered").length, 1);
  });

  it("Codex M-2 + M-4: probe failures freeze liveness latches AND raise PROCESS_PROBE_BLIND after 3 sightings", async () => {
    const w = makeWorld({
      latches: {
        [JOB_ID]: {
          slug: SLUG,
          conditions: {
            CHILD_DEAD_JOB_RUNNING: {
              consecutive: 2,
              firstSeenMs: NOW0 - 10 * MIN,
              lastSeenMs: NOW0 - 5 * MIN,
              alerted: true,
              escalated: false,
            },
          },
        },
      },
      probePid: (pid) =>
        pid === WORKER_PID
          ? { ok: true, exists: true, commandLine: "node worker.ts" }
          : { ok: false, exists: false }, // child probe fails every time
    });
    const f = await runN(w, 3);
    assert.equal(f.filter((x) => x.kind === "recovered").length, 0);
    assert.equal(w.latches.get(JOB_ID)?.conditions["CHILD_DEAD_JOB_RUNNING"]?.alerted, true);
    assert.equal(byClass(f, "PROCESS_PROBE_BLIND").length, 1);
  });

  it("close-out: a latch for a job that left status='running' is deleted with no recovered email", async () => {
    const w = makeWorld({
      latches: {
        [OTHER_ID]: {
          slug: "gone-job",
          conditions: {
            STALLED_PRODUCT: {
              consecutive: 3,
              firstSeenMs: NOW0 - 30 * MIN,
              lastSeenMs: NOW0 - 5 * MIN,
              alerted: true,
              escalated: false,
            },
          },
        },
      },
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(w.deletedLatches.includes(OTHER_ID), true);
    assert.equal(r.findings.filter((x) => x.jobId === OTHER_ID).length, 0);
  });
});

// ── Degrade paths + input validation ────────────────────────────────

describe("degrade paths (§9)", () => {
  it("studio_only rows are skipped (v1 exclusion, Codex MAJOR-2)", async () => {
    const w = makeWorld({
      jobs: [
        {
          id: JOB_ID,
          topic_slug: SLUG,
          organization_id: "o",
          selected_products: { video: true },
          pipeline_mode: "studio_only",
          claimed_at: iso(NOW0 - 30 * MIN),
        },
      ],
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.jobsChecked, 0);
  });

  it("invalid id / slug shapes are skipped before any filesystem or NLM use", async () => {
    const w = makeWorld({
      jobs: [
        {
          id: "not-a-uuid",
          topic_slug: SLUG,
          organization_id: "o",
          selected_products: { video: true },
          claimed_at: iso(NOW0),
        },
        {
          id: OTHER_ID,
          topic_slug: "../../etc/passwd",
          organization_id: "o",
          selected_products: { video: true },
          claimed_at: iso(NOW0),
        },
      ],
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.jobsChecked, 0);
    assert.equal(w.listCalls.length, 0);
  });

  it("malformed state.json / missing workdir degrade to a log line, never a crash", async () => {
    const w = makeWorld({ stateJson: "{{{not json", markerJson: null });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.ran, true);
    assert.equal(
      r.observations.filter((o) => o.cls === "NO_ARTIFACT_AFTER_LAUNCH").length,
      0,
    );
  });

  it("a job with no parseable claimed_at/created_at is skipped with a log line", async () => {
    const w = makeWorld({
      jobs: [
        {
          id: JOB_ID,
          topic_slug: SLUG,
          organization_id: "o",
          selected_products: { video: true },
          claimed_at: "garbage",
          created_at: "also-garbage",
        },
      ],
    });
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.observations.length, 0);
    assert.ok(w.logs.some((l) => l.includes("no parseable")));
  });

  it("one throwing job does not blind the fleet (per-job containment)", async () => {
    const bad: CheckerJobRow = {
      id: OTHER_ID,
      topic_slug: "bad-job-slug",
      organization_id: "o",
      selected_products: { video: true },
      claimed_at: iso(NOW0 - 90 * MIN),
    };
    const w = makeWorld({});
    const good = (await w.deps.fetchRunningJobs())[0];
    const jobs = [bad, good];
    const origFindState = w.deps.findState;
    w.deps.fetchRunningJobs = async () => jobs;
    w.deps.findState = async (workDir) => {
      if (workDir.includes("bad-job-slug")) throw new Error("EPERM boom");
      return origFindState(workDir);
    };
    w.setNow(NOW0);
    const r = await runStudioCheckerOnce(w.deps, w.cfg);
    assert.equal(r.ran, true);
    assert.equal(r.jobsChecked, 2); // good job still fully processed
  });
});

// ── Lock (§4.3) ─────────────────────────────────────────────────────

describe("singleton lock", () => {
  it("contention: a fresh lock blocks; a stale lock is taken over; release is owner-only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checker-lock-"));
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    try {
      // acquire as pid 100
      assert.equal(await acquireLock(dir, log, 10 * MIN, NOW0, 100), true);
      // pid 200 within TTL → blocked
      assert.equal(await acquireLock(dir, log, 10 * MIN, NOW0 + MIN, 200), false);
      // pid 200 after TTL → stale takeover
      assert.equal(await acquireLock(dir, log, 10 * MIN, NOW0 + 11 * MIN, 200), true);
      // release by NON-owner (pid 100) is a no-op...
      await releaseLock(dir, 100);
      assert.equal(await acquireLock(dir, log, 10 * MIN, NOW0 + 12 * MIN, 300), false);
      // ...release by the owner clears it
      await releaseLock(dir, 200);
      assert.equal(await acquireLock(dir, log, 10 * MIN, NOW0 + 13 * MIN, 300), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── detailed-list classification ────────────────────────────────────

describe("classifyDetailedList (Gemini CRITICAL-2)", () => {
  it("timeout via ETIMEDOUT / killed-by-signal", () => {
    assert.equal(
      (classifyDetailedList({ status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" }) as {
        reason: string;
      }).reason,
      "timeout",
    );
    assert.equal(
      (classifyDetailedList({ status: null, signal: "SIGKILL" }) as { reason: string }).reason,
      "timeout",
    );
  });

  it("auth signature on either stream, any exit code — incl. exit 0", () => {
    for (const r of [
      { status: 1, signal: null, stderr: "Authentication expired — please re-run auth login" },
      { status: 1, signal: null, stdout: "redirecting to https://accounts.google.com/signin" },
      { status: 0, signal: null, stdout: "<html>accounts.google.com</html>" },
    ]) {
      assert.equal((classifyDetailedList(r) as { reason: string }).reason, "auth");
    }
  });

  it("cli-crash on other non-zero exits (cp1252 crash class)", () => {
    assert.equal(
      (classifyDetailedList({
        status: 1,
        signal: null,
        stderr: "UnicodeEncodeError: 'charmap' codec can't encode character",
      }) as { reason: string }).reason,
      "cli-crash",
    );
  });

  it("parse on non-JSON stdout and non-array artifacts", () => {
    assert.equal(
      (classifyDetailedList({ status: 0, signal: null, stdout: "not json" }) as { reason: string })
        .reason,
      "parse",
    );
    assert.equal(
      (classifyDetailedList({ status: 0, signal: null, stdout: `{"artifacts": {}}` }) as {
        reason: string;
      }).reason,
      "parse",
    );
  });

  it("ok path: malformed elements dropped, ids required, newest-first", () => {
    const r = classifyDetailedList({
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        artifacts: [
          { id: "a", title: "x", created_at: "2026-07-01T10:00:00Z", status_id: 1 },
          null,
          "junk",
          { title: "no-id", created_at: "2026-07-01T11:00:00Z" },
          { id: "b", title: "y", created_at: "2026-07-01T12:00:00Z", status_id: 3 },
        ],
      }),
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(
        r.artifacts.map((a) => a.id),
        ["b", "a"],
      );
    }
  });
});

// ── parity + read-only guards ───────────────────────────────────────

describe("single-source + read-only guards", () => {
  it("PRODUCT_TO_NLM_TYPE parity: key set ≡ STUDIO_PRODUCT_LIST; slides → slide-deck", () => {
    assert.deepEqual(
      Object.keys(PRODUCT_TO_NLM_TYPE).sort(),
      [...STUDIO_PRODUCT_LIST].sort(),
    );
    assert.equal(PRODUCT_TO_NLM_TYPE["slides"], "slide-deck");
    for (const v of Object.values(PRODUCT_TO_NLM_TYPE)) {
      assert.ok(typeof v === "string" && v.length > 0);
    }
  });

  it("read-only by construction: the checker imports NO job-mutation helper (§9 grep guard)", async () => {
    const src = await fs.readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "scripts",
        "studio-product-checker.ts",
      ),
      "utf-8",
    );
    assert.doesNotMatch(src, /from\s+["'][^"']*api-client/);
    assert.doesNotMatch(src, /import\s*\{[^}]*\b(updateJob|failJob|completeJob)\b[^}]*\}/);
    // DB access is SELECT-only: no .insert/.update/.upsert/.delete on the client
    assert.doesNotMatch(src, /\.\s*(insert|update|upsert|delete)\s*\(/);
  });
});

// ── config clamp (§5.4) ─────────────────────────────────────────────

describe("cap-aware video threshold clamp (Codex MAJOR)", () => {
  const withEnv = async (
    env: Record<string, string | undefined>,
    fn: () => void | Promise<void>,
  ) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("150-min cap: video threshold stays at 75min", () =>
    withEnv({ MAX_JOB_DURATION_MS: "9000000" }, () => {
      assert.equal(buildConfigFromEnv().tRenderMs.video, 75 * MIN);
    }));

  it("shipped 90-min default cap: clamped to cap − 30min = 60min", () =>
    withEnv({ MAX_JOB_DURATION_MS: undefined }, () => {
      assert.equal(buildConfigFromEnv().tRenderMs.video, 60 * MIN);
    }));

  it("pathologically small cap: floored at 20min", () =>
    withEnv({ MAX_JOB_DURATION_MS: "1200000" }, () => {
      assert.equal(buildConfigFromEnv().tRenderMs.video, 20 * MIN);
    }));

  it("NaN env falls back (envMs guard)", () =>
    withEnv({ MAX_JOB_DURATION_MS: "banana" }, () => {
      assert.equal(buildConfigFromEnv().maxJobDurationMs, 5_400_000);
    }));
});

// ── parsePsDateMs ───────────────────────────────────────────────────

describe("parsePsDateMs", () => {
  it("PS 5.1 /Date(ms)/, PS 7 ISO, and garbage", () => {
    assert.equal(parsePsDateMs("/Date(1719849602000)/"), 1719849602000);
    assert.equal(parsePsDateMs("\\/Date(1719849602000)\\/"), 1719849602000);
    assert.equal(parsePsDateMs("2026-07-01T12:00:00Z"), NOW0);
    assert.equal(parsePsDateMs("nonsense"), null);
    assert.equal(parsePsDateMs(42), null);
    assert.equal(parsePsDateMs(undefined), null);
  });
});

// ── child-breadcrumb ────────────────────────────────────────────────

describe("child-breadcrumb", () => {
  it("isValidJobId / breadcrumbPath reject traversal shapes", () => {
    assert.equal(isValidJobId(JOB_ID), true);
    assert.equal(isValidJobId("../../etc/passwd"), false);
    assert.equal(isValidJobId(""), false);
    assert.equal(breadcrumbPath("..%2f..%2fx"), null);
    assert.ok(breadcrumbPath(JOB_ID)?.endsWith(`${JOB_ID}.json`));
  });

  it("GC: keeps running jobs' crumbs, deletes completed/row-gone/malformed", async () => {
    const deleted: string[] = [];
    const deps: BreadcrumbGcDeps = {
      listBreadcrumbIds: async () => [JOB_ID, OTHER_ID, "not-a-uuid"],
      fetchStatuses: async () =>
        new Map([
          [JOB_ID, "running"],
          [OTHER_ID, "completed"],
          // "not-a-uuid" never reaches the query
        ]),
      deleteBreadcrumb: async (id) => {
        deleted.push(id);
      },
      log: () => {},
    };
    await gcChildBreadcrumbsOnce(deps);
    assert.deepEqual(deleted.sort(), ["not-a-uuid", OTHER_ID].sort());
  });

  it("GC fail-safe: a failed status query deletes NOTHING (the #6 evidence survives)", async () => {
    const deleted: string[] = [];
    const deps: BreadcrumbGcDeps = {
      listBreadcrumbIds: async () => [JOB_ID],
      // default-deps behavior on query error: report everything as running
      fetchStatuses: async (ids) => new Map(ids.map((id) => [id, "running"])),
      deleteBreadcrumb: async (id) => {
        deleted.push(id);
      },
      log: () => {},
    };
    await gcChildBreadcrumbsOnce(deps);
    assert.deepEqual(deleted, []);
  });
});
