import * as fs from "node:fs/promises";
import { updateJob } from "../api-client.js";
import { readPipelineState } from "./read-state-file.js";
import { findStateFile } from "./find-state-file.js";
import { obligedProducts } from "./studio-completeness.js";
import { pickWinners } from "./studio-winner.js";
import type { PipelineState, ResearchJob, SelectedProducts } from "../types.js";

// Phase number → { name, progressPct } mapping from /research-compare
const PHASE_MAP: Record<string, { name: string; pct: number }> = {
  "0":   { name: "Preflight",           pct: 5 },
  "0.5": { name: "Research Brief",      pct: 8 },
  "1":   { name: "Perplexity Research", pct: 15 },
  "1.5": { name: "CI Tier 1 Scoring",   pct: 25 },
  "2":   { name: "NotebookLM Import",   pct: 30 },
  "3":   { name: "NotebookLM Research", pct: 40 },
  "4":   { name: "Extraction",          pct: 50 },
  "5":   { name: "Synthesis",           pct: 60 },
  "5.5": { name: "Studio Products",     pct: 70 },
  "6":   { name: "Vendor Evaluation",   pct: 85 },
  "7":   { name: "Finalization",        pct: 95 },
};

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}

// ── State file watcher ──────────────────────────────────────────────

export interface StateWatcher {
  stop: () => void;
}

// ── State-field coercion safety (S166/S168) ─────────────────────────
// state.json is JSON.parsed from an UNTRUSTED child-written file, so a field's
// runtime value is NOT guaranteed to match its declared PipelineState type. A
// JSON-representable non-null object (e.g. {"toString":null}, [], {}) passes a
// structural "is an object" check but throws "Cannot convert object to
// primitive value" the moment it is coerced — String(x), `${x}`, or MAP[x].
// These two pure/total helpers are the single source for that defense; every
// state-field coercion site routes through them. (Codex MERGE CRITICAL, S166.)

/**
 * True iff `v` is a non-null object (incl. arrays) — i.e. NOT a primitive — so
 * String(v) / `${v}` / MAP[v] would risk throwing. Pure, never throws.
 */
export function isNonPrimitiveStateField(v: unknown): boolean {
  return typeof v === "object" && v !== null;
}

/**
 * The recovery-eligible notebook id, or null. ONLY a non-empty STRING is a
 * usable recovery target: a non-string notebook_id (object/number/null) must
 * fail CLOSED — never be laundered into a success verdict (fail-OPEN) — and a
 * non-coercible object must never reach a log-line template. Pure, never throws.
 */
