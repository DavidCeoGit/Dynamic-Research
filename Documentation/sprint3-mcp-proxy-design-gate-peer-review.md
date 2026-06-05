# DESIGN-Gate Synthesis: Sprint 3 — MCP Proxy + Conditional Direct-SDK (v3 FINAL)

**Status:** v3 FINAL post-sequential-MRPF (Gemini Round 1 → integrate → Codex Round 2 → integrate). Design doc at `Documentation/sprint3-mcp-proxy-design-gate.md` (v3). **No code change occurred this session** — this is a planning artifact that gates a 30-min OQ#11 spike + 4.5-8.5 dev days of implementation work.

**Author:** Claude (Opus 4.7, S69 2026-05-29/30 UTC).

**MRPF classification:**
- Event Gate = **DESIGN** (architectural decision affecting executor harness, MCP wiring, tool runtime, multi-week rollout).
- Risk Labels = **ARCHITECTURE** (cross-module boundary change), **DEPENDENCY** (direct-SDK migration + @modelcontextprotocol/sdk add), **INFRA** (if Path A chosen — new proxy service), **AGENT BEHAVIOR** (both paths reshape how tool_result flows to Claude).
- Severity = **NORMAL**.
- Topology = Sequential Gemini → integrate → Codex on integrated v2 (per ~/CLAUDE.md HARD RULE for DESIGN-fresh artifacts).

---

## Reviewer trail

### Round 1 — Gemini 3 Pro Preview (CLI headless, `gemini -m gemini-3-pro-preview -p`, stdin piped doc)

Verdict: **REQUEST_CHANGES**. 1 CRITICAL + 3 MAJOR + 1 MINOR. All integrated into v2.

| ID | Sev | Disposition |
|---|---|---|
| **G-1** | **CRITICAL** | INTEGRATED v2. v1 §2 recommended Architecture B (5-6 day rewrite) primarily to avoid the OQ#11 risk that v1 §5 itself said could be empirically resolved by a 30-minute spike. Gemini called it engineering malpractice to commit to a large architectural rewrite to bypass a blocker without first taking the 30 minutes to see if the blocker actually exists. v2 fix: §4 added Phase 0 ("OQ#11 spike — MUST run before architecture commitment"), with concrete method (minimal MCP server returning a tool_result with cache_control attached, called 3× in sequence, read cache_read_input_tokens from the result event), decision rule (>5000 cache_read on call 2-3 → YES → Path A; ≈0 → NO → Path B), and reproducibility output. §2 author's recommendation reframed from "Architecture B" to "Defer architecture decision until spike runs." |
| G-2 | MAJOR | INTEGRATED v2. v1 §7 ROI table summed L1 (90% reduction on cached tokens via caching) and L3+L9+L10 (100% reduction on the same tokens via trimming/dedup) without accounting for the mutual exclusivity — once L1/L5 cache 90% of a tool_result block, L3 saves only the remaining 10%. v1's $5-12.50/run claim was structurally invalid. v2 fix: §7 ROI table recalculated with mutually exclusive economics. L3 dropped from $1-3 → $0.30-0.80; L5 stayed $0.80-1.80 (cache-mechanism-primary); L9 dropped from $0.50-1.50 → see G-3; L10 dropped from $0.50-1 → $0.30-0.80. Total Sprint 3 unlock $1.50-5.50/run combined (revised again in v3 — see C-2 below). |
| G-3 | MAJOR | INTEGRATED v2. v1 §3 L9 proposed replacing repeat Perplexity tool_results with `{ref: <hash>, see: <prior-turn-id>}` references to save Anthropic tokens. Gemini identified the Context Amnesia Paradox: if the ref replaces the body before it hits the Anthropic API, Claude no longer has the facts in context window — synthesis-time hallucinations/failures. If the ref expands BACK to text before the API, zero Anthropic-token savings. v2 fix: §3 L9 rescoped to vendor-side dedup only — skip duplicate Perplexity API calls (saves $0.02-0.10/run Perplexity vendor cost); Anthropic still receives full body to preserve synthesis quality. |
| G-4 | MAJOR | INTEGRATED v2. v1 §4 Phase 2 estimated 1 day to wire MCP servers (Perplexity + Chrome DevTools) into the direct-SDK executor. Gemini observed: the Anthropic SDK does NOT speak MCP — it speaks Anthropic REST. To keep using stdio-spawned MCP servers, the executor must include a full JSON-RPC MCP client (capability discovery, lifecycle, schema translation MCP `tools/call` ↔ Anthropic `tool_use`). v2 fix: §4 Phase 2 effort raised to 3 days; added `@modelcontextprotocol/sdk` as required dependency; §6 risk #7 added for MCP-client schema-bridge complexity. |
| G-5 | MINOR | INTEGRATED v2. v1 §6 risks ignored Claude Code's implicit context accumulation (settings.json merging, prompt injections, directory conventions). If any of this is load-bearing for output quality, the direct-SDK migration silently degrades. v2 fix: §4 Phase 5 step 17 added explicit "diff the actual `system` block emitted by Arch B vs the CLI's system block" — revised again in v3 per Codex C-1 (worker.log is the wrong source). |

