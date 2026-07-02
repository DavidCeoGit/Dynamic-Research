/**
 * Tests for summarizeStateProgress() — the pure, total progress-summary used by
 * watchStateFile. Regression coverage for the S166 MERGE-gate CRITICAL (Codex):
 * the helper readPipelineState returns kind:"ok" for ANY JSON object, but a
 * malformed object whose phase/phase_status is itself a non-primitive (e.g.
 * {"phase":{"toString":null}}) would throw on PHASE_MAP key coercion / string
 * interpolation, escaping watchStateFile's async setInterval as an UNHANDLED
 * REJECTION. summarizeStateProgress must classify such a state as "malformed"
 * (never throw). These are sensitivity proofs: the two exact Codex counterexamples
 * are asserted to NOT throw and to be malformed; valid states must NOT be flagged.
 *
 * S199 F2: also covers the "status-update" kind — a same-(phase, pct) state
 * whose phase_status TEXT changed (the Studio-poll heartbeat pattern) must
 * surface as "status-update" (never silently "unchanged", never an unthrottled
 * "update"), and a phase TRANSITION must stay "update" regardless of status.
 * Plus the S199 Gemini MERGE-gate fixes: status-text normalization
 * (string-coerce + MAX_PHASE_STATUS_LEN truncation at the summarize boundary)
 * and the makeStateSync behavioral contract — 30s throttle (deferred, not
 * dropped), revert-on-failed-PATCH (paced retry instead of permanent
 * staleness), and the unthrottled stop()-flush (a child's dying phase_status
 * must reach the DB).
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/watch-state-progress.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeStateProgress,
  makeStateSync,
  MAX_PHASE_STATUS_LEN,
  MAX_PHASE_LEN,
  SAME_PHASE_STATUS_MIN_INTERVAL_MS,
} from "../lib/state-evaluation.js";
import type { StateSyncDeps } from "../lib/state-evaluation.js";
import type { StateReadResult } from "../lib/read-state-file.js";
import type { PipelineState, ResearchJob } from "../types.js";

/** Build a minimal state — summarizeStateProgress only reads phase/phase_status. */
const mk = (phase: unknown, phase_status: unknown): PipelineState =>
  ({ phase, phase_status }) as unknown as PipelineState;