export function recoverableNotebookId(state: PipelineState | null): string | null {
  const id: unknown = state?.notebook_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Discriminated outcome of summarizing an OK-parsed state into a progress
 * update. "malformed" = the parsed JSON object's phase/phase_status are not
 * usable primitives (see summarizeStateProgress). "status-update" = same
 * (phase, pct) but the phase_status TEXT changed — the caller throttles these
 * (they can recur every poll tick), unlike phase-transition "update"s. */
export type ProgressSummary =
  | { kind: "malformed"; detail: string }
  | { kind: "unchanged" }
  | { kind: "update"; phase: string; phaseName: string; pct: number; phaseStatus: string }
  | { kind: "status-update"; phase: string; phaseName: string; pct: number; phaseStatus: string };

/**
 * Pure + total: map an OK-parsed state to a progress-update decision. NEVER
 * throws — returns "malformed" when phase/phase_status are not primitives.
 *
 * readPipelineState guarantees the parsed value is a JSON OBJECT, but NOT that
 * its FIELDS are primitives. A JSON-representable object like
 * `{"phase":{"toString":null}}` throws "Cannot convert object to primitive
 * value" on PHASE_MAP key coercion (and a non-primitive phase_status throws on
 * string interpolation). In watchStateFile's async setInterval such a throw
 * would escape as an UNHANDLED REJECTION rather than the intended corrupt-state
 * log — the old whole-tick try/catch silently swallowed it; this guard restores
 * that safety while still surfacing it as a (deduped) signal. (Codex MERGE
 * CRITICAL, S166.) Exported for unit testing.
 *
 * S199 F2: dedupe used to key on (phase, pct) only, so same-phase changes to
 * the phase_status TEXT never reached the DB — the process page sat on a
 * ~50-min-stale label through an entire Studio render (run 8bcd4644) even
 * though state.json was fresh. A same-(phase, pct) state whose phase_status
 * differs from lastPhaseStatus is now its own "status-update" kind so the
 * caller can sync it WITH throttling (status text can change every tick;
 * phase transitions can't).
 */
export function summarizeStateProgress(
  state: PipelineState,
  lastPhase: string,
  lastPct: number,
  lastPhaseStatus: string,
): ProgressSummary {
  const phase: unknown = state.phase;
  const phaseStatus: unknown = state.phase_status;
  if (isNonPrimitiveStateField(phase) || isNonPrimitiveStateField(phaseStatus)) {
    return { kind: "malformed", detail: "phase/phase_status is not a primitive" };
  }
  const phaseKey = phase as string;
  const mapped = PHASE_MAP[phaseKey];
  const pct = mapped?.pct ?? lastPct;
  const phaseName = mapped?.name ?? phaseKey;
  if (phaseKey === lastPhase && pct === lastPct) {
    if ((phaseStatus as string) === lastPhaseStatus) {
      return { kind: "unchanged" };
    }
    return {
      kind: "status-update",
      phase: phaseKey,
      phaseName,
      pct,
      phaseStatus: phaseStatus as string,
    };
  }
  return {
    kind: "update",
    phase: phaseKey,
    phaseName,
    pct,
    phaseStatus: phaseStatus as string,
  };
}

// Same-phase status-text writes are throttled to one per this window; phase
// TRANSITIONS are never throttled. 30s matches the cadence of the slash
// prompt's Studio-poll heartbeat (which rewrites state.json phase_status
// ~every 30s without moving phase) while bounding Supabase PATCH traffic to
// ≤2 writes/min per job against the 5s poll tick. (S199 F2)
const SAME_PHASE_STATUS_MIN_INTERVAL_MS = 30_000;

export function watchStateFile(job: ResearchJob, workDir: string): StateWatcher {
  let lastPhase = "";
  let lastPct = 0;
  let lastPhaseStatus = "";
  let lastProgressWriteMs = 0;
  let stopped = false;
  // Dedupe: a present-but-unusable state file (unparseable OR a JSON object with
  // non-primitive phase/phase_status) is logged ONCE per bad episode — the 5s
  // poll would otherwise spam every tick. Re-armed after the next usable parse.
  let loggedCorrupt = false;

  const noteCorrupt = (detail: string) => {
    if (!loggedCorrupt) {
      loggedCorrupt = true;
      log(job.id, `state.json present but unusable — progress sync paused: ${detail}`);
    }
  };

  const interval = setInterval(async () => {
    if (stopped) return;

    const result = await readPipelineState(workDir);

    // ABSENT (not written yet) and transient IO (file vanished/locked between
    // find and read, or workdir not yet enumerable) are EXPECTED during a live
    // run — ignore and retry on the next tick.
    if (result.kind === "absent" || result.kind === "io-error") return;

    if (result.kind === "corrupt") {
      noteCorrupt(
        result.error instanceof Error ? result.error.message : String(result.error),
      );
      return;
    }

    // kind === "ok": the helper guarantees a JSON object but NOT primitive
    // fields; summarizeStateProgress is total and flags a non-primitive
    // phase/phase_status as "malformed" instead of throwing inside this async
    // interval (Codex MERGE CRITICAL, S166).
    const summary = summarizeStateProgress(result.state, lastPhase, lastPct, lastPhaseStatus);
    if (summary.kind === "malformed") {
      noteCorrupt(summary.detail);
      return;
    }

    loggedCorrupt = false; // re-arm: a usable state parsed cleanly this tick
    if (summary.kind === "update") {
      lastPhase = summary.phase;
      lastPct = summary.pct;
      lastPhaseStatus = summary.phaseStatus;
      lastProgressWriteMs = Date.now();

      log(job.id, `Phase: ${summary.phaseName} (${summary.pct}%) — ${summary.phaseStatus}`);

      await updateJob(job.id, {
        current_phase: summary.phaseName,
        phase_status: summary.phaseStatus,
        progress_pct: summary.pct,
      }).catch((err) => {
        log(job.id, `Failed to update progress: ${err}`);
      });
    } else if (summary.kind === "status-update") {
      // Throttled tick: return WITHOUT recording the new text, so the change
      // is re-seen next tick and lands once the window opens — deferred, not
      // dropped (only the latest text is ever written).
      if (Date.now() - lastProgressWriteMs < SAME_PHASE_STATUS_MIN_INTERVAL_MS) return;
      lastPhaseStatus = summary.phaseStatus;
      lastProgressWriteMs = Date.now();

      log(job.id, `Status: ${summary.phaseStatus}`);

      // All three fields, not phase_status alone: the phase-transition PATCH
      // above is best-effort (.catch → log), so a failed one would otherwise
      // leave a stale current_phase/progress_pct beside fresh status text.
      await updateJob(job.id, {
        current_phase: summary.phaseName,
        phase_status: summary.phaseStatus,
        progress_pct: summary.pct,
      }).catch((err) => {
        log(job.id, `Failed to update progress: ${err}`);
      });
    }
  }, 5_000);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

// findStateFile() moved to ./lib/find-state-file.ts (imported above) as a
// shared, tested primitive. It now selects the NEWEST state file by the run
// timestamp embedded in the filename (fs mtime only as a fallback for plain
// names) — the prior "prefer exact state.json, else the FIRST '<x>-state.json'"
// logic returned the OLDEST timestamp in a REUSED workdir and false-failed
// e18e1931 (a completed phase-6 run shadowed by a stale phase-0 state.json). S87.

// ── Pipeline completion verifier (Bug 35) ──────────────────────────

/**
 * S136 Layer 2: read the parsed state.json for a cap-killed run so the recovery
 * branch can synthesize a success verdict + drive enforceStudioCompleteness.
 *
 * Returns null for ALL non-OK outcomes (→ not recovery-eligible, since
 * shouldRecoverAfterDurationKill requires a notebook_id), but now distinguishes
 * them via readPipelineState so a recoverable run is not silently dropped:
 *   - absent   → no state file written; nothing to recover (silent, expected).
 *   - io-error → transient read failure; fail CLOSED, logged.
 *   - corrupt  → present but unparseable; the child is already dead so this is
 *                genuine corruption (not a write race) — fail CLOSED, logged
 *                loudly so a run lost to a malformed state file is visible.
 */
export async function readStateForRecovery(
  job: ResearchJob,
  workDir: string,
): Promise<PipelineState | null> {
  const result = await readPipelineState(workDir);
  switch (result.kind) {
    case "ok":
      return result.state;
    case "absent":
      return null;
    case "io-error": {
      const msg =
        result.error instanceof Error ? result.error.message : String(result.error);
      log(job.id, `readStateForRecovery: state read failed — recovery skipped: ${msg}`);
      return null;
    }
    case "corrupt": {
      const msg =
        result.error instanceof Error ? result.error.message : String(result.error);
      log(
        job.id,
        `readStateForRecovery: state.json present but corrupt — recovery skipped: ${msg}`,
      );
      return null;
    }
  }
}

export interface CompletionVerdict {
  success: boolean;
  reason: string;
  /** Parsed state.json on success — consumed by the PUBLISH gate so the
   * caller doesn't re-read/re-parse the file it was just verified from. */
  state?: PipelineState;
}

export async function verifyPipelineCompletion(workDir: string): Promise<CompletionVerdict> {
  let stateFile: string | null;
  try {
    stateFile = await findStateFile(workDir);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      success: false,
      reason: `Cannot enumerate workDir to locate state.json (IO error after Claude exit): ${msg}`,
    };
  }

  if (!stateFile) {
    return {
      success: false,
      reason: "Claude exited 0 but no state.json was written — cannot verify completion",
    };
  }

  let state: PipelineState;
  try {
    const content = await fs.readFile(stateFile, "utf-8");
    state = JSON.parse(content) as PipelineState;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      reason: `state.json unreadable after Claude exit: ${msg}`,
    };
  }

  // S187 P0-2: attach the parsed state to a NON-complete verdict too, so the
  // executor's flag-gated Gate-A defer interception can read notebook_id + build
  // the success verdict that flows into Gate B WITHOUT re-reading state.json. The
  // pure evaluateCompletion is UNCHANGED (its unit tests are unaffected) — only
  // this async wrapper attaches state on failure. On a non-deferred failure the
  // executor fails before Gate B, so the attached state is inert there.
  const verdict = evaluateCompletion(state);
  return verdict.success ? verdict : { ...verdict, state };
}

