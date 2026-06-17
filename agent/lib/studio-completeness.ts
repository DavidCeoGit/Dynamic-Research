/**
 * S129 — Worker-level fail-closed studio-completeness gate.
 *
 * Closes the recurring "video completed in the notebook but never reached the
 * gallery" bug. Two root defects compounded it:
 *   1. The pipeline's poll loop detects completion via `notebooklm artifact
 *      poll <task_id>`, which returns `in_progress` even AFTER the video is
 *      fully rendered (verified live S129: same task_id → poll says
 *      `in_progress`, `artifact list --type video` says `completed`/status_id 3).
 *      So the loop never sees the video finish.
 *   2. The pipeline then fails OPEN — it writes phase=7/phase_status=complete
 *      with a completion_note acknowledging the video was still in_progress,
 *      and the worker uploads whatever's on disk. No video.mp4 → silently gone.
 *      The publish-gate checks claims (not studio artifacts); the Phase 6.5
 *      verify gate compares notebook-COMPLETED-artifacts vs disk, so a product
 *      not yet "completed" per the broken poll is EMPTY on both sides → skipped.
 *
 * This module is the deterministic backstop in the WORKER (not the drift-prone
 * `claude -p` slash prompt). BEFORE completeJob, it asserts requested ==
 * delivered using the RELIABLE signal (`artifact list --type <T>` filtered to
 * status_id===3), and DOWNLOADS BY ARTIFACT ID (`-a <id>`, never bare
 * default-latest) any selected product that is ready-but-not-on-disk. A
 * still-rendering product is polled up to a bounded budget. Anything still
 * missing after the budget makes the gate FAIL-CLOSED — the job must NOT report
 * success (caller marks it failed + alerts the operator).
 *
 * The recovery download runs AFTER `claude -p` exits, so it is NOT bounded by
 * MAX_JOB_DURATION_MS (that cap only kills the claude subprocess), and NLM
 * list/download is $0.
 *
 * Pure orchestration + injectable seams (listArtifacts / downloadArtifact /
 * listDir / now / sleep) so the loop is unit-testable without spawning the NLM
 * CLI. See test/studio-completeness.test.ts.
 *
 * Pairs with feedback_worker_90min_cap_kills_nlm_video_poll.md (the
 * "worker-level fallback … currently not implemented" it called for),
 * feedback_nlm_download_default_latest.md (download by id, not default-latest),
 * and feedback_post_run_artifact_verification.md (the Phase 6.5 gate this
 * backstops).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { studioFilename } from "./conventions.js";
import { pickWinners } from "./studio-winner.js";
import type { PipelineState, SelectedProducts } from "../types.js";

// Canonical product order (matches SelectedProducts / conventions STUDIO_PRODUCTS).
const STUDIO_ORDER = ["audio", "video", "slides", "report", "infographic"] as const;

// Conventions product name → NotebookLM CLI type. The CLI uses "slide-deck"
// for what conventions calls "slides"; both `artifact list --type` and
// `download <type>` take this value. Cinematic videos share the "video" type.
const PRODUCT_TO_NLM_TYPE: Record<string, string> = {
  audio: "audio",
  video: "video",
  slides: "slide-deck",
  report: "report",
  infographic: "infographic",
};

// Windows: spawnSync needs the native venv path (Bug 3 / WinError 2).
const NLM_BIN =
  process.env.NOTEBOOKLM_BIN ??
  (process.platform === "win32"
    ? "C:/Users/ceo/.notebooklm-venv/Scripts/notebooklm.exe"
    : "notebooklm");

export interface NlmArtifactRef {
  id: string;
  title: string;
  created_at: string;
}

export interface CompletenessDeps {
  /** COMPLETED artifacts (status_id===3) of an NLM type, newest-first. null on CLI/parse error. */
  listArtifacts: (notebookId: string, nlmType: string) => NlmArtifactRef[] | null;
  /** Download a specific artifact BY ID to outPath. Resolves true only on a non-empty file. */
  downloadArtifact: (
    notebookId: string,
    artifactId: string,
    nlmType: string,
    outPath: string,
  ) => Promise<boolean>;
  /** Filenames (not dirs) in the deliverables dir; [] if the dir is absent. */
  listDir: (dir: string) => Promise<string[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface CompletenessOptions {
  /** Total wait budget per still-rendering product, after claude -p exits. */
  recoveryBudgetMs: number;
  /** Re-list interval while a product is still rendering. */
  pollIntervalMs: number;
}

export interface CompletenessResult {
  ok: boolean;
  selected: string[];
  presentBefore: string[];
  recovered: string[];
  stillMissing: string[];
  notes: string[];
}

/**
 * Products the run was OBLIGED to produce. Driven by the DURABLE DB selection
 * (job.selected_products), NOT the pipeline-written state.selectedProducts —
 * the whole point of a worker backstop is to not trust the drift-prone pipeline
 * (Codex MERGE MAJOR-3): a pipeline that drops/flips a product in state must not
 * be able to make the gate pass open. Defensive: tolerate a partial/loose object.
 */
function obligedProducts(selected: SelectedProducts | null | undefined): string[] {
  const sel = (selected ?? {}) as unknown as Record<string, unknown>;
  return STUDIO_ORDER.filter((p) => sel[p] === true);
}

/**
 * Build a compact YYYYMMDD-HHMMSS token from epoch-style components, or null if
 * the components don't form a real calendar date/time (Codex MERGE CRITICAL-2:
 * `new Date(2026, 12, ...)` silently NORMALIZES instead of rejecting). Round-trip
 * validates so an impossible token can't masquerade as a valid run start.
 */
function buildCompact(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): { compact: string; ms: number } | null {
  const dt = new Date(y, mo - 1, d, h, mi, s);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return null;
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi ||
    dt.getSeconds() !== s
  ) {
    return null; // normalized → not a real date
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { compact: `${y}${p2(mo)}${p2(d)}-${p2(h)}${p2(mi)}${p2(s)}`, ms };
}

/**
 * Parse any timestamp form the pipeline emits into {compact, ms}, or null.
 * Accepts compact `YYYYMMDD-HHMMSS`, colon-ISO `YYYY-MM-DDTHH:MM:SS`, AND
 * hyphen-time ISO `YYYY-MM-DDTHH-mm-ss` (Codex MERGE CRITICAL-2 — a shipped
 * worker format the prior code missed and would have synthesized "now" for).
 */
function parseTimestamp(raw: string | null | undefined): { compact: string; ms: number } | null {
  if (typeof raw !== "string" || !raw) return null;
  let m = raw.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/); // compact
  if (m) return buildCompact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})[:-](\d{2})/); // colon- OR hyphen-time ISO
  if (m) return buildCompact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  return null;
}