**Gemini items already correct / well-handled** (preserved verbatim from Round 1 output):
- OQ#11 correctly identified as the architectural linchpin (the order of resolution was wrong; the framing was right).
- Phase 5 shadow validation + dark-launch flip is mature, standards-aligned mitigation for core-loop rewrites.
- Sprint 4 (Batch API L4) genuinely needs a direct-SDK posture eventually, which provides secondary justification for Arch B even if Arch A wins the short-term battle.

### Round 2 — Codex (`codex exec -s read-only`, code-grounded on integrated v2)

Verdict: **REQUEST_CHANGES**. 5 MAJOR + 1 MINOR. All integrated into v3.

| ID | Sev | Disposition |
|---|---|---|
| **C-1** | **MAJOR** | INTEGRATED v3. v2 §4 Phase B5 step 17 + §8 reviewer task assumed worker.log/raw_json could serve as the CLI `system`-block baseline. Codex grounded: `agent/executor.ts:887-789` truncates `[claude:out]` lines to 200 chars (worker.log can't reconstruct the system block) AND `agent/lib/usage-tracking.ts:291-297` intentionally stores ONLY the final result event in `raw_json` (no assistant/system turns). v3 fix: dedicated one-shot baseline-capture harness — temporary spawn with `--output-format stream-json` (untruncated) writes assistant turns to `sandbox/cli-baseline-<topic>.json` — separate from production logging. §6 added risk #11 for baseline-capture reliability (CLI version pin). |
| **C-2** | **MAJOR** | INTEGRATED v3. v2 §2/§3 claimed L3 (trim unreferenced tool_result) and L10 (replace snapshot with ref if not re-read) work in pure Path A. Codex grounded: the MCP proxy is request/response middleware over the MCP wire ONLY; it CANNOT observe Claude's NEXT assistant message to know what was referenced. v3 fix: L3/L10 split by sub-mechanism — **static** variants (size-cap trim; cache snapshot by input-signature) run in Path A; **reference-aware** variants (trim only what next-turn doesn't cite) require Path B. §3 lever specs updated; §7 Path A ROI dropped from $1.42-3.50 → $1.02-2.50; §2 architecture-comparison matrix updated to show the split. |
| **C-3** | **MAJOR** | INTEGRATED v3. v2 §2 Arch A claim "executor unchanged except `--mcp-config` points at proxy" was incorrect against `agent/executor.ts:838-860` — current spawn args have no `--mcp-config` flag at all. v3 fix: §4 Phase A1 step 6 adds explicit executor edit (conditional `--mcp-config` arg under EXECUTOR_MCP_VIA_PROXY flag); step 7 adds a rollback-verification test (back-to-back jobs with proxy on/off; verify MCP traffic + cost delta). Path A total raised 4 → 4.5 dev days. |
| **C-4** | **MAJOR** | INTEGRATED v3. v2 §2 Arch B Pro #3 + §10 references called `plan-transports.ts` a "proven architectural template" for direct-SDK migration. Codex grounded: `agent/lib/plan-transports.ts:638-642` + `:727-731` only build user-only message arrays (no tools); `:659-664` + `:742-747` extract response text. The file covers SDK credential plumbing + dynamic-import patterns ONLY. v3 fix: reworded Arch B Pro to "credential plumbing + dynamic-import precedent" (not "agent-loop template"); added Phase B0 (SDK agent-loop spike, 0.5 days) BEFORE Phase B3 to verify multi-turn tool-using shape works. Path B total raised 8 → 8.5 dev days. |
| **C-5** | **MAJOR** | INTEGRATED v3. v2 §4 Phase B2 step 8 said Bash/Read/Write/WebSearch/WebFetch get "direct implementation (no MCP)" with no further spec. Codex grounded: these are Claude Code BUILT-INS via `agent/executor.ts:843-844` `--allowedTools`; the Anthropic SDK has no equivalent tool runtime. v3 fix: §4 Phase B2 step 8 expanded with per-tool implementation + security-boundary spec (Read/Write Node fs scoped to workDir; Bash child_process.exec with allow-list + timeout; WebSearch via Brave Search API + rate-limit; WebFetch via undici with content-length cap + URL allow-list + private-IP-range deny). §6 risk #10 added for native-tool runtime security surface; SECURITY MERGE-gate required on `agent/lib/native-tools.ts` before any Path B production traffic. |
| C-6 | MINOR | INTEGRATED v3. v2 §4 Phase A1/B2 required `@modelcontextprotocol/sdk` but did not include a `pnpm add` step; `agent/package.json:11-18` does not currently list it. v3 added explicit dependency steps at §4 Phase A1 step 0a and Phase B1 step 5a. v2 also referenced "17 currently-allowed tools" at §6 risk #7 + §8 reviewer task; actual allow-list at `agent/executor.ts:843-859` is **20 tools** (Bash + Read + Write + WebSearch + WebFetch + 4 Perplexity + 11 Chrome DevTools). v3 corrected all "17 tools" → "20 tools" references. |

