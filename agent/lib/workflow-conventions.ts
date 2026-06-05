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

// ── Phase 0 — Existing-Notebook Resolution (CE-3) ──────────────────

/**
 * NotebookLM CLI binary — venv exe on Windows, mirrors the resolution in
 * agent/preflight.ts and agent/scripts/verify-gallery-vs-notebook.ts.
 */
const NLM_BIN =
  process.env.NOTEBOOKLM_BIN ??
  (process.platform === "win32"
    ? "C:/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe"
    : `${process.env.HOME}/.notebooklm-venv/bin/notebooklm`);

/**
 * Studio-only regeneration (pipeline_mode = "studio_only") reuses a parent
 * run's existing notebook — it never creates one. If that notebook has been
 * deleted, the entire run is impossible and must fail BEFORE any `generate`
 * call burns NLM quota. This check is the structured, reusable form of that
 * gate: agent/scripts/regenerate-studio-products.ts calls it at step 3, and
 * any future caller (recovery script, a studio-only slash-command path) gets
 * the identical verdict.
 *
 * Pipeline contract: when pipeline_mode is "studio_only", a run cannot
 * proceed to Studio generation if this returns ok=false. ctx.notebookId is
 * required — it is resolved upstream from the parent run's state.json.
 *
 * See Documentation/clone-and-edit-design.md (CE-3 acceptance criteria) and
 * Documentation/workflow-conventions-enforcer-design.md.
 */
async function existingNotebookCheck(ctx: PipelineContext): Promise<PhaseCheckResult> {
  const phase = "phase-0-existing-notebook";
  const notebookId = ctx.notebookId;

  if (!notebookId || typeof notebookId !== "string") {
    return {
      ok: false,
      phase,
      remediation: [
        "PipelineContext.notebookId (string) is required for phase-0-existing-notebook.",
        "Studio-only mode resolves it from the parent run's state.json — a missing value " +
          "means the parent run has no recorded notebook. Re-run with full pipeline mode.",
      ],
      warnings: [],
    };
  }

  const result = spawnSync(NLM_BIN, ["list", "--json"], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? -1;
  const combined = `${stdout}\n${stderr}`.toLowerCase();

  if (exitCode !== 0 || !stdout.trim()) {
    const authish =
      combined.includes("auth") || combined.includes("login") || combined.includes("sign in");
    return {
      ok: false,
      phase,
      remediation: authish
        ? [
            "`notebooklm list --json` failed with an auth-shaped error — NotebookLM auth is not " +
              "currently valid.",
            "The 30-min RefreshNotebookLMAuth task may be mid-cycle; retry shortly, or run " +
              "`notebooklm login`.",
          ]
        : [
            `\`notebooklm list --json\` exited ${exitCode} — cannot verify the parent notebook exists.`,
            `stderr: ${stderr.trim().slice(0, 300)}`,
          ],
      warnings: [],
      context: { exitCode, notebookId },
    };
  }

  let exists = false;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>).notebooks as unknown[]) ?? [];
    exists = arr.some((nb) => {
      const o = nb as Record<string, unknown>;
      return o.id === notebookId || o.notebook_id === notebookId;
    });
  } catch {
    // Unparseable list output — fall back to a substring probe. The id is
    // unique enough that a false positive is unlikely, and failing the run
    // on a parser hiccup would be worse than this best-effort match.
    exists = stdout.includes(notebookId);
  }

  if (!exists) {
    return {
      ok: false,
      phase,
      remediation: [
        `Parent notebook ${notebookId} was not found in NotebookLM — it appears to have been deleted.`,
        "Studio-only regeneration is impossible without the parent's notebook.",
        "Re-run this clone with full pipeline mode (it will create a fresh notebook).",
      ],
      warnings: [],
      context: { exitCode, notebookId, found: false },
    };
  }

  return {
    ok: true,
    phase,
    remediation: [],
    warnings: [],
    context: { notebookId, found: true },
  };
}

// ── Registry ────────────────────────────────────────────────────────

/**
 * Pipeline-phase checks indexed by canonical name. The slash command (or a
 * future workflow-runner) invokes these at phase boundaries; ok=false means
 * the pipeline cannot proceed.
 *
 * S34 shipped phase-7-lint-gate. CE-3 adds phase-0-existing-notebook (the
 * studio-only notebook-resolution gate). Phase 3 source import and Phase 5.5b
 * post-Studio reconcile are documented in the design doc but remain TODO.
 */
export const PHASE_CHECKS: Record<string, PhaseCheck> = {
  "phase-7-lint-gate": lintDeliverablesCheck,
  "phase-0-existing-notebook": existingNotebookCheck,
};
