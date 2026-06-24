/**
 * S158 — tests for the decoupled studio-recovery sweep.
 *
 * Covers (design §13): re-confirm status_id 3 → download-by-id → finalize →
 * completed (recovered); partial (still-failing download) → retry; artifact-gone
 * (re-list no longer status_id 3) → exhausted fast; absent/NULL payload →
 * safe-degrade to exhausted; the attempts-GATED age cap (a clock past MAX_AGE
 * with attempts < MIN does NOT exhaust — Codex MAJOR-1); the trigger-immune
 * first_failed_at anchor (retry PATCHes never re-write it — G6); the
 * attempt-cap → one alert; and the shorter sweep download timeout (Codex
 * MAJOR-2). Decoupling: the sweep processes a due candidate purely from
 * fetchDueCandidate, with NO dependency on any job claim (Gemini CRITICAL-1).
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-recovery-sweep.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runStudioRecoverySweepOnce,
  maybeRunStudioRecoverySweep,
  studioRecoveryBackoffMs,
  type RecoveryCandidate,
  type RecoverySweepDeps,
} from "../lib/studio-recovery-sweep.js";
import type { DownloadResult } from "../lib/studio-completeness.js";
import type { FinalizeArgs, FinalizeResult } from "../scripts/finalize-recovered-run.js";

const JOB = "22222222-2222-2222-2222-222222222222";
const NB = "ca4561a0-a1df-40d6-a9da-f0efaad432af";
const NOW = 2_000_000_000_000; // fixed clock
const HOUR = 3_600_000;
const VID = { product: "video", artifactId: "vid-1", nlmType: "video", filename: "x-20260615-190502-video.mp4" };

function candidate(over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    id: JOB,
    topic: "Arrowhead",
    topic_slug: "arrowhead-abc123",
    notify_email: "user@example.com",
    organization_id: "org-1",
    studio_recovery_attempts: 1,
    studio_recovery_first_failed_at: new Date(NOW - HOUR).toISOString(), // 1h ago
    studio_recovery_payload: { notebookId: NB, products: [VID] },
    ...over,
  };
}

const AUD = { product: "audio", artifactId: "aud-1", nlmType: "audio", filename: "x-20260615-190502-audio.mp3" };

interface Harness {
  deps: RecoverySweepDeps;
  patches: Record<string, unknown>[];
  patchedIds: string[];
  finalizeCalls: FinalizeArgs[];
  downloads: Array<{ id: string; timeoutMs?: number }>;
  emails: { completed: number; failed: number; exhausted: number };
  /** S161 R2-1: dirs the sweep asked removeOrphanParts to clean. */
  removeOrphanDirs: string[];
}

