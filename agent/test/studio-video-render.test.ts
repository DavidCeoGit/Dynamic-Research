/**
 * S187 P0-2 — tests for the best-effort still-rendering-video completion (Branch (c)).
 *
 * Covers the two highest-value SAFETY keystones of the feature (the fail-opens
 * Gemini C-1 / Codex flagged in the DESIGN gate):
 *   1. shouldDeferForVideoRender — the Gate-A deliverable-presence probe. It must
 *      DEFER only when the ONLY missing deliverable is the Studio video (every
 *      non-video studio + all 5 research docs present, publish gate satisfied,
 *      notebook present); ANY other gap → terminal (never best-effort).
 *   2. finalizeBestEffortRun — the best-effort carve-out keystone. It must REFUSE
 *      to complete on any non-video obligation gap, any missing research doc, or a
 *      missing videoTaskId; and on success PATCH completed +
 *      studio_recovery_video_deferred=true + reconcile billing (markUsageCompleted).
 *
 * (Branch-(c) classification anti-stale + the sweep render-arm/best-effort
 * integration are exercised at the MERGE-gate session — see the S187 handoff.)
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-video-render.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { shouldDeferForVideoRender } from "../lib/state-evaluation.js";
import {
  finalizeBestEffortRun,
  type FinalizeBestEffortArgs,
  type FinalizeDeps,
} from "../scripts/finalize-recovered-run.js";
import type { SelectedProducts } from "../types.js";

const TS = "20260615-190502";
const EXT: Record<string, string> = {
  audio: "mp3",
  video: "mp4",
  slides: "pdf",
  report: "md",
  infographic: "png",
};
const RESEARCH_ROLES = ["brief", "perplexity", "comparison", "vendor-evaluation", "notebooklm"];

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
function studio(product: string): string {
  return `some-title-${TS}-${product}.${EXT[product]}`;
}
function research(role: string): string {
  return `my-topic-${role}.md`;
}
/** {name,size} entries: the selected NON-VIDEO studio products + all 5 research docs. */
function entries(nonVideoStudio: string[]): Array<{ name: string; size: number }> {
  return [
    ...nonVideoStudio.map((p) => ({ name: studio(p), size: 100 })),
    ...RESEARCH_ROLES.map((r) => ({ name: research(r), size: 100 })),
  ];
}

// ───────────────────────────── 1. Gate-A probe ─────────────────────────────

describe("shouldDeferForVideoRender — Gate-A deliverable-presence probe", () => {
  const happy = {
    notebookId: "nb-1",
    entries: entries(["audio", "report"]),
    selected: sel({ video: true, audio: true, report: true }),
    publishOk: true,
  };

  test("DEFERS when ONLY the video is missing (all non-video studio + research present, publish ok)", () => {
    const r = shouldDeferForVideoRender(happy);
    assert.equal(r.defer, true, r.reason);
  });

  test("terminal when notebook_id is absent (video not recoverable from NLM)", () => {
    assert.equal(shouldDeferForVideoRender({ ...happy, notebookId: null }).defer, false);
    assert.equal(shouldDeferForVideoRender({ ...happy, notebookId: "" }).defer, false);
  });

  test("terminal when the publish gate is NOT satisfied (never best-effort a failed publish)", () => {
    const r = shouldDeferForVideoRender({ ...happy, publishOk: false });
    assert.equal(r.defer, false);
    assert.match(r.reason, /publish/i);
  });

  test("terminal when video is NOT a selected product (not a render-defer case)", () => {
    const r = shouldDeferForVideoRender({
      ...happy,
      selected: sel({ audio: true, report: true }),
    });
    assert.equal(r.defer, false);
  });

  test("terminal when a NON-video studio product is missing (a studio gap is a crash — Gemini C-1)", () => {
    // audio selected but absent on disk (only report present).
    const r = shouldDeferForVideoRender({
      ...happy,
      entries: entries(["report"]),
    });
    assert.equal(r.defer, false);
    assert.match(r.reason, /audio/);
  });

  test("terminal when a RESEARCH deliverable is missing (phase crash — the Gemini C-1 fail-open)", () => {
    const missingBrief = entries(["audio", "report"]).filter((e) => !e.name.endsWith("-brief.md"));
    const r = shouldDeferForVideoRender({ ...happy, entries: missingBrief });
    assert.equal(r.defer, false);
    assert.match(r.reason, /brief/);
  });

  test("terminal when a research doc is present but ZERO-byte (truncated, not a deliverable)", () => {
    const zeroBrief = entries(["audio", "report"]).map((e) =>
      e.name.endsWith("-brief.md") ? { ...e, size: 0 } : e,
    );
    assert.equal(shouldDeferForVideoRender({ ...happy, entries: zeroBrief }).defer, false);
  });

  test("no defer when the video is already on disk (nothing to defer)", () => {
    const withVideo = [...happy.entries, { name: studio("video"), size: 100 }];
    const r = shouldDeferForVideoRender({ ...happy, entries: withVideo });
    assert.equal(r.defer, false);
  });
});

// ─────────────────────── 2. finalizeBestEffortRun keystone ───────────────────────

const JOB = "11111111-1111-1111-1111-111111111111";

