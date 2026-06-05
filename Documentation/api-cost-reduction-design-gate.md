# DESIGN-Gate: Per-Run API Cost Reduction (v3 FINAL, post-Gemini + Codex sequential MRPF)

**Status:** v3 FINAL. POST sequential Gemini Round 1 → integrate → Codex Round 2 → integrate. Ready for /promote to `Documentation/api-cost-reduction-design-gate.md`. Author: Claude Opus 4.7. Session: S66, 2026-05-29.

**Round 1 changelog (Gemini → v2):**
- **G-1 CRITICAL**: L6 (server-side `clear_tool_uses_20250919`) **DROPPED** from rollout — incompatible with L3 (cache_control on tool_result) because server-side clearing mutates the byte sequence and busts every cache_control hash downstream of the cleared block. Cannot interleave dynamic clearing and strict prefix caching in the same session.
- **G-2 MAJOR**: L9 mechanism changed from URL-set dedup to **content-hash dedup** (SHA-256 of snippet body, URL as fast first-pass filter only).
- **G-3 MINOR**: Added Open Question #10 — does Claude Code CLI natively support Batch API?
- **G-4 MINOR**: §8 Sprint 2 gates L7 commit behind empirical shadow-run validation of final-deliverable quality.

**Round 2 changelog (Codex → v3):**
- **C-1 CRITICAL**: L3 and L9 are **not implementable as originally described** — `executor.ts` delegates ALL MCP calls inside `claude -p` and only captures stdout after. There is no executor-layer access to `tool_result` blocks between Claude's tool calls. Both levers move from Low/Medium-effort harness edits → High-effort MCP proxy infrastructure (consolidated as new lever **L15** below). Their ROI ranking drops accordingly; they move from Sprint 2 → Sprint 3.
- **C-2 MAJOR**: L1 was overstated as a "single edit". Current `spawnClaude` writes the full execution brief to `claude-prompt.md` and asks the CLI to read it — there is no programmatic system block we control. Fix: L1 becomes "**instrument first, then decide**". `usage-tracking.ts:285-288` already captures `cache_creation_input_tokens` + `cache_read_input_tokens`, so baseline measurement requires zero new code. If `cache_read_tokens > 0` is observed on real jobs, Claude Code auto-cache_control is already firing and L1 savings are silently in the baseline. If not, L1 requires direct-SDK migration (Sprint 3 territory).
- **C-3 MAJOR**: L11 **DROPPED** — full job is ONE `claude -p` spawn (no sequential CLI invocations within job), `spawnClaude` explicitly deletes `CLAUDE_CODE_SESSION_ID`, and `job.id` already exists as a UUID. No cache-amortization opportunity in current architecture; reconsider only if/when worker adds retry/resume.
- **C-WELL-HANDLED items**: 7 architectural assumptions confirmed safe — see Codex's "Items already correct" list in the peer-review companion doc. Most consequential: `usage-tracking.ts` already captures cache-token fields (closes Open Question #1 architecturally), `@anthropic-ai/sdk` is already a direct dependency used in `plan-transports.ts` (closes Open Question #10 architecturally — direct-SDK path partially in place), no `research_preview_2026_02` usage in agent/ (batch path is open), plan-review gate cost is independent of executor caching levers (no cross-impact).

**MRPF classification:**
- **Event Gate:** DESIGN — architectural decision affecting per-job cost model + executor harness + caching strategy. Multi-week impact.
- **Risk Labels:** INFRA (env vars, worker spawn config), ARCHITECTURE (cache_control placement, optional MCP proxy, optional batch path), AGENT BEHAVIOR (verbosity-constraint prompt edits change executor output shape).
- **Severity Mode:** NORMAL.
- **Reviewer topology:** Sequential Gemini → integrate → Codex (per ~/CLAUDE.md HARD RULE for DESIGN-fresh artifacts).

---

## 1. Problem statement

Dynamic Research worker pipeline currently costs ~$10 per research run. Cost is dominated by Anthropic API spend on the Claude Code CLI executor:

| Source | Estimated share |
|---|---|
| Output tokens (Opus 4.7 @ $25/MTok) | ~$8.50 |
| Input tokens (Opus 4.7 @ $5/MTok) | ~$1.50 |
| Plan-review gate (Gemini + Codex synthesis) | ~$0.22 (S65 Tesla replay) |
| Local probes (preflight, file I/O) | $0 |

Concrete spawn: `agent/executor.ts:738-760` calls `claude -p <prompt>` via `cross-spawn` with NO `--model` flag → defaults to global Opus 4.7. Typical run: ~50K input prompt, 30-90 min wall-clock, 50-150K output tokens, multiple MCP tool calls (Perplexity research, Chrome DevTools, Bash, file I/O).

**Goal:** reduce per-run cost by ≥40% (target ≤$6/run) WITHOUT quality regression on the final deliverable.

---

## 2. Hard constraints