function harness(over: {
  candidate?: RecoveryCandidate | null;
  malformedPending?: RecoveryCandidate[];
  listArtifacts?: RecoverySweepDeps["listArtifacts"];
  isFilePresent?: RecoverySweepDeps["isFilePresent"];
  downloadResult?: DownloadResult;
  finalizeResult?: FinalizeResult;
  /** S162: make the finalize dep THROW (simulate a Supabase/storage transport
   *  reject inside finalizeRecoveredRun's un-try/caught fetch/upload deps). */
  finalizeThrows?: boolean | Error;
  /** S162 (Codex grounded BLOCK): make the downloadArtifact dep THROW (simulate the
   *  arg-validation spawnSync('') throw from a blank NLM_BIN escaping realDownloadArtifact). */
  downloadThrows?: boolean | Error;
  patchOk?: boolean;
  now?: number;
} = {}): Harness {
  const patches: Record<string, unknown>[] = [];
  const patchedIds: string[] = [];
  const finalizeCalls: FinalizeArgs[] = [];
  const downloads: Array<{ id: string; timeoutMs?: number }> = [];
  const emails = { completed: 0, failed: 0, exhausted: 0 };
  const removeOrphanDirs: string[] = [];
  const cand = over.candidate === undefined ? candidate() : over.candidate;
  const deps: RecoverySweepDeps = {
    fetchDueCandidate: async () => cand,
    removeOrphanParts: async (dir) => {
      removeOrphanDirs.push(dir);
    },
    fetchMalformedPending: async () => over.malformedPending ?? [],
    isFilePresent: over.isFilePresent ?? (async () => false),
    listArtifacts:
      over.listArtifacts ??
      ((_nb, type) => (type === "video" ? [{ id: "vid-1", title: "X", created_at: "2026-06-15T19:34:36" }] : [])),
    downloadArtifact: async (_nb, id, _type, _out, timeoutMs) => {
      downloads.push({ id, timeoutMs });
      if (over.downloadThrows) {
        throw over.downloadThrows instanceof Error
          ? over.downloadThrows
          : new TypeError("The argument 'file' cannot be empty. Received ''");
      }
      return over.downloadResult ?? { ok: true };
    },
    finalize: async (args) => {
      finalizeCalls.push(args);
      if (over.finalizeThrows) {
        throw over.finalizeThrows instanceof Error
          ? over.finalizeThrows
          : new Error("fetch failed: ECONNRESET (simulated transport reject)");
      }
      return over.finalizeResult ?? { ok: true, uploaded: 2, skipped: 0, failed: 0 };
    },
    patchRecovery: async (jobId, body) => {
      patchedIds.push(jobId);
      patches.push(body);
      return over.patchOk ?? true;
    },
    sendCompleted: async () => {
      emails.completed++;
    },
    sendFailed: async () => {
      emails.failed++;
    },
    sendExhaustedAlert: async () => {
      emails.exhausted++;
    },
    projectsDir: "/projects",
    now: () => over.now ?? NOW,
    log: () => {},
  };
  return { deps, patches, patchedIds, finalizeCalls, downloads, emails, removeOrphanDirs };
}