/**
 * Pure + total: decide pipeline completion from a parsed state. NEVER throws.
 *
 * state.json is parsed from an UNTRUSTED child-written file, so phase /
 * phase_status are not guaranteed to be the primitives PipelineState declares.
 * A non-null object (e.g. {"phase":{"toString":null}}) throws "Cannot convert
 * object to primitive value" on the String()/`${}`/PHASE_MAP[] coercions below,
 * and a non-string phase_status throws on .slice(). Both are treated as a
 * malformed (NOT-complete) state and fail CLOSED — never thrown, never a false
 * success. The parsed value ITSELF may also be a non-object — the literal `null`
 * (JSON.parse("null") returns null, NOT a throw), a primitive, or an array — so
 * a top-level guard runs first; otherwise `state.phase` would null-deref and
 * escape on the sync path (bypassing failJob → orphaned job). Extracted from
 * verifyPipelineCompletion + exported for unit testing. (S168, mirrors the S166
 * summarizeStateProgress guard.)
 */
export function evaluateCompletion(state: PipelineState): CompletionVerdict {
  // state.json may JSON.parse to a non-object (the literal `null`, a primitive,
  // or an array) — declared type PipelineState is a runtime lie. Guard FIRST so
  // `state.phase` below can't null-deref and a non-object can't slip through.
  // Fail CLOSED (malformed) — keeps the function total. (Gemini MERGE CRITICAL, S168.)
  const s: unknown = state;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    return {
      success: false,
      reason: "state.json malformed after Claude exit: parsed value is not a JSON object",
    };
  }
  if (isNonPrimitiveStateField(state.phase) || isNonPrimitiveStateField(state.phase_status)) {
    return {
      success: false,
      reason: "state.json malformed after Claude exit: phase/phase_status is not a primitive value",
    };
  }

  const phaseRaw = state.phase;
  const phaseStr = String(phaseRaw).trim().toLowerCase();
  const phaseNum = parseFloat(phaseStr);
  const phaseStatusStr = String(state.phase_status ?? "").trim().toLowerCase();
  const ALLOWED = new Set(["7", "complete", "finalized", "finalised", "done"]);
  const COMPLETE_AUGMENTED = /^complete[\s\-:(]/;
  const isComplete =
    ALLOWED.has(phaseStr) ||
    (Number.isFinite(phaseNum) && phaseNum >= 7) ||
    phaseStatusStr === "complete" ||
    COMPLETE_AUGMENTED.test(phaseStatusStr);

  if (!isComplete) {
    const phaseLabel = PHASE_MAP[String(phaseRaw)]?.name ?? String(phaseRaw);
    const status = String(state.phase_status ?? "(empty)").slice(0, 200);
    return {
      success: false,
      reason: `Pipeline stopped at phase ${phaseRaw} (${phaseLabel}); expected phase_status="complete" OR phase>=7 (Finalization). phase_status: "${status}"`,
    };
  }

  return {
    success: true,
    reason: `Pipeline reached terminal state (phase ${phaseRaw}, phase_status: "${phaseStatusStr}")`,
    state,
  };
}