- **NO quality regression on the final research deliverable.** User-stated constraint. Main-model swap (Opus → Sonnet on the executor) is NOT acceptable absent independent benchmark evidence that the swap is safe. Sub-task model routing (Haiku for compression sidecar) IS acceptable.
- **Windows 11 + Git Bash + PowerShell** environment; worker runs as Scheduled Task (5-min cron, NOT a supervisor — see [[feedback_scheduled_task_is_cron_not_supervisor]]).
- **90-min wall-clock cap** per `claude -p` spawn (see [[feedback_worker_spawn_90min_cap]]).
- **Worker daemon must not be killed without explicit user authorization** (CLAUDE.md §6 HARD RULE).
- **Sandbox + /promote workflow** required for any `agent/*`, `frontend/*`, `supabase/*`, `Documentation/*` writes (CLAUDE.md §5).

---

## 3. Research methodology

Custom Workflow run (`wf_56d160f3-f3d`, 2026-05-29) launched 5 parallel research clusters via Perplexity deep-research (`reasoning_effort=high`) + WebFetch on official Anthropic docs, on Sonnet 4.6 to keep meta-cost low. Plain-text returns (no structured-output schema) after the canonical `/deep-research` skill failed catastrophically (106 agents, 2.47M tokens, 0 outputs) due to schema-enforcement bug.

**Cluster outcomes:**

| # | Topic | Status |
|---|---|---|
| 1 | Claude Code CLI flags + Anthropic prompt-cache mechanics | ✓ returned |
| 2 | Batch API + provider arbitrage (Bedrock/Vertex/OpenRouter) | ✓ returned |
| 3 | Architectural decomposition + Sonnet 4.6 vs Opus 4.7 benchmarks | ✗ FAILED (6 stalls × 180s each) |
| 4 | Context-window pricing tiers + output-token reduction | ✓ returned |
| 5 | MCP tool-result pruning + production cost patterns | ✓ returned |

**Cluster 3 gap impact:** the Sonnet-4.6-vs-Opus-4.7 head-to-head benchmark question is unresolved. This DOES NOT affect the recommended levers below because the user's no-quality-regression constraint means we keep Opus on the main executor regardless. The gap matters only if we later want to revisit main-model swap — flagged as Open Question #1.

All cited claims below have a `[src: URL]` marker. Where the research found weak or contradicted evidence, that is flagged explicitly.

---

## 4. Headline factual findings (myth-bust priority)

These overturn assumptions a reader might bring in. Confirm before designing around them.

| # | Finding | Implication |
|---|---|---|
| F1 | **Opus 4.7 has FLAT 1M-context pricing — NO 200K threshold premium.** The 200K cliff exists only on Sonnet 4.5 / Sonnet 4 1M-context betas, not on any Opus variant. [src: Anthropic pricing page; 2026-03-13 GA confirmation] | Context-trimming for cost is NOT motivated by tier-crossing on Opus. Trim only for cache-hit-rate purposes (F4). |
| F2 | **Anthropic Batch API: 50% discount applies + tool use IS supported + MCP IS supported.** Perplexity Sonar initially claimed tool use was unsupported in batch — directly contradicted by current Anthropic docs. Only the `research_preview_2026_02: "active"` beta header is excluded. [src: Anthropic message-batches docs] | Pipeline phases with no cross-call state dependency (per-source summarization, citation formatting, transcript rewriting) can move to batch for a hard 50% discount. |
| F3 | **`cache_control` is valid on `tool_result` blocks, not just on the prefix.** Place a breakpoint on a large Perplexity tool_result; it caches at 1.25× write cost, reads at 0.1× on turns 2+. Breakeven ≈ 2 turns. [src: Anthropic prompt-caching docs] | A 15K Perplexity result re-read at 0.1× vs 1.0× saves ~90% of its recurring input cost across the synthesis loop. |
| F4 | **Claude Code CLI auto-places `cache_control` on system prompt + tools, but defaults to 5-MINUTE TTL on API-key auth** (1h on subscription auth). `ENABLE_PROMPT_CACHING_1H=1` env var opts API-key auth into 1-hour TTL at 2× write cost (vs 1.25×). [src: Claude Code prompt-caching docs] | Cross-job cache continuity within the 5-min cron window requires the 1h TTL. Critical for batched/sequential job patterns. |
| F5 | **Cache hit detection is byte-exact and cumulative on the prefix hash.** Any single-byte change anywhere before the breakpoint busts the cache — including the CLI's auto-injected `cc_version`/`cch` dynamic header and the working directory string. [src: Anthropic prompt-caching docs; GitHub cline/cline #9892] | Cross-spawn cache hits via `claude -p` cold-start are rare in practice. `--resume <session-id>` reconstructs an identical prefix from local JSONL → reliable cache hit within TTL. |
| F6 | **Opus 4.7 uses a new tokenizer that inflates token counts 0-35% vs Opus 4.6** on code/JSON content. Nominal $/token is unchanged; cost-per-character can rise up to 35%. [src: Anthropic pricing page tokenizer note] | The $10/run baseline may itself be ~10-20% higher than the Opus 4.6 equivalent. All percentage-savings estimates compound on the inflated baseline. |
| F7 | **Anthropic Context Editing API beta (`context-management-2025-06-27` header + `clear_tool_uses_20250919` strategy)** auto-clears old tool_result blocks server-side when context grows past threshold. Zero harness content changes. [src: Anthropic context-editing docs] | Lowest-friction option for Chrome DevTools DOM-snapshot accumulation (large, single-use). Conflicts with F3 (cache_control on tool_result) — pick one per block type. |
| F8 | **`max_tokens=N` does NOT save money if model would have stopped before N.** Billing is per token actually emitted. [src: Anthropic rate-limits docs] | Don't expect savings from tightening `max_tokens` unless the model is actually hitting the cap today. |
| F9 | **Two-pass pattern (verbose draft → concise rewrite) is ~9-10× MORE expensive than a single careful call.** Pass-1 output tokens are billed at output rate AND pass-2 re-pays them as input. [src: token math on published rates] | Reject any "draft then summarize" pattern proposed for cost reduction. Use it only for quality / reasoning transparency. |

