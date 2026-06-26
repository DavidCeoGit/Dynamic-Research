import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { MAX_JOB_COST_CENTS } from "./worker-config.js";
import type { ResearchJob } from "../types.js";

function log(context: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${context.slice(0, 8)}] ${msg}`);
}

// ── S69: in-flight cost estimator ──────────────────────────────────
//
// Scans an in-progress `claude -p --output-format json --verbose` stdout
// buffer for `"type":"assistant"` events and sums their `usage` token
// blocks. Uses Opus 4.7 published rates as worst-case approximation (over-
// estimates when subagents run on Sonnet/Haiku — fine, triggers cap earlier
// → safer). Returns rough cents; exact billing comes from the result event
// at exit (handled by usage-tracking.ts). Tolerates partial buffers — the
// brace-counter just stops at the first unclosed event.
function estimateInFlightCostCents(stdoutBuf: string): number {
  // Opus 4.7 rates per million tokens (USD)
  const INPUT_PER_MTOK = 15.0;
  const OUTPUT_PER_MTOK = 75.0;
  const CACHE_WRITE_PER_MTOK = 18.75;
  const CACHE_READ_PER_MTOK = 1.50;

  let inputT = 0;
  let cacheWriteT = 0;
  let cacheReadT = 0;
  let outputT = 0;
  let searchFrom = 0;

  while (searchFrom < stdoutBuf.length) {
    const usageIdx = stdoutBuf.indexOf('"usage":', searchFrom);
    if (usageIdx === -1) break;

    // Confirm this usage block belongs to an assistant message (look back
    // ~600 chars — assistant header + message fields fit comfortably).
    const lookbackStart = Math.max(0, usageIdx - 600);
    const lookback = stdoutBuf.slice(lookbackStart, usageIdx);
    if (!lookback.includes('"type":"assistant"')) {
      searchFrom = usageIdx + 8;
      continue;
    }

    // Find the opening '{' of the usage object value
    let i = usageIdx + '"usage":'.length;
    while (i < stdoutBuf.length && stdoutBuf[i] !== '{') i++;
    if (i >= stdoutBuf.length) break;

    // Brace-count to find matching '}' (string-aware, same pattern as
    // usage-tracking.ts:225-240 recovery parser).
    let depth = 0;
    let inStr = false;
    let esc = false;
    let endIdx = -1;
    for (let j = i; j < stdoutBuf.length; j++) {
      const c = stdoutBuf[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { endIdx = j; break; }
      }
    }
    if (endIdx === -1) break;  // partial event mid-buffer; retry next tick

    try {
      const u = JSON.parse(stdoutBuf.slice(i, endIdx + 1)) as {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
      inputT += u.input_tokens ?? 0;
      cacheWriteT += u.cache_creation_input_tokens ?? 0;
      cacheReadT += u.cache_read_input_tokens ?? 0;
      outputT += u.output_tokens ?? 0;
    } catch {
      // Skip — likely a partial fragment or unfamiliar shape
    }

    searchFrom = endIdx + 1;
  }

  // Cents = (sum of tokens × $/Mtok) / 1_000_000 × 100 = (...)/10_000
  const costUsd =
    (inputT * INPUT_PER_MTOK +
      outputT * OUTPUT_PER_MTOK +
      cacheWriteT * CACHE_WRITE_PER_MTOK +
      cacheReadT * CACHE_READ_PER_MTOK) /
    1_000_000;
  return Math.floor(costUsd * 100);
}

// ── Claude CLI spawner ──────────────────────────────────────────────

/**
 * S82: Build the env passed to the `claude -p` child process. Strips
 * `ANTHROPIC_API_KEY` so the spawned claude CLI falls through to the
 * OAuth subscription (claude.ai Max) instead of billing the Anthropic
 * API account. The API key remains in `process.env` for Phase 0a/0b
 * direct Anthropic API calls in `lib/plan-transports.ts` — only the
 * child process's view is stripped.
 *
 * Also strips:
 *   - Parent-session CLAUDE_* markers that would confuse the child CLI's
 *     session-resume logic (pre-S82 behavior, preserved).
 *   - `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (S82 Gemini round 1
 *     finding [ADDITIONAL-ANTHROPIC-VARS]): any of these could redirect
 *     the child claude CLI away from the OAuth subscription endpoint
 *     after the API key strip, defeating the fix.
 *   - Provider routing/auth vars for Bedrock / Vertex / Foundry / AWS
 *     (S82 Codex round 1 finding [PROVIDER-ENV-SHADOWS], sourced from
 *     https://code.claude.com/docs/en/env-vars). Without these, an
 *     inherited `CLAUDE_CODE_USE_BEDROCK=true` would route the child
 *     CLI to AWS Bedrock billing, again defeating the fix.
 *
 * Deletion is **case-insensitive** (S82 Gemini round 1 finding
 * [ENV-CASE-INSENSITIVITY]): on Windows, `process.env` is a
 * case-insensitive proxy but `{ ...parentEnv }` produces a plain object
 * with case-preserved keys. A case-naive `delete` would miss any
 * non-canonical casing that the OS would still merge into the canonical
 * name when passed to `CreateProcess`. UPPER_SNAKE is the conventional
 * casing for `.env` files, so this is defense-in-depth rather than a
 * known live exposure.
 *
 * Pure function: does not mutate the input env.
 *
 * Root cause + history: feedback_anthropic_api_key_shadows_subscription_in_executor.md
 * — recurring credit-out events S76 ($4.09), S81 ($10.94), S82 ($12.57).
 */
const CLAUDE_SPAWN_ENV_STRIP_KEYS = [
  // Parent-session markers (pre-S82 behavior, preserved).
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  // S82 root cause: API account billing shadow.
  "ANTHROPIC_API_KEY",
  // S82 Gemini round 1 [ADDITIONAL-ANTHROPIC-VARS]: alternate auth +
  // endpoint redirect that would defeat the API key strip.
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  // S82 Codex round 1 [PROVIDER-ENV-SHADOWS]: provider-routing vars
  // documented at https://code.claude.com/docs/en/env-vars that would
  // route the child CLI to Bedrock / Vertex / Foundry / AWS instead
  // of claude.ai OAuth Max. The invariant we want is "spawned claude -p
  // uses claude.ai Max OAuth" — strip all known routing overrides.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
] as const;

export function buildClaudeSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };
  const stripUpper = new Set<string>(CLAUDE_SPAWN_ENV_STRIP_KEYS.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (stripUpper.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  env.CLAUDE_CODE_ENTRYPOINT = "worker";
  return env;
}

/**
 * S64: returns getStderr() in addition to existing getStdout() so the
 * exit-nonzero catch path can pass stderrTail to classifyTerminalError().
 * Stderr buffer is capped the same way as stdout (8MB tail-preserve).
 */
export function spawnClaude(prompt: string, cwd: string, mcpProxyConfigPath: string): {
  child: ChildProcess;
  getStdout: () => string;
  getStderr: () => string;
} {
  // Sprint 3 Phase A1 (Codex C-3, S70): conditional --mcp-config insertion
  // under EXECUTOR_MCP_VIA_PROXY env flag. Default false (dark-launch). When
  // true, routes ALL MCP traffic through agent/mcp-proxy/index.ts. A1 ships
  // the proxy as passthrough scaffold; A2 adds L3/L5/L10 policies; A3 adds
  // L9 vendor-cache. --strict-mcp-config matches the OQ#11 spike pattern
  // (only the proxy's declared servers; no merge with ~/.claude.json).
  // See Documentation/sprint3-mcp-proxy-design-gate.md §4 Phase A1.
  const useProxy = process.env.EXECUTOR_MCP_VIA_PROXY === "true";
  // S173 decomposition principle 9 (path re-anchor): mcpProxyConfigPath is now
  // computed by executor.ts (which stays at agent/) and passed in. Deriving it
  // from THIS module's own location would re-root to a nonexistent
  // agent/lib/mcp-proxy/… dir and silently bypass the proxy. It resolves to
  // agent/mcp-proxy/mcp-config.json. See design §6.4.

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--verbose",
    ...(useProxy
      ? ["--mcp-config", mcpProxyConfigPath, "--strict-mcp-config"]
      : []),
    "--allowedTools", [
      "Bash", "Read", "Write", "WebSearch", "WebFetch",
      "mcp__perplexity__perplexity_research",
      "mcp__perplexity__perplexity_ask",
      "mcp__perplexity__perplexity_search",
      "mcp__perplexity__perplexity_reason",
      "mcp__Chrome_DevTools_MCP__list_pages",
      "mcp__Chrome_DevTools_MCP__new_page",
      "mcp__Chrome_DevTools_MCP__select_page",
      "mcp__Chrome_DevTools_MCP__navigate_page",
      "mcp__Chrome_DevTools_MCP__take_snapshot",
      "mcp__Chrome_DevTools_MCP__fill",
      "mcp__Chrome_DevTools_MCP__click",
      "mcp__Chrome_DevTools_MCP__type_text",
      "mcp__Chrome_DevTools_MCP__press_key",
      "mcp__Chrome_DevTools_MCP__evaluate_script",
      "mcp__Chrome_DevTools_MCP__take_screenshot",
    ].join(","),
  ];

  if (useProxy) {
    log("spawn", `[EXECUTOR_MCP_VIA_PROXY=true] routing MCP via ${mcpProxyConfigPath}`);
  }
  log("spawn", `claude ${args.slice(0, 2).join(" ")} [... ${args.length} args]`);

  const childEnv = buildClaudeSpawnEnv(process.env);

  const child = crossSpawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const MAX_BUF_BYTES = 8 * 1024 * 1024;
  const TRIM_TO_BYTES = 6 * 1024 * 1024;

  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuf += data.toString();
    if (stdoutBuf.length > MAX_BUF_BYTES) {
      stdoutBuf = stdoutBuf.slice(-TRIM_TO_BYTES);
      log("claude:out", `[buffer-trim] stdoutBuf >8MB; trimmed to last 6MB (result event at tail; recovery parser handles head truncation)`);
    }
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      log("claude:out", line.slice(0, 200));
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    stderrBuf += data.toString();
    if (stderrBuf.length > MAX_BUF_BYTES) {
      stderrBuf = stderrBuf.slice(-TRIM_TO_BYTES);
    }
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      log("claude:err", line.slice(0, 200));
    }
  });

  return { child, getStdout: () => stdoutBuf, getStderr: () => stderrBuf };
}