/**
 * S187 P0-2 — the 5 research-text DELIVERABLES (design G11). `context` (pipeline
 * INPUT) and `state` (internal state file) are EXCLUDED — their absence is not a
 * deliverable gap. `report` is a STUDIO product, not research-text.
 */
const RESEARCH_TEXT_ROLES = [
  "brief",
  "perplexity",
  "comparison",
  "vendor-evaluation",
  "notebooklm",
] as const;

export interface VideoDeferProbeInput {
  /** state.notebook_id — required present (else nothing is NLM-recoverable). */
  notebookId: string | null | undefined;
  /** Deliverable files in Projects/<slug>/ as {name,size}; the probe filters 0-byte. */
  entries: Array<{ name: string; size: number }>;
  /** DURABLE DB obligation (job.selected_products), never the LLM-written state. */
  selected: SelectedProducts | null | undefined;
  /**
   * evaluatePublishGateForJob(...).ok — TRUE for non-publish jobs. Computed by the
   * caller (it holds the job + the pre-spawn bypass snapshot); kept out of this
   * pure probe so it stays trivially unit-testable.
   */
  publishOk: boolean;
}

export interface VideoDeferProbeResult {
  defer: boolean;
  reason: string;
}

/**
 * S187 P0-2 — the Gate-A DELIVERABLE-PRESENCE probe (design §5.1; Gemini C-1 /
 * Codex M-6/M-8). Pure + total. Decides whether a phase-non-complete run is the
 * "ONLY the Studio video is still missing" case that may DEFER to Gate B's render
 * classification — vs a genuine crash that must stay terminal. Defers ONLY when
 * EVERY check holds:
 *   1. notebook_id present (the video is recoverable from NLM at all);
 *   2. publish gate satisfied (publish jobs) — never best-effort a FAILED publish;
 *   3. video is a SELECTED obligation (else not a render case);
 *   4. EVERY non-video selected studio product present non-empty (a non-video
 *      studio gap = crash → terminal, the Gemini C-1 fail-open);
 *   5. the video itself is absent (else nothing to defer);
 *   6. EVERY research-text deliverable present non-empty (a missing research doc =
 *      phase-2/6 crash → terminal — the exact fail-open Gemini C-1 flagged).
 * The CALLER (executor) must already have run terminal-error classification + the
 * dark-launch flag check; this probe assumes neither and NEVER trusts the
 * LLM-written phase — only durable signals (DB obligation + on-disk deliverables
 * + the publish verdict).
 */