---

## 5. Lever inventory (14 levers, ranked by synthesis)

Full inventory below. Mechanism, estimated savings, effort, quality risk, and citation cluster.

| # | Lever | Mechanism | Est. $ saved / $10 run | Effort | Quality risk | Source |
|---|---|---|---|---|---|---|
| L1 | System-prompt `cache_control` (measurement-gated per C-2) | **Phase 1**: just measure. `usage-tracking.ts` already captures `cache_creation_input_tokens` + `cache_read_input_tokens`. After L2 ships, run 3 real jobs and inspect telemetry. If `cache_read_tokens > 0` consistently, Claude Code auto-cache_control is already firing on our prompt-file pattern → L1 savings already in baseline → no further action. If `cache_read_tokens ≈ 0`, **Phase 2**: explicit cache_control requires direct-SDK migration (executor.ts currently writes prompt to `claude-prompt.md` and asks CLI to read it — no programmatic system block to attach metadata to). Phase 2 effort matches the L15 MCP-proxy work below. | $2-5 if Phase 2 fires; possibly $0 incremental if auto-cache already active | Phase 1: trivial (read DB); Phase 2: High (direct-SDK migration) | None | C1 §3, C5 §1, C-2 |
| L2 | 1-hour cache TTL via `ENABLE_PROMPT_CACHING_1H=1` env var | Write at 2× base input (vs 1.25× for 5m); read at 0.1× regardless. Net positive after 2 reads. Survives cross-job within 1h window. | $0.50-2 incremental over L1 | Low (1 env var) | None | C1 §3, C4 §7 |
| L3 | `cache_control` on large `tool_result` blocks (Perplexity) | Mark each tool_result ≥1024 tokens with cache_control. 15K Perplexity result read at 0.1× vs 1.0× on subsequent turns = 90% saving per repeat. Breakeven ≈ 2 turns. **Per C-1: NOT implementable as in-executor harness edit** — `executor.ts` has no access to tool_result blocks between Claude's tool calls. Requires L15 MCP proxy infrastructure (or full direct-SDK migration). | $1-3 | High (requires L15 prerequisite) | None | C5 §3, C-1 |
| L4 | Anthropic Batch API for stateless leaf phases | 50% discount on both input + output. Tool use + MCP supported. Async, ≤24h SLA, typical <1h. Apply to per-source summarization, citation formatting, transcript-to-NLM-prompt rewriting. | $3-5 | High (pipeline refactor; Threads API unsupported → manual context reconstruction) | Low on pure-output tasks | C2 §1, §2 |
| L5 | Haiku 4.5 as compression sidecar | After each Perplexity/Chrome-DevTools result, spawn `claude-haiku-4-5` to compress 15K raw → ≤500-token structured JSON extract before insertion into main Opus conversation. Compression cost ~$0.01; saves recurring tokens at Opus rates. | $1-2 | Medium (sub-agent spawn or MCP proxy) | Low-medium — structured extract must preserve citations needed downstream | C5 §2a |
| L6 | ~~Server-side `clear_tool_uses_20250919` (beta)~~ **DROPPED v2 per G-1** — server-side clearing rewrites the byte sequence and busts every L1/L3 cache_control hash downstream. Mutually exclusive with prefix-caching strategy across the whole session, not just per block. L1+L3 alone retain Chrome DevTools snapshots cheaply at 0.1× read cost. | ~~$1-3~~ → $0 | n/a | n/a — dropped | C5 §2b; G-1 |
| L7 | System-prompt verbosity constraints | Add "no preamble", "do not repeat the question", "do not summarize prior steps", "answer in ≤N sentences per section" to executor system prompt. Output is 5× input cost; 10-20% output reduction is material. | $0.50-2 | Low (prompt edit) | Low-medium — overly aggressive constraints can truncate reasoning needed for quality | C4 §3d, §3e |
| L8 | `stop_sequences` to halt post-answer rambling | Pass `stop_sequences: ["</answer>", "---"]` to halt after structured block. Only saves money when trailing commentary is actually present. | $0.25-1 (workload-dep.) | Low (1 param) | Low if marker placement is careful | C4 §3b |
| L9 | Client-side citation deduplication (content-hash) | Maintain `Map<urlHash, Set<contentHash>>` in MCP proxy. For each new Perplexity tool result containing structured citations, drop snippets whose `(url, content-hash)` pair already appeared this session. URL = fast first-pass filter; SHA-256 of snippet body = actual dedup key. **Per C-1: must live in L15 MCP proxy, not executor.ts** — executor has no access to tool_result blocks. The proxy already needs to normalize Perplexity output to `{citations: [{url, snippet}], body}` for L9 to operate on structured fields; this normalization is part of L15's smallest viable scope. | $0.50-1.50 | High (requires L15 prerequisite) | Low — content-hash preserves novel snippets from repeat URLs | C5 §6; G-2; C-1 |
| L10 | MCP proxy wrapper with Haiku pre-compression | Thin Node.js MCP server in front of Perplexity + Chrome DevTools. Proxy intercepts raw results, calls Haiku for compression, returns compressed version. Main Opus session never sees raw 15-30K responses. | $2-4 | High (new service, deploy, monitor) | Medium — lossy compression; DOM extraction needs careful selectors | C5 §2d |
| L11 | ~~`--resume <session-id>` with fixed UUID per job~~ **DROPPED v3 per C-3** — full job is ONE `claude -p` spawn (no sequential CLI invocations within job). `spawnClaude` explicitly deletes `CLAUDE_CODE_SESSION_ID`. `job.id` already exists as UUID. No cache-amortization opportunity in current architecture. Reconsider only if/when worker adds retry/resume workflow with multi-spawn-per-job semantics. | ~~$0.50-1.50~~ → $0 | n/a | n/a — dropped | C1 §4; C-3 |
| L12 | `--max-turns N` circuit breaker | Hard cap on agentic tool-call loops via headless flag. $0 on well-behaved runs; potentially large savings on pathological loops. | $0-3 (situational) | Low (1 param) | Low on normal runs; quality risk if legitimate job hard-truncated mid-synthesis | C1 §1 |
| L13 | Structured output schemas (Zod / JSON mode) | Force tool outputs through schemas. 99.5% vs 74.7% schema adherence documented on Sonnet 3.5 baseline. Length reduction is workload-dependent; no controlled Claude-specific token benchmark. | $0.25-1 (directional) | Medium (schema authoring) | Low — reliability improves; length reduction unverified | C4 §3a |
| L14 | Pre-filter context (exclude build artifacts) | Strip lockfiles, generated code, build artifacts from injected context. Practitioner reports 40-60% input-token reduction. Mostly applicable to code-analysis jobs, less so to pure web-research. | $0-2 (limited applicability) | Low-medium (preprocessing) | Low | C4 §2 |
| **L15 NEW** | **MCP proxy infrastructure (consolidated enabler for L3 + L5 + L9 + L10)** | Thin Node.js MCP server in front of Perplexity (and optionally Chrome DevTools) MCPs. Single architectural investment that unlocks four levers at once: (a) normalizes tool output to `{citations: [{url, snippet}], body}` (enables L9); (b) wraps tool_result blocks in cache_control metadata via direct-SDK message construction OR by structuring output Claude Code will cache (enables L3); (c) calls Haiku 4.5 to compress raw results before returning (enables L5); (d) implements L10 by design. **Per C-1: this consolidation is the correct architecture, not 4 separate harness edits.** Pre-requisite: confirm Claude Code can pass-through `cache_control` metadata via MCP tool_result wire format — if not, L15 requires migration to direct-SDK orchestration alongside MCP server (large lift, but `@anthropic-ai/sdk` is already used in `plan-transports.ts` per C-WELL-HANDLED). | $3-6 consolidated (sums L3+L5+L9 partial savings minus implementation overhead) | High (new service: design, deploy, monitor, secure per CLAUDE.md §10 untrusted_input fence inside proxy) | Medium — lossy compression is the dominant risk; selector extraction for Chrome DevTools needs care; security: proxy handles potentially-injected content and MUST apply untrusted_input fence before passing to Haiku | C-1; C5 §2a/§2d/§6 |

