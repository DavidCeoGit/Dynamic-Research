/**
 * S129/S158 — tests for the worker-level fail-closed studio-completeness gate.
 *
 * Covers the recurring "video completed in notebook but never reached the
 * gallery" bug + the MRPF review findings (S129) AND the S158 transient-tolerance
 * taxonomy split: a download that fails on a CONFIRMED status_id-3 artifact is
 * classified transient-vs-terminal; a purely-transient set becomes
 * recoverablePending (NOT a terminal hard-fail) while NEVER making ok true.
 * Fake clock: sleep() advances time so loops terminate.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-completeness.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import { join as pathJoin } from "node:path";

import {
  enforceStudioCompleteness,
  type CompletenessDeps,
} from "../lib/studio-completeness.js";
import {
  classifyDownloadFailure,
  realDownloadArtifact,
  type DownloadResult,
  type DownloadSpawn,
  type NlmArtifactRef,
} from "../lib/nlm-artifact-cli.js";
import type { PipelineState, SelectedProducts } from "../types.js";

// Run starts 2026-06-15 19:05:02.
const TS = "20260615-190502";
const AFTER = "2026-06-15T19:34:36"; // this run's artifact (after start)
const BEFORE = "2026-06-15T10:00:00"; // stale parent artifact (well before start)
const NEAR_BEFORE = "2026-06-15T19:03:30"; // 92s BEFORE start — must be rejected (no skew)
const NB = "ca4561a0-a1df-40d6-a9da-f0efaad432af";

function deliverable(product: string, ext: string): string {
  return `some-title-${TS}-${product}.${ext}`;
}

function sel(over: Partial<Record<string, boolean>>): SelectedProducts {
  return {
    audio: false,
    video: false,
    slides: false,
    report: false,
    infographic: false,
    ...over,
  } as SelectedProducts;
}

function stateWith(over: Partial<PipelineState> = {}): PipelineState {
  return {
    timestamp: TS,
    notebook_id: NB,
    selectedProducts: sel({}), // ignored by the gate (durable arg drives) — present for realism
    artifacts: {},
    ...over,
  } as unknown as PipelineState;
}

interface Harness {
  deps: CompletenessDeps;
  logs: string[];
  downloads: Array<{ id: string; type: string; out: string }>;
}

const OK: DownloadResult = { ok: true };

function harness(over: Partial<CompletenessDeps> & { dir?: string[] } = {}): Harness {
  let t = 0;
  const logs: string[] = [];
  const downloads: Array<{ id: string; type: string; out: string }> = [];
  const deps: CompletenessDeps = {
    listArtifacts: over.listArtifacts ?? (() => []),
    listArtifactsWithStatus: over.listArtifactsWithStatus ?? (() => []),
    downloadArtifact:
      over.downloadArtifact ??
      (async (_nb, id, type, out) => {
        downloads.push({ id, type, out });
        return OK;
      }),
    // S161 R2-3: listDir now returns {name, size}. `dir` names default to size 1
    // (non-empty → present); size-specific cases inject a custom listDir.
    listDir: over.listDir ?? (async () => (over.dir ?? []).map((name) => ({ name, size: 1 }))),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    log: (m: string) => logs.push(m),
  };
  return { deps, logs, downloads };
}

const OPTS = { recoveryBudgetMs: 600_000, pollIntervalMs: 60_000 };

describe("enforceStudioCompleteness", () => {
  test("all selected products present → ok, no recovery attempted", async () => {
    const h = harness({
      dir: [deliverable("audio", "mp3"), deliverable("video", "mp4"), deliverable("report", "md")],
      listArtifacts: () => {
        throw new Error("must not list when nothing is missing");
      },
    });
    const r = await enforceStudioCompleteness(
      sel({ audio: true, video: true, report: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.selected.sort(), ["audio", "report", "video"]);
    assert.deepEqual(r.recovered, []);
    assert.deepEqual(r.stillMissing, []);
    assert.deepEqual(r.recoverablePending, []);
  });

  test("missing video completed after run start → recovered BY ID", async () => {
    const art: NlmArtifactRef = { id: "vid-art-1", title: "Arrowhead 7-Agent OS", created_at: AFTER };
    const h = harness({
      dir: [deliverable("report", "md")],
      listArtifacts: (_nb, type) => (type === "video" ? [art] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true, report: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ["video"]);
    assert.equal(h.downloads[0].id, "vid-art-1");
    assert.equal(h.downloads[0].type, "video");
    assert.match(h.downloads[0].out, new RegExp(`-${TS}-video\\.mp4$`));
  });

  test("ANTI-STALE: a reused notebook's OLDER completed video is NOT recovered", async () => {
    const stale: NlmArtifactRef = { id: "parent-vid", title: "Old Parent", created_at: BEFORE };
    const h = harness({
      dir: [deliverable("report", "md")],
      listArtifacts: (_nb, type) => (type === "video" ? [stale] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true, report: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.stillMissing, ["video"]);
    assert.equal(h.downloads.length, 0);
    // No status_id-3 winner matched this run → branch (a), NOT recoverable.
    assert.deepEqual(r.recoverablePending, []);
  });

  test("STRICT floor: an artifact created 92s BEFORE start is rejected (no skew)", async () => {
    const nearStale: NlmArtifactRef = { id: "near", title: "Near", created_at: NEAR_BEFORE };
    const h = harness({
      dir: [deliverable("report", "md")],
      listArtifacts: (_nb, type) => (type === "video" ? [nearStale] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true, report: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.equal(h.downloads.length, 0, "92s-pre-start artifact must not be accepted");
  });

  test("expectedId (persisted task_id) recovers the exact artifact regardless of order", async () => {
    const mine: NlmArtifactRef = { id: "mine-123", title: "Mine", created_at: AFTER };
    const other: NlmArtifactRef = { id: "other-999", title: "Other", created_at: AFTER };
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) => (type === "video" ? [other, mine] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith({ artifacts: { video: { task_id: "mine-123" } } } as unknown as Partial<PipelineState>),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, true);
    assert.equal(h.downloads[0].id, "mine-123");
  });

  test("DURABLE selection drives obligations even if state disagrees (Codex MAJOR-3)", async () => {
    const art: NlmArtifactRef = { id: "v", title: "V", created_at: AFTER };
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) => (type === "video" ? [art] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith({ selectedProducts: sel({ video: false }) }),
      "/p",
      OPTS,
      h.deps,
    );
    assert.deepEqual(r.selected, ["video"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ["video"]);
  });

  test("hyphen-ISO state.timestamp (YYYY-MM-DDTHH-mm-ss) parses → floor works (Codex CRITICAL-2)", async () => {
    const art: NlmArtifactRef = { id: "v", title: "V", created_at: AFTER };
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) => (type === "video" ? [art] : []),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith({ timestamp: "2026-06-15T19-05-02" } as unknown as Partial<PipelineState>),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ["video"]);
    assert.match(h.downloads[0].out, new RegExp(`-${TS}-video\\.mp4$`));
  });

  test("slides → slide-deck NLM type on recovery", async () => {
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) =>
        type === "slide-deck" ? [{ id: "s1", title: "Deck", created_at: AFTER }] : [],
    });
    const r = await enforceStudioCompleteness(sel({ slides: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, true);
    assert.equal(h.downloads[0].type, "slide-deck");
  });

  test("still-rendering (no completed artifact) → fail-closed, NOT recoverable (branch a)", async () => {
    let calls = 0;
    const h = harness({
      dir: [deliverable("report", "md")],
      listArtifacts: () => {
        calls++;
        return [];
      },
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true, report: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.stillMissing, ["video"]);
    // Never confirmed status_id 3 → branch (a), not recoverable-pending.
    assert.deepEqual(r.recoverablePending, []);
    assert.ok(calls >= 10, `expected >=10 attempts, got ${calls}`);
  });

  test("recovers on a later poll once the artifact appears", async () => {
    let calls = 0;
    const h = harness({
      dir: [],
      listArtifacts: () => {
        calls++;
        return calls >= 3 ? [{ id: "late", title: "Late", created_at: AFTER }] : [];
      },
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, true);
    assert.equal(h.downloads[0].id, "late");
  });

  test("budget loop is NaN-safe and does ≥1 attempt then terminates (Codex MAJOR-4)", async () => {
    let calls = 0;
    const h = harness({
      dir: [],
      listArtifacts: () => {
        calls++;
        return [];
      },
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith(),
      "/p",
      { recoveryBudgetMs: Number("bad"), pollIntervalMs: Number("bad") },
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.equal(calls, 1, "NaN budget → exactly one attempt, no spin");
  });

  test("null notebook_id → fail-closed immediately, NOT recoverable", async () => {
    const h = harness({
      dir: [],
      listArtifacts: () => {
        throw new Error("must not list without a notebook");
      },
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith({ notebook_id: null }),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.match(r.notes.join(" "), /notebook_id is null/);
    assert.deepEqual(r.recoverablePending, []);
  });

  test("only obliged products are checked (unselected ignored)", async () => {
    const h = harness({
      dir: [deliverable("report", "md")],
      listArtifacts: () => {
        throw new Error("must not list — nothing obliged is missing");
      },
    });
    const r = await enforceStudioCompleteness(sel({ report: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(r.selected, ["report"]);
  });

  test("no artifact-list call fires at or after the deadline (Codex QA finding-4)", async () => {
    const callTimes: number[] = [];
    let t = 0;
    const deps: CompletenessDeps = {
      listArtifacts: () => {
        callTimes.push(t);
        return [];
      },
      listArtifactsWithStatus: () => [],
      downloadArtifact: async () => OK,
      listDir: async () => [],
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      log: () => {},
    };
    const r = await enforceStudioCompleteness(
      sel({ video: true }),
      stateWith(),
      "/p",
      { recoveryBudgetMs: 100, pollIntervalMs: 60 },
      deps,
    );
    assert.equal(r.ok, false);
    assert.ok(callTimes.length >= 1, "must do at least one attempt");
    for (const ct of callTimes) {
      assert.ok(ct < 100, `list fired at t=${ct} which is at/after the deadline (100)`);
    }
  });

  // ── S161 R2-3: size-aware gate (zero-byte fail-open in the PRIMARY path) ────
  test("R2-3: a 0-byte obliged product is NOT a winner → fail-closed (no completed-while-empty)", async () => {
    // Sensitivity: the size-BLIND gate (listDir filenames only) counted a 0-byte
    // convention file as present → ok:true → executor ships an empty buffer +
    // completeJob. The size-aware gate filters 0-byte → product MISSING; with no
    // recoverable artifact it fails closed. The buggy `pickWinners(entries…)`
    // (ignoring size) makes ok true here.
    const h = harness({
      listArtifacts: () => [], // nothing to recover
      listDir: async () => [{ name: deliverable("video", "mp4"), size: 0 }],
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, false, "a 0-byte obliged product must NOT pass the gate");
    assert.deepEqual(r.stillMissing, ["video"]);
  });

  test("R2-3: a 0-byte obliged product WITH a confirmed artifact → re-downloaded (recovered)", async () => {
    // The 0-byte file is treated as absent, so the gate recovers BY ID over it.
    const art: NlmArtifactRef = { id: "vid-1", title: "X", created_at: AFTER };
    const h = harness({
      listArtifacts: (_nb, type) => (type === "video" ? [art] : []),
      listDir: async () => [{ name: deliverable("video", "mp4"), size: 0 }],
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ["video"]);
    assert.equal(h.downloads[0].id, "vid-1");
  });

  test("R2-3: a NON-empty obliged product still passes (size>0 winner unaffected)", async () => {
    const h = harness({
      listArtifacts: () => {
        throw new Error("must not list — the non-empty product is already present");
      },
      listDir: async () => [{ name: deliverable("report", "md"), size: 42 }],
    });
    const r = await enforceStudioCompleteness(sel({ report: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(r.stillMissing, []);
  });
});

// ── S158 taxonomy split (design §4/§13) ──────────────────────────────

describe("S158 taxonomy split — recoverablePending", () => {
  test("branch (b): confirmed winner + TRANSIENT download failure → recoverablePending (ok still false)", async () => {
    // Sensitivity: pre-S158 (boolean dep, no recoverablePending) this is a plain
    // hard-fail; the recoverablePending assertion fails on the old gate.
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) => (type === "video" ? [{ id: "vid-1", title: "X", created_at: AFTER }] : []),
      downloadArtifact: async () => ({ ok: false, exitCode: 1, stderr: "HTTP 503 Service Unavailable", signal: null }),
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, false, "recoverablePending NEVER makes ok true (invariant)");
    assert.deepEqual(r.stillMissing, ["video"]);
    assert.equal(r.recoverablePending.length, 1);
    const rp = r.recoverablePending[0];
    assert.equal(rp.product, "video");
    assert.equal(rp.artifactId, "vid-1");
    assert.equal(rp.nlmType, "video");
    assert.match(rp.filename, /video\.mp4$/);
    assert.equal(r.notebookId, NB, "notebookId echoed for the executor payload");
    assert.match(r.recoveryStderr ?? "", /503/);
  });

  test("branch (a): confirmed winner + TERMINAL (disk-full) download failure → NOT recoverable", async () => {
    // Sensitivity: a transient classification would wrongly add it to
    // recoverablePending; only a local-disk terminal stays branch (a).
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) => (type === "video" ? [{ id: "vid-1", title: "X", created_at: AFTER }] : []),
      downloadArtifact: async () => ({ ok: false, exitCode: 1, stderr: "OSError: [Errno 28] No space left on device", signal: null }),
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, false);
    assert.deepEqual(r.stillMissing, ["video"]);
    assert.deepEqual(r.recoverablePending, [], "local-disk terminal → branch (a), not recoverable");
  });

  test("mixed (a)+(b): one transient + one still-rendering → only (b) is recoverable; both still-missing", async () => {
    // Sensitivity: purelyTransient (executor branch) must be FALSE here — a
    // still-rendering product means the whole job is a genuine hard-fail.
    const h = harness({
      dir: [],
      listArtifacts: (_nb, type) =>
        type === "video" ? [{ id: "vid-1", title: "X", created_at: AFTER }] : [], // slides never appear
      downloadArtifact: async () => ({ ok: false, exitCode: 1, stderr: "connection reset", signal: null }),
    });
    const r = await enforceStudioCompleteness(
      sel({ video: true, slides: true }),
      stateWith(),
      "/p",
      OPTS,
      h.deps,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.stillMissing.sort(), ["slides", "video"]);
    // Only video was a confirmed-transient; slides never confirmed (branch a).
    assert.deepEqual(r.recoverablePending.map((p) => p.product), ["video"]);
    // The executor's purelyTransient test: NOT every still-missing is recoverable.
    const purelyTransient = r.stillMissing.every((p) =>
      r.recoverablePending.some((rp) => rp.product === p),
    );
    assert.equal(purelyTransient, false, "a mixed job must take the terminal branch");
  });
});

// ── S158 classifyDownloadFailure (design §8/§13.2) ───────────────────

describe("classifyDownloadFailure", () => {
  test("confirmed-winner HTTP/auth/network/timeout failures → transient (Codex MAJOR-7)", () => {
    assert.equal(classifyDownloadFailure(1, "HTTP 404 not found", null), "transient");
    assert.equal(classifyDownloadFailure(1, "401 Unauthorized", null), "transient");
    assert.equal(classifyDownloadFailure(1, "403 Forbidden", null), "transient");
    assert.equal(classifyDownloadFailure(1, "503 Service Unavailable", null), "transient");
    assert.equal(classifyDownloadFailure(1, "429 Too Many Requests", null), "transient");
    assert.equal(classifyDownloadFailure(1, "ECONNRESET connection reset", null), "transient");
    assert.equal(classifyDownloadFailure(null, "", "SIGTERM"), "transient", "timeout/null-exit → transient");
  });

  test("only truly-local-disk failures → terminal", () => {
    assert.equal(classifyDownloadFailure(1, "ENOSPC: no space left on device", null), "terminal");
    assert.equal(classifyDownloadFailure(1, "OSError: [Errno 28] No space left on device", null), "terminal");
    assert.equal(classifyDownloadFailure(1, "disk is full", null), "terminal");
    assert.equal(classifyDownloadFailure(1, "Read-only file system", null), "terminal");
    assert.equal(classifyDownloadFailure(1, "disk quota exceeded", null), "terminal");
  });

  test("exit 0 with clean stderr → transient (never keys terminal on Bug-12 success)", () => {
    assert.equal(classifyDownloadFailure(0, "", null), "transient");
  });
});

describe("realDownloadArtifact — atomic temp-then-rename (S160 Codex CRITICAL/MAJOR-2)", () => {
  // The injected spawn simulates the NLM CLI by writing to the temp path it is
  // handed in argv: ["download", type, "-n", nb, "-a", id, <TMP>, "--force"] (idx 6).
  const argTmp = (args: string[]): string => args[6];
  const tmpdir = (): Promise<string> => fsp.mkdtemp(pathJoin(os.tmpdir(), "dr-s160-dl-"));

  test("crash/partial: the download TARGETS a temp path, never the final (crash-safety)", async () => {
    // The crash-safety invariant: a killed worker can only leave a partial where
    // the CLI was told to write. Asserting the target is a `.part` temp (not the
    // final convention path) proves a mid-download kill can never strand a partial
    // at the path M5/finalize trust. Sensitivity: a version that writes directly to
    // outPath has target===out and fails the notEqual assertion.
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    let target = "";
    const spawn: DownloadSpawn = (args) => {
      target = argTmp(args);
      writeFileSync(target, "PARTIAL-BYTES"); // positive-size partial
      return { status: 1, signal: null, stderr: "HTTP 503" };
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn);
    assert.equal(r.ok, false);
    assert.notEqual(target, out, "the download must target a temp path, not the final convention path");
    assert.equal(target, `${out}.part`);
    assert.equal(existsSync(out), false, "the final convention path must NEVER hold a partial");
    assert.equal(existsSync(`${out}.part`), false, "temp partial cleaned up after return");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("success: a non-empty temp is atomically promoted to the final path", async () => {
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    const spawn: DownloadSpawn = (args) => {
      writeFileSync(argTmp(args), "FULL-CONTENT");
      return { status: 0, signal: null };
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(out, "utf8"), "FULL-CONTENT");
    assert.equal(existsSync(`${out}.part`), false, "temp removed after promotion");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("a FAILED re-download must NOT delete a prior good final file", async () => {
    // Sensitivity: the prior cleanup deleted outPath on failure → a good file from
    // a previous successful tick would be destroyed by a later failed attempt.
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    writeFileSync(out, "PRIOR-GOOD-DOWNLOAD");
    const spawn: DownloadSpawn = (args) => {
      writeFileSync(argTmp(args), "GARBAGE");
      return { status: 1, signal: null, stderr: "boom" };
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn);
    assert.equal(r.ok, false);
    assert.equal(
      readFileSync(out, "utf8"),
      "PRIOR-GOOD-DOWNLOAD",
      "a failed download must not delete a prior good file",
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("exit 0 but EMPTY temp → ok:false, final untouched", async () => {
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    const spawn: DownloadSpawn = (args) => {
      writeFileSync(argTmp(args), ""); // 0 bytes
      return { status: 0, signal: null };
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn);
    assert.equal(r.ok, false, "a 0-byte download is not a success");
    assert.equal(existsSync(out), false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // ── S161 R2-2: rename-only promotion (no pre-delete, no copyFile fallback) ──
  test("R2-2: a promotion rename FAILURE → ok:false, prior good final preserved, NO copyFile", async () => {
    // Sensitivity: the round-1 code did fs.rm(outPath) then fs.rename then
    // catch→fs.copyFile. With a prior good final present + the rename throwing, the
    // pre-delete destroyed it and the copyFile fallback wrote the new temp on top
    // (or a crash mid-copy truncated it). rename-ONLY leaves the prior final intact
    // and returns ok:false. The injected renameImpl forces the failure deterministically.
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    writeFileSync(out, "PRIOR-GOOD-DOWNLOAD");
    const spawn: DownloadSpawn = (args) => {
      writeFileSync(argTmp(args), "NEW-FULL-CONTENT"); // non-empty temp, exit 0
      return { status: 0, signal: null };
    };
    const failingRename = async (): Promise<void> => {
      throw new Error("EXDEV simulated cross-device rename");
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn, failingRename);
    assert.equal(r.ok, false, "a failed promotion is not a success");
    assert.equal(
      readFileSync(out, "utf8"),
      "PRIOR-GOOD-DOWNLOAD",
      "a rename failure must NOT delete/overwrite the prior good final (no pre-delete, no copyFile)",
    );
    assert.equal(existsSync(`${out}.part`), false, "temp dropped after a failed promotion");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("R2-2: success promotion atomically REPLACES an existing final via rename", async () => {
    // rename-only must still overwrite a stale final on the SUCCESS path (no
    // pre-delete needed — fs.rename replaces atomically). Guards against a
    // regression where dropping the pre-delete would strand the old content.
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    writeFileSync(out, "OLD-CONTENT");
    const spawn: DownloadSpawn = (args) => {
      writeFileSync(argTmp(args), "NEW-CONTENT");
      return { status: 0, signal: null };
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, spawn);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(out, "utf8"), "NEW-CONTENT", "a successful download replaces the prior final");
    assert.equal(existsSync(`${out}.part`), false, "temp removed after promotion");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // ── S162 (Codex grounded BLOCK): the spawn seam must never throw out ──
  test("S162: a spawnImpl THROW (arg-validation, e.g. empty NLM_BIN) → ok:false, NOT thrown", async () => {
    // realDownloadArtifact documents a throw-safe "returns {ok:false} on failure"
    // contract. defaultDownloadSpawn's spawnSync throws SYNCHRONOUSLY on an empty
    // NLM_BIN (a blank NOTEBOOKLM_BIN survives the `??` default) or a NUL byte —
    // distinct from the error-shaped {status:null} returns for a missing binary /
    // timeout / maxBuffer. An unguarded throw escaped the recovery sweep and stranded
    // a row (Codex grounded BLOCK). Sensitivity: removing the try/catch around the
    // spawnImpl call makes realDownloadArtifact REJECT instead of returning ok:false.
    const dir = await tmpdir();
    const out = pathJoin(dir, "x-20260615-190502-video.mp4");
    writeFileSync(out, "PRIOR-GOOD"); // a prior good final must survive a spawn throw
    const throwingSpawn: DownloadSpawn = () => {
      throw new TypeError("The argument 'file' cannot be empty. Received ''");
    };
    const r = await realDownloadArtifact("nb", "a1", "video", out, 1000, throwingSpawn);
    assert.equal(r.ok, false, "a spawn throw is fail-closed, not a success");
    assert.equal(readFileSync(out, "utf8"), "PRIOR-GOOD", "a spawn throw must not touch the prior good final");
    assert.equal(existsSync(`${out}.part`), false, "temp dropped after a spawn throw");
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
