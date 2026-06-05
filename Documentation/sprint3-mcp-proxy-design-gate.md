# Sprint 3 — MCP Proxy + Conditional Direct-SDK Migration DESIGN gate (v3 FINAL — post-sequential MRPF)

**Status:** v3 FINAL after sequential MRPF (Gemini Round 1 → integrate v2 → Codex Round 2 → integrate v3). S69, 2026-05-29/30 UTC. Ready for promote to `Documentation/sprint3-mcp-proxy-design-gate.md` + companion `-peer-review.md`.
**Parent design:** [`api-cost-reduction-design-gate.md`](./api-cost-reduction-design-gate.md) §8 Sprint 3 + §9 OQ #11/#12.
**Scope:** L15 (MCP proxy) — unlocks L3 + L5 + L9 + L10 — plus conditional L1 Phase 2 (direct-SDK executor migration). Out of scope: Sprint 4 Batch API L4 (its own DESIGN gate).

---

## Round changelogs

**v1 → v2 (Gemini Round 1):**
- **G-1 CRITICAL** integrated. Added §4 Phase 0 ("OQ#11 spike — MUST run before architecture commitment"). §2 architecture-comparison matrix updated to make the OQ#11 decision branch explicit. §5 OQ#11 reframed from "open question" to "blocking spike — run BEFORE design freeze". Author's recommendation in §2 split into two paths conditional on spike outcome.
- **G-2 MAJOR** integrated. §7 ROI table recalculated with mutually exclusive token economics — once L1/L5 cache 90% of a tool_result block, L3/L9/L10 save only the remaining 10% on the cached portion. Per-lever savings revised downward; total Sprint 3 unlock revised from $5-12.50/run to $1.50-5.50/run.
- **G-3 MAJOR** integrated. §3 L9 reframed: the original "replace tool_result with `{ref: hash}` reference" spec produces the Context Amnesia Paradox (Claude loses access to the facts mid-synthesis). v2 scopes L9 to **vendor-side dedup only** (skip duplicate Perplexity API calls; replay cached result text to Anthropic with full body intact). Saves Perplexity cost ($0.02-0.10/run) but NOT Anthropic token cost. ROI in §7 updated accordingly.
- **G-4 MAJOR** integrated. §4 Phase 2 effort estimate revised. Arch B must include an in-process MCP client to drive the existing Chrome DevTools MCP server's stdio — pulled in via `@modelcontextprotocol/sdk` TypeScript client. Added as explicit Phase 2 sub-step; effort estimate raised by 2 days. §6 added explicit risk entry for MCP protocol-bridge complexity.
- **G-5 MINOR** integrated. §4 Phase 5 shadow validation now explicitly requires diffing the `system` block emitted by Arch B against the actual `system` block the CLI generates (via worker.log capture of an Arch A baseline run). Catches implicit `.claude/settings.json` / hook injections that worker mode relies on without realizing.

**Items Gemini caught as well-handled (PRESERVED VERBATIM — must not be weakened in v3):**
- OQ#11 correctly identified as the architectural linchpin (the order of resolution was wrong; the framing was right).
- Phase 5 shadow validation + dark-launch flip is mature, standards-aligned mitigation for core-loop rewrites.
- Sprint 4 (Batch API L4) genuinely needs a direct-SDK posture eventually, which provides secondary justification for Arch B even if Arch A wins the short-term battle.

**v2 → v3 (Codex Round 2):**
- **C-1 MAJOR** integrated. v2 §4 Phase B5 step 17 + §8 reviewer task assumed worker.log/raw_json could serve as the CLI `system`-block baseline. Codex grounded: `agent/executor.ts:887-789` truncates `[claude:out]` lines to 200 chars (so worker.log can't reconstruct the system block) AND `agent/lib/usage-tracking.ts:291-297` intentionally stores ONLY the final result event in `raw_json` (no assistant turns). v3 replaces the baseline source: §4 Phase B5 step 17 now specifies a dedicated one-shot **baseline-capture** harness — a temporary spawn with `--output-format stream-json` (untruncated) writing assistant turns to `sandbox/cli-baseline-<topic>.json` — separate from production logging.
- **C-2 MAJOR** integrated. v2 §2/§3 claimed L3 (trim unreferenced tool_result) and L10 (replace snapshot with ref if not re-read) work in pure Path A. Codex grounded: the MCP proxy is request/response middleware over the MCP wire ONLY; it CANNOT observe Claude's NEXT assistant message to know what was referenced. v3 splits L3/L10 by sub-mechanism: a **static** variant (always trim/replace after N seconds OR if size > X) runs in Path A; a **reference-aware** variant (trim only what next-turn doesn't cite) requires Path B. Path A ROI revised downward; §7 ROI tables updated; §3 lever specs reflect the split.
- **C-3 MAJOR** integrated. v2 §2 Arch A claim "executor unchanged except `--mcp-config` points at proxy" is incorrect against `agent/executor.ts:838-860` — current spawn args have no `--mcp-config` flag at all. v3 §4 Phase A1 adds explicit step: modify spawnClaude args at executor.ts:838 to insert `--mcp-config <path>` conditional on the `EXECUTOR_MCP_VIA_PROXY` flag + add a rollback test (one with-proxy + one without-proxy job; compare cost/result deltas; verify MCP traffic flows through proxy via log inspection).
- **C-4 MAJOR** integrated. v2 §2 Arch B Pro #3 + §10 references called `plan-transports.ts` a "proven architectural template" for direct-SDK migration. Codex grounded: `agent/lib/plan-transports.ts:638-642` + `:727-731` only build user-only message arrays (no tools); `:659-664` + `:742-747` extract response text. The file covers SDK credential plumbing + dynamic-import patterns ONLY. It does NOT cover tools, `tool_use` / `tool_result` blocks, stop_reason handling, streaming, multi-turn history, or `cache_control`. v3 reworded Arch B Pro to "credential plumbing + dynamic-import precedent" (not "agent-loop template"); added Phase B0 (SDK agent-loop spike, 0.5 days) BEFORE Phase B3 to verify the multi-turn tool-using shape works against `@anthropic-ai/sdk` before locking estimates. Path B total raised from 8 to 8.5 days; Combined Sprint 3+4 still favors Path B.
- **C-5 MAJOR** integrated. v2 §4 Phase B2 step 8 said Bash/Read/Write/WebSearch/WebFetch get "direct implementation (no MCP)" with no further spec. Codex grounded: these are Claude Code BUILT-INS via `agent/executor.ts:843-844` `--allowedTools`. The `@anthropic-ai/sdk` path used in `plan-transports.ts` has no equivalent tool runtime. v3 §4 Phase B2 step 8 expanded with per-tool implementation + security-boundary spec: Read/Write → Node fs scoped to per-job workDir; Bash → child_process.exec with allow-list patterns and per-call timeout, denying network spawns; WebSearch → Brave Search API (no Claude built-in equivalent); WebFetch → undici with content-length cap + URL allow-list. §6 added explicit risk for tool-runtime re-implementation security surface.
- **C-6 MINOR** integrated. v2 §4 Phase A1/B2 required `@modelcontextprotocol/sdk` but did not include a "pnpm add" step; `agent/package.json` does not currently list it. v3 added explicit dependency steps at §4 Phase A1 step 0a and Phase B2 step 6a. v2 also referenced "17 currently-allowed tools" at §6 risk #7 + §8 reviewer task; actual allow-list at `agent/executor.ts:843-859` is 20 tools (Bash + Read + Write + WebSearch + WebFetch + perplexity 4 + Chrome DevTools 11 = 20). v3 corrected all "17 tools" to "20 tools".