---

## 6. Top 7 by ROI (savings ÷ effort) — v3 ordering after Codex Round 2

### Rank 1 — L2: 1-hour cache TTL via `ENABLE_PROMPT_CACHING_1H=1`
$0.50-2 savings, truly Low effort, zero quality risk. **Per C-WELL-HANDLED #3**, this env var inherits cleanly through `node --env-file=.env` → `crossSpawn("claude", args, { env: childEnv })` to the child `claude -p` process. **Phase 1 deployment: add to `agent/.env` and Scheduled Task env config. Zero code changes.** Captures cross-job cache hits within the 5-min cron window — net positive after 2 reads. **This is now Rank 1 because it's the ONLY truly low-effort lever with confirmed in-place plumbing.**

### Rank 2 — L1 measurement (Phase 1): instrument-first cache baseline check
Effort: trivial (read DB after 3 jobs). **Per C-2 + C-WELL-HANDLED #4**, `usage-tracking.ts:285-288` already captures `cache_creation_input_tokens` + `cache_read_input_tokens`. Run 3 real jobs post-L2 and inspect the columns:
- `cache_read_tokens > 0` consistently → Claude Code auto-cache_control is already firing on our prompt-file pattern → L1 savings already silently in the baseline; no further action needed.
- `cache_read_tokens ≈ 0` → explicit cache_control placement required → escalate to Phase 2 (direct-SDK migration; matches L15 effort profile; move to Sprint 3).

