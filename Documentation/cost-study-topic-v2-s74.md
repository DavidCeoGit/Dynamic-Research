# Cost-Study Topic v2 — S74 (2026-05-30 UTC)

> Re-submission of the S73 cost-study after plan-review halt on a Codex bracket-vs-strict-pricing contradiction. Topic body below is what the submission script (`c:/tmp/submit-cost-study-s74.mjs`) embeds verbatim into the research_queue row.

---

## Topic body (verbatim)

# Cost-Benefit Migration Analysis: Anthropic Claude Opus 4.7 -> OpenAI GPT-5 (Dynamic Research Worker Executor)

## Background
Dynamic Research is an internal multi-tenant research orchestration system that runs long-form research jobs via a Node.js worker daemon spawning the Claude Code CLI (claude -p) with Anthropic Claude Opus 4.7 (1M context window). The worker drives MCP tool use (perplexity-mcp + Chrome_DevTools_MCP) for source gathering and synthesizes a final report. Typical research job costs $0.10-15 per job (capped at $15 via MAX_JOB_COST_CENTS=1500); peak observed cost was $5.85 (S67 incident, Tesla v3 capital-structure topic). 1-hour prompt cache TTL is currently enabled (ENABLE_PROMPT_CACHING_1H=1) and Sprint 1 L2 measurement is pending.

Date of analysis: 2026-05-30.

## Pricing Data Handling (READ FIRST — plan-reviewers please honor)
This analysis MUST quote concrete numbers, not vague ranges. To handle pricing-source uncertainty consistently across both vendors:

- Where a vendor has published canonical per-token rates (a public pricing page or developer docs current as of 2026-05-30), quote the single-point published number with a source URL inline.
- Where pricing requires inference (beta/preview tiers without published GA pricing, volume-discount multipliers, regional variance, vendor-published ranges, or no canonical doc exists), present the inferred number as a single working estimate with the estimation method named inline (e.g., "estimated $X/Mtok input via Y-to-Z ratio extrapolation; confidence: medium"). Do NOT present brackets like "[$X-$Y]" as the primary answer — pick a single working number and state confidence in prose.
- Where two vendor sources disagree (docs vs pricing page), note the discrepancy and pick the more recent / authoritative source. Cite both.
- "Pricing cannot be sourced" is an acceptable terminal answer for a sub-item ONLY if a documented search attempt is shown (which URLs + queries were tried). Do not infer beyond a 2x band.

Why this section exists: the prior submission (S73) halted plan-review when one reviewer's iter-1 critique ("drop bracketed range estimates") was integrated, then iter-2 of the same reviewer flagged the integrated single-point pricing as "too strict." Pre-resolving the tension upfront prevents that loop. Reviewers: please accept single-point pricing-with-confidence-method as the canonical form, NOT bracketed ranges.

## Research Question
Should we migrate the worker daemon main research executor from Claude Opus 4.7 (via claude -p CLI) to OpenAI GPT-5? Compare TWO OpenAI surfaces:
1. gpt-5 via OpenAI Responses API (programmatic SDK call, full control over caching/tools/streaming/structured-output)
2. gpt-5-codex via the codex CLI (already used for MRPF Round 2 in this repo; codex exec -s read-only invocation pattern)

## Required Coverage

### Cost dimension (primary)
- Per-job cost projections for typical research workloads using the Pricing Data Handling rules above:
  - 5-15 turns
  - 50-200K input tokens
  - 5-20K output tokens
  - Heavy MCP perplexity calls (search + research tools)
  - Cache_read in the 30-70 percent range when 1h cache is hot
- 30-day projected billing under typical job volume (~10-50 jobs/month) — single-point numbers per Pricing Data Handling
- Cost-cap interaction: how would each surface interact with the existing MAX_JOB_COST_CENTS=1500 cap?
  - Would gpt-5 / gpt-5-codex hit the cap at lower or higher per-job complexity vs Opus?
  - Does cap need adjustment for the new model?
  - What is the cost for a high-complexity job (200K input, 20K output, 15 turns, heavy MCP) on each surface?