**Codex items already correct / well-handled** (load-bearing — preserved verbatim, must NOT weaken in any future revision):
1. OQ#11 promotion to a blocking spike before architecture commitment is the right move (`sandbox/sprint3-mcp-proxy-design-gate-v3.md` §4 Phase 0).
2. L9 rescope to vendor-side replay preserves Anthropic context and avoids the prior reference/amnesia failure mode (v3 §3 L9 v2 spec).
3. Current telemetry already captures CLI cache token fields for Sprint 1 measurement (`agent/lib/usage-tracking.ts:285-288`).

**Total MRPF cost for this DESIGN-gate:**
- Gemini Round 1 wall-clock: ~2 min foreground; cost = $0 (Google AI Ultra subscription).
- Codex Round 2 wall-clock: ~7 min foreground (took 3 invocation attempts to get past stdin-handling quirks in background mode); 83,851 tokens consumed; cost = $0 (ChatGPT Plus subscription).
- Doc-authoring + integration: Claude Opus 4.7 main-loop time; estimated ~$0.30-0.50 in Anthropic API costs for v1 read + Gemini integration into v2 + Codex integration into v3 + this synthesis. Combined with S69 ops-hardening work earlier this session (PREFLIGHT_NOTIFY_EMAIL + per-job cost cap), total session cost projected ~$1-2.
- **Net meta-cost of the MRPF cycle: ~$0.30-0.50**, paid once, against a Sprint 3 unlock of $1.02-2.50 (Path A) or $3.42-8.50 (Path B) per-run savings.

---

## v2.2 sequential MRPF — empirical reinforcement from S69

S69 adds another data point for the v2.2 sequential rule (~/CLAUDE.md): each reviewer caught material findings the OTHER could NOT have caught alone.