// ── Process completion waiter ───────────────────────────────────────

/** Why a watched `claude -p` was SIGTERM'd, or NONE if it exited on its own. */
export type KillReason = "NONE" | "DURATION" | "COST";

/**
 * S136 Layer 2 — pure recovery-eligibility decision (unit-tested without the
 * private process internals). A worker may ONLY attempt studio-artifact
 * recovery after a kill when ALL hold:
 *   - the kill was the MAX_JOB_DURATION cap (NOT the cost cap),
 *   - NO terminal error was classified (credit/auth/billing/model — a
 *     duration kill that ALSO emitted one must stay fail-fast), and
 *   - a notebook_id exists to recover from.
 * Cost-cap kills and terminal errors are NEVER recovery-eligible (Gemini
 * MERGE CRITICAL-2 cost-bypass guard / Codex K-4).
 */
export function shouldRecoverAfterDurationKill(
  killReason: KillReason,
  hasTerminalError: boolean,
  hasNotebookId: boolean,
): boolean {
  return killReason === "DURATION" && !hasTerminalError && hasNotebookId;
}

export function waitForProcess(
  child: ChildProcess,
  job: ResearchJob,
  getStdout?: () => string,
): Promise<{ code: number; killReason: KillReason }> {
  const maxDuration = Number(process.env.MAX_JOB_DURATION_MS) || 5_400_000;
  const SLEEP_THRESHOLD_MS = 5 * 60 * 1000;
  const TICK_MS = 30_000;
  // S69: cost check runs every 2 ticks (60s) — less aggressive than time
  // check; the parser walks the whole buffer each call which is cheap but
  // not free at multi-MB scale.
  const COST_CHECK_EVERY_N_TICKS = 2;

  return new Promise((resolve, reject) => {
    let lastTick = Date.now();
    let activeMs = 0;
    let killAttempted = false;
    // S136 Layer 2: record WHY we killed so the exit handler can distinguish a
    // recoverable duration cap-kill from a cost-cap kill (which stays fail-fast).
    let killReason: KillReason = "NONE";
    let tickCount = 0;

    const deadlineCheck = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      tickCount++;

      if (gap < SLEEP_THRESHOLD_MS) {
        activeMs += gap;
      } else {
        log(job.id, `Detected ${Math.round(gap / 60000)}min gap (system sleep?) — not counting toward MAX_JOB_DURATION`);
      }

      if (activeMs > maxDuration && !killAttempted) {
        killAttempted = true;
        killReason = "DURATION";
        log(job.id, `Job exceeded max active duration (${maxDuration}ms; active ${Math.round(activeMs / 60000)}min) — killing`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000);
      }

      // S69: per-job cost cap. Second-line defense — plan-review gate
      // (enforce=true since S68) catches most runaway prompts upfront for
      // ~$0.20; this catches in-execution runaways (model loops, retry
      // storms, unbounded tool use). Skip if disabled (cap=0) or stdout
      // accessor not provided (back-compat for callers that don't wire it).
      if (
        !killAttempted &&
        MAX_JOB_COST_CENTS > 0 &&
        getStdout !== undefined &&
        tickCount % COST_CHECK_EVERY_N_TICKS === 0
      ) {
        const estCents = estimateInFlightCostCents(getStdout());
        if (estCents > MAX_JOB_COST_CENTS) {
          killAttempted = true;
          killReason = "COST";
          log(
            job.id,
            `Job exceeded cost cap (est $${(estCents / 100).toFixed(2)} > $${(MAX_JOB_COST_CENTS / 100).toFixed(2)}) — killing`,
          );
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000);
        }
      }
    }, TICK_MS);

    child.on("exit", (code) => {
      clearInterval(deadlineCheck);
      resolve({ code: code ?? 1, killReason });
    });

    child.on("error", (err) => {
      clearInterval(deadlineCheck);
      reject(err);
    });
  });
}