/**
 * Derive the REAL run-start {compact, ms} for naming + the anti-stale floor.
 * Sources, in order of trust: an on-disk winner's embedded timestamp; a token
 * in any artifacts.<p>.file; state.timestamp. Returns null only when NONE is
 * derivable — in which case the floor degrades to best-effort (never a
 * synthesized "now", which Codex CRITICAL-2 showed would wrongly exclude this
 * run's real artifact).
 */
function deriveRunStart(
  winners: ReturnType<typeof pickWinners>,
  state: PipelineState,
): { compact: string; ms: number } | null {
  const w = Object.values(winners)[0];
  const fromWinner = parseTimestamp(w?.timestamp);
  if (fromWinner) return fromWinner;

  const arts = state.artifacts as Record<string, { file?: unknown }> | undefined;
  if (arts) {
    for (const v of Object.values(arts)) {
      const fromFile = typeof v?.file === "string" ? parseTimestamp(v.file) : null;
      if (fromFile) return fromFile;
    }
  }
  return parseTimestamp(state.timestamp);
}

/** Artifact created_at → epoch ms, or null if absent/unparseable. */
function artifactCreatedAtMs(a: NlmArtifactRef): number | null {
  if (!a.created_at) return null;
  const ms = Date.parse(a.created_at);
  return Number.isFinite(ms) ? ms : null;
}

/** Finite, non-negative ms or the fallback (Codex MERGE MAJOR-4: NaN env). */
function safeMs(value: number, fallback: number, floor = 0): number {
  return Number.isFinite(value) && value >= floor ? value : fallback;
}

/**
 * The task/artifact id this run submitted for `product`, if the pipeline
 * persisted it into state.artifacts. Optional + forward-compatible: today's
 * state.json does not carry it, so the created-after-run-start floor is the
 * load-bearing anti-stale guard; an exact id (when present) is strictly tighter.
 */
function expectedArtifactId(state: PipelineState, product: string): string | null {
  const arts = state.artifacts as
    | Record<string, { task_id?: unknown; id?: unknown }>
    | undefined;
  const e = arts?.[product];
  const v =
    (typeof e?.task_id === "string" && e.task_id) ||
    (typeof e?.id === "string" && e.id) ||
    "";
  return v || null;
}

/**
 * Enforce requested == delivered for studio products, recovering any selected
 * product that is ready-but-not-on-disk. Returns ok=false (fail-closed) when a
 * selected product cannot be recovered within the budget — the caller must then
 * refuse to mark the job completed.
 */
