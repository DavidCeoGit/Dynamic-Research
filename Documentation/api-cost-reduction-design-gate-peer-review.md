# DESIGN-Gate Synthesis: Per-Run API Cost Reduction (v3 FINAL)

**Status:** v3 FINAL post-sequential-MRPF (Gemini Round 1 → integrate → Codex Round 2 → integrate). Design doc at `Documentation/api-cost-reduction-design-gate.md` (v3). **No code change occurred this session** — this is a planning artifact that gates Sprint 1's 30-minute deploy + measurement window.

**Author:** Claude (Opus 4.7, S66 2026-05-29)

**MRPF classification:**
- Event Gate = **DESIGN** (architectural decision affecting per-job cost model + executor harness + caching strategy across multi-week rollout).
- Risk Labels = **INFRA** (env vars, worker spawn config), **ARCHITECTURE** (cache_control placement, optional MCP proxy in Sprint 3, optional batch path in Sprint 4), **AGENT BEHAVIOR** (verbosity-constraint prompt edits in Sprint 2 change executor output shape).
- Severity = **NORMAL**.
- Topology = Sequential Gemini → integrate → Codex on integrated v2 (per ~/CLAUDE.md HARD RULE for DESIGN-fresh artifacts).

---

## Reviewer trail

### Round 1 — Gemini 3.1 Pro Deep Think (CLI headless, `gemini -p`, stdin piped doc)

Verdict: **REQUEST_CHANGES**. 1 CRITICAL + 1 MAJOR + 2 MINOR. All integrated into v2.

| ID | Sev | Disposition |
|---|---|---|
| **G-1** | **CRITICAL** | INTEGRATED v2. v1 §7 proposed using L6 (server-side `clear_tool_uses_20250919`) on Chrome DevTools blocks and L3 (cache_control on tool_result) on Perplexity blocks in the same session. Gemini observed: prompt caching uses byte-exact cumulative prefix hash; if Anthropic server dynamically replaces an older Chrome DevTools block with a placeholder, the byte sequence of the entire conversation history from that point forward is altered → guaranteed cache miss for any subsequent Perplexity tool_result reads or system-prompt cumulative hits that span the cleared block. Mutual exclusivity is session-wide, not block-level. v2 dropped L6 entirely; L1+L3 alone retain Chrome DevTools snapshots at 0.1× read cost when 2+ downstream reads expected. |
| G-2 | MAJOR | INTEGRATED v2. v1 §5 L9 proposed `Set<string>` of seen URLs to drop duplicate citations. Gemini observed: subsequent Perplexity queries may extract entirely different snippets, facts, or context from the same URL depending on the search prompt. URL-only dedup risks silently dropping novel reasoning — directly violates "NO quality regression" hard constraint. v2 changed L9 to `Map<urlHash, Set<contentHash>>` (SHA-256 of snippet body; URL is a fast first-pass filter, content-hash is the actual dedup key). |
| G-3 | MINOR | INTEGRATED v2. Added Open Question #10 — Claude Code CLI is interactive/synchronous by design; `claude -p` is one-shot but still synchronous (not batch-async). L4 may require building a parallel direct-API client integration in Node.js (`@anthropic-ai/sdk`) alongside the existing `claude -p` executor path. Roughly doubles L4 implementation surface; changes its quality-risk profile. Codex Round 2 partially resolved this (see C-WELL-HANDLED #5). |
| G-4 | MINOR | INTEGRATED v2. v1 Sprint 2 step 5 said "Measure output-token delta on 3 jobs before locking in" for L7. Gemini observed: verbosity constraints inherently alter the model's reasoning trace shape and carry tangible quality risk; token-delta alone is structurally insufficient as a quality gate. v2 Sprint 2 step now requires **side-by-side human review of synthesis quality on shadow-run pairs** before merge. Token-delta is necessary-but-not-sufficient. |