interface Mock {
  deps: FinalizeDeps;
  patches: Record<string, unknown>[];
  uploads: string[];
  billingCalls: string[];
}

function mockDeps(over: {
  onDisk?: string[];
  selected?: SelectedProducts | null;
  lint?: number | null;
  uploadFails?: boolean;
} = {}): Mock {
  const patches: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const billingCalls: string[] = [];
  const deps: FinalizeDeps = {
    url: "http://supabase.local",
    key: "service-role-key",
    runLint: () => (over.lint === undefined ? 0 : over.lint),
    readDir: async () => over.onDisk ?? [],
    statPath: async () => ({ isFile: true, size: 100 }),
    readFile: async () => Buffer.from("data"),
    upload: async (a) => {
      uploads.push(a.filename);
      return over.uploadFails ? { ok: false, reason: "storage 500 (test)" } : { ok: true };
    },
    fetchRow: async () => ({
      organization_id: "org-1",
      selected_products: over.selected ?? null,
    }),
    patchRow: async (_jobId, body) => {
      patches.push(body);
      return { ok: true, httpStatus: 200, row: body };
    },
    log: () => {},
    markUsageCompleted: async (id) => {
      billingCalls.push(id);
    },
  };
  return { deps, patches, uploads, billingCalls };
}

function bestEffortArgs(over: Partial<FinalizeBestEffortArgs> = {}): FinalizeBestEffortArgs {
  return {
    jobId: JOB,
    workDir: "/p",
    slug: "topic-abc123",
    deferred: "video",
    videoTaskId: "vid-task-1",
    ...over,
  };
}

/** A fully-present best-effort scenario: video selected (deferred) + audio/report
 *  present + all 5 research docs. */
function fullOnDisk(): string[] {
  return [studio("audio"), studio("report"), ...RESEARCH_ROLES.map(research)];
}

describe("finalizeBestEffortRun — best-effort carve-out keystone", () => {
  test("completes (video deferred) when every NON-video obligation + research doc is present", async () => {
    const m = mockDeps({
      selected: sel({ video: true, audio: true, report: true }),
      onDisk: fullOnDisk(),
    });
    const r = await finalizeBestEffortRun(bestEffortArgs(), m.deps);
    assert.equal(r.ok, true, r.reason);
    assert.equal(m.patches.length, 1);
    assert.equal(m.patches[0].status, "completed");
    assert.equal(m.patches[0].studio_recovery_video_deferred, true);
    assert.equal(m.patches[0].studio_recovery_status, "recovered");
    assert.equal(m.patches[0].result_slug, "topic-abc123");
    // billing reconciled to complete (S186 markUsageCompleted).
    assert.deepEqual(m.billingCalls, [JOB]);
    // the video was NOT required on disk (it's deferred) — only audio+report uploaded.
    assert.ok(!m.uploads.includes(studio("video")));
  });

  test("REFUSES when videoTaskId is missing (cannot prove the render was launched)", async () => {
    const m = mockDeps({
      selected: sel({ video: true, audio: true }),
      onDisk: fullOnDisk(),
    });
    const r = await finalizeBestEffortRun(bestEffortArgs({ videoTaskId: "" }), m.deps);
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.equal(m.patches.length, 0, "must not PATCH completed");
    assert.deepEqual(m.billingCalls, []);
  });

  test("REFUSES when a NON-video obliged product is absent on disk (fail-closed)", async () => {
    // audio selected but NOT on disk.
    const m = mockDeps({
      selected: sel({ video: true, audio: true, report: true }),
      onDisk: [studio("report"), ...RESEARCH_ROLES.map(research)], // audio missing
    });
    const r = await finalizeBestEffortRun(bestEffortArgs(), m.deps);
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.deepEqual(r.missingObliged, ["audio"]);
    assert.equal(m.patches.length, 0);
  });

  test("REFUSES when a research deliverable is missing (phase crash — Gemini C-1)", async () => {
    const m = mockDeps({
      selected: sel({ video: true, report: true }),
      onDisk: [studio("report"), ...RESEARCH_ROLES.filter((r) => r !== "comparison").map(research)],
    });
    const r = await finalizeBestEffortRun(bestEffortArgs(), m.deps);
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.match(r.reason ?? "", /comparison/);
    assert.equal(m.patches.length, 0);
  });

  test("does NOT require the video itself (it is the deferred product)", async () => {
    // Only the video is selected+missing; no other studio obligation. Research present.
    const m = mockDeps({
      selected: sel({ video: true }),
      onDisk: [...RESEARCH_ROLES.map(research)],
    });
    const r = await finalizeBestEffortRun(bestEffortArgs(), m.deps);
    assert.equal(r.ok, true, r.reason);
    assert.equal(m.patches[0].studio_recovery_video_deferred, true);
  });

  test("REFUSES (no completed PATCH) when a deliverable UPLOAD fails (C2 — no fail-open)", async () => {
    const m = mockDeps({
      selected: sel({ video: true, report: true }),
      onDisk: fullOnDisk(),
      uploadFails: true,
    });
    const r = await finalizeBestEffortRun(bestEffortArgs(), m.deps);
    assert.equal(r.ok, false);
    assert.equal(m.patches.length, 0);
  });
});
