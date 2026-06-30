import * as path from "node:path";

// ── Config ──────────────────────────────────────────────────────────

export const WORKING_DIR = process.env.WORKING_DIR ?? "/c/tmp/research-compare";

// S129 studio-completeness gate. After claude -p exits, before completeJob, the
// worker re-checks that every SELECTED studio product is on disk and recovers
// any that are ready-but-not-downloaded via the RELIABLE artifact-list signal
// (the pipeline's `artifact poll` lies "in_progress" after a video completes).
// A still-rendering product is polled up to STUDIO_RECOVERY_MAX_MS; anything
// still missing fails the job CLOSED (never a silent success). The gate's own
// runtime is NOT bounded by MAX_JOB_DURATION_MS (that cap only kills the claude
// subprocess); NLM list/download is $0. See lib/studio-completeness.ts.
//
// COVERAGE BOUNDARY (Gemini MERGE MINOR-3): the gate runs ONLY on the claude
// exit-0 success path. If the pipeline BLOCKS on a slow product and trips the
// MAX_JOB_DURATION_MS 90-min cap, claude is killed (exit!=0) and the job fails
// at the exit-code check ABOVE — the gate never runs, so a still-rendering
// product on a CAPPED job is not recovered here (manual finalize-recovered-run.ts
// remains the recourse). The in-pipeline detection fix (research-compare.md poll
// loop now uses `artifact list`, not the lying `artifact poll`) makes the asset
// land DURING the job in the common case, so reaching this backstop with a truly
// still-rendering product is rare.
//
// STARVATION (Gemini MERGE MAJOR-2): this runs synchronously on the single-
// threaded worker, so a genuinely-still-rendering product blocks the next job
// for up to the budget. The dominant case (asset done, poll just lied) recovers
// on the FIRST list() call (~0 wait); the budget only bites the rare rendering
// tail. Default 15 min bounds worst-case queue latency (acceptable behind a
// 60-90 min job + 5-min cron). A non-blocking DB-`recovering`-state + async
// poller is the future architecture if the tail becomes common.
// Parse a non-negative ms env var, falling back if unset/NaN/negative (Codex
// MERGE MAJOR-4 — a bad STUDIO_RECOVERY_* value must not produce a NaN deadline /
// spin loop; the module also defends via safeMs, this is belt-and-suspenders).
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export const STUDIO_RECOVERY_MAX_MS = envMs("STUDIO_RECOVERY_MAX_MS", 900_000);
export const STUDIO_RECOVERY_POLL_MS = envMs("STUDIO_RECOVERY_POLL_MS", 60_000);

// MRPF PUBLISH gate (S108): operator-only URGENT risk-acceptance files live
// here as <job-id>.txt (gitignored; OUTSIDE per-job workdirs so the spawned
// pipeline has no business writing one). See lib/publish-gate.ts.
export const PUBLISH_RISK_ACCEPT_DIR =
  process.env.PUBLISH_RISK_ACCEPT_DIR ??
  path.join(process.cwd(), ".publish-risk-accepted");
export const PROJECTS_DIR = process.env.PROJECTS_DIR ??
  "/c/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/Projects";
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
export const DRY_RUN = process.env.DRY_RUN === "true";

// S187 P0-2 dark-launch flag (design §13): Branch (c) "Studio video still
// rendering at the checkpoint" → best-effort completion. DEFAULT OFF — when unset
// or not exactly "true", BOTH the Gate-A defer interception (state-evaluation) and
// the studio-completeness render classification stay inert, so a still-rendering
// video hard-fails EXACTLY as pre-S187 (zero behaviour change). Flip to "true" in
// the DR-Deploy .env only AFTER a shadow-observed run. Shared export so the
// executor (Gate-A) and the decoupled sweep read ONE source and cannot drift.
// NOTE: gates only NEW render-parks; an already-parked render row keeps draining
// through the sweep even if the flag is later turned off.
export const STUDIO_VIDEO_RENDER_ENABLED =
  process.env.STUDIO_VIDEO_RENDER_ENABLED === "true";

// S69: Per-job cost cap (second-line defense complementing the plan-review
// gate). Worker estimates cumulative cost mid-flight by parsing assistant
// usage events streaming out of `claude -p --output-format json --verbose`
// and applying Opus 4.7 published rates. On exceed → SIGTERM. Set to 0 to
// disable entirely. Default 1500 cents ($15) = 2.5× the S67 $5.85 burn,
// well above legit max (~$3), aggressive enough to catch $50+ runaways.
export const MAX_JOB_COST_CENTS = Number(process.env.MAX_JOB_COST_CENTS ?? 1500);
