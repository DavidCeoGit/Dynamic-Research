/**
 * S52 #4 — Claude CLI usage telemetry recorder.
 *
 * Sandbox draft 2026-05-25 morning. Intended path on promote:
 *   agent/lib/usage-tracking.ts
 *
 * Mirrors `agent/lib/storage-paths.ts` `uploadWithAudit()` pattern:
 *   - Best-effort write to public.research_usage on every job completion.
 *   - Failure logs to console.warn and returns { ok: false }; NEVER throws
 *     into the caller's path. Audit must not be a single-point-of-failure
 *     choke for legitimate job completion.
 *
 * JSON shape verified live 2026-05-25 morning via two probes
 * (CLI v2.1.146 — see sandbox/s52-4-telemetry-design.md §3).
 *
 * Parser hardening (per design doc §5 + Gemini round-1 M2/m1):
 *   1. Two stdout shapes supported:
 *      - `--output-format json --verbose` → JSON ARRAY of events; last
 *        element with type=="result" is the usage summary (current).
 *      - `--output-format json` alone → single JSON object with
 *        type=="result" (fallback if --verbose is later dropped).
 *   2. Trim whitespace before JSON.parse; trailing \n is normal.
 *   3. On parse failure: log + write a 'no-summary' row so we still see the
 *      job ran (and its exit code) without the cost/token detail.
 *   4. Sanity ranges: negative tokens, total_cost_usd > $1000, single
 *      token total > 10M → log + flag (still writes the row).
 *   5. Long-run defense: callers MUST cap stdoutBuf size (executor.ts uses
 *      8MB cap with tail-preserve). When the buffer trim truncates the head
 *      of an array, JSON.parse fails — we then attempt a lastIndexOf-based
 *      result-event extraction as a degraded-but-useful recovery path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── CLI JSON shape (subset we read; all fields optional except top type) ────

interface ClaudeCliUsageSummary {
  type?: "result";
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    [k: string]: unknown;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    webSearchRequests?: number;
    costUSD?: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
  terminal_reason?: string;
  fast_mode_state?: string;
  uuid?: string;
  [k: string]: unknown;
}

// ── Parsed usage row (what we INSERT into research_usage) ──────────────────

export interface ParsedUsageRow {
  job_status: "complete" | "failed" | "killed" | "no-summary";
  exit_code: number;
  is_error: boolean | null;
  api_error_status: string | null;
  stop_reason: string | null;
  terminal_reason: string | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  ttft_ms: number | null;
  num_turns: number | null;
  input_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  total_cost_usd: number | null;
  model_usage: unknown | null;
  raw_json: unknown | null;
}

// ── Sanity range guards (per design doc §5) ────────────────────────────────

const SANITY_MAX_COST_USD = 1000;
const SANITY_MAX_TOKENS = 10_000_000;

function sanityCheck(row: ParsedUsageRow): string[] {
  const warnings: string[] = [];
  const negs: (keyof ParsedUsageRow)[] = [
    "input_tokens", "cache_creation_tokens", "cache_read_tokens",
    "output_tokens", "duration_ms", "duration_api_ms", "ttft_ms",
  ];
  for (const k of negs) {
    const v = row[k];
    if (typeof v === "number" && v < 0) warnings.push(`${k}=${v} is negative`);
    if (typeof v === "number" && v > SANITY_MAX_TOKENS) warnings.push(`${k}=${v} exceeds sanity cap ${SANITY_MAX_TOKENS}`);
  }
  if (typeof row.total_cost_usd === "number" && row.total_cost_usd < 0) {
    warnings.push(`total_cost_usd=${row.total_cost_usd} is negative`);
  }
  if (typeof row.total_cost_usd === "number" && row.total_cost_usd > SANITY_MAX_COST_USD) {
    warnings.push(`total_cost_usd=${row.total_cost_usd} exceeds sanity cap $${SANITY_MAX_COST_USD}`);
  }
  return warnings;
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Try to parse a CLI stdout buffer into a ParsedUsageRow.
 *
 * Strategy: trim, then JSON.parse, then map known fields. On failure, return
 * a 'no-summary' row (so we still capture exit_code and the raw buffer for
 * forensic analysis).
 *
 * @param stdoutBuf  raw stdout bytes accumulated from the claude child
 * @param exitCode   the child process exit code
 *
 * Note: the schema's job_status CHECK constraint admits 'killed' as a future
 * value, but v1 classifies purely from exitCode. Distinguishing
 * worker-initiated kill (MAX_JOB_DURATION) from CLI-internal kill would need
 * waitForProcess to surface its `killAttempted` flag — deferred to S53+ to
 * keep this MERGE-gate's surface area small.
 */