**This Rank 2 placement is the cheapest decision point in the whole inventory** — one DB query decides whether L1 is "already done" or "Sprint 3 work".

### Rank 3 — L7: System-prompt verbosity constraints (GATED on empirical validation)
$0.50-2 savings, Low edit effort BUT per G-4 commit is **gated on empirical shadow-run validation of final-deliverable quality, not just output-token delta**. Verbosity constraints alter the model's reasoning trace shape and carry tangible quality risk. Process: write the prompt edits to `sandbox/verbosity-system-prompt-v2.txt`; run 3-5 representative jobs in shadow (same input → side-by-side output); human-review each pair for quality regression on the synthesis itself BEFORE merging into production prompt. Note: the executor reads its prompt from `claude-prompt.md` (per C-2 EVIDENCE) — verify where the system-level guidance lives that L7 would edit (could be the brief template, `agent/lib/conventions.ts`, or both).

### Rank 4 — L15: MCP proxy infrastructure (consolidated enabler)
$3-6 consolidated savings, **High effort**. Single architectural investment unlocks L3 + L5 + L9 + L10 simultaneously by sitting in front of the Perplexity (and optionally Chrome DevTools) MCP. Gating decision: only commit after Rank 1+2+3 are deployed and measured, because:
- If L1 Phase 1 measurement shows auto-caching is firing, the L3 incremental shrinks
- If L7 shadow validation establishes baseline output-token savings, the L9 dedup incremental is easier to estimate
- L15 is non-trivial (new service, deploy, monitor, security per CLAUDE.md §10 untrusted_input fence applied INSIDE the proxy before any Haiku call)

### Rank 5 — L4: Anthropic Batch API for stateless leaf phases
$3-5 savings, **High effort**. Per C-WELL-HANDLED #5: `@anthropic-ai/sdk` is already a direct dependency, used in `plan-transports.ts:635-658` and `:724-741` — the direct-API path is partially scaffolded. Per C-WELL-HANDLED #6: no `research_preview_2026_02` usage in agent/, so batch is open. The implementation lift becomes: extract leaf phases (per-source summarization, citation formatting) from `claude -p` orchestration into batch-submitted `@anthropic-ai/sdk.beta.messages.batches.create()` calls, awaiting results via polling. Threads API still unsupported → manual context reconstruction per batch item.

### Rank 6 — L8: `stop_sequences` to halt post-answer rambling
$0.25-1 savings (workload-dependent), Low effort. Only fires when trailing commentary is actually present. Add to `claude -p` invocation OR to the brief template. Low-risk if marker placement is careful.

### Rank 7 — L13: Structured output schemas (Zod / JSON mode)
$0.25-1 savings (directional), Medium effort. Improves schema adherence (99.5% vs 74.7% on Sonnet 3.5 baseline). Length reduction is workload-dependent. Compose with L9 dedup since structured citation output is also a precondition for content-hash dedup.

**Dropped from Top 7 in v3:**
- ~~L11~~ — DROPPED per C-3 (single spawn per job, `CLAUDE_CODE_SESSION_ID` explicitly deleted).
- ~~L6~~ — DROPPED per G-1 (server-side clear vs cache_control incompatibility).

**Demoted from Top 7 in v3 (but still in inventory):**
- L3, L9 — both now require L15 prerequisite, effort jumps from Low/Medium → High. ROI per unit effort dropped below L4 and L8.
- L5, L10 — both consolidated into L15. Standalone deployment no longer recommended.
- L12 (`--max-turns`) — situational; deploy as a defensive parameter, not a savings lever.
- L14 (context pre-filter) — not applicable to web-research jobs.

---

## 7. Composition map

**Levers that compose well:**
- L1 + L2 + L11 = core caching stack. L1 places the breakpoint; L2 extends TTL for cross-job hits; L11 ensures the prefix hash is reproducible across `claude -p` invocations.
- L1 + L9 + L7 = zero-infra, zero-quality-risk trio. Reduce both input (dedup) and output (verbosity) without new services.
- L5 + L9 = Haiku compression produces structured JSON; dedup Set operates on the structured object before raw string ever hits conversation.
- L4 + L5 = if batch refactor happens, Haiku batch ($0.50/$2.50/MTok) is the cheapest credible path for per-source summarization leaves.