**Gemini items already correct / well-handled** (preserved verbatim from Round 1 output):
- F1 + F8 myth-busts (Opus 4.7 flat 1M pricing; `max_tokens` doesn't save money on early stops) — load-bearing factual baselines.
- L1 baseline prioritization in v1 — correct architectural choice given the data Gemini could see (Codex's C-2 later revealed L1 effort is much higher than v1 estimated; both reviewers agree L1 belongs near the top of the inventory, but disagree on effort).
- F9 two-pass trap rejection — mathematically correct.
- L2 1-hour TTL — "excellent domain-specific optimization that perfectly accommodates the 5-min Scheduled Task constraint." Codex's C-WELL-HANDLED #3 later confirmed the env-var inheritance chain is in place.

### Round 2 — Codex (`codex exec -s read-only`, code-grounded on integrated v2)

Verdict: **REQUEST_CHANGES**. 1 CRITICAL + 2 MAJOR. All integrated into v3.

| ID | Sev | Disposition |
|---|---|---|
| **C-1** | **CRITICAL** | INTEGRATED v3. v2 §5 L3+L9 assumed `executor.ts` could see and mutate Perplexity/Chrome `tool_result` blocks before Claude consumes them. Codex grounded this against actual code: `executor.ts:738-760` only builds CLI args with `--allowedTools` including `mcp__perplexity__...` and Chrome tools; `executor.ts:769-773` calls `crossSpawn("claude", args, { env: childEnv })`. The executor delegates ALL MCP calls inside `claude -p` and only captures stdout afterwards. Also: `agent/lib/untrusted-input.ts:65-66` returns `<untrusted_input>...</untrusted_input>` wrapping but does NOT enforce or produce structured `citations:[{url,snippet}]`. v2's "Low-Medium 40 LOC" L9 estimate was wrong; "Medium per-call harness edit" L3 estimate was wrong. **v3 fix:** L3 and L9 both consolidated as downstream consumers of new **L15 (MCP proxy infrastructure)** — single architectural investment that also enables L5 (Haiku compression) and L10. Effort jumps from Low/Medium → High; both move from Sprint 2 → Sprint 3. ROI ranking re-sorted. |
| **C-2** | **MAJOR** | INTEGRATED v3. v2 §6 Rank 1 framed L1 as "single edit to executor.ts" placing cache_control on the prompt prefix. Codex grounded this against actual code: `executor.ts:374-380` writes the full execution brief to `claude-prompt.md`, then the CLI is asked to read that file; it is NOT a programmatic system block. Args at `:738-760` are only `-p`, `--output-format json`, `--verbose`, `--allowedTools` — no `--prepend-system-prompt`, no `--append-system-prompt`, no structured message payload where block-level cache_control could attach. Direct Anthropic block construction exists only in `agent/lib/plan-transports.ts:635-658` and `:724-741`, and those calls do not include cache controls. **v3 fix:** L1 reframed as **measurement-gated**. Phase 1 = "just measure" (read `cache_creation_input_tokens` + `cache_read_input_tokens` from `usage-tracking.ts:285-288` which already captures these). Decision rule embedded in §8 Sprint 1: if `cache_read_tokens > 0` consistently, Claude Code auto-cache is firing and savings are already silently in the baseline → DONE. If ≈0, escalate to Phase 2 (direct-SDK migration, bundled with L15 work). |
| **C-3** | **MAJOR** | INTEGRATED v3. v2 §5 L11 proposed deterministic `--session-id` per job to amortize cache across sequential CLI invocations. Codex grounded: `agent/worker.ts:237-248` claims one job and calls `executeJob(job)`; `agent/executor.ts:326-344` derives `workDir` and writes manifest once; `agent/executor.ts:393-406` calls `spawnClaude(spawnPrompt, workDir)` ONCE and waits. The architecture has ONE `claude -p` spawn per job — there are no sequential CLI invocations within a job to amortize across. Plus `agent/executor.ts:764-767` explicitly DELETES `CLAUDE_CODE_SESSION_ID` from the child env, so even if L11 were sound, the env-var path would be stripped. Plus `agent/types.ts:74-75` already has `ResearchJob.id: string` (UUID), so a new UUID policy in `conventions.ts` would be the wrong layer. **v3 fix:** L11 DROPPED entirely. Reconsider only if/when worker adds retry/resume workflow with multi-spawn-per-job semantics. Saving floor: -$0.50 to -$1.50 (lost L11 contribution); offset by L15's consolidated $3-6. |

**Codex items already correct / well-handled** (load-bearing — preserved verbatim, must NOT weaken in any future revision):
1. v3 §1 claim confirmed: `spawnClaude` passes no `--model` flag.
2. Current spawn also passes no `--prepend-system-prompt`, `--append-system-prompt`, `--session-id`, or `--resume`.
3. `ENABLE_PROMPT_CACHING_1H=1` will inherit cleanly: `agent/package.json:7` runs `node --env-file=.env`; `agent/executor.ts:764-773` forwards `childEnv` to `crossSpawn` without deleting that variable. → L2 (Sprint 1) is truly zero-code-change.
4. Usage telemetry already captures `cache_creation_input_tokens` and `cache_read_input_tokens` at `agent/lib/usage-tracking.ts:285-288`, persisted at `:350-369`. → Open Question #1 architecturally resolved; Sprint 1 L1 measurement requires zero new instrumentation.
5. Stored usage fields include status/error, duration, `num_turns`, input/cache/output tokens, `total_cost_usd`, `model_usage`, `raw_json`. → rich enough for empirical Sprint 1 decision.
6. Open Question #10 partially resolved: `@anthropic-ai/sdk` is already installed and used directly in `agent/lib/plan-transports.ts` (the plan-review gate transports); the main executor still does not use it directly, and no Batch API path exists yet. → L4 (Sprint 4) has a partial scaffold; the lift is "extract leaf phases" not "build new SDK integration from scratch."
7. No `research_preview_2026_02` usage found in `agent/`. → L4 batch path is open (G-3 concern: confirmed not blocked by this header in our codebase).
8. Dropping L6 has no Documentation collateral: no `Documentation/` hits for `context-management`, `context_management`, or `clear_tool_uses_20250919`. → G-1 integration is safe.
9. Plan-review gate cost is independent of executor caching: `runPlanReviewGate()` runs before `spawnClaude`, uses separate SDK transports, tracks its own costs in `plan-reviewer.ts`. → none of L1-L15 affect the $0.22/run plan-review-gate baseline.

**Total MRPF cost for this DESIGN-gate:**
- Gemini Round 1 wall-clock: completed in 1 background pass (single notification); cost = $0 (subscription)
- Codex Round 2 wall-clock: completed in 1 background pass with 160,337 tokens consumed; cost = $0 (subscription)
- Doc-authoring + integration: Claude Opus 4.7 main-loop time; estimated ~$0.40-0.60 in Anthropic API costs for v1 write + Gemini integration + Codex integration + this synthesis.
- **Net meta-cost of the MRPF cycle: ~$0.40-0.60**, paid once, against an inventory that targets $0-7/run savings in Sprint 1 alone.

---

## v2.2 sequential MRPF — empirical reinforcement from S66

S66 adds another data point for the v2.2 sequential rule (~/CLAUDE.md): each reviewer caught material findings the OTHER could NOT have caught alone.

| Round | Reviewer | Critical catches the OTHER could NOT have caught alone |
|---|---|---|
| 1 | Gemini (holistic v1) | **G-1** (L3 vs L6 server-wide cache invalidation cascade) — required understanding the byte-exact cumulative prefix hash mechanic + reasoning about session-wide consequences of dynamic clearing. Codex's code-grounded pass on v1 would NOT have caught this without grounding against Anthropic prompt-cache internals (which are documentation, not code). **G-2** (URL-only dedup quality risk) — required reasoning about Perplexity query behavior (same URL, different prompts → different snippets), not code grounding. **G-4** (L7 token-delta-is-insufficient quality gate) — reasoning about model behavior, not code. |
| 2 | Codex (code-grounded on integrated v2) | **C-1** (L3/L9 not implementable in executor.ts because MCP delegation lives inside `claude -p`) — required reading `executor.ts` line ranges + understanding the `--allowedTools` delegation pattern. Gemini's top-down read could not have surfaced this without source access. **C-2** (L1 effort overstated — prompt written to file, no programmatic system block) — required reading `executor.ts:374-380` + understanding the `claude-prompt.md` file-passing convention. **C-3** (L11 architecturally moot — single spawn per job + `CLAUDE_CODE_SESSION_ID` explicitly deleted) — required reading `worker.ts:237-248` + `executor.ts:764-767`. ALL three required code grounding; NONE were visible from doc-only read. |

**Reinforcement:** the v2.2 HARD RULE of sequential Gemini → integrate → Codex remains correct. Inverting the order (Codex first on v1, then Gemini on integrated v2) would have changed which reviewer caught what:
- C-1 would have surfaced before G-1, which means L6's drop might have been overshadowed by L3's "not implementable" reframing and the cleaner architectural fix (L15 consolidation) might have arrived in v2 instead of v3.
- BUT: Gemini's G-2 (URL-only dedup → content-hash) only applies if L9 is in the inventory at all — and Codex's C-1 would arguably have moved L9 to "MCP proxy work" before Gemini saw it, possibly losing G-2's quality nuance entirely.

S66 weakly supports a future refinement (NOT actioned in this session): for projects where the design surface is heavily code-dependent (most levers reference specific files), Codex-first MAY surface architectural impossibilities earlier and let Gemini focus on the surviving design surface. For projects where the design surface is heavily documentation/policy (like the S65 plan-review-enforce-flip protocol), Gemini-first remains optimal. **No change recommended yet** — single data point, and the current order delivered a clean v3 with no missed findings.

---

## Disagreement procedure log

Gemini and Codex did not directly disagree on any finding. They worked in non-overlapping domains:
- Gemini's findings (G-1 to G-4) were doc-level + reasoning about model behavior + caching semantics.
- Codex's findings (C-1 to C-3) were strictly code-grounded against `executor.ts`, `worker.ts`, `untrusted-input.ts`, `usage-tracking.ts`, `plan-transports.ts`.

No SECURITY-labeled CRITICAL findings → no blocking semantics fired → no human-owner sign-off needed beyond the normal approval-to-deploy gate for Sprint 1.

---

## Sign-off + recommended next move

v3 is FINAL. /promote target: `Dynamic Research/Documentation/api-cost-reduction-design-gate.md` (the design doc) + `Dynamic Research/Documentation/api-cost-reduction-design-gate-peer-review.md` (this synthesis).

**Recommended Sprint 1 deployment (30 min, zero quality risk):**
1. Add `ENABLE_PROMPT_CACHING_1H=1` to `agent/.env` AND to the `DynamicResearchWorker` Scheduled Task env config.
2. Restart the worker (PowerShell `Start-ScheduledTask -TaskName DynamicResearchWorker` after killing the current PID with explicit user authorization).
3. Run 3 real research jobs through the queue.
4. Query Supabase: `SELECT job_id, cache_creation_tokens, cache_read_tokens, input_tokens, output_tokens, total_cost_usd FROM usage_tracking ORDER BY created_at DESC LIMIT 9;` (3 jobs × up to 3 turns each).
5. Decision: if `cache_read_tokens > 0` on jobs 2+, L1 is silently booked → no further code change needed. If ≈0, escalate to Sprint 3 L1 Phase 2 (direct-SDK migration bundled with L15).

After Sprint 1 measurement, present me (Claude/operator) the data so we can decide whether to commit to Sprint 2 (L7 with shadow gate) or jump straight to Sprint 3's L15 DESIGN gate.
