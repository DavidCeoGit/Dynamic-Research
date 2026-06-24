# MCP-Proxy connect/callTool Timeout Fix — MERGE-gate Peer Review

**Gate:** MERGE · **Risk label:** AGENT BEHAVIOR (changes the worker's MCP tool-call
failure semantics; propagates to every future research run) · **Severity:** NORMAL ·
**Topology:** sequential Gemini (holistic-adversarial) → Codex (grounded-adversarial),
both adversarial, plus an inline Claude grounded SDK-source pass.
**Date:** 2026-06-16 (DR S133) · **Artifact under review:** `sandbox/index.ts`
(staged revision of `agent/mcp-proxy/index.ts`).

## VERDICT: BLOCK — do NOT promote. The fix does not do what it claims.

All three lenses independently reached BLOCK. The change is well-intentioned hardening,
but its centerpiece is **inert** against the installed SDK, and its stated root-cause
premise is **mechanically false**. Promoting it would add complexity and a *longer*
silent-hang window (120s vs the current 60s) without fixing the Arrowhead S130 failure.

### What each reviewer saw
- **Gemini (gemini-3.1-pro-preview):** full NEW source of the file embedded inline in the
  prompt (it cannot read gitignored `sandbox/`), plus verified SDK facts. Holistic
  whole-artifact adversarial read. Did NOT have live SDK source access.
- **Codex (`codex exec -s workspace-write`, ChatGPT auth):** read `sandbox/index.ts` +
  `agent/mcp-proxy/index.ts` + the installed `@modelcontextprotocol/sdk` dist/esm source
  directly, and **ran live probes against SDK 1.29.0**.
- **Claude (inline, this session):** grounded read of `protocol.js` / `client/index.js` /
  `client/stdio.js` in the installed SDK; originated Claims 1 & 2 that Codex then confirmed.

---

## CRITICAL findings (block-worthy)

### C1 — `resetTimeoutOnProgress: true` is INERT, and `maxTotalTimeout` is DEAD with it
**Confirmed by Codex (live probe) + Claude grounded read. This is the main blocker.**

The fix passes `{ timeout, resetTimeoutOnProgress: true, maxTotalTimeout }` to `callTool`
but **no `onprogress` callback**. In the SDK:
- `protocol.js:643` — the progress handler is registered, AND the `progressToken` is
  injected into the request `_meta`, **only** inside `if (options?.onprogress) { ... }`.
  Without `onprogress`, the upstream is never even *asked* to emit progress.
- `protocol.js:424–434` — `_onprogress()` ignores any notification whose token has no
  registered handler, and only calls `_resetTimeout()` when a handler exists AND
  `resetTimeoutOnProgress` is true.
- `protocol.js:191` (Codex) — **`maxTotalTimeout` is only ever checked inside
  `_resetTimeout()`**, which only runs on a progress notification. No progress handling →
  `_resetTimeout()` never runs → **`maxTotalTimeout` is never evaluated at all.**

**Net effective behavior of the staged fix:** a hard `PROXY_CALL_TIMEOUT_MS` (120s) per
call. `resetTimeoutOnProgress` does nothing; the 600s `maxTotalTimeout` backstop is
unreachable. The stated goal — "let legitimately-slow streaming research survive past the
per-call timeout, with maxTotalTimeout as the hard backstop" — is **not achieved**.

Codex probe (SDK 1.29.0): without `onprogress`, a request had no progressToken and timed
out at the per-request timeout despite progress notifications; **with** `onprogress`, it
got a progressToken and correctly hit "Maximum total timeout exceeded."

---

## MAJOR findings

### M1 — Root-cause premise is mechanically false
**Confirmed by Codex + Claude.** The header comment claims the live code had "NO
RequestOptions, so each request inherited only the SDK's 60s default with NO absolute
ceiling," and that this caused the silent 90-min Phase-0 hang. But:
- `protocol.js:8` `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`; `protocol.js:712` always arms
  `timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`.
- `client/index.js:293` routes `initialize` (inside `connect()`) through
  `this.request(..., options)`; `client/index.js:495` routes `tools/call` likewise.
- `client/stdio.js:80` `start()` resolves on the `spawn` event (immediate).

So in the **live** code, both `initialize` and every `callTool` already had a 60s timeout,
and process spawn is not an unbounded wait. **A single proxy request cannot hang 90 minutes
in the current code.** Codex: the 90-min cap is far more consistent with the outer
`claude -p` process cap at `executor.ts:1561` — i.e., something *inside* the spawned
executor hung (possibly a retry-storm of 60s-timing-out tool calls, or a non-MCP Phase-0
stall), which these per-request knobs do **not** bound. The patch actually lengthens a
silent `callTool` hang from 60s → 120s.