describe("runStudioRecoverySweepOnce", () => {
  test("no due candidate → ran:false", async () => {
    const h = harness({ candidate: null });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.ran, false);
  });

  test("happy path: confirmed status_id 3 + download ok → finalize → RECOVERED", async () => {
    const h = harness();
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "recovered");
    assert.equal(h.finalizeCalls.length, 1);
    assert.equal(h.finalizeCalls[0].status, "completed");
    // workDir = path.join(projectsDir, slug) — separator is platform-specific
    // (matches the executor's exact path construction). Assert the slug suffix.
    assert.match(h.finalizeCalls[0].workDir, /[/\\]arrowhead-abc123$/);
    assert.equal(h.finalizeCalls[0].extraPatch?.studio_recovery_status, "recovered");
    assert.equal(h.emails.completed, 1, "requester gets the completion email on heal");
    assert.equal(h.emails.failed, 0);
    // Shorter sweep download timeout (Codex MAJOR-2): a real, sub-in-gate value.
    assert.equal(typeof h.downloads[0].timeoutMs, "number");
    assert.ok(h.downloads[0].timeoutMs! > 0 && h.downloads[0].timeoutMs! < 300_000);
  });

  test("S161 R2-1: orphan `.part` cleanup runs for the candidate dir before processing", async () => {
    // The sweep asks removeOrphanParts to clean the per-candidate deliverables dir
    // (path.join(projectsDir, slug)) so a temp left by a kill mid-spawn or the
    // artifact-gone branch can't accumulate. Sensitivity: dropping the call leaves
    // removeOrphanDirs empty.
    const h = harness();
    await runStudioRecoverySweepOnce(h.deps);
    assert.equal(h.removeOrphanDirs.length, 1, "removeOrphanParts called once for the candidate");
    assert.match(h.removeOrphanDirs[0], /[/\\]arrowhead-abc123$/);
  });

  test("partial: download still failing transiently → RETRY (bump attempts, schedule next)", async () => {
    const h = harness({ downloadResult: { ok: false, exitCode: 1, stderr: "HTTP 503", signal: null } });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "retry");
    assert.equal(h.finalizeCalls.length, 0, "no finalize when a product is still missing");
    assert.equal(h.patches.length, 1);
    assert.equal(h.patches[0].studio_recovery_attempts, 2); // 1 → 2
    assert.ok(h.patches[0].studio_recovery_next_attempt_at, "next attempt scheduled");
    // G6: the immutable age anchor is NEVER re-written by a retry PATCH.
    assert.equal(
      "studio_recovery_first_failed_at" in h.patches[0],
      false,
      "retry must NOT touch studio_recovery_first_failed_at (trigger-immune anchor)",
    );
    assert.equal(h.emails.failed, 0);
    assert.equal(h.emails.exhausted, 0);
  });

  test("artifact-gone: re-list no longer status_id 3 → EXHAUSTED fast (no download)", async () => {
    const h = harness({
      listArtifacts: () => [], // artifact no longer present
      downloadResult: { ok: true },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "artifact-gone");
    assert.equal(h.downloads.length, 0, "artifact-gone short-circuits before any download");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
    assert.equal(h.emails.failed, 1);
    assert.equal(h.emails.exhausted, 1);
  });

  test("NULL payload → safe-degrade to EXHAUSTED (payload-missing)", async () => {
    const h = harness({ candidate: candidate({ studio_recovery_payload: null }) });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "payload-missing");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
  });

  // ── S162 (Codex grounded round-2 BLOCK): a MALFORMED payload element ──
  // A row read via service-role can carry `products:[null]` (the migration CHECK only
  // enforces payload IS NOT NULL; the DB jsonb is cast to StudioRecoveryPayload with
  // no runtime validation). The per-element validation must terminalize it as
  // payload-missing — NOT let `productNames = payload.products.map(p=>p.product)`
  // throw OUTSIDE the structural backstop and strand the row forever. Through the
  // outer wrapper (the strand surface). Sensitivity: reverting the per-element
  // validation AND the null-safe productNames re-throws on the .map → {ran:false},
  // empty patches (the strand symptom) — every assertion below fails.
  test("S162 (Codex r2): a malformed payload (products:[null]) → EXHAUSTED (payload-missing), NOT stranded", async () => {
    const h = harness({
      candidate: candidate({
        studio_recovery_payload: {
          notebookId: NB,
          products: [null as unknown as typeof VID],
        },
      }),
    });
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.ran, true, "a malformed payload must terminalize, not silently no-op (strand)");
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "payload-missing");
    assert.equal(h.patches.length, 1, "the exhaust PATCH was written (row terminalized)");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
    assert.equal(h.downloads.length, 0, "no recovery attempt on a malformed payload");
  });

  test("S162 (Codex r2): a partly-malformed payload (one good + one null product) → EXHAUSTED (payload-missing)", async () => {
    // .every() must reject if ANY element is malformed — a mix must not slip through.
    const h = harness({
      candidate: candidate({
        studio_recovery_payload: {
          notebookId: NB,
          products: [VID, null as unknown as typeof VID],
        },
      }),
    });
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "payload-missing");
    assert.equal(h.downloads.length, 0);
  });

  test("age-cap NOT met when attempts < MIN (Codex MAJOR-1): old clock + low attempts → RETRY, not exhaust", async () => {
    // first_failed_at 200h ago (> 48h), but only attempts=1 → newAttempts=2 < 3.
    // Sensitivity: WITHOUT the min-attempts conjunct this would wrongly exhaust.
    const h = harness({
      candidate: candidate({
        studio_recovery_attempts: 1,
        studio_recovery_first_failed_at: new Date(NOW - 200 * HOUR).toISOString(),
      }),
      downloadResult: { ok: false, exitCode: 1, stderr: "HTTP 503", signal: null },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "retry", "a never-really-tried job must survive pure wall-clock age");
    assert.equal(h.emails.exhausted, 0);
  });

  test("age-cap MET: old clock AND attempts >= MIN → EXHAUSTED (age-cap)", async () => {
    const h = harness({
      candidate: candidate({
        studio_recovery_attempts: 3, // → newAttempts=4 >= MIN(3), <= MAX(8)
        studio_recovery_first_failed_at: new Date(NOW - 200 * HOUR).toISOString(),
      }),
      downloadResult: { ok: false, exitCode: 1, stderr: "HTTP 503", signal: null },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "age-cap");
    assert.equal(h.emails.exhausted, 1, "operator alert fires ONCE");
    assert.equal(h.emails.failed, 1, "requester gets the terminal failed email");
  });

  test("attempt-cap: attempts at the cap → EXHAUSTED (attempt-cap), one alert", async () => {
    const h = harness({
      candidate: candidate({ studio_recovery_attempts: 8 }), // → newAttempts=9 > MAX(8)
      downloadResult: { ok: false, exitCode: 1, stderr: "HTTP 503", signal: null },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "attempt-cap");
    assert.equal(h.emails.exhausted, 1);
  });

  test("finalize REFUSAL (obligation guard) is treated as continued-transient, not silent completion", async () => {
    // download succeeds but finalize refuses (a presentBefore product is gone on
    // disk) → must NOT report recovered; bump attempts + retry (the caps backstop).
    const h = harness({
      finalizeResult: { ok: false, refused: true, reason: "obliged product(s) missing on disk: audio", uploaded: 0, skipped: 0, failed: 0 },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "retry");
    assert.equal(h.emails.completed, 0, "a refused finalize must never send the completion email");
    assert.equal(h.patches[0].studio_recovery_attempts, 2);
  });

  // ── S162: a finalize THROW must NOT strand the recovery row (Codex QA r3) ──
  // Tested through the OUTER wrapper maybeRunStudioRecoverySweep — the exact strand
  // surface: pre-fix, a finalize throw escapes runStudioRecoverySweepOnce, the outer
  // try/catch swallows it and returns {ran:false} BEFORE the attempt-bump
  // patchRecovery runs → attempts never bump, caps never trip, the row sits
  // non-terminal forever. Sensitivity: reverting the try/catch makes finalize's throw
  // propagate → {ran:false} + patches empty, failing every assertion below.
  test("S162: a finalize THROW is caught + treated as continued-transient → RETRY (bumps attempts, NOT stranded)", async () => {
    const h = harness({ finalizeThrows: true }); // attempts=1 default; download ok → allPresent → finalize
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(
      r.ran,
      true,
      "a finalize throw must NOT make the sweep silently no-op (the strand symptom)",
    );
    assert.equal(r.outcome, "retry");
    assert.equal(h.finalizeCalls.length, 1, "finalize was actually attempted (and threw)");
    assert.equal(h.emails.completed, 0, "a throwing finalize must never send the completion email");
    assert.equal(h.patches.length, 1, "attempts were bumped — the row is NOT stranded");
    assert.equal(h.patches[0].studio_recovery_attempts, 2, "1 → 2");
    assert.ok(h.patches[0].studio_recovery_next_attempt_at, "next attempt scheduled");
    // G6: a retry PATCH never re-writes the immutable age anchor.
    assert.equal(
      "studio_recovery_first_failed_at" in h.patches[0],
      false,
      "retry must NOT touch studio_recovery_first_failed_at",
    );
    assert.equal(h.emails.exhausted, 0, "a single transient throw is not terminal");
  });

  test("S162: a PERSISTENT finalize THROW still reaches the cap → EXHAUSTED (attempt-cap), never stuck forever", async () => {
    // attempts=8 → newAttempts=9 > MAX(8): on a finalize throw the converted non-ok
    // result flows to the attempt-cap branch → finishExhausted. Sensitivity: pre-fix
    // the throw escapes → {ran:false}, no exhaust PATCH, no alert (assertions fail).
    const h = harness({
      candidate: candidate({ studio_recovery_attempts: 8 }),
      finalizeThrows: new Error("supabase storage upload rejected (persistent outage)"),
    });
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.ran, true);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.exhaustReason, "attempt-cap");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
    assert.equal(h.patches[0].studio_recovery_attempts, 9);
    assert.equal(h.emails.exhausted, 1, "operator alerted exactly once on the terminal exhaust");
    assert.equal(h.emails.failed, 1, "requester gets the terminal failed email");
  });

  // ── S162 (Codex grounded BLOCK): class-closing STRUCTURAL backstop ──
  // Any UNEXPECTED throw from a dep AFTER candidate selection (e.g. the
  // arg-validation spawnSync('') throw from a blank NLM_BIN escaping
  // realListArtifacts/realDownloadArtifact, or any future un-try/caught dep) must NOT
  // strand the row. runStudioRecoverySweepOnce wraps the whole recovery attempt; on
  // any throw it falls through to the cap/bump tail so attempts ALWAYS progress.
  // Tested through the outer wrapper — the strand surface. Sensitivity: removing the
  // structural try/catch lets the throw escape to maybeRunStudioRecoverySweep →
  // {ran:false} + patches empty (every assertion below fails).
  test("S162 backstop: a THROWING listArtifacts (spawnSync('') sibling) → RETRY (bumps attempts, NOT stranded)", async () => {
    const h = harness({
      listArtifacts: () => {
        throw new TypeError("The argument 'file' cannot be empty. Received ''");
      },
    });
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.ran, true, "an unexpected list throw must NOT silently no-op (the strand symptom)");
    assert.equal(r.outcome, "retry");
    assert.equal(h.downloads.length, 0, "no download — the list threw before it");
    assert.equal(h.emails.exhausted, 0, "a single transient throw is not terminal");
    assert.equal(h.patches.length, 1, "attempts bumped — the row is NOT stranded");
    assert.equal(h.patches[0].studio_recovery_attempts, 2, "1 → 2");
    assert.ok(h.patches[0].studio_recovery_next_attempt_at, "next attempt scheduled");
  });

  test("S162 backstop: a THROWING downloadArtifact → RETRY (bumps attempts, NOT stranded)", async () => {
    const h = harness({ downloadThrows: true }); // list returns vid-1 → confirmed → download throws
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.ran, true);
    assert.equal(r.outcome, "retry");
    assert.equal(h.downloads.length, 1, "the download was attempted (and threw)");
    assert.equal(h.emails.completed, 0, "a throwing download must never complete the job");
    assert.equal(h.patches[0].studio_recovery_attempts, 2);
  });

  test("S162 backstop: a PERSISTENT dep THROW still reaches the cap → EXHAUSTED (attempt-cap)", async () => {
    const h = harness({
      candidate: candidate({ studio_recovery_attempts: 8 }), // → newAttempts=9 > MAX(8)
      listArtifacts: () => {
        throw new TypeError("The argument 'file' cannot be empty. Received ''");
      },
    });
    const r = await maybeRunStudioRecoverySweep({ deps: h.deps });
    assert.equal(r.ran, true);
    assert.equal(r.outcome, "exhausted", "a persistently-throwing dep terminalizes via the caps, never stuck forever");
    assert.equal(r.exhaustReason, "attempt-cap");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
    assert.equal(h.emails.exhausted, 1);
  });

  // ── C1: transient artifact-LIST failure must NOT exhaust as artifact-gone ──
  test("C1: listArtifacts returns null (transient CLI fail) → RETRY, never artifact-gone exhaust", async () => {
    // Sensitivity: the bug `listArtifacts(...) ?? []` turned null into [] →
    // stillConfirmed=false → artifact-gone exhaust (a delayed re-creation of S156).
    const h = harness({
      listArtifacts: () => null, // transient list failure
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "retry", "a list blip must retry, not exhaust");
    assert.notEqual(r.exhaustReason, "artifact-gone");
    assert.equal(h.downloads.length, 0, "no download attempted when the list failed");
    assert.equal(h.emails.failed, 0, "no terminal email on a transient list failure");
    assert.equal(h.emails.exhausted, 0);
    assert.equal(h.patches[0].studio_recovery_attempts, 2, "attempts bumped for the retry");
  });

  // ── M5: a pending product already on disk is not re-listed/re-downloaded ──
  test("M5: product already on disk (prior tick) is skipped; partial recovery completes across ticks", async () => {
    // payload = [audio (already on disk, artifact aged out of NLM), video (still
    // pending)]. The bug re-listed audio FIRST → [] → artifact-gone exhaust,
    // losing the already-recovered audio. The fix checks on-disk first → skips
    // audio, recovers video, finalizes (finalize re-asserts the full set on disk).
    const h = harness({
      candidate: candidate({
        studio_recovery_payload: { notebookId: NB, products: [AUD, VID] },
      }),
      isFilePresent: async (p) => p.includes(AUD.filename), // only audio on disk
      listArtifacts: (_nb, type) =>
        type === "video"
          ? [{ id: "vid-1", title: "X", created_at: "2026-06-15T19:34:36" }]
          : [], // audio would be artifact-gone IF it were re-listed
      downloadResult: { ok: true },
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "recovered", "on-disk product is skipped, the rest recovers");
    assert.equal(h.emails.exhausted, 0, "must NOT exhaust on the already-on-disk product");
    assert.equal(h.downloads.length, 1, "only the not-on-disk product is downloaded");
    assert.equal(h.downloads[0].id, "vid-1");
    assert.equal(h.finalizeCalls.length, 1);
  });

  test("M5: ALL pending products already on disk → finalize without any download", async () => {
    const h = harness({
      candidate: candidate({
        studio_recovery_payload: { notebookId: NB, products: [AUD, VID] },
      }),
      isFilePresent: async () => true, // both already recovered on disk
      listArtifacts: () => null, // even a list outage cannot block this — all on disk
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "recovered");
    assert.equal(h.downloads.length, 0, "nothing re-downloaded when all products are on disk");
    assert.equal(h.finalizeCalls.length, 1);
  });

  // ── M4: exhaustion alerts fire ONLY after a successful 'exhausted' PATCH ──
  test("M4: exhaust PATCH fails → NO emails, NOT marked exhausted (no Resend cascade)", async () => {
    // Sensitivity: the bug ignored patchRecovery's boolean and emailed regardless;
    // a 500 on the PATCH left the row pending → every tick re-fired the alerts.
    const h = harness({
      listArtifacts: () => [], // artifact-gone → would exhaust
      patchOk: false, // the exhausted PATCH fails
    });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.notEqual(r.outcome, "exhausted", "a failed exhaust PATCH must not report terminal");
    assert.equal(h.emails.failed, 0, "no requester email when the exhaust latch failed to write");
    assert.equal(h.emails.exhausted, 0, "no operator alert when the exhaust latch failed to write");
    assert.equal(h.patches.length, 1, "the exhaust PATCH was attempted");
  });

  test("M4: exhaust PATCH succeeds → emails fire exactly once", async () => {
    const h = harness({ listArtifacts: () => [], patchOk: true });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.outcome, "exhausted");
    assert.equal(h.emails.failed, 1);
    assert.equal(h.emails.exhausted, 1);
  });

  // ── C3: malformed pending rows are quarantined to exhausted (defense-in-depth) ──
  test("C3: a malformed pending row (invisible to the due query) is quarantined → exhausted + operator alert", async () => {
    // Sensitivity: without the quarantine the malformed row is never touched
    // (patches empty, no alert) and sits non-terminal forever.
    const malformed = candidate({
      id: "33333333-3333-3333-3333-333333333333",
      studio_recovery_first_failed_at: null, // the structural defect
      studio_recovery_payload: null,
    });
    const h = harness({ candidate: null, malformedPending: [malformed] });
    const r = await runStudioRecoverySweepOnce(h.deps);
    assert.equal(r.ran, false, "no due candidate this tick");
    assert.equal(h.patches.length, 1, "the malformed row was patched");
    assert.equal(h.patchedIds[0], "33333333-3333-3333-3333-333333333333");
    assert.equal(h.patches[0].studio_recovery_status, "exhausted");
    assert.equal(h.emails.exhausted, 1, "operator alerted on quarantine");
    assert.equal(h.emails.failed, 0, "no requester email for an integrity quarantine");
  });

  test("C3: malformed-pending quarantine PATCH failure → no alert (retried next tick)", async () => {
    const malformed = candidate({
      id: "44444444-4444-4444-4444-444444444444",
      studio_recovery_attempts: 0, // attempts<1 is also a malformed-pending defect
      studio_recovery_payload: null,
    });
    const h = harness({ candidate: null, malformedPending: [malformed], patchOk: false });
    await runStudioRecoverySweepOnce(h.deps);
    assert.equal(h.patches.length, 1, "quarantine PATCH attempted");
    assert.equal(h.emails.exhausted, 0, "no alert when the quarantine PATCH failed");
  });
});

describe("studioRecoveryBackoffMs", () => {
  test("monotonic non-decreasing and capped", () => {
    const a = studioRecoveryBackoffMs(1);
    const b = studioRecoveryBackoffMs(3);
    const cap1 = studioRecoveryBackoffMs(8);
    const cap2 = studioRecoveryBackoffMs(50);
    assert.ok(a > 0);
    assert.ok(b >= a);
    assert.equal(cap1, cap2, "beyond the schedule length, the backoff is capped");
  });
});