export function shouldDeferForVideoRender(
  input: VideoDeferProbeInput,
): VideoDeferProbeResult {
  const { notebookId, entries, selected, publishOk } = input;
  if (typeof notebookId !== "string" || notebookId.length === 0) {
    return {
      defer: false,
      reason: "no notebook_id — a still-rendering video is not recoverable",
    };
  }
  if (!publishOk) {
    return {
      defer: false,
      reason: "publish gate not satisfied — terminal, never best-effort",
    };
  }
  const obliged = obligedProducts(selected);
  if (!obliged.includes("video")) {
    return {
      defer: false,
      reason: "video is not a selected product — not a render-defer case",
    };
  }
  const nonEmpty = entries.filter((e) => e.size > 0);
  const winners = pickWinners(nonEmpty.map((e) => ({ name: e.name })));
  const missingNonVideoStudio = obliged.filter((p) => p !== "video" && !winners[p]);
  if (missingNonVideoStudio.length > 0) {
    return {
      defer: false,
      reason: `non-video studio product(s) missing: ${missingNonVideoStudio.join(", ")} — terminal (not a clean video-only gap)`,
    };
  }
  if (winners["video"]) {
    return { defer: false, reason: "video already on disk — no defer needed" };
  }
  const missingResearch = RESEARCH_TEXT_ROLES.filter(
    (role) => !nonEmpty.some((e) => e.name.endsWith(`-${role}.md`)),
  );
  if (missingResearch.length > 0) {
    return {
      defer: false,
      reason: `research deliverable(s) missing: ${missingResearch.join(", ")} — terminal (phase crash, never best-effort)`,
    };
  }
  return {
    defer: true,
    reason:
      "only the Studio video is missing; all non-video studio + research deliverables present, publish gate satisfied — defer to render classification",
  };
}
