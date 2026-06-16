/**
 * S129 — tests for the worker-level fail-closed studio-completeness gate.
 *
 * Covers the recurring "video completed in notebook but never reached the
 * gallery" bug and the MRPF review findings: requested-vs-delivered enforcement
 * driven by the DURABLE job selection (Codex MAJOR-3), reliable artifact-list
 * recovery (download-by-id), the STRICT anti-stale floor (Gemini CRITICAL-1 +
 * Codex CRITICAL-1 — no negative skew; a reused notebook's older OR
 * just-pre-start completed artifact is not mistaken for this run's still-
 * rendering one), robust timestamp parsing incl. hyphen-ISO (Codex CRITICAL-2),
 * NaN/overshoot-safe budget loop (Codex MAJOR-4), and fail-closed when
 * unrecoverable. Fake clock: sleep() advances time so loops terminate.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-completeness.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  enforceStudioCompleteness,
  type CompletenessDeps,
  type NlmArtifactRef,
} from "../lib/studio-completeness.js";
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

function harness(over: Partial<CompletenessDeps> & { dir?: string[] } = {}): Harness {
  let t = 0;
  const logs: string[] = [];
  const downloads: Array<{ id: string; type: string; out: string }> = [];
  const deps: CompletenessDeps = {
    listArtifacts: over.listArtifacts ?? (() => []),
    downloadArtifact:
      over.downloadArtifact ??
      (async (_nb, id, type, out) => {
        downloads.push({ id, type, out });
        return true;
      }),
    listDir: over.listDir ?? (async () => over.dir ?? []),
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
    // state says video=false (pipeline drift), durable arg says video=true.
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
    assert.deepEqual(r.selected, ["video"]); // obligation from durable arg, not state
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ["video"]);
  });

  test("hyphen-ISO state.timestamp (YYYY-MM-DDTHH-mm-ss) parses → floor works (Codex CRITICAL-2)", async () => {
    // No on-disk winner, empty artifacts → floor must come from state.timestamp.
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
    // recovered name uses the parsed compact timestamp, not a synthesized "now"
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

  test("still-rendering (no completed artifact) → fail-closed after budget", async () => {
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
      { recoveryBudgetMs: Number("bad"), pollIntervalMs: Number("bad") }, // NaN both
      h.deps,
    );
    assert.equal(r.ok, false); // terminates (no infinite loop), fails closed
    assert.equal(calls, 1, "NaN budget → exactly one attempt, no spin");
  });

  test("null notebook_id → fail-closed immediately", async () => {
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
  });

  test("completed artifact found but download keeps failing → fail-closed", async () => {
    const h = harness({
      dir: [],
      listArtifacts: () => [{ id: "x", title: "X", created_at: AFTER }],
      downloadArtifact: async () => false,
    });
    const r = await enforceStudioCompleteness(sel({ video: true }), stateWith(), "/p", OPTS, h.deps);
    assert.equal(r.ok, false);
    assert.deepEqual(r.stillMissing, ["video"]);
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
      downloadArtifact: async () => true,
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
    // deadline = 0 + 100; no list may start at or past it
    for (const ct of callTimes) {
      assert.ok(ct < 100, `list fired at t=${ct} which is at/after the deadline (100)`);
    }
  });
});