**Levers that conflict:**
- ~~**L3 vs L6** on the same block type — caching and clearing are mutually exclusive.~~ **Per G-1, L6 is DROPPED globally** — server-side clearing rewrites the byte sequence and busts every L1/L3 cache_control hash downstream of the cleared block, across the entire session (not just per block type). Mutual exclusivity is session-wide, not block-level. Resolution: L1 + L3 only; if a tool_result is genuinely single-use and never re-read, simply omit the L3 cache_control marker on that block (cheaper than paying 1.25× write for one consumer).
- **L11 vs MCP-server onboarding** — `--resume` reconstructs from JSONL history. If new MCP servers are added mid-session, the tool definitions in the reconstructed prefix change → cache hash bust. Any MCP server change requires treating existing session IDs as cold starts.
- **L4 vs `research_preview_2026_02: "active"` beta header** — if the pipeline uses this header, those calls cannot batch. Verify before designing the L4 split.
- **L4 vs Claude Code CLI architecture (per G-3)** — the CLI is interactive/synchronous; Batch API is async and non-CLI. L4 may require building a parallel direct-API client integration in Node.js alongside the existing `claude -p` executor path. See Open Question #10. This is a hidden scope cost that should land before L4 is committed.
- **L7 vs final-deliverable quality** — per G-4, verbosity constraints alter the model's reasoning trace and can degrade synthesis quality in ways token counts won't reveal. Empirical shadow validation required before merge.

---

## 8. Recommended rollout sequence

### Sprint 1 — deployable TODAY (zero code changes; truly low risk)

1. **L2** — Add `ENABLE_PROMPT_CACHING_1H=1` to `agent/.env` AND to the Scheduled Task environment (so PowerShell-spawned worker process inherits it). Inheritance through to `claude -p` is confirmed per C-WELL-HANDLED #3.
2. **L1 measurement** — After L2 is live, run 3 real research jobs. Query `usage_tracking` table for `cache_read_tokens` and `cache_creation_tokens` columns. Decision rule:
   - `cache_read_tokens > 0` on jobs 2+ → Claude Code auto-cache + L2's 1h TTL are firing → DONE, L1 implicit savings already booked
   - `cache_read_tokens ≈ 0` on jobs 2+ → escalate to Sprint 3 L1 Phase 2 (direct-SDK migration)
3. **(Optional) L12 `--max-turns N` circuit breaker** — Add as a defensive parameter to `spawnClaude` (suggested N=200 — well above normal job size; only fires on pathological loops). Zero cost on well-behaved runs.

**Validation:** the 3-job measurement IS the validation. Expected outcome on baseline: 20-50% input-token reduction visible as cache_read activity.

### Sprint 2 — quality-gated prompt edits (1-2 days, after Sprint 1 measurement)

4. **L7** — verbosity constraints. Write edits to `sandbox/verbosity-system-prompt-v2.txt`. Per G-4 gate: shadow-run 3-5 jobs same-input → side-by-side output → human-review each pair for synthesis quality regression. Lock in ONLY after sign-off. Token-delta alone is NOT sufficient.
5. **(Optional) L8** — `stop_sequences` if Sprint 1 instrumentation shows trailing post-answer commentary in outputs.
6. **L13 partial** — Begin structured-output schema work for Perplexity tool output (pre-requisite for L9 in Sprint 3 anyway).

### Sprint 3 — MCP proxy infrastructure (own DESIGN-gate MRPF cycle)

7. **L15 MCP proxy** — Build the consolidated Perplexity-fronting MCP server that enables L3 + L5 + L9 + L10. Trigger a fresh DESIGN-gate MRPF (Gemini → Codex sequential) on the proxy architecture BEFORE writing code, because per C-1 this is the structurally correct place for tool_result interception. The proxy MUST apply CLAUDE.md §10 `untrusted_input` fence inside before any Haiku compression call. Pre-requisite: confirm Claude Code can pass-through `cache_control` metadata via MCP tool_result wire format. If not, L15 also requires direct-SDK migration (this becomes the L1 Phase 2 fork as well — measure first per Sprint 1).
8. **L1 Phase 2** (conditional, only if Sprint 1 measurement showed `cache_read_tokens ≈ 0`) — direct-SDK migration of the executor. Architecturally bundles with L15 since both need direct-SDK if Claude Code MCP wire format doesn't pass cache_control.

### Sprint 4 — Batch API (own DESIGN-gate MRPF cycle)

9. **L4** — Batch API for stateless leaf phases. Per C-WELL-HANDLED #5, `@anthropic-ai/sdk` is already used in `plan-transports.ts` → direct-API scaffolding partially exists. Per C-WELL-HANDLED #6 + G-3: no `research_preview_2026_02` usage in agent/, so the batch path is open. Implementation surface: extract leaf phases from `claude -p` orchestration into batch-submitted `@anthropic-ai/sdk.beta.messages.batches.create()` calls; manual context reconstruction per batch item (Threads API unsupported in batch).

---

## 9. Open questions (v3 — many resolved by Codex Round 2)