describe("summarizeStateProgress — malformed (S166 unhandled-rejection regression)", () => {
  test("Codex counterexample 1: phase is a non-coercible object → malformed, NOT thrown", () => {
    const state = mk({ toString: null }, "running");
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("Codex counterexample 2: phase_status is a non-coercible object → malformed, NOT thrown", () => {
    const state = mk("1", { toString: null });
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("phase is an array → malformed", () => {
    assert.equal(summarizeStateProgress(mk([], "running"), "", 0, "").kind, "malformed");
  });

  test("phase_status is a plain object → malformed", () => {
    assert.equal(summarizeStateProgress(mk("5", { a: 1 }), "", 0, "").kind, "malformed");
  });

  test("both fields objects → malformed (and never throws)", () => {
    const state = mk({}, {});
    assert.doesNotThrow(() => summarizeStateProgress(state, "", 0, ""));
    assert.equal(summarizeStateProgress(state, "", 0, "").kind, "malformed");
  });

  test("malformed precedence: non-primitive status on the SAME phase → malformed, never status-update", () => {
    assert.equal(
      summarizeStateProgress(mk("5", { toString: null }), "5", 60, "running").kind,
      "malformed",
    );
  });
});

describe("summarizeStateProgress — valid (behavior preserved + guard not over-broad)", () => {
  test("known phase '5' from empty → update with mapped name/pct (proves PHASE_MAP integration)", () => {
    const r = summarizeStateProgress(mk("5", "running"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phase, "5");
    assert.equal(r.phaseName, "Synthesis");
    assert.equal(r.pct, 60);
    assert.equal(r.phaseStatus, "running");
  });

  test("same known phase + matching pct + same status text → unchanged (no spurious update)", () => {
    // PHASE_MAP['5'].pct === 60, so lastPhase '5' + lastPct 60 + identical
    // status text = no change of any kind.
    assert.equal(
      summarizeStateProgress(mk("5", "running"), "5", 60, "running").kind,
      "unchanged",
    );
  });

  test("unknown phase → update with phaseKey as name + lastPct fallback (no throw)", () => {
    const r = summarizeStateProgress(mk("zzz-not-a-phase", "x"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phaseName, "zzz-not-a-phase");
    assert.equal(r.pct, 0);
  });

  test("a normal string state is NOT flagged malformed (guard not over-broad)", () => {
    assert.notEqual(summarizeStateProgress(mk("3", "complete"), "", 0, "").kind, "malformed");
  });
});

describe("summarizeStateProgress — status-update (S199 F2 same-phase status sync)", () => {
  test("same (phase, pct), new status text → status-update carrying mapped name/pct + the NEW text", () => {
    const next = "Phase 5.5a: Studio polling - 2/5 products complete (poll 12)";
    const r = summarizeStateProgress(
      mk("5.5", next),
      "5.5",
      70,
      "Phase 5.5a: Studio polling - 1/5 products complete (poll 6)",
    );
    assert.equal(r.kind, "status-update");
    if (r.kind !== "status-update") return;
    assert.equal(r.phase, "5.5");
    assert.equal(r.phaseName, "Studio Products");
    assert.equal(r.pct, 70);
    assert.equal(r.phaseStatus, next);
  });

  test("phase transition with changed status → update, never status-update (transition precedence)", () => {
    const r = summarizeStateProgress(mk("6", "evaluating"), "5.5", 70, "polling");
    assert.equal(r.kind, "update");
  });

  test("unknown phase, same as last, status text changed → status-update with lastPct fallback", () => {
    const r = summarizeStateProgress(mk("zzz-not-a-phase", "b"), "zzz-not-a-phase", 42, "a");
    assert.equal(r.kind, "status-update");
    if (r.kind !== "status-update") return;
    assert.equal(r.pct, 42);
    assert.equal(r.phaseName, "zzz-not-a-phase");
  });

  test("status text reverting to the tracked last value → unchanged (strict equality, not ordering)", () => {
    assert.equal(
      summarizeStateProgress(mk("5.5", "poll 6"), "5.5", 70, "poll 6").kind,
      "unchanged",
    );
  });
});

describe("summarizeStateProgress — status normalization (S199 Gemini MAJOR/MINOR)", () => {
  test("text beyond MAX_PHASE_STATUS_LEN is truncated in the payload (both kinds)", () => {
    const long = "x".repeat(MAX_PHASE_STATUS_LEN + 100);
    const up = summarizeStateProgress(mk("5", long), "", 0, "");
    assert.equal(up.kind, "update");
    if (up.kind !== "update") return;
    assert.equal(up.phaseStatus.length, MAX_PHASE_STATUS_LEN);

    const su = summarizeStateProgress(mk("5", long), "5", 60, "short");
    assert.equal(su.kind, "status-update");
    if (su.kind !== "status-update") return;
    assert.equal(su.phaseStatus.length, MAX_PHASE_STATUS_LEN);
  });

  test("texts differing only past the cap → unchanged (dedupe compares what would be written)", () => {
    const base = "y".repeat(MAX_PHASE_STATUS_LEN);
    assert.equal(
      summarizeStateProgress(mk("5", base + "AAA"), "5", 60, base).kind,
      "unchanged",
    );
  });

  test("non-string primitive statuses coerce to strings: 42 → '42'; null and missing → ''", () => {
    const rNum = summarizeStateProgress(mk("5", 42), "", 0, "");
    assert.equal(rNum.kind, "update");
    if (rNum.kind !== "update") return;
    assert.equal(rNum.phaseStatus, "42");

    // null/missing coerce to "" — matching a lastPhaseStatus of "" is unchanged,
    // so a child briefly omitting phase_status can't desync the dedupe or emit
    // a JSON.stringify-stripped (fieldless) PATCH.
    assert.equal(summarizeStateProgress(mk("5", null), "5", 60, "").kind, "unchanged");
    const missing = { phase: "5" } as unknown as PipelineState;
    assert.equal(summarizeStateProgress(missing, "5", 60, "").kind, "unchanged");
  });

  test("numeric phase normalizes to string: JSON `\"phase\": 5` maps and carries string fields (Codex MINOR)", () => {
    const r = summarizeStateProgress(mk(5, "x"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phase, "5");
    assert.equal(r.phaseName, "Synthesis");
    assert.equal(r.pct, 60);
  });

  test("numeric 5 against tracked string '5' → unchanged (no spurious update on type flip)", () => {
    assert.equal(summarizeStateProgress(mk(5, "x"), "5", 60, "x").kind, "unchanged");
  });

  test("unknown NUMERIC phase → phaseName is the STRING form (route schema requires string)", () => {
    const r = summarizeStateProgress(mk(8, "x"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phaseName, "8");
    assert.equal(typeof r.phaseName, "string");
    assert.equal(typeof r.phase, "string");
  });

  test("lens F1: a runaway phase string is capped — phase AND phaseName never exceed MAX_PHASE_LEN", () => {
    const huge = "z".repeat(1_000_000);
    const r = summarizeStateProgress(mk(huge, "ok"), "", 0, "");
    assert.equal(r.kind, "update");
    if (r.kind !== "update") return;
    assert.equal(r.phase.length, MAX_PHASE_LEN);
    assert.equal(r.phaseName.length, MAX_PHASE_LEN);
  });

  test("lens F2: missing / null / empty phase → malformed, never a blank current_phase write", () => {
    // Old code emitted current_phase: undefined (stripped by JSON.stringify —
    // silently load-bearing: the DB column kept its last good value). The v3
    // String() normalization would have BLANKED it. Must be malformed instead.
    const missingPhase = { phase_status: "heartbeat poll 7" } as unknown as PipelineState;
    assert.equal(summarizeStateProgress(missingPhase, "5.5", 70, "x").kind, "malformed");
    assert.equal(summarizeStateProgress(mk(null, "hb"), "5.5", 70, "x").kind, "malformed");
    assert.equal(summarizeStateProgress(mk("", "hb"), "5.5", 70, "x").kind, "malformed");
  });
});

// ── makeStateSync behavioral contract (S199 Gemini CRITICAL ×2) ──────

describe("makeStateSync — throttle / revert-on-failure / stop-flush", () => {
  const JOB = { id: "test-job-1" } as ResearchJob;

  function harness() {
    let nowMs = 100_000;
    let result: StateReadResult = { kind: "absent" };
    let failCount = 0;
    let gatesToArm = 0;
    const releases: Array<() => void> = [];
    const stats = { attempts: 0 };
    const events: string[] = [];
    const calls: Array<{ current_phase: string; phase_status: string; progress_pct: number }> = [];
    const sync = makeStateSync(JOB, "wd-irrelevant", {
      readState: async () => result,
      update: async (_id, patch) => {
        stats.attempts++;
        events.push(`start:${patch.current_phase}`);
        if (failCount > 0) {
          failCount--;
          events.push(`fail:${patch.current_phase}`);
          throw new Error("simulated supabase 502");
        }
        if (gatesToArm > 0) {
          gatesToArm--;
          await new Promise<void>((res) => {
            releases.push(res);
          });
        }
        calls.push(patch); // pushed at PATCH completion → calls order == DB landing order
        events.push(`end:${patch.current_phase}`);
      },
      now: () => nowMs,
    });
    return {
      sync,
      calls,
      stats,
      events,
      setState: (phase: unknown, status: unknown) => {
        result = { kind: "ok", state: mk(phase, status), path: "wd/state.json" };
      },
      setResult: (r: StateReadResult) => {
        result = r;
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
      failNext: (n: number) => {
        failCount = n;
      },
      gateNext: (n: number) => {
        gatesToArm = n;
      },
      release: () => {
        releases.shift()?.();
      },
    };
  }

  /** Flush pending microtasks (one macrotask turn). */
  const settle = () => new Promise<void>((r) => setImmediate(r));

  test("status-update inside the 30s window is deferred, then lands with the LATEST text", async () => {
    const h = harness();
    h.setState("5.5", "poll 1");
    await h.sync.syncOnce(true); // phase transition "" → 5.5: unthrottled write 1
    assert.equal(h.calls.length, 1);

    h.advance(5_000);
    h.setState("5.5", "poll 2");
    await h.sync.syncOnce(true); // 5s since write 1 → throttled, no write
    assert.equal(h.calls.length, 1);

    h.advance(SAME_PHASE_STATUS_MIN_INTERVAL_MS - 4_000); // now 31s past write 1
    await h.sync.syncOnce(true); // window open → deferred text lands
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].phase_status, "poll 2");
    assert.equal(h.calls[1].current_phase, "Studio Products");
    assert.equal(h.calls[1].progress_pct, 70);
  });

  test("stop-flush (throttled=false) bypasses the window so a dying message lands (C-2)", async () => {
    const h = harness();
    h.setState("5.5", "poll 1");
    await h.sync.syncOnce(true);
    assert.equal(h.calls.length, 1);

    h.advance(10_000);
    h.setState("5.5", "Fatal error: context length exceeded");
    await h.sync.syncOnce(true); // throttled tick — deferred
    assert.equal(h.calls.length, 1);

    await h.sync.syncOnce(false); // the stop() flush
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].phase_status, "Fatal error: context length exceeded");
  });

  test("failed phase-transition PATCH reverts dedupe state and retries next pass (C-1)", async () => {
    const h = harness();
    h.setState("6", "evaluating");
    h.failNext(1);
    await h.sync.syncOnce(true); // attempt 1 fails — state reverted
    assert.equal(h.stats.attempts, 1);
    assert.equal(h.calls.length, 0);

    h.advance(5_000);
    await h.sync.syncOnce(true); // unthrottled retry succeeds
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].current_phase, "Vendor Evaluation");
    assert.equal(h.calls[0].progress_pct, 85);

    h.advance(5_000);
    await h.sync.syncOnce(true); // no duplicate after success
    assert.equal(h.calls.length, 1);
  });

  test("failed status-update PATCH retries but stays 30s-paced (clock deliberately not reverted)", async () => {
    const h = harness();
    h.setState("5.5", "poll 1");
    await h.sync.syncOnce(true); // write 1 ok
    assert.equal(h.calls.length, 1);

    h.advance(31_000);
    h.setState("5.5", "poll 2");
    h.failNext(1);
    await h.sync.syncOnce(true); // window open, attempt fails, text reverted
    assert.equal(h.stats.attempts, 2);
    assert.equal(h.calls.length, 1);

    h.advance(5_000); // 5s since the failed stamp → still throttled (bounded retry)
    await h.sync.syncOnce(true);
    assert.equal(h.stats.attempts, 2);

    h.advance(26_000); // 31s since the failed stamp → retry lands
    await h.sync.syncOnce(true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].phase_status, "poll 2");
  });

  test("absent / io-error / corrupt / unchanged / empty flush → no PATCH, no throw", async () => {
    const h = harness();
    h.setResult({ kind: "absent" });
    await h.sync.syncOnce(true);
    h.setResult({ kind: "io-error", error: new Error("EBUSY") });
    await h.sync.syncOnce(true);
    h.setResult({ kind: "corrupt", error: new Error("bad json"), path: "p" });
    await h.sync.syncOnce(true);
    assert.equal(h.calls.length, 0);

    h.setState("5", "running");
    await h.sync.syncOnce(true); // update → write 1
    await h.sync.syncOnce(true); // unchanged
    await h.sync.syncOnce(false); // flush with nothing pending → no extra write
    assert.equal(h.calls.length, 1);
  });

  // ── Pass serialization (S199 Codex MAJOR-1 / MAJOR-2) ──────────────

  test("Codex MAJOR-1 counterexample: a slow phase-5 PATCH cannot be outrun by a later phase-6 pass", async () => {
    const h = harness();
    h.setState("5", "draft");
    h.gateNext(1);
    const p1 = h.sync.syncOnce(true); // starts; its PATCH hangs at the gate
    await settle();
    assert.deepEqual(h.events, ["start:Synthesis"]);

    h.setState("6", "evaluating");
    const p2 = h.sync.syncOnce(true); // chained: must not even START until p1 settles
    await settle();
    assert.deepEqual(h.events, ["start:Synthesis"], "second pass ran while first was in flight");

    h.release(); // phase-5 PATCH completes
    await p1;
    await p2;
    assert.deepEqual(h.events, [
      "start:Synthesis",
      "end:Synthesis",
      "start:Vendor Evaluation",
      "end:Vendor Evaluation",
    ]);
    // Landing order == chain order: the row ends on the NEWER phase, never
    // regressed by a late-resolving older PATCH.
    assert.deepEqual(
      h.calls.map((c) => c.current_phase),
      ["Synthesis", "Vendor Evaluation"],
    );
  });

  test("Codex MAJOR-2 contract: the flush is serialized behind an in-flight pass and resolves only after its own PATCH", async () => {
    const h = harness();
    h.setState("5.5", "poll 1");
    h.gateNext(1);
    const p1 = h.sync.syncOnce(true); // hangs at the PATCH
    await settle();

    h.setState("5.5", "Fatal error: dying words");
    const flush = h.sync.syncOnce(false);
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });
    await settle();
    assert.equal(flushSettled, false, "flush resolved while a pass was still in flight");
    assert.equal(h.calls.length, 0);

    h.release();
    await p1;
    await flush;
    // The flush read the NEWEST text (after p1 settled) and bypassed the window.
    assert.deepEqual(
      h.calls.map((c) => c.phase_status),
      ["poll 1", "Fatal error: dying words"],
    );
  });

  test("a rejecting pass does not wedge the chain — subsequent passes still run", async () => {
    const h = harness();
    // Violate readState's never-throw contract deliberately (null.kind throws).
    h.setResult(null as unknown as StateReadResult);
    await assert.rejects(h.sync.syncOnce(true));
    h.setState("5", "running");
    await h.sync.syncOnce(true);
    assert.equal(h.calls.length, 1);
  });

  test("lens F4: a failed flush PATCH reverts, and the immediate second unthrottled pass lands the dying text", async () => {
    const h = harness();
    h.setState("5.5", "poll 1");
    await h.sync.syncOnce(true); // write 1
    assert.equal(h.calls.length, 1);

    h.advance(10_000);
    h.setState("5.5", "ERROR: PUBLISH fail-closed — dying words");
    h.failNext(1);
    await h.sync.syncOnce(false); // flush shot 1: PATCH fails → dedupe reverted
    assert.equal(h.calls.length, 1);

    await h.sync.syncOnce(false); // flush shot 2 (stop()'s retry): re-seen → lands
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].phase_status, "ERROR: PUBLISH fail-closed — dying words");
  });

  test("lens INFO: a SYNCHRONOUSLY-throwing update seam still reverts (try/catch, not .catch)", async () => {
    let callNo = 0;
    const landed: string[] = [];
    const sync = makeStateSync(JOB, "wd-irrelevant", {
      readState: async () =>
        ({ kind: "ok", state: mk("5", "x"), path: "p" }) as StateReadResult,
      update: ((_id: string, patch: { current_phase: string }) => {
        if (callNo++ === 0) throw new Error("synchronous throw, not a rejection");
        landed.push(patch.current_phase);
        return Promise.resolve();
      }) as unknown as StateSyncDeps["update"],
      now: () => 0,
    });
    await sync.syncOnce(true); // must not escape as an unhandled throw; must revert
    assert.deepEqual(landed, []);
    await sync.syncOnce(true); // revert made the transition re-seen → retried
    assert.deepEqual(landed, ["Synthesis"]);
  });
});