### Capability parity (must-preserve)
- Prompt caching support (5min + 1h TTLs; cache_creation/cache_read pricing)
- MCP tool-use compatibility (do gpt-5 / gpt-5-codex natively support the Model Context Protocol the way Claude Code does?)
- Structured output / JSON mode (--output-format json --verbose equivalent)
- Streaming output (incremental assistant messages)
- Long-context handling (Opus 4.7 has 1M; GPT-5 context limit?)
- Tool-calling reliability + parallel tool calls
- System prompt + multi-turn conversation handling

### Implementation cost (secondary)
- Migration effort (LOC + days) to swap claude -p to gpt-5 API / codex CLI
- Risk register: error-handling, rate limits, billing-error classification, terminal vs transient errors
- Rollback complexity (can we keep both backends behind a feature flag?)

## Audience
Technical operator (the system owner) making a cost-vs-effort migration decision. Non-technical framing NOT needed. Numbers + capability gaps + risk register + recommendation matter most.

## Output structure
1. Executive summary (1-2 paragraphs, recommendation up front)
2. Per-surface cost table (gpt-5 API vs gpt-5-codex CLI vs Opus 4.7 baseline) — single-point numbers per Pricing Data Handling
3. Capability parity matrix
4. Cost-cap implications (specific to MAX_JOB_COST_CENTS=1500)
5. Migration effort + risk register
6. Recommendation: migrate / partial migration / hold

## Explicit exclusions
- Other OpenAI models (gpt-4o, gpt-5-mini, o1, o3) - focus is gpt-5 + gpt-5-codex only
- Non-OpenAI alternatives (Google Gemini, Mistral, etc.) - Anthropic vs OpenAI only
- Frontend SSR migration (out of scope; we may run that separately)
- Phase 0 preflight migration (out of scope)
- MRPF reviewer changes (out of scope; codex already used there)

## Constants
- TODAY = 2026-05-30 (use canonical pricing published on/before this date; inferred-pricing fallback per Pricing Data Handling)
- BASELINE_MODEL = Claude Opus 4.7 (claude-opus-4-7, 1M context variant)
- TARGET_MODELS = gpt-5 (Responses API) + gpt-5-codex (codex CLI)
- COST_CAP_USD = $15.00 (MAX_JOB_COST_CENTS=1500)
- TYPICAL_JOB = 5-15 turns, 50-200K input tokens, 5-20K output tokens

---

## Diff vs S73 topic

1. NEW section "Pricing Data Handling (READ FIRST)" — explicitly resolves bracket-vs-strict tension upfront with concrete handling rules and acknowledges the S73 loop so reviewers understand why the rules exist.
2. Cost dimension text: "Per-job cost projections at current Q2 2026 published pricing" → "Per-job cost projections ... using the Pricing Data Handling rules above"
3. Cost-cap variance: "What is the cost variance" → "What is the cost" (variance implied range; cost+confidence is single-point per the handling rules)
4. Output structure §2: "Per-surface cost table" → "Per-surface cost table — single-point numbers per Pricing Data Handling"
5. Constants line: "(use latest published pricing as of this date)" → "(use canonical pricing published on/before this date; inferred-pricing fallback per Pricing Data Handling)"

Substantive intent unchanged: Opus 4.7 → gpt-5/gpt-5-codex migration cost-benefit for the worker executor.

## Submission flow

1. /promote this doc → `Documentation/cost-study-topic-v2-s74.md`
2. Bump `MAX_REVIEW_ROUNDS=2` → `3` via sandbox+/promote (separate file)
3. Recycle worker (Stop-Process + Start-ScheduledTask) for env reload
4. `node --env-file=agent/.env c:/tmp/submit-cost-study-s74.mjs`
5. Tail `agent/worker.log` for claim → plan-review verdict → Phase 2 terminal state
6. Revert `MAX_REVIEW_ROUNDS=3` → `2` at end of session