1. ~~**What is the actual static-vs-dynamic token split?**~~ **RESOLVED architecturally** — `usage-tracking.ts:285-288` already captures `cache_creation_input_tokens` + `cache_read_input_tokens` per C-WELL-HANDLED #4. Sprint 1 step 2 (L1 measurement) resolves the empirical answer in 3 jobs.

2. ~~**Does the executor set `research_preview_2026_02: "active"`?**~~ **RESOLVED** — Codex confirmed no such usage in `agent/`. Batch path is open.

3. **(Withdrawn — moot since L6 dropped)** Is `context-management-2025-06-27` beta stable enough? Not relevant in v3.

4. **What is the actual Chrome DevTools snapshot size and reuse pattern?** Still open but lower priority — only matters if/when L15 MCP proxy is built. Defer to L15's own DESIGN gate.

5. **(Withdrawn — moot since L11 dropped)** Claude Code CLI version vs #34629 regression. Not relevant in v3.

6. **Opus 4.7 tokenizer inflation (0-35%) — does it affect the $10 baseline?** Still open. Compare per-token-count vs per-character-cost on 3 real jobs once L2 is live. Likely affects all percentage estimates by 10-20%.

7. **Batch API + prompt-cache pre-warming interaction (L4 + L2)** — `max_tokens: 0` cache pre-warm does NOT work inside a batch. Pre-warm must happen via a synchronous call before submitting the batch. Adds orchestration complexity to L4. Resolve in the dedicated L4 DESIGN gate (Sprint 4).

8. **Cluster 3 gap (Sonnet vs Opus benchmarks).** Not blocking — user constraint excludes main-model swap on executor.

9. ~~**`agent/executor.ts:738-760` spawn args inspection**~~ **RESOLVED** — Codex confirmed: spawn passes no `--model`, no `--prepend-system-prompt`, no `--append-system-prompt`, no `--session-id`, no `--resume`. The full execution brief is written to `claude-prompt.md` and the CLI is asked to read it. There is no programmatic system block for executor.ts to attach cache_control to today.

10. ~~**Does Claude Code CLI natively support Anthropic Batch API operations?**~~ **PARTIALLY RESOLVED** — `@anthropic-ai/sdk` is already a direct dependency used in `plan-transports.ts`, so the parallel-direct-API path for L4 is architecturally scaffolded. The CLI itself does not (and per its sync design probably cannot) submit batch jobs. L4 will use direct SDK, not CLI.

11. **(NEW)** Does Claude Code pass `cache_control` metadata through the MCP tool_result wire format? Critical input to the L15 DESIGN gate. If yes, L15 can be a pure MCP proxy. If no, L15 also requires direct-SDK orchestration of the executor (large lift), and Sprint 3 conflates with L1 Phase 2. Test before scoping Sprint 3.

12. **(NEW)** Where does the executor's "system-level guidance" actually live for L7? Codex confirmed `executor.ts` writes the brief to `claude-prompt.md` — find the template source (likely `agent/lib/conventions.ts` or a brief-template module) so L7 edits land in the right place.

---

## 10. What reviewers should focus on (HISTORICAL — v1/v2 hand-off; v3 is FINAL)

*This section captured the explicit reviewer hand-off prior to each round. Both rounds complete; sections preserved here for traceability and for the future Sprint 3 (L15) / Sprint 4 (L4) DESIGN gates that will reuse the format.*

**For Gemini (round 1, holistic long-context):**
- Are the headline factual findings (§4 F1-F9) accurate as stated? Any Anthropic doc claim above that's been superseded or that I've misread?
- Is the L1-L14 inventory complete? Any major cost lever from production Claude API usage missing — particularly anything domain-specific to a long-running research orchestrator?
- Is the ROI ranking defensible? Any lever I've under-weighted or over-weighted given the no-quality-regression constraint?
- Are the conflicts in §7 exhaustive, or are there silent interactions between levers I've missed?
- Is the rollout sequencing sound? Should any Sprint 1 lever move to Sprint 2 or vice versa for safety reasons?
- The Cluster 3 (Sonnet-vs-Opus benchmark) gap — does it actually matter for this design, or is the "keep Opus for main executor" decision the right one regardless?