### M2 — `callTool` timeout does not evict the cached client (upstream poisoning)
**New, Codex (grounded).** On a `callTool` timeout the SDK cancels the request
(`protocol.js:670`) but keeps the transport open; the fix only clears `cachedClient` on the
*connect* path. A wedged upstream therefore stays cached and poisons all subsequent calls
for the proxy-process lifetime.

### M3 — `listTools` still fails silent
**Gemini + Codex.** `sandbox/index.ts:283` catches and returns `{ tools: [] }` on upstream
failure. If `connect()` times out during the agent's initial tool discovery, Claude sees an
empty tool list and proceeds tool-less (hallucinate / silently degrade) rather than failing
loud. Contradicts the fix's own "fail loud" objective. (Pre-existing behavior, but directly
in scope because the fix's connect-timeout surfaces here.)

### M4 — `maxTotalTimeout` is not an independent hard timer (even with onprogress)
**Codex.** Because it's only checked on progress resets, if progress *stops* after a reset
the total wall time can overshoot `maxTotalTimeout` by up to one per-request `timeout`. Any
future design must treat it as approximate, not an exact ceiling.

---

## REFUTED / downgraded

### R1 — Gemini's "[CRITICAL] zombie process leak on connect timeout" → REFUTED
**Codex grounded refutation (corrects the holistic pass).** Gemini claimed the connect
catch leaks the spawned child because it never calls `transport.close()`. But SDK
`Client.connect()` already catches initialize errors and calls `void this.close()`
(`client/index.js:323` → `protocol.js:500` → `client/stdio.js:137` closes stdin then
SIGTERM/SIGKILL). Codex probe: child was briefly alive post-timeout, then SDK-killed. So
this is a **short async cleanup window, not a process leak.** A manual `transport.close()`
would make cleanup more *immediate/deterministic* but is optional, not block-worthy.
(Textbook breadth-vs-depth: the holistic lens flagged the right area, wrong mechanism —
see [[feedback_holistic_reviewer_can_misframe_mechanism]].)

### MINOR — redundant `maxTotalTimeout` on `connect()`
**Gemini + Codex + Claude.** `connect()` sets `timeout === maxTotalTimeout === CONNECT_MS`;
initialize emits no progress so `maxTotalTimeout` is redundant there. Drop it for clarity.

---

## Required rework before this can pass a re-gate (v2)

1. **Confirm the actual Arrowhead root cause FIRST (design question).** The 90-min hang was
   almost certainly the `executor.ts:1561` `claude -p` cap, NOT the proxy. Pull the
   Arrowhead worker.log window and identify where it actually stalled before reworking the
   proxy at all. If the stall was inside `claude -p` (non-MCP or a tool-error retry-storm),
   this proxy change is treating the wrong layer and should be re-scoped.
2. **If keeping per-call timeouts:** either (a) add an `onprogress` callback (a no-op or a
   stderr logger) so the SDK injects `progressToken` and `resetTimeoutOnProgress` +
   `maxTotalTimeout` actually engage — but ONLY if `perplexity_research` genuinely emits
   progress notifications (verify against the live perplexity MCP server; if it does not,
   onprogress buys nothing); OR (b) drop the progress machinery entirely and set a single
   sane per-call `timeout` sized above the longest legitimate `perplexity_research` call
   (the live 60s evidently sufficed in normal operation, so e.g. 180–300s is ample),
   accepting that a true silent hang waits that long.
3. **Evict the cached client on `callTool` timeout** (close + null `cachedClient`) so a
   wedged upstream cannot poison subsequent calls (M2).
4. **Make `listTools` fail loud** on connect/timeout failure instead of `{tools:[]}` (M3).
5. **Drop the redundant `connect()` `maxTotalTimeout`** (minor).
6. **No automated test covers the proxy timeout path.** Any v2 must add a test (e.g. a fake
   slow/hung upstream) — the MRPF AGENT-BEHAVIOR label requires answering the test question,
   and the inert-reset defect is exactly the class a test would have caught.

## Process notes
- Codex (grounded) was the decisive lens: it confirmed C1/M1 with a live SDK probe and
  refuted Gemini's CRITICAL leak — validating both the both-lenses-adversarial rule and the
  Gemini→Codex sequential order.
- Codex ran clean on ChatGPT auth (no quota/read-only block this round); `-s workspace-write`
  used so it could read file bodies on Windows (per [[feedback_codex_readonly_windows_cannot_read_file_bodies]]).
- This gate PREVENTED shipping a no-op fix. The staged `sandbox/index.ts` remains staged and
  BLOCKED; the live `agent/mcp-proxy/index.ts` is unchanged.