export async function enforceStudioCompleteness(
  obliged: SelectedProducts | null | undefined,
  state: PipelineState,
  projectsDir: string,
  opts: CompletenessOptions,
  deps: CompletenessDeps,
): Promise<CompletenessResult> {
  // Obligations come from the DURABLE DB selection, NOT pipeline-written state.
  const selected = obligedProducts(obliged);
  const names = await deps.listDir(projectsDir).catch(() => [] as string[]);
  const winners = pickWinners(names.map((name) => ({ name })));
  const presentBefore = selected.filter((p) => winners[p]);
  const missing = selected.filter((p) => !winners[p]);

  const result: CompletenessResult = {
    ok: true,
    selected,
    presentBefore,
    recovered: [],
    stillMissing: [],
    notes: [],
  };

  if (missing.length === 0) {
    deps.log(
      `[studio-completeness] all ${selected.length} selected product(s) present` +
        `${selected.length ? `: ${selected.join(", ")}` : ""}`,
    );
    return result;
  }

  deps.log(
    `[studio-completeness] selected=[${selected.join(",")}] present=[${presentBefore.join(",") || "-"}] ` +
      `MISSING=[${missing.join(",")}] — attempting reliable artifact-list recovery`,
  );

  const notebookId = state.notebook_id ?? "";
  if (!notebookId) {
    result.ok = false;
    result.stillMissing = [...missing];
    result.notes.push(
      "state.notebook_id is null — cannot recover any missing product from NotebookLM",
    );
    return result;
  }

  // Real run-start: {compact} names recovered files; {ms} is the strict anti-stale
  // floor. NO negative skew (Codex CRITICAL-1: a 5-min tolerance re-admitted a
  // parent created 92s pre-start). runFloorMs is null ONLY when no real timestamp
  // is derivable — then the floor degrades to best-effort (never a synthesized
  // "now", which would wrongly exclude this run's real artifact — Codex CRITICAL-2).
  const runStart = deriveRunStart(winners, state);
  const runFloorMs = runStart?.ms ?? null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const namingTs =
    runStart?.compact ??
    `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
      `-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  if (runFloorMs == null) {
    deps.log(
      `[studio-completeness] WARN: no real run timestamp derivable — naming recovered files ${namingTs} ` +
        `and DEGRADING the anti-stale guard to newest-completed (reused-notebook risk)`,
    );
    result.notes.push(
      "no run-start floor derivable — anti-stale guard degraded to newest-completed",
    );
  }

  // Sanitize budget/interval against NaN/negative env (Codex MAJOR-4).
  const budgetMs = safeMs(opts.recoveryBudgetMs, 0, 0);
  const pollMs = safeMs(opts.pollIntervalMs, 60_000, 1);

  for (const product of missing) {
    const nlmType = PRODUCT_TO_NLM_TYPE[product];
    if (!nlmType) {
      result.stillMissing.push(product);
      result.notes.push(`${product}: no NotebookLM type mapping — cannot recover`);
      continue;
    }
    const expectedId = expectedArtifactId(state, product);

    const deadline = deps.now() + budgetMs;
    let attempts = 0;
    let recovered = false;
    for (;;) {
      // Don't START a new list once the budget is spent — but ALWAYS do the
      // first attempt (the dominant "poll lied, asset already done" case recovers
      // in one shot even with a 0 budget). So: guard only after attempt #1. This
      // closes the "one extra list AT the deadline" edge (Codex QA finding-4).
      if (attempts > 0 && deps.now() >= deadline) break;
      attempts++;
      const arts = deps.listArtifacts(notebookId, nlmType) ?? [];
      // Anti-stale (Gemini CRITICAL-1 / Codex CRITICAL-1): in a REUSED notebook a
      // parent's older COMPLETED video must NOT be mistaken for this run's still-
      // rendering one. Prefer an exact submitted id; else require created AT/AFTER
      // run start (strict). Fall back to newest-completed only if no floor exists.
      const candidates = arts.filter((a) => {
        if (expectedId) return a.id === expectedId;
        if (runFloorMs == null) return true;
        const c = artifactCreatedAtMs(a);
        return c == null ? false : c >= runFloorMs;
      });
      const winner = candidates[0]; // arts are COMPLETED + newest-first; filter keeps order
      if (winner) {
        const filename = studioFilename(winner.title, namingTs, product);
        const outPath = path.join(projectsDir, filename);
        const downloaded = await deps.downloadArtifact(notebookId, winner.id, nlmType, outPath);
        if (downloaded) {
          result.recovered.push(product);
          result.notes.push(
            `${product}: recovered ${filename} from completed artifact ${winner.id} (attempt ${attempts})`,
          );
          deps.log(
            `[studio-completeness] RECOVERED ${product} → ${filename} (artifact ${winner.id})`,
          );
          recovered = true;
          break;
        }
        result.notes.push(
          `${product}: completed artifact ${winner.id} found but download failed — retrying`,
        );
      } else if (arts.length > 0) {
        result.notes.push(
          `${product}: ${arts.length} completed artifact(s) in notebook but none match ` +
            `${expectedId ? `id ${expectedId}` : "this run's start time"} — treating as still-rendering`,
        );
      }

      // Check the budget AFTER an attempt (so at least one try always happens),
      // then sleep only the remaining time — never overshoot, never an extra
      // list past the deadline (Codex MAJOR-4).
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      await deps.sleep(Math.min(pollMs, remaining));
    }

    if (!recovered) {
      result.stillMissing.push(product);
      result.notes.push(
        `${product}: no recoverable completed artifact within ` +
          `${Math.round(budgetMs / 60000)}min budget (${attempts} attempt(s))`,
      );
      deps.log(
        `[studio-completeness] STILL MISSING ${product} after ${attempts} attempt(s) / ` +
          `${Math.round(budgetMs / 60000)}min budget`,
      );
    }
  }

  result.ok = result.stillMissing.length === 0;
  return result;
}