| Round | Reviewer | Critical catches the OTHER could NOT have caught alone |
|---|---|---|
| 1 | Gemini (holistic v1) | **G-1** (commit-to-rewrite-before-running-30-min-spike is engineering malpractice) — required reasoning about engineering decision sequencing + risk economics, not source access. **G-2** (cache savings vs trim savings ARE mutually exclusive on the same tokens) — required reasoning about Anthropic cache-pricing mechanics, not code. **G-3** (Context Amnesia Paradox — ref-replacing tool_result before API gives Claude no facts at synthesis time) — required reasoning about LLM context-window mechanics, not code. **G-4** (Anthropic SDK doesn't speak MCP — need a separate MCP client) — required reading Anthropic SDK + MCP spec docs holistically, not local code. |
| 2 | Codex (code-grounded on integrated v2) | **C-1** (worker.log can't be the system-block baseline because executor.ts:887-789 truncates [claude:out] lines to 200 chars + usage-tracking.ts:291-297 stores only result event) — required reading both files. **C-2** (proxy can't see Claude's NEXT assistant message — L3/L10 reference-aware variants require Path B) — required understanding the executor.ts spawn-and-capture-stdout pattern. **C-3** (`--mcp-config` flag NOT in current spawn args; v2 said "executor unchanged" but actually needs a code edit) — required grep of executor.ts:838-860 spawn-args builder. **C-4** (plan-transports.ts is single-shot text calls, NOT a multi-turn tool-using template) — required reading the actual lines 638-742 to see no tool dispatch logic exists. **C-5** (native tools are Claude Code built-ins; SDK path has no equivalent runtime) — required reading the --allowedTools list at executor.ts:843. **C-6** (@modelcontextprotocol/sdk NOT in package.json; "17 tools" claim wrong — actual is 20) — required reading package.json:11-18 + counting the allowedTools list. ALL six required code grounding; NONE were visible from doc-only read. |

**Reinforcement:** the v2.2 HARD RULE of sequential Gemini → integrate → Codex remains correct. Inverting the order (Codex first on v1, then Gemini on integrated v2) would have:
- Lost G-1 — Codex's code-grounded mindset would have surfaced C-1 through C-6 (file:line discrepancies) but may not have produced G-1's "your method to bypass the blocker is more expensive than the spike to resolve the blocker" decision-economics critique that came from holistic doc reasoning.
- Lost G-2 / G-3 — both required Anthropic cache mechanic / LLM context-window reasoning that doesn't surface from grep of executor.ts.
- Gained nothing: Codex's findings were all code-grounded, so they would have surfaced regardless of round position.

S69 strongly reinforces the sequential Gemini-first order for DESIGN-fresh artifacts where the architectural reasoning surface is large. **No change recommended.**

---

## Disagreement procedure log

Gemini and Codex did not directly disagree on any finding. They worked in non-overlapping domains:
- Gemini's findings (G-1 to G-5) were doc-level + reasoning about engineering decision sequencing + caching/LLM mechanics + Anthropic-vs-MCP protocol architecture.
- Codex's findings (C-1 to C-6) were strictly code-grounded against `agent/executor.ts`, `agent/lib/plan-transports.ts`, `agent/lib/usage-tracking.ts`, `agent/package.json`.

No SECURITY-labeled CRITICAL findings → no blocking semantics fired → no human-owner sign-off needed beyond the normal approval gate for Phase 0 (OQ#11 spike) start.

One note on near-SECURITY: Codex C-5 expanded Phase B2 step 8 with explicit security boundaries on the native-tool re-implementation (Bash command-injection scope, WebFetch SSRF / private-IP-range deny, path-traversal scoping on Read/Write). Sprint 3 Path B's `agent/lib/native-tools.ts` is flagged for SECURITY label at MERGE-gate time — sequential Gemini + Codex review mandatory before any Path B job runs against real research traffic. Not blocking for THIS DESIGN gate.

---

## Sign-off + recommended next move

v3 is FINAL. /promote target: `Dynamic Research/Documentation/sprint3-mcp-proxy-design-gate.md` (the design doc) + `Dynamic Research/Documentation/sprint3-mcp-proxy-design-gate-peer-review.md` (this synthesis).

**Recommended next step (BEFORE any Sprint 3 implementation work):**

Run the **OQ#11 spike** per §4 Phase 0:
1. Write `sandbox/oq11-spike-mcp.mjs` (minimal MCP server returning a tool_result block with `cache_control` attached)
2. Write `sandbox/oq11-prompt.md` (3× call sequence on the test tool)
3. Spawn: `claude -p --mcp-config sandbox/oq11-mcp-config.json --output-format json --verbose < sandbox/oq11-prompt.md`
4. Parse result event for `cache_creation_input_tokens` + `cache_read_input_tokens` on calls 2-3
5. Write verdict to `Documentation/oq11-spike-result-<DATE>.md`

**Decision rule:**
- `cache_read_input_tokens > ~5000` on call 2 or 3 → **OQ#11 = YES** → pursue Architecture A (4.5 dev days, $1.02-2.50/run savings)
- `cache_read_input_tokens ≈ 0` on all calls → **OQ#11 = NO** → pursue Architecture B (8.5 dev days, $3.42-8.50/run savings)
- Either way: Architecture decision is locked by empirical result, not by author preference.

**Cost ceiling for spike:** ~$1 of Anthropic API + 30 min of engineer time. Versus 4.5-8.5 days of risk on the wrong architecture — the spike is the dominant first move.