**Items Codex caught as well-handled (PRESERVED VERBATIM — must not be weakened):**
- OQ#11 promotion to a blocking spike before architecture commitment (v2 §4 Phase 0).
- L9 rescope to vendor-side replay preserves Anthropic context (v2 §3 L9 v2 spec).
- Current telemetry already captures CLI cache token fields for Sprint 1 measurement (`agent/lib/usage-tracking.ts:285-288`).

---

## 1. Why Sprint 3 exists

Sprint 1 deployed `ENABLE_PROMPT_CACHING_1H=1` (S67, 2026-05-29). Pre-existing worker.log telemetry already shows `cache_read_input_tokens:157404` on a single recent `claude -p` event — strong evidence Claude Code's auto-`cache_control` on system prompt + tools is firing at the default 5-min TTL. Sprint 1's 3-job measurement will confirm whether L1 (the implicit baseline cache) is silently saving $2-5/run today and whether L2 (TTL extension) adds the projected $0.50-2/run for cross-job continuity.

Whatever Sprint 1 returns, Sprint 3 levers remain the next-biggest ROI block after L1+L2. The savings ranges below have been revised downward from v1 to account for the cache/trim mutual-exclusivity uncovered by Gemini G-2:

| Lever | What it does | Sprint 1 savings | Sprint 3 unlock (REVISED v2) |
|---|---|---|---|
| L3 | Trim redundant Perplexity tool_result blocks inside a turn | N/A | $0.30-0.80 (was $1-3 — cache reduces per-token cost 90%; trim saves only the residual 10%) |
| L5 | Add cache_control breakpoints to large Perplexity tool_results (F3) | N/A | $0.80-1.80 (was $1-2 — assumes 2+ re-reads per cached block, breakeven at 2 turns) |
| L9 | Vendor-side dedup of repeat Perplexity searches (RESCOPED v2 — vendor cost only, NOT Anthropic tokens) | N/A | $0.02-0.10 (was $0.50-1.50 — full body still sent to Anthropic to preserve synthesis quality) |
| L10 | Strip large Chrome DevTools snapshot blobs from re-sent context | N/A | $0.30-0.80 (was $0.50-1 — same cache-vs-trim economics as L3; only UI-heavy jobs benefit) |
| **L15 sum** | **MCP proxy intercept + per-tool-result policy** | — | **$1.02-2.50 (Path A) / $1.42-3.50 (Path B w/ ref-aware) consolidated** |
| L1 Phase 2 (cond.) | Direct-SDK executor migration; explicit cache_control placement | — | $2-5 (conditional on Sprint 1 measurement — unchanged from v1; cache-economics primary effect not double-counted) |

**Re-evaluation triggered by G-2:** the v1 sum of $5-12.50/run conflated cache savings (a 90% reduction on cached tokens) with trim/dedup savings (a 100% reduction on the residual 10%). v2 ROI total: **$1.50-5.50/run** combined (still material on a $10/run baseline but no longer the dominant lever block).

The Codex C-1 CRITICAL finding from the parent design (S66) established the architectural constraint: `agent/executor.ts:733-799` delegates ALL MCP calls inside `claude -p` and only captures stdout after the subprocess exits. There is **NO executor-layer access** to `tool_result` blocks between Claude's tool calls. Any lever that needs to read, modify, deduplicate, or annotate `tool_result` content MUST live in either (a) a proxy layer sitting between Claude Code and the MCP servers, or (b) a direct-SDK executor that orchestrates the agent loop itself.

This DESIGN gate decides **which path** (or hybrid) to take — but the decision is **gated on OQ#11 spike** (see §4 Phase 0).

---

## 2. Three candidate architectures

### Architecture A — Pure MCP Proxy
```
executor.ts → spawnClaude(--mcp-config <proxy-config>) → claude -p
                                                            ↓ MCP wire (stdio/HTTP)
                                                         [PROXY] ← (new service)
                                                            ↓
                                            perplexity-mcp / chrome-devtools-mcp
```
- Proxy intercepts every `tools/call` request → forwards to real MCP server → intercepts response → applies per-tool policy (dedup, trim, cache_control annotation, content-hash filter) → returns to Claude Code.
- Executor is unchanged except `--mcp-config` points at proxy.
- Proxy is a standalone Node service speaking MCP protocol on both sides.