export function parseUsageSummary(
  stdoutBuf: string,
  exitCode: number,
  finalJobStatus?: "complete" | "failed" | "killed",
): ParsedUsageRow {
  // Base row — fields will fill in on successful parse.
  // Codex round-2 MAJOR #1: prefer worker-supplied finalJobStatus over
  // exitCode-derived classification. The parser can still override to
  // 'no-summary' downstream when the buffer is unparseable.
  const base: ParsedUsageRow = {
    job_status: finalJobStatus ?? (exitCode === 0 ? "complete" : "failed"),
    exit_code: exitCode,
    is_error: null,
    api_error_status: null,
    stop_reason: null,
    terminal_reason: null,
    duration_ms: null,
    duration_api_ms: null,
    ttft_ms: null,
    num_turns: null,
    input_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    output_tokens: null,
    total_cost_usd: null,
    model_usage: null,
    raw_json: null,
  };

  const trimmed = stdoutBuf.trim();
  if (!trimmed) {
    return { ...base, job_status: "no-summary" };
  }

  // Extract the result-event object from the stdout buffer. Three paths:
  //   1. Whole-buffer parse, array shape (--verbose ON, normal path).
  //   2. Whole-buffer parse, single object shape (--verbose OFF fallback).
  //   3. Whole-buffer parse failed → buffer was probably truncated by the
  //      8MB tail-cap. Fall back to a lastIndexOf-based result-event slice.
  let result: ClaudeCliUsageSummary | null = null;
  let parsedRaw: unknown = null;

  try {
    const parsed = JSON.parse(trimmed);
    parsedRaw = parsed;
    if (Array.isArray(parsed)) {
      // Walk array in reverse — the result event is always the last one.
      for (let i = parsed.length - 1; i >= 0; i--) {
        const ev = parsed[i] as ClaudeCliUsageSummary;
        if (ev && typeof ev === "object" && ev.type === "result") {
          result = ev;
          break;
        }
      }
      if (!result) {
        console.warn(`[usage-tracking] parsed array had no type==result event (${parsed.length} events); falling back to no-summary`);
        return { ...base, job_status: "no-summary", raw_json: parsed };
      }
    } else if (parsed && typeof parsed === "object" && (parsed as ClaudeCliUsageSummary).type === "result") {
      result = parsed as ClaudeCliUsageSummary;
    } else {
      console.warn(`[usage-tracking] parsed JSON shape unexpected (top-level type=${(parsed as { type?: string })?.type}); falling back to no-summary`);
      return { ...base, job_status: "no-summary", raw_json: parsed };
    }
  } catch (parseErr) {
    // Path 3: whole-buffer parse failed. The buffer may have been trimmed by
    // the executor's tail-preserve cap, lopping off the array opener. Try a
    // last-occurrence-of result-event-marker slice as a degraded recovery.
    // Codex round-2 NIT: regex tolerates whitespace variations
    // (`{ "type" : "result"`) the CLI may add in future shapes.
    const RESULT_MARKER_RX = /\{\s*"type"\s*:\s*"result"/g;
    let startIdx = -1;
    for (const m of trimmed.matchAll(RESULT_MARKER_RX)) {
      if (typeof m.index === "number") startIdx = m.index;
    }
    if (startIdx === -1) {
      console.warn(
        `[usage-tracking] JSON.parse failed (${(parseErr as Error).message}); ` +
          `no result-event marker in ${stdoutBuf.length}-byte buffer; falling back to no-summary`,
      );
      return {
        ...base,
        job_status: "no-summary",
        raw_json: { _parse_error: (parseErr as Error).message, _stdout_tail: stdoutBuf.slice(-400) },
      };
    }
    // Walk forward from startIdx, tracking brace depth, to find the matching '}'.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let endIdx = -1;
    for (let i = startIdx; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx === -1) {
      console.warn(
        `[usage-tracking] result-marker recovery: no matching close brace for marker at ${startIdx}; falling back to no-summary`,
      );
      return {
        ...base,
        job_status: "no-summary",
        raw_json: { _recovery_failed: true, _stdout_tail: stdoutBuf.slice(-400) },
      };
    }
    const sliced = trimmed.slice(startIdx, endIdx + 1);
    try {
      result = JSON.parse(sliced) as ClaudeCliUsageSummary;
      parsedRaw = { _recovered_from_truncated_buffer: true, result };
    } catch (recoveryErr) {
      console.warn(
        `[usage-tracking] result-marker recovery JSON.parse failed (${(recoveryErr as Error).message}); falling back to no-summary`,
      );
      return {
        ...base,
        job_status: "no-summary",
        raw_json: { _recovery_parse_error: (recoveryErr as Error).message, _stdout_tail: stdoutBuf.slice(-400) },
      };
    }
  }

  // Defensive: result must be a non-null object with type==="result".
  if (!result || typeof result !== "object" || result.type !== "result") {
    console.warn(`[usage-tracking] extracted result is not a valid result-event; falling back to no-summary`);
    return { ...base, job_status: "no-summary", raw_json: parsedRaw };
  }

  const parsed = result;  // alias so the field-mapping block below stays unchanged

  const row: ParsedUsageRow = {
    ...base,
    is_error: parsed.is_error ?? null,
    api_error_status: parsed.api_error_status ?? null,
    stop_reason: parsed.stop_reason ?? null,
    terminal_reason: parsed.terminal_reason ?? null,
    duration_ms: parsed.duration_ms ?? null,
    duration_api_ms: parsed.duration_api_ms ?? null,
    ttft_ms: parsed.ttft_ms ?? null,
    num_turns: parsed.num_turns ?? null,
    input_tokens: parsed.usage?.input_tokens ?? null,
    cache_creation_tokens: parsed.usage?.cache_creation_input_tokens ?? null,
    cache_read_tokens: parsed.usage?.cache_read_input_tokens ?? null,
    output_tokens: parsed.usage?.output_tokens ?? null,
    total_cost_usd: parsed.total_cost_usd ?? null,
    model_usage: parsed.modelUsage ?? null,
    // Codex round-2 MAJOR #2: raw_json stores ONLY the result event, not the
    // full parsedRaw payload. With --verbose, parsedRaw is the array of
    // events including {assistant} events that carry the FULL LLM response
    // text — that's DATA exposure + storage bloat we don't want for a
    // telemetry table. The migration's COMMENT ON COLUMN already promises
    // "full final-event summary"; this lines up the code with the contract.
    raw_json: result,
  };

  const warnings = sanityCheck(row);
  if (warnings.length > 0) {
    console.warn(
      `[usage-tracking] sanity-range warnings on parsed usage: ${warnings.join("; ")}`,
    );
  }

  return row;
}

// ── DB writer (best-effort, mirrors uploadWithAudit) ───────────────────────

export interface RecordUsageOpts {
  sb: SupabaseClient;
  researchQueueId: string;
  organizationId: string;
  /** raw stdout accumulated from `claude -p --output-format json --verbose` */
  stdoutBuf: string;
  exitCode: number;
  /**
   * Codex round-2 MAJOR #1: worker-determined final classification, used to
   * override the exit-code-derived job_status. Catches Bug-35 (exit 0 but
   * state.json didn't reach Finalization) and partial-upload-failure paths.
   * Pass 'complete' only after BOTH verifyPipelineCompletion + uploadOutputs
   * have succeeded. Pass 'failed' for any path the worker treats as failed.
   * Optional for back-compat; if omitted, falls back to exitCode-derived.
   * Parser-side 'no-summary' (unparseable buffer) still wins regardless —
   * "we ran but couldn't read the summary" is a distinct outcome from
   * worker-side success/failure classification.
   */
  finalJobStatus?: "complete" | "failed" | "killed";
}

export interface RecordUsageResult {
  ok: boolean;
  parsed?: ParsedUsageRow;
  reason?: string;
}

/**
 * Parse the CLI stdout summary and best-effort insert one row into
 * public.research_usage. Failure of the parse OR the insert is logged but
 * NEVER thrown — mirrors uploadWithAudit() invariant.
 */
export async function recordUsage(
  opts: RecordUsageOpts,
): Promise<RecordUsageResult> {
  const parsed = parseUsageSummary(opts.stdoutBuf, opts.exitCode, opts.finalJobStatus);

  try {
    const { error } = await opts.sb.from("research_usage").insert({
      research_queue_id: opts.researchQueueId,
      organization_id: opts.organizationId,
      job_status: parsed.job_status,
      exit_code: parsed.exit_code,
      is_error: parsed.is_error,
      api_error_status: parsed.api_error_status,
      stop_reason: parsed.stop_reason,
      terminal_reason: parsed.terminal_reason,
      duration_ms: parsed.duration_ms,
      duration_api_ms: parsed.duration_api_ms,
      ttft_ms: parsed.ttft_ms,
      num_turns: parsed.num_turns,
      input_tokens: parsed.input_tokens,
      cache_creation_tokens: parsed.cache_creation_tokens,
      cache_read_tokens: parsed.cache_read_tokens,
      output_tokens: parsed.output_tokens,
      total_cost_usd: parsed.total_cost_usd,
      model_usage: parsed.model_usage,
      raw_json: parsed.raw_json,
    });

    if (error) {
      console.warn(
        `[usage-tracking] research_usage insert failed (non-blocking): ${error.message}`,
      );
      return { ok: false, parsed, reason: error.message };
    }

    return { ok: true, parsed };
  } catch (insertEx) {
    const msg = (insertEx as Error).message;
    console.warn(`[usage-tracking] research_usage insert threw (non-blocking): ${msg}`);
    return { ok: false, parsed, reason: msg };
  }
}