**For Codex (round 2, code-grounded on integrated v2):**
- Read `agent/executor.ts:738-760` (the `spawnClaude` function) and `agent/lib/plan-transports.ts` (the model-default + pricing-table source). Are the L1/L11 implementations described actually compatible with how the executor constructs its `claude -p` invocation? In particular: does Claude Code's auto-placed `cache_control` cover our system prompt prefix already, or do we need explicit `--prepend-system-prompt` or programmatic cache_control via direct SDK?
- Does the worker daemon's current architecture (Scheduled-Task cron, 30s poll, claim-and-spawn) cleanly support L11's deterministic `--session-id`? Where would the UUID be generated and persisted? Inspect `agent/worker.ts` and `agent/lib/conventions.ts` for the right insertion point.
- Inspect `agent/lib/usage-tracking.ts` — can it already log `cache_creation_input_tokens` and `cache_read_input_tokens` from the API response, or does it need extension to enable Open Question #1 instrumentation? Without this, we can't validate L1 savings empirically.
- L9 (content-hash dedup): does the project's `untrusted_input` fence pattern (`agent/lib/untrusted-input.ts`) already produce structured Perplexity output (`citations: [{url, snippet}]`) suitable for content-hashing, or does it need extension to expose snippet bodies? Check whether structured Perplexity tool-output is already enforced or only a frontend-side convention.
- Any Windows-specific gotchas in setting `ENABLE_PROMPT_CACHING_1H=1` for the Scheduled-Task spawn ([[feedback_powershell_start_process_cmd_shims]] et al.)? Will the env var be inherited correctly through PowerShell → cmd shim → `claude -p`?
- Open Question #10: scan for whether the project already uses `@anthropic-ai/sdk` directly anywhere (besides `claude -p`). If yes, the parallel direct-API path for L4 is partially in place. If no, the L4 implementation surface roughly doubles.
- Security implications: L10 (MCP proxy) introduces a new privileged service handling potentially-prompt-injected content. Per project CLAUDE.md §10 (untrusted_input fence), the proxy MUST apply the fence pattern BEFORE passing content to the compression Haiku call. Confirm the proxy design accommodates this if/when L10 is reached.
- Does dropping L6 (per G-1) reduce flexibility in any other downstream feature we already planned? Search Documentation/ for any prior commitment to server-side context clearing.

---

## 11. Out of scope (explicitly)

- **Main-model swap on the executor** (Opus → Sonnet 4.6 / Haiku 4.5). User constraint excludes this. Cluster 3 gap means we don't have published benchmark evidence either way.
- **Reducing or restructuring the plan-review MRPF gate itself** ($0.22/run; not a meaningful cost lever).
- **Migrating off Anthropic to a different vendor on the executor.** No verified provider arbitrage; Bedrock pricing for Opus 4.7 not publicly confirmed; OpenRouter at parity or higher; Vertex not listed.
- **Reducing research depth / source count.** A quality-side decision, not an architecture decision.

---

## 12. Appendix — Cluster reports

Full per-cluster research output (4/5 succeeded) is preserved in workflow run `wf_56d160f3-f3d` transcript at:
`C:\Users\ceo\AppData\Local\Temp\claude\c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research\ae06cfc0-8970-4535-8dc6-d32f6a69f85c\tasks\wf1qw894b.output`

Cluster 1 (CLI + caching), Cluster 2 (Batch + arbitrage), Cluster 4 (context tiers + output reduction), Cluster 5 (MCP pruning + production patterns) returned with cited findings. Cluster 3 (model decomposition) stalled on all 6 attempts.

---

*End of v3 FINAL (post-Gemini Round 1 + Codex Round 2 sequential MRPF integration). Ready for /promote to `Documentation/api-cost-reduction-design-gate.md`.*

**v3 net savings estimate (re-computed after C-1/C-2/C-3 effort revisions):**

| Sprint | Levers | Effort | Est. savings on $10 baseline | Risk |
|---|---|---|---|---|
| **Sprint 1 (deploy today)** | L2 env var + L1 measurement + (opt) L12 max-turns | Zero code changes | $0.50-2 confirmed + L1 possibly already $2-5 silently in baseline | Zero quality risk |
| **Sprint 2 (1-2 days)** | L7 (gated) + (opt) L8 + L13 partial | Low edit + shadow validation cycle | $0.75-3 | Medium quality risk on L7 (mitigated by G-4 shadow gate) |
| **Sprint 3 (own DESIGN gate)** | L15 MCP proxy (unlocks L3+L5+L9+L10) + (cond) L1 Phase 2 | High (new service + possible direct-SDK migration) | $3-6 consolidated | Medium-high (lossy compression, security surface) |
| **Sprint 4 (own DESIGN gate)** | L4 Batch API via direct SDK | High (parallel pipeline) | $3-5 | Low on pure-output tasks |

**Cumulative achievable: $7.25-16 saved per $10 baseline = effective per-run cost $0-2.75 in steady state** (after all 4 sprints land).

**Today's confident deploy (Sprint 1 alone):** $0.50-2 incremental savings + the diagnostic that determines whether L1's $2-5 is already silently booked. **Net first-week savings expectation: $0.50-7/run depending on L1 measurement outcome.**

**v1 → v2 → v3 net evolution:**
- v1 estimated $4.50-13.50 saved via 14 small levers, mostly Sprint 1-2.
- v2 dropped L6 (-$1-3), shifted L9 mechanism (no $ change), gated L7 (no $ change) → $3.50-10.50.
- v3 dropped L11 (-$0.50-1.50), consolidated L3+L5+L9+L10 into L15 with raised effort floor, moved L1 to "measure first" → headline savings range narrows but ROI per unit of effort improves dramatically (Sprint 1 is now $0-7 with zero code).

**Recommended next action for the user:** approve Sprint 1 (add 1 env var + run 3 jobs + read DB). 30 minutes of work. Resolves the L1 measurement question and books L2's savings immediately. Then revisit Sprint 2+ based on measured baseline.