**Pros:**
- Minimal executor change (one config-pointer flip)
- L3 + L5 + L9 + L10 all implementable as proxy-side rules (subject to OQ#11 for L5 specifically)
- Each MCP server's behavior unchanged; proxy is purely middleware
- Logging/debugging surface concentrated in one place
- **No re-implementation of Claude Code's accumulated production hardening** (preflight, terminal-error classification, stream parsing, JSON-mode coercion)

**Cons:**
- ⚠ **OQ#11 dependency on L5 specifically:** Does Claude Code's MCP wire format pass `cache_control` metadata THROUGH `tool_result` blocks to the upstream Anthropic API? If NO → proxy cannot inject cache breakpoints. L3 + L9 + L10 still work. L5 + arguably L1 Phase 2 become unrecoverable from a pure-proxy posture. **Per G-1 integration:** resolve this empirically via Phase 0 spike before architectural commitment.
- New service to operate (process management on Windows: another Scheduled Task? Wrapped in worker-start.bat?)
- Per-tool-call latency: every MCP request now traverses one extra hop
- MCP protocol versioning: when Claude Code upgrades, the proxy must keep up
- Security surface: a misbehaving proxy can corrupt or leak ALL tool_result content

### Architecture B — Direct-SDK Executor (L1 Phase 2 full migration)
```
executor.ts → @anthropic-ai/sdk Messages.create({...}) — agent loop in-process
                ↓
              MCP tool calls dispatched via @modelcontextprotocol/sdk (G-4 v2 add)
                ↓
              perplexity-mcp / chrome-devtools-mcp (or direct API calls)
```
- Replace `claude -p` subprocess with direct `@anthropic-ai/sdk` invocation. Architecturally bundles with L1 Phase 2.
- Executor owns the agent loop: reads Anthropic response, dispatches tool calls, accumulates tool_result, sends next turn.
- Full control over `cache_control` placement, tool_result content, message history.
- L3, L5, L10 all become "edit the messages array before send". (L9 unchanged from rescope — see §3.)

**Pros:**
- Direct cache_control control on EVERY block (system, tools, tool_result, user)
- No MCP protocol-version coupling to Claude Code
- `plan-transports.ts` already uses `@anthropic-ai/sdk` directly — **credential plumbing + dynamic-import precedent ONLY** (Codex C-4: `plan-transports.ts:638-642` + `:727-731` build single-shot user-only message arrays; `:659-664` + `:742-747` extract response text. The file does NOT cover tools, tool_use/tool_result blocks, stop_reason handling, streaming, multi-turn history, or cache_control). Phase B0 (NEW — see §4) runs a 0.5-day SDK agent-loop spike to verify the multi-turn tool-using pattern before locking Phase B3 estimate.
- Per-turn instrumentation/observability is trivial (it's all in-process)
- Eliminates the `--max-turns N` cap as a defensive parameter (executor IS the loop)
- Unlocks Sprint 4 (Batch API L4) naturally (also needs direct SDK)
- L5 NOT gated on OQ#11

**Cons (Gemini G-4 expanded):**
- Large refactor: executor.ts is 1000+ lines built around `claude -p` semantics
- Loses Claude Code's built-in slash-command system, `/promote` skill, `/end-session`, hooks, settings.json behavior — but these aren't relevant inside the worker subprocess anyway (per `agent/AGENTS.md` execution rules: "Skip Phase 0.5 Steps A-E", "do NOT invoke /promote", etc.)
- Need to re-implement: tool-call dispatching, recursion limits, error classification, stream parsing, JSON-mode coercion
- **G-4 expanded:** Anthropic SDK speaks Anthropic REST, not MCP. To keep using `chrome-devtools-mcp` (and avoid porting it to Playwright), executor must include an in-process MCP client — pulled in via `@modelcontextprotocol/sdk` TypeScript client — handling JSON-RPC lifecycle, capability negotiation, stdio transport, and schema translation from MCP `tools/call` → Anthropic `tool_use`. **Adds 2 dev days to Phase 2.**
- Removes the `node --env-file=.env` → `claude -p` env-inheritance pattern that just landed in Sprint 1; executor reads env directly (already does for ANTHROPIC_API_KEY)
- Bigger blast radius: bugs here break the entire worker pipeline
- Sprint 1's `ENABLE_PROMPT_CACHING_1H=1` becomes irrelevant — executor sets cache TTL explicitly per `cache_control: {type: "ephemeral", ttl: "1h"}`
- **G-5:** implicit Claude Code context accumulation (settings.json merging, prompt injections from `.claude/`, directory-level conventions) MUST be diffed against Arch B output in Phase 5 — see §4.

### Architecture C — Hybrid (proxy for tools, SDK for executor cache_control)
- Direct-SDK executor (Arch B) AS the agent loop owner
- Plus optional MCP proxy (Arch A scaled-down) only for tool-side dedup/trim where in-process logic is undesirable (e.g. cross-job content-hash dedup needs persistent state outside any one job)
- All cache_control placement done in executor (no OQ#11 dependency)

**Pros:**
- Cleanest cache_control control AND clean cross-job dedup story
- Each component does one thing well

**Cons:**
- Most work: both refactor executor AND build proxy
- Two new operational surfaces

### Architecture comparison matrix (revised v2 — OQ#11 branch explicit per G-1)

| Property | A if OQ#11=YES | A if OQ#11=NO | B (Direct-SDK) | C (Hybrid) |
|---|---|---|---|---|
| Effort | Medium (4.5 days w/ C-3 wiring + C-6 dep) | Medium (L5 unrecoverable; do A then also B) | High (8.5 days w/ C-4 spike + C-5 native-tool spec) | Highest |
| L3-static (size-cap trim) | Yes (proxy rule) | Yes | Yes | Yes |
| L3-reference-aware (REVISED v3 per C-2) | **NO** — proxy can't see Claude's next-turn references | NO | Yes (msg-edit between SDK turns) | Yes |
| L5 unlock | Yes (proxy injects cache_control) | **NO** — must wait for Arch B | Yes | Yes |
| L9 unlock (RESCOPED v2 — vendor cost only) | Yes (proxy cache) | Yes (proxy cache) | Yes (in-process cache) | Yes |
| L10-static (size-sig cache) | Yes (proxy rule) | Yes | Yes | Yes |
| L10-reference-aware (REVISED v3 per C-2) | **NO** — same reason as L3-reference-aware | NO | Yes (msg-edit between SDK turns) | Yes |
| L1 Phase 2 | Conditional separate work | Conditional separate work | **Bundled** | Bundled |
| Sprint 4 (L4 Batch) | Separate work later | Separate work later | **Pre-positioned** | Pre-positioned |
| Operational surface | +1 service | +1 service then refactor | 0 new services + native-tool runtime | +1 service |
| Test surface | MCP protocol mock | MCP protocol mock + SDK mock later | Anthropic SDK + MCP-client mock + native-tool mocks | Both |
| Rollback story | Flip EXECUTOR_MCP_VIA_PROXY=false | Flip EXECUTOR_MCP_VIA_PROXY=false | Revert executor.ts (large) | Both |
| Per-tool-call latency | +1 hop | +1 hop | unchanged | +1 hop on tools using proxy |

**Author's revised recommendation (G-1 integration):** **Defer the architecture decision until OQ#11 spike runs.** Two paths:

- **If OQ#11=YES → Architecture A.** Avoids the 5-6+ day rewrite and the G-4 MCP-client implementation surface. Proxy-side cache_control injection is the cheapest path to L5. L1 Phase 2 stays open as a separate later Sprint conditional on Sprint 1 measurement. Total Sprint 3: 2-3 dev days.
- **If OQ#11=NO → Architecture B.** Worth the 7-8 dev days because L5 + L1 Phase 2 are otherwise unrecoverable, AND Sprint 4 (Batch API) needs the direct-SDK posture anyway. Architecture A becomes a sunk-cost detour.

The OQ#11 spike (§4 Phase 0) takes ~30 minutes of engineer time + ~$1 of Anthropic API cost. Versus 5-6 days of risk on the wrong architecture choice — the spike is the dominant first move regardless of what the v1 author preferred.

---

## 3. Detailed lever spec per architecture

### L3 — Trim redundant Perplexity tool_result blocks (SPLIT v3 per Codex C-2)
- **L3-static (Path A capable):** Truncate or summarize any `perplexity_search` tool_result whose body exceeds N bytes (default 8KB) BEFORE returning it to Claude — same N-byte cap regardless of whether Claude will reference it next turn. Loses some search-result fidelity but is implementable as pure MCP middleware (request/response only — no need to see Claude's next assistant message). Savings: $0.10-0.30/run.
- **L3-reference-aware (Path B only):** Track Claude's tool_use → tool_result chain in the executor; when the NEXT assistant turn cites only a subset of result fragments, drop the unreferenced fragments before the following SDK call. Higher savings because it preserves the cited fragments at full fidelity. Requires assistant-message visibility — only Path B exposes this. Savings: $0.30-0.80/run.
- **Why the split:** Codex C-2 verified the MCP proxy in Path A sees only `tools/call` request and `CallToolResult` response over the MCP wire — it cannot observe Claude's NEXT assistant message (which is what determines what was referenced). v1/v2 conflated the two mechanisms; v3 separates them so the ROI table accurately reflects which path unlocks which sub-mechanism.

### L5 — Add cache_control breakpoints to large Perplexity tool_results (F3)
- **Definition:** Anthropic supports `cache_control: {type: "ephemeral"}` on `tool_result` blocks. A 15K Perplexity result re-read at 0.1× costs ~$0.005 vs ~$0.05 fresh; breakeven at 2 turns.
- **Arch A:** Proxy injects `cache_control` into tool_result before Claude Code reads it. **Requires OQ#11 = YES** (Claude Code must pass cache_control THROUGH to Anthropic API).
- **Arch B:** Direct: `messages.push({role: "tool", content: [{...result, cache_control: {type: "ephemeral", ttl: "1h"}}]})`. Trivial.
- **Arch C:** Same as B.
- **Savings (revised G-2):** $0.80-1.80/run — biggest cache-economics lever in Sprint 3 because Perplexity blocks are the largest individually-cacheable units re-read across multiple turns within a single job.

### L9 — Vendor-side dedup of repeat Perplexity searches (RESCOPED v2 per Gemini G-3)
- **v1 spec (DEPRECATED — caused Context Amnesia Paradox):** SHA-256 hash snippet bodies; replace repeat tool_results with `{ref: <hash>, see: <prior-turn-id>}` to save Anthropic tokens.
- **v2 spec (SAFE):** When a Perplexity query's `(prompt, params)` signature matches a prior call in the same job (or cross-job, see §5 OQ#14), skip the outbound HTTP call to Perplexity and replay the previously-returned `result` text verbatim into Claude's context. **Anthropic still receives the full body** — Claude's synthesis-time access to the facts is preserved. Only Perplexity vendor API cost is saved.
- **Arch A:** Proxy maintains a `(prompt_hash, params_hash) → result_body` cache; serves replay when hit.
- **Arch B:** Executor in-process map (per job) + Supabase table (`perplexity_call_cache`) for cross-job hits.
- **Arch C:** Proxy holds it.
- **Savings (revised G-3):** **$0.02-0.10/run** — Perplexity API list pricing is ~$0.005-0.015 per call (Sonar Pro tier). Dedup of 5-10 repeat calls saves at most $0.10. Materially smaller lever than v1 estimated. May not pencil out vs implementation cost — see §7 ROI re-evaluation.
- ⚠ Hazard from v1 dropped: the "ref/expand" complexity is moot. Cache is a transparent vendor-cost optimization that does not alter the message stream to Anthropic.

### L10 — Strip large Chrome DevTools snapshot blobs (SPLIT v3 per Codex C-2)
- **L10-static (Path A capable):** Cache snapshot blob server-side after first delivery; on second-or-later identical-input snapshot calls within the same job session, return a small `<snapshot-id: ...>` reference instead of re-shipping the full DOM. Implementable as MCP middleware (proxy only needs to track its own per-session cache, no visibility into Claude's messages). Savings: $0.10-0.30/run on UI-heavy jobs; near-zero on non-UI.
- **L10-reference-aware (Path B only):** Replace full snapshot blob with a reference in subsequent message-array sends IF the next assistant turn does not cite specific DOM elements from it. Requires assistant-message visibility — only Path B exposes this. Savings: $0.30-0.80/run on UI-heavy jobs.
- **Why the split:** Same as L3 — the MCP proxy can't observe Claude's reference patterns. v3 separates the static (proxy-implementable) from the reference-aware (Path B only).
- ⚠ **Note on L10's G-3 cousin risk (preserved from v2):** Unlike L9 v1, L10 replacement WITH IDS is acceptable because the assistant typically extracts a small piece of the DOM (e.g., a button selector) within the same turn as the snapshot read. Full DOM blob is rarely re-referenced in synthesis. The L10-static variant simply caches blobs by input-signature; downstream re-use is the cache-hit path, no Claude reference tracking required.

### L1 Phase 2 — Direct-SDK executor migration (conditional)
- **Trigger:** Sprint 1 measurement shows `cache_read_tokens ≈ 0` on jobs 2-3 → Claude Code is NOT auto-firing cache_control well enough → need explicit placement.
- **Trigger NOT fired:** Sprint 1 measurement shows healthy cache_read → L1 baseline is silently booked → L1 Phase 2 is optional.
- **Arch A:** L1 Phase 2 stays open as separate Sprint after Sprint 3 — proxy can't inject cache_control without OQ#11=YES.
- **Arch B:** L1 Phase 2 IS Sprint 3 — same architectural work.
- **Arch C:** L1 Phase 2 IS Sprint 3.

---

## 4. Implementation plan (gated by OQ#11 spike)

### Phase 0 — OQ#11 spike (G-1 critical integration) — RUN FIRST, BEFORE COMMITTING TO ARCH

**Question:** Does Claude Code's MCP wire format pass `cache_control` metadata THROUGH `tool_result` blocks to the upstream Anthropic API?

**Method (30 min engineer time, ~$1 Anthropic cost):**
1. Write `sandbox/oq11-spike-mcp.mjs` — a minimal MCP server (stdio transport) that exposes one tool, `echo_with_cache_control`, returning a tool_result block of ~5KB text with `cache_control: {type: "ephemeral", ttl: "5m"}` attached at the block level.
2. Write `sandbox/oq11-prompt.md` — a prompt that asks Claude to call `echo_with_cache_control` THREE times in sequence with the same input (to force what would be a cache hit if cache_control persists).
3. Spawn: `claude -p --mcp-config sandbox/oq11-mcp-config.json --output-format json --verbose < sandbox/oq11-prompt.md`.
4. Parse the final result event; specifically read `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`.

**Decision rule:**
- `cache_read_input_tokens > ~5000` on call 2 or 3 → **OQ#11 = YES**. Cache control persists through the MCP wire. Pursue Architecture A.
- `cache_read_input_tokens ≈ 0` on all calls → **OQ#11 = NO**. Claude Code strips block-level cache_control on tool_result. Pursue Architecture B.
- Ambiguous (some cache hit, but suspiciously small) → run again with a 30KB tool_result to push above the noise floor; document the result either way.

**Output:** New file `Documentation/oq11-spike-result-<DATE>.md` recording the verdict + measured token counts + prompt/config used (reproducibility).

### IF OQ#11 = YES → Path A (Architecture A, Pure MCP Proxy)

#### Phase A1 — Proxy scaffold + executor wiring (1.5 days)
0a. **Codex C-6 NEW:** `pnpm -C agent add @modelcontextprotocol/sdk` — the package is NOT currently in `agent/package.json:11-18` and is needed for both proxy ends.
1. Create `agent/mcp-proxy/` directory + `index.ts` entrypoint.
2. Use `@modelcontextprotocol/sdk` Server class to expose proxy as MCP server (stdio); use `@modelcontextprotocol/sdk` Client class to upstream-connect to real `perplexity-mcp` + `chrome-devtools-mcp` stdio processes.
3. Per-tool routing table: `{tool_name: {upstream: "perplexity-mcp", policy: ["L5", "L9-vendor-cache"]}}`.
4. Add `EXECUTOR_MCP_VIA_PROXY=true|false` feature flag to `agent/.env`; default `false`.
5. Wire `worker-start.bat` to launch proxy as a sibling process when flag is `true`.
6. **Codex C-3 NEW: executor spawn args modification.** Edit `agent/executor.ts:838-860` (spawnClaude args builder): conditional on `process.env.EXECUTOR_MCP_VIA_PROXY === "true"`, INSERT `"--mcp-config", path.join(__dirname, "mcp-proxy/mcp-config.json")` BEFORE `--allowedTools`. The mcp-config JSON declares the proxy as the MCP server endpoint. Without this step, Claude Code never routes through the proxy regardless of whether the proxy is running.
7. **Codex C-3 NEW: rollback-verification test.** Run TWO jobs back-to-back on the same topic (one with `EXECUTOR_MCP_VIA_PROXY=true`, one with `false`). Inspect proxy logs to confirm the `true` run shows MCP traffic flowing through proxy; confirm the `false` run shows zero proxy log activity. Compare cost/tokens between runs to baseline L5 savings ceiling.

#### Phase A2 — L3 + L5 + L10 policies (1.5 days)
6. L5: on `tool_result` from `perplexity_search` if size >5KB, inject `cache_control: {type: "ephemeral", ttl: "1h"}` block annotation. Validate via `usage.cache_creation_input_tokens` growth.
7. L3: track Claude's tool_call→tool_result chain inside the proxy session-context; when a turn references only a subset, drop unreferenced blocks from re-sent context (note: this requires the proxy to also see Claude's NEXT turn — implementation requires a turn-buffer that holds the last N tool_results until next assistant message confirms references).
8. L10: same shape as L5; for `chrome_devtools_take_snapshot` results >50KB, replace with shorter reference token IF L3-style turn-reference-tracking shows the snapshot isn't re-read.

#### Phase A3 — L9 vendor cache (0.5 days)
9. Add `perplexity_call_cache` Supabase table: `(prompt_hash text, params_hash text, body text, created_at timestamptz, expires_at timestamptz)`.
10. Proxy intercepts perplexity tool_calls; computes `(prompt_hash, params_hash)`; checks cache; serves from cache if hit + non-expired; else upstream-calls + writes back.

#### Phase A4 — Shadow + dark launch (1 day)
11. Run 3 small/cheap jobs in BOTH modes (proxy on + proxy off) via `EXECUTOR_MCP_VIA_PROXY`. SQL-compare cost.
12. Per [[feedback_dark_launch_for_integration_gates]]: ship with proxy-off default, flip per-job for first 5-10 jobs, then promote to default.

**Path A total: 4.5 dev days** (was 4 in v2; Codex C-3 + C-6 added 0.5 day for explicit `--mcp-config` wiring + dependency add). L1 Phase 2 stays open as separate later Sprint conditional on Sprint 1 measurement.

### IF OQ#11 = NO → Path B (Architecture B, Direct-SDK Executor)

#### Phase B0 — SDK agent-loop spike (NEW v3 per Codex C-4 — 0.5 days)
0a. Write a standalone script `sandbox/sdk-agent-loop-spike.mjs` exercising `@anthropic-ai/sdk` `Messages.create()` with: (a) one MCP-style tool definition, (b) tool_use stop_reason handling, (c) tool_result block construction, (d) multi-turn message accumulation, (e) cache_control on system + tools. The script does ONE real tool round-trip (e.g., `echo` tool that returns the input) — enough to verify SDK shapes against the doc's assumptions BEFORE committing to Phase B3's 1-day estimate.
0b. **Decision rule:** if the spike works in <2h, Phase B3 estimate (1 day) holds. If the SDK has unexpected gotchas (e.g., streaming required for tool_use detection, schema-validation strictness, missing field), raise Phase B3 to 1.5 days + log finding to `Documentation/sdk-agent-loop-spike-result-<DATE>.md`.

#### Phase B1 — Scaffold (1 day)
1. Create `agent/lib/direct-executor.ts` — skeleton of `runJobViaDirectSDK(job)`.
2. Lift the `claude-prompt.md` template construction from `executor.ts` into a shared module both implementations call.
3. Add feature flag `EXECUTOR_MODE=cli|direct-sdk` to `agent/.env`; default `cli`.
4. Stub out tool-dispatch table.
5. Add Anthropic SDK import (already in dependencies via `plan-transports.ts`).
5a. **Codex C-6 NEW:** `pnpm -C agent add @modelcontextprotocol/sdk` — needed for the MCP-client bridge in Phase B2.

#### Phase B2 — Tool dispatch + MCP-client bridge (3 days — G-4 expansion + C-5 native-tool spec)
6. Pull in `@modelcontextprotocol/sdk` TypeScript client (already added Phase B1 step 5a).
7. For each MCP server still spawned (currently `perplexity-mcp` + `chrome-devtools-mcp`):
   - Use SDK Client class to drive its stdio transport
   - Map MCP `tools/list` capability discovery on startup
   - Bridge MCP `tools/call` request → Anthropic SDK `tool_use` block
   - Bridge upstream `CallToolResult` → Anthropic SDK `tool_result` block (preserving `is_error` flag)
8. **Codex C-5 EXPANDED:** Native tools (Bash/Read/Write/WebSearch/WebFetch) require explicit implementation + security boundaries — they exist only as Claude Code built-ins today and the Anthropic SDK provides no equivalent runtime. v3 per-tool spec:
   - **Read** → `node:fs/promises.readFile` scoped to `path.resolve` under per-job `workDir`; reject reads outside `workDir` with a structured error.
   - **Write** → `node:fs/promises.writeFile` same scoping; deny `.env`, `.git/`, secrets-bearing paths via deny-list regex.
   - **Bash** → `child_process.exec` with explicit allow-list patterns (initial scope: file/dir manipulation only; deny `curl`, `wget`, network-spawning binaries) + 30s per-call timeout + stdout/stderr 1MB cap. Mirrors the worker's own hardening pattern.
   - **WebSearch** → Brave Search API (no Claude Code equivalent in worker mode). Add `BRAVE_SEARCH_API_KEY` env var; respect rate-limits via `frontend/lib/rate-limit.ts` pattern adapted server-side.
   - **WebFetch** → `undici` with Content-Length cap (default 10MB), URL allow-list regex, redirect-following bounded to N=5, 30s timeout. Reject `file://`, `localhost`, and private IP ranges.
   - Document the boundaries in a new `agent/lib/native-tools.ts` module; security-review at MERGE-gate time per the project's security HARD RULE.
9. Validate tool_call → tool_result roundtrip with 1 hardcoded test prompt that exercises Perplexity + Chrome + all 5 native tools.

#### Phase B3 — Agent loop (1 day)
10. Implement `Messages.create()` loop: build messages array → SDK call → parse `stop_reason` → if `tool_use` → dispatch → append `tool_result` → loop.
11. Add cache_control placement: system prompt + tools (both with `ephemeral` 1h TTL), large tool_result blocks (per L5).
12. Add `max_iterations` guard (replacement for `--max-turns N`).

#### Phase B4 — Telemetry + dedup (1 day)
13. Wire `usage-tracking.ts` to ingest direct-SDK response shape (same `cache_creation_input_tokens` / `cache_read_input_tokens` fields).
14. Add `perplexity_call_cache` Supabase table for L9 vendor-side dedup.
15. Add per-tool-call logging to match `claude:out` / `claude:err` log shape so dashboards keep working — including a new `direct-sdk:tool` prefix.

#### Phase B5 — Shadow + system-block diff + flip (2 days — G-5 expansion)
16. Run 3 Tesla-style jobs in BOTH modes (cli + direct-sdk) via `EXECUTOR_MODE`. Compare outputs side-by-side for synthesis quality regression.
17. **G-5 integration (REVISED v3 per Codex C-1): diff the actual `system` block** that Arch B sends to Anthropic vs a dedicated CLI baseline capture. The v2 plan to extract baseline from worker.log/raw_json was WRONG: `agent/executor.ts:887-789` truncates `[claude:out]` lines to 200 chars, and `agent/lib/usage-tracking.ts:291-297` intentionally stores only the final result event in `raw_json` (no assistant/system turns). v3 baseline-capture spec:
    - One-shot: spawn a CLI subprocess with `--output-format stream-json` instead of `--output-format json` (untruncated streaming) + redirect ALL stdout to `sandbox/cli-baseline-<topic>-<DATE>.jsonl` without the executor's 200-char-line truncation
    - Parse the JSONL: find the `init` event whose payload includes the system prompt block; extract the `system` field verbatim
    - This is the diff baseline. Compare against Arch B's `Messages.create({system: <ours>, ...})` value
    - Any non-empty diff: either replicate in Arch B or document the omission with explicit acceptable-loss rationale
18. SQL: compare cost/job between modes.
19. Per [[feedback_dark_launch_for_integration_gates]] pattern: ship with `EXECUTOR_MODE=cli` default, flip per-job via env override for first 5-10 jobs, then promote to default.

**Path B total: 8.5 dev days** (was 5-6 in v1; G-4 added 2 to Phase B2; G-5 added 1 to Phase B5; Codex C-4 added 0.5 day for Phase B0 spike; Codex C-5 expanded Phase B2 step 8 within the existing 3-day budget). Sprint 4 (Batch API L4) becomes 1-2 more days on top, leveraging the Path B SDK scaffolding.

---

## 5. Open questions (UPDATED v2)

1. **OQ#11 — ELEVATED: blocking spike (G-1 integration).** Originally an open question; v2 reclassifies as Phase 0 spike. Must run before architecture commitment. Owner: next session. Cost: ~$1 + 30 min.
2. **OQ#12 (carried from parent):** Where does executor's "system-level guidance" live for L7 (verbosity)? **Answer (S67 partial):** `agent/executor.ts:700-714` constructs `claude-prompt.md` in-line; that IS the template. The system prompt itself comes from Claude Code's internal defaults, NOT from us. So L7 edits land in the in-line prompt construction — straightforward.
3. **OQ#13:** Chrome DevTools MCP in direct-sdk mode — keep spawning the MCP server stdio-side, or port to in-process Playwright? Latter is bigger refactor but eliminates one MCP dependency. **v2 lean:** Path B Phase B2 keeps stdio-side via `@modelcontextprotocol/sdk` client (G-4); Playwright port deferred to a later Sprint if Chrome MCP wedging (Bug #7) becomes a chronic blocker.
4. **OQ#14 (RESCOPED v2):** Cross-job vendor dedup (L9) cardinality bound — do we cap the `perplexity_call_cache` table at N entries? TTL on rows? Default proposal: `expires_at = created_at + interval '7 days'`, vacuum old rows nightly via a Supabase scheduled function.
5. **OQ#15:** When in direct-SDK mode, do we still need the preflight circuit breaker (S64 v3)? `claude auth status` is meaningless without claude.exe; cost-failure-loop detection moves to per-message API error classification in the executor itself.
6. **OQ#16:** EXECUTOR_MODE is per-worker not per-job — is there value in per-job override (e.g. for A/B testing single jobs without daemon restart)? Cost is one env-var lookup per job start.
7. **(NEW v2) OQ#17:** If OQ#11 = YES (Path A), the proxy itself becomes another MCP-protocol-version-coupling point. When Claude Code upgrades its MCP wire schema (we don't control its release cadence), the proxy must keep up or fail open-loop. What's the operational protocol for proxy MCP-version-drift? Default proposal: in-proxy MCP-protocol-version assertion at startup; mismatch logs a SECURITY-labeled alert and falls back to passthrough (no policy applied).

---

## 6. Risks

1. **Direct-SDK quality regression (Path B only)** — `claude -p` has accumulated production hardening (preflight, terminal-error classification, output parsing, JSON streaming edge cases). Direct-SDK re-implements these in-house; surface area for new bugs is large. **Mitigation:** Phase B5 shadow validation + dark-launch flip.
2. **Cost regression in shadow window** — running 3 jobs in BOTH modes doubles cost during validation. **Mitigation:** Phase 5 uses 3 small/cheap topics, not Tesla-class. Budget: $10-30 for shadow phase.
3. **Loss of Claude Code feature parity (Path B only)** — if executor ever needs to invoke a Claude Code slash command or skill, direct-SDK has none. **Mitigation:** worker mode already disables /promote, /end-session, etc.; per AGENTS.md the worker calls NO Claude Code features. Risk is near-zero today.
4. **Anthropic SDK version drift (Path B only)** — `@anthropic-ai/sdk` major versions occasionally rename fields (e.g. `max_tokens_to_sample` → `max_tokens`). **Mitigation:** version-pin in package.json; smoke-test on bump via the existing test suite.
5. **Operational maturity gap (Path B only)** — Claude Code's `claude auth status`, model selection UX, telemetry of session_id, etc. all evaporate in direct-SDK. **Mitigation:** OQ#15 — re-architect preflight + cost-failure-loop in executor; document the loss.
6. **Sprint 1 work redundancy** — the env var deployed today (`ENABLE_PROMPT_CACHING_1H=1`) becomes irrelevant in Path B mode. **Mitigation:** it's already free + harmless when EXECUTOR_MODE=cli; remove from .env if/when cli mode is retired.
7. **(G-4 NEW v2; corrected v3 per Codex C-6) MCP-client schema-bridge complexity (Path B only)** — bridging `@modelcontextprotocol/sdk` Client request/response shapes to/from `@anthropic-ai/sdk` Messages.create tool_use/tool_result block shapes is a non-trivial translation layer with edge cases (e.g. how does MCP `CallToolResult.isError` map to Anthropic `tool_result.is_error`? How are multi-content-block MCP results flattened?). **Mitigation:** Phase B2 explicit 3-day budget; smoke-test against the **20 currently-allowed tools** in worker mode (Bash + Read + Write + WebSearch + WebFetch + 4 perplexity + 11 Chrome DevTools, per `agent/executor.ts:843-859`); maintain a `mcp-bridge-translation-table.md` in `Documentation/` as the contract record.
8. **(G-5 NEW v2) Implicit CLI context drift (Path B only)** — Claude Code's CLI silently merges `.claude/settings.json`, injects from `.claude/prompts/`, applies directory-level conventions, and resolves hooks. If any of this is load-bearing for the worker's output quality, Arch B silently degrades. **Mitigation:** Phase B5 step 17 (system-block diff) catches this empirically. Document any discovered injection as an explicit Arch B duty.
9. **(NEW v2) OQ#11 spike cost** — running the spike costs ~$1 of API and a flat 30 min of engineer time. Per the design risk asymmetry, the spike is the dominant first move regardless of inclination. No mitigation needed; budget it.
10. **(C-5 NEW v3) Native-tool runtime re-implementation security surface (Path B only)** — Phase B2 step 8 spec re-implements Bash/Read/Write/WebSearch/WebFetch as direct Node code. Each is a fresh path-traversal / SSRF / command-injection / arbitrary-write attack surface that Claude Code's built-in versions already harden. **Mitigation:** explicit per-tool security boundaries documented in Phase B2 step 8 of v3 (allow-list patterns + path scoping + content-length caps + URL filtering); `agent/lib/native-tools.ts` MERGE-gate review required by both Gemini AND Codex per the project's SECURITY label HARD RULE before any Path B job runs against real research traffic.
11. **(C-1 NEW v3) Baseline-capture harness reliability (Path B only)** — Phase B5 step 17 baseline capture spec runs `claude --output-format stream-json` once to extract the CLI's `system` block. If the CLI silently changes its stream-json shape between captures (or between baseline capture and Arch B comparison), the diff is unreliable. **Mitigation:** version-pin Claude Code CLI used for baseline capture; record CLI version in `sandbox/cli-baseline-<topic>-<DATE>.jsonl`'s metadata; re-capture if CLI version changes during Sprint 3.

---

## 7. Lever ROI table (Sprint 3 only — REVISED v4 per S73 L5 spike)

**Revision history:**
- v2 (Gemini G-2 round 1): added L9 rescope
- v3 (Codex C-2/C-3/C-6 round 2): split L3/L10 into static (Path A) vs reference-aware (Path B); dropped Path A from $1.42-3.50 to $1.02-2.50
- **v4 (S73 L5 spike, 2026-05-30):** dropped L5 entirely from both paths per `Documentation/l5-spike-result-2026-05-30.md`. Claude Code auto-caches large MCP tool_results regardless of user-attached `cache_control`; the L5 lever provides ZERO incremental value. Path A drops from $1.02-2.50 to $0.72-1.70; Path B drops from $3.42-8.50 to $2.62-6.70. Architecture decision (Path A locked) is UNCHANGED — Sprint 4 (L4 Batch) ROI gap was already dominated by L4 itself, not L5.

### IF OQ#11 = YES → Path A (Architecture A) — REVISED v4

| Rank | Lever | Effort (dev days) | Savings/run @$10 baseline | Risk |
|---|---|---|---|---|
| 1 | L3-static (proxy: size-cap truncation only) | 0.5 | $0.10-0.30 | Low (reference-aware L3 requires Path B per C-2) |
| 2 | L10-static (proxy: cache snapshot by input-sig) | 0.5 | $0.10-0.30 | Low (saves upstream-API call cost only per Codex C-2 S72, NOT Claude input tokens; reference-return requires Path B) |
| 3 | L9 (vendor-cache, rescoped) | 0.5 (proxy + Supabase table) | $0.02-0.10 | Very low; may not pencil out vs eng cost |
| Phase 0 spike | OQ#11 | 0 (already done) | — | — |
| Phase 0b spike | L5 disambiguation (S73) | 0 (already done) | — | — |
| Operational | Proxy scaffold + executor --mcp-config wiring (C-3) + @modelcontextprotocol/sdk add (C-6) + rollback-test | 1.5 | — | Medium (new service + spawn-args edit) |
| Auto-mechanism | Claude Code auto-cache on large MCP tool_results | 0 (already operational) | $0.30-0.80 (incumbent, attributed to L1/L2 footprint) | None — already shipping |
| **Total** | **L13-static via proxy + auto-cache incumbent** | **4.0** | **$0.72-1.70** | **Medium (one new service)** |

**~~L5 (cache_control on tool_result) — REMOVED v4.~~** Per S73 L5 spike: Variant A (with cache_control) and Variant B (without cache_control) produced IDENTICAL per-turn cache_read patterns on tool_result blocks (~7,674 tokens cached per ~18KB block both ways). Mechanism is Claude Code auto-cache, not user passthrough. The $0.30-0.80/run originally attributed to L5 already exists in the production cache footprint and rolls into the L1/L2 (5min/1h cache TTL) telemetry. See `Documentation/l5-spike-result-2026-05-30.md` for the per-turn evidence.

**Path A savings dropped vs v3** ($1.02-2.50 → $0.72-1.70) because L5 was double-counted: the cache_read it was supposed to unlock was already happening via auto-cache. The Path A operational scaffold is unchanged; the lever count is now 3 (L3-static + L10-static + L9).

### IF OQ#11 = NO → Path B (Architecture B) — REVISED v4

| Rank | Lever | Effort (dev days) | Savings/run @$10 baseline | Risk |
|---|---|---|---|---|
| 1 | L1 Phase 2 (cond.) | 0 incremental | $2-5 if Sprint 1 measurement shows cache_read ≈ 0 | Already mitigated by Sprint 1 measurement |
| 2 | L3-reference-aware (full unlock) | 0.5 | $0.30-0.80 | Low |
| 3 | L10-reference-aware (full unlock) | 0.5 | $0.30-0.80 | Low (UI jobs only) |
| 4 | L9 (vendor-cache, rescoped) | 0.5 + Supabase table | $0.02-0.10 | Very low; may not pencil out vs eng cost |
| Phase 0 spike | OQ#11 | 0 (already done) | — | — |
| Phase B0 spike | SDK agent-loop pattern (C-4) | 0.5 | — | Low — but validates Phase B3 estimate |
| Operational | Direct-SDK scaffold + MCP-client bridge (G-4) + native-tool runtime (C-5) + system-block diff via dedicated baseline harness (G-5/C-1) | 6 | — | High (large refactor + new translation layer + new tool security surface) |
| Auto-mechanism | Claude Code auto-cache (still applies in Path B since direct-SDK can re-attach cache_control directly without proxy layer) | 0 | $0.30-0.80 (incumbent) | None |
| **Total** | **L14 unlock + L1 P2 (cond.) + B0 spike** | **8.0** | **$2.62-6.70** | **High (one big refactor + native-tool security surface)** |

**~~L5 (cache_control on tool_result) — REMOVED v4 from Path B too.~~** In Path B (direct-SDK), the proxy isn't in the picture, so user code COULD attach cache_control directly to upstream content blocks. But the L5 spike shows Claude Code auto-cache is already doing this for large tool_results — Path B users wouldn't need to add cache_control either. The L5 lever was illusory in both paths.

**Cost-effectiveness ratio (Path A vs Path B) — REVISED v4:**
- Path A: $0.72-1.70 / 4.0 days = ~$0.30/day saved
- Path B: $2.62-6.70 / 8.0 days = ~$0.58/day saved BUT pre-positions Sprint 4 ($3-5/run from Batch API)

**Including Sprint 4 (L4 Batch) pre-positioning:**
- Path A: Sprint 4 then requires separate SDK migration anyway → 5+ more days for L4
- Path B: Sprint 4 is +1-2 days on top of Path B

**Combined (Sprint 3 + Sprint 4) — REVISED v4:**
- Path A → A→A4: 4.0+5 = 9.0 dev days for $0.72-1.70 (Sprint 3) + $3-5 (Sprint 4) = $3.72-6.70/run savings → $0.58/day
- Path B → B→B4: 8.0+1.5 = 9.5 dev days for $2.62-6.70 (Sprint 3) + $3-5 (Sprint 4) = $5.62-11.70/run savings → $0.91/day

→ **Path B remains dominant when Sprint 4 is included** ($0.58 vs $0.91 per day). The gap narrowed slightly vs v3 ($0.61 vs $0.99) because L5's removal hit Path B harder in absolute terms ($0.80 lost vs Path A's $0.80 lost — same absolute, smaller % of base). The architecture lock on Path A (per OQ#11=YES) stands; if Sprint 4 ever ships, the Path A → Path B migration cost remains the gating concern, not Sprint 3's lever count.

### What this revision DOES NOT change

- Architecture decision: Path A is still locked per OQ#11=YES (S69). The lock was on the operational question "can the proxy operate without breaking the cache layer?", not on L5 specifically. The auto-cache mechanism preserves Path A's operational viability.
- Sprint 3 A1 + A2 ship state: A1 (proxy scaffold) and A2 (L3 + L10 policies, L5 dropped at S72) remain LIVE on the worker. A3 (L9 vendor-cache) remains the next Sprint 3 phase to implement.
- Sprint 4 (L4 Batch API) remains the strategic unlock for the larger savings band — independent of Sprint 3's lever count.

### What this revision ADDS

- An "Auto-mechanism" row in both tables acknowledging the Claude Code auto-cache footprint as an INCUMBENT savings layer that L5 attempted to overlap. This makes the $0.30-0.80/run "ghost savings" explicit so future ROI revisions don't accidentally re-add it.
- A "Phase 0b spike" row noting the S73 L5 disambiguation was a follow-up to Phase 0 (OQ#11) — completes the spike provenance.

---

## 8. What reviewers should focus on (UPDATED v2 for Codex Round 2)

### For Codex (Round 2 — code-grounded on integrated v2)
- Verify the `agent/lib/plan-transports.ts` direct-SDK pattern actually generalizes to a tool-using agent loop (it's only used for single-shot reviewer calls today). Specifically: does it handle streaming, multi-turn message accumulation, and tool_use stop_reason?
- Check that the `@anthropic-ai/sdk` version pinned in `agent/package.json` supports `cache_control: {ttl: "1h"}` (newer field) AND `tool_use` / `tool_result` block types.
- **G-4 verification (RESOLVED v3 per Codex C-6):** `@modelcontextprotocol/sdk` is NOT in `agent/package.json:11-18`; v3 §4 Phase A1 step 0a + Phase B1 step 5a explicitly add it. MCP→Anthropic schema bridge effort estimated against the **20 currently-allowedTools** list at `agent/executor.ts:843-859`. Phase B2 budgets 3 dev days for the bridge + per-tool native implementation (Codex C-5 expansion).
- The `usage-tracking.ts` ingest path — verify the SDK response shape exactly matches the `parsed.usage` shape used today (S62 bug experience suggests SDK responses sometimes lack fields the CLI tail-line carries).
- The Supabase `perplexity_call_cache` table — schema sketch with TTL/cardinality cap (per OQ#14 v2 rescope).
- The preflight circuit breaker (S64 v3) — verify whether removing `claude auth status` from preflight in direct-SDK mode leaves any failure modes uncovered (e.g., Anthropic API key revocation). What signal replaces it?
- Operational concern: `worker.log` parsing assumes `claude:out` / `claude:err` line prefixes. Confirm no downstream consumer (Grafana dashboards? `feedback_grafana_alert_query_filter_footgun.md`?) breaks if we add `direct-sdk:tool` / `direct-sdk:out` prefixes.
- **G-5 verification:** Read `worker.log` for `[claude:out]` lines from a recent job and identify the `system` block content. Map any non-`claude-prompt.md` content (CLAUDE.md? settings.json prompts?) so Phase B5 step 17 has a known baseline to diff against.
- **OQ#11 spike spec:** Verify the proposed MCP-test-server skeleton is implementable as a standalone script. Identify any gotchas in `--mcp-config` JSON shape from prior Chrome MCP work.

### Both reviewers
- Is the OQ#11 spike methodology sound? Specifically: does the 3-call repeat actually exercise the cache_control path we want to test, or is there a confound (e.g. tool-result-block-level caching may be implicit on identical content even without explicit cache_control)?
- Severity Mode: **NORMAL**. No production-down pressure. Full sequential MRPF.

---

## 9. MRPF classification

- **Event Gate:** DESIGN (new subsystem, multi-day initiative, irreversible architecture decision).
- **Risk Labels:** ARCHITECTURE (cross-module boundary change), DEPENDENCY (direct-SDK migration), INFRA (if Path A chosen — new service). AGENT BEHAVIOR (proxy Path A reshapes tool_result flow to Claude; even Path B changes prompt/tool wire) — both reviewers mandatory regardless.
- **Severity Mode:** NORMAL.
- **Reviewer topology:** Sequential Gemini Round 1 → integrate v2 → Codex Round 2 → integrate v3 FINAL. Per [[feedback_multi_reviewer_gate_dependent_pattern]]. **v3 status:** COMPLETE — Gemini Round 1 produced 5 findings (1 CRITICAL + 3 MAJOR + 1 MINOR), all integrated into v2. Codex Round 2 produced 6 findings (treated as 1 MAJOR + 4 MAJOR + 1 MINOR based on doc-correctness impact), all integrated into v3. Both reviewers' "well-handled" lists preserved verbatim. Sequential MRPF complete; v3 ready for promote to `Documentation/`.

---

## 10. References

- Parent: `Documentation/api-cost-reduction-design-gate.md` §8 Sprint 3 + §9 OQ#11/#12 + §11 ROI table
- Empirical cache evidence: `agent/worker.log` grep for `cache_read_input_tokens:` (one value `157404` observed pre-L2)
- Direct-SDK template: `agent/lib/plan-transports.ts` lines 1-100 (uses `@anthropic-ai/sdk` dynamic import + env-driven model IDs)
- Telemetry ingest: `agent/lib/usage-tracking.ts:285-288` (already captures cache fields)
- Spawn pattern under replacement: `agent/executor.ts:733-799` (`spawnClaude` + `crossSpawn` + 17-tool allowedTools)
- MCP wedging risk reference: `~/.claude/skills/chrome-mcp-doctor/SKILL.md` (Bug #7 — Windows setContentsSize + profile-lock; relevant for OQ#13)
- L9 cross-job state: precedent at [[feedback_storage_path_scoping_is_the_boundary]] for org-scoped Supabase tables
- **(NEW v2)** MCP client SDK: `@modelcontextprotocol/sdk` (TypeScript) — npm package, MIT license, maintained by Anthropic
- **(NEW v2)** S69 incident reference for cost-conscious architecture: `Documentation/multi-reviewer-policy-framework.md` §4 (dark-launch pattern that informed Phase 5 / Phase B5 step 19)

---

**End of v3 FINAL.** Sequential MRPF complete. Next step: promote to `Documentation/sprint3-mcp-proxy-design-gate.md` + write companion `Documentation/sprint3-mcp-proxy-design-gate-peer-review.md` synthesis. Then schedule Phase 0 (OQ#11 spike, ~30 min, ~$1 cost) to resolve the architecture branch BEFORE any Sprint 3 implementation work.