// ── Real (non-injected) dependency implementations ───────────────────

interface RawArtifact {
  id: string;
  title: string;
  created_at: string;
  status_id?: number;
}

/**
 * Raw `artifact list --type <T> --json` parse — ALL statuses, newest-first, or
 * null on CLI/parse error. The NLM `LIST_ARTIFACTS` RPC filter is
 * `NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"` (verified in the CLI
 * source `notebooklm/_artifacts.py`), so this surfaces processing(1)/pending(2)/
 * completed(3)/failed(4) — every status except suggested. status_id maps
 * 1=processing 2=pending 3=completed 4=failed (notebooklm/types.py). Callers
 * pick which statuses they care about. Single source of the spawn+parse so the
 * completed-only and all-status listers can never drift apart.
 */
function rawListArtifacts(notebookId: string, nlmType: string): RawArtifact[] | null {
  const r = spawnSync(
    NLM_BIN,
    ["artifact", "list", "-n", notebookId, "--type", nlmType, "--json"],
    {
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout ?? "") as { artifacts?: RawArtifact[] };
    const arts = (parsed.artifacts ?? []).slice();
    arts.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return arts;
  } catch {
    return null;
  }
}

/** List COMPLETED (status_id===3) artifacts of a type, newest-first. */
export function realListArtifacts(
  notebookId: string,
  nlmType: string,
): NlmArtifactRef[] | null {
  const arts = rawListArtifacts(notebookId, nlmType);
  if (arts === null) return null;
  // status_id 3 == completed; undefined assumed completed for forward-compat
  // (mirrors verify-gallery-vs-notebook.ts). In_progress (other status_id)
  // is excluded — that is the whole point vs the unreliable `artifact poll`.
  return arts
    .filter((a) => a.status_id === 3 || a.status_id === undefined)
    .map((a) => ({ id: a.id, title: a.title, created_at: a.created_at }));
}

/**
 * S142 — ALL-status artifact ids of a type (regardless of status_id), newest-
 * first, or null on CLI/parse error.
 *
 * The studio_only pre-generation snapshot uses THIS, not realListArtifacts,
 * so a FOREIGN generation that is already IN-PROGRESS on a SHARED parent
 * notebook when our run starts is captured in the before-set and is therefore
 * excluded from "new" once it completes (closes the concurrent-foreign exact-1
 * false-success Codex caught at S141). The artifact `id` is the backend entity
 * id (data[0] in the API tuple — notebooklm/types.py Artifact.from_api_response)
 * and is STABLE across the processing→completed transition, so a before-set id
 * still matches the same artifact after it finishes rendering.
 */
export function realListAllArtifactIds(
  notebookId: string,
  nlmType: string,
): string[] | null {
  const arts = rawListArtifacts(notebookId, nlmType);
  if (arts === null) return null;
  return arts.map((a) => a.id).filter(Boolean);
}

/** Download a specific artifact BY ID; resolve true only on a non-empty file. */
export async function realDownloadArtifact(
  notebookId: string,
  artifactId: string,
  nlmType: string,
  outPath: string,
): Promise<boolean> {
  const r = spawnSync(
    NLM_BIN,
    ["download", nlmType, "-n", notebookId, "-a", artifactId, outPath, "--force"],
    {
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    },
  );
  if (r.status !== 0) return false;

  // Bug 12: NLM occasionally writes to a backslash-mangled path instead.
  const candidates = [
    outPath,
    outPath.replace(/^([A-Za-z]):\//, "\\$1\\").replace(/\//g, "\\"),
  ];
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile() && st.size > 0) {
        if (candidate !== outPath) {
          await fs.copyFile(candidate, outPath).catch(() => {});
        }
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

/** Default real deps for the worker. */
export function defaultDeps(log: (msg: string) => void): CompletenessDeps {
  return {
    listArtifacts: realListArtifacts,
    downloadArtifact: realDownloadArtifact,
    listDir: async (dir: string) => {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      return dirents.filter((d) => d.isFile()).map((d) => d.name);
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}
