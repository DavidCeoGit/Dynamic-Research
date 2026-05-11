/**
 * Workflow Conventions Enforcer (S34 first cut — Phase 7 lint gate only).
 *
 * Background: agent/lib/conventions.{ts,json,py} is the SSOT for DATA
 * conventions (filenames, skip rules, content types). But /research-compare's
 * WORKFLOW conventions (find-or-create notebook, post-Studio reconcile, lint
 * before finalize, etc.) live in a 1010-line slash-command markdown prompt
 * with no second source of enforcement. Memory documents the right behavior;
 * the prompt drifts; bugs recur. See feedback_workflow_drift_layer_3_gap.md.
 *
 * This module exposes pipeline-phase checks as callable PhaseCheck functions
 * with structured ok/remediation results. The slash command (Path A in the
 * design doc) calls them at phase boundaries via run-phase-check.ts CLI.
 *
 * S34 ships ONE check — phase-7-lint-gate — as the lowest-risk proof of the
 * interface. Phase 0 find-or-create, Phase 3 source import, and Phase 5.5b
 * post-Studio reconcile are documented in the design doc and remain TODO.
 *
 * Design doc: Documentation/workflow-conventions-enforcer-design.md
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Public types ────────────────────────────────────────────────────

export interface PhaseCheckResult {
  ok: boolean;
  phase: string;
  /** Operator-actionable steps when ok=false. Empty when ok=true. */
  remediation: string[];
  /** Non-blocking advisories regardless of ok. */
  warnings: string[];
  /** Free-form data the caller may persist or surface. */
  context?: Record<string, unknown>;
}

/** Inputs supplied by the pipeline at each phase boundary. */
export interface PipelineContext {
  workDir?: string;
  topic?: string;
  notebookId?: string;
  preStudioSourceCount?: number;
  [key: string]: unknown;
}

export type PhaseCheck = (ctx: PipelineContext) => Promise<PhaseCheckResult>;

// ── Phase 7 — Lint Gate ────────────────────────────────────────────

/**
 * Wraps `agent/scripts/lint-deliverables.ts <workDir> --strict`. Parses the
 * script's stdout to extract violation + warning counts and the per-file
 * error lines, then returns a structured result the slash command (or any
 * other caller) can decide on.
 *
 * Pipeline contract: cannot mark a run `phase: "Complete"` if this check
 * returns ok=false. Mirrors finalize-recovered-run.ts's --strict gate, but
 * usable from anywhere — no Supabase auth required, no DB round-trip.
 */
async function lintDeliverablesCheck(ctx: PipelineContext): Promise<PhaseCheckResult> {
  const phase = "phase-7-lint-gate";

  if (!ctx.workDir || typeof ctx.workDir !== "string") {
    return {
      ok: false,
      phase,
      remediation: ["PipelineContext.workDir (string) is required for phase-7-lint-gate"],
      warnings: [],
    };
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const lintScript = path.join(__dirname, "..", "scripts", "lint-deliverables.ts");

  const result = spawnSync(
    process.execPath,
    ["--import=tsx", lintScript, ctx.workDir, "--strict"],
    { encoding: "utf-8" },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? -1;

  // Parse counts from the lint script's summary lines.
  const errorMatch = stdout.match(/ERRORS \((\d+)\):/);
  const warnMatch = stdout.match(/WARNINGS \((\d+)\):/);
  const violations = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const warnings = warnMatch ? parseInt(warnMatch[1], 10) : 0;

  // Extract per-file violation lines (the lint script prefixes them "  [error] ...").
  const errorLines = stdout
    .split("\n")
    .filter((l) => /^\s+\[error\]/.test(l))
    .map((l) => l.trim());
  const warnLines = stdout
    .split("\n")
    .filter((l) => /^\s+\[warn\]/.test(l))
    .map((l) => l.trim());

  const baseContext: Record<string, unknown> = {
    violations,
    warnings,
    lintExitCode: exitCode,
    lintStdoutTail: stdout.slice(-2000),
  };
  if (stderr.length > 0) baseContext.lintStderrTail = stderr.slice(-1000);

  if (exitCode === 0) {
    return {
      ok: true,
      phase,
      remediation: [],
      warnings: warnings > 0
        ? [`${warnings} non-blocking warning(s):`, ...warnLines]
        : [],
      context: baseContext,
    };
  }

  // Exit 1 = violations; exit 2 = usage error; anything else = spawn failure.
  const remediation: string[] = [];
  if (exitCode === 2) {
    remediation.push(
      `lint-deliverables.ts usage error (exit 2) — workDir may not exist or be unreadable: ${ctx.workDir}`,
    );
    if (stderr.length > 0) remediation.push(`stderr: ${stderr.trim().slice(0, 300)}`);
  } else if (exitCode === 1) {
    remediation.push(`Lint failed: ${violations} error(s) blocking finalize.`);
    remediation.push(...errorLines);
    remediation.push(
      "Fix by renaming files per agent/lib/conventions.json patterns, then re-run the check.",
    );
  } else {
    remediation.push(
      `lint-deliverables.ts exited unexpectedly (code ${exitCode}). Check stderr: ${stderr.trim().slice(0, 300)}`,
    );
  }

  return {
    ok: false,
    phase,
    remediation,
    warnings: warnings > 0
      ? [`${warnings} additional warning(s) present (non-blocking):`, ...warnLines]
      : [],
    context: baseContext,
  };
}

// ── Registry ────────────────────────────────────────────────────────

/**
 * Pipeline-phase checks indexed by canonical name. The slash command (or a
 * future workflow-runner) invokes these at phase boundaries; ok=false means
 * the pipeline cannot proceed.
 *
 * S34 ships only phase-7-lint-gate. Phase 0 find-or-create, Phase 3 source
 * import, and Phase 5.5b post-Studio reconcile are documented in the design
 * doc but remain stubs/TODO.
 */
export const PHASE_CHECKS: Record<string, PhaseCheck> = {
  "phase-7-lint-gate": lintDeliverablesCheck,
};
