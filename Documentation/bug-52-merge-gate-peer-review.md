# Bug 52 + 53a — MERGE-gate Peer Review Synthesis (S62)

**Status:** v3 APPROVED post-Codex-QA-fidelity-fix. Ship-ready for promote.

**Multi-reviewer policy framework:** `~/CLAUDE.md` MRPF v2.2 — AGENT BEHAVIOR risk label triggers mandatory Gemini → Codex sequential MERGE-gate. Severity NORMAL (no production fire; dark-launch shadow mode still active).

## What each reviewer saw

- **Gemini v1 (CLI, `gemini-3.1-pro-preview` with default thinking):** brief at `sandbox/working/s62-bug52-mrpf-v1.md` + sandbox files + live files for BEFORE comparison. Hit 429 rate-limit retries twice but completed.
- **Codex v2 (`codex exec -s read-only`, gpt-5):** brief at `sandbox/working/s62-bug52-mrpf-v2.md` + same files post-Gemini-integration + web research against `@google/genai` SDK source.
- **Codex v3 QA (same):** fidelity brief at `sandbox/working/s62-bug52-mrpf-v3-codex-qa.md`; verified each v2 finding was applied. Could not execute tests (read-only sandbox blocked `node --import=tsx --test` — per `feedback_codex_exec_readonly_blocks_own_verification.md`).

## Context

Bug 51 closed in S61 — `plan_reviews` audit table populated by gate cycles. n=2 telemetry on Tesla replays (da75bcdc + 86d198fc) immediately surfaced two new bugs in the gate's signal quality:

- **Bug 52 (HIGH):** Gemini-3.1-pro-preview emitted `APPROVE + 0 findings` on 4/4 reviewer calls. Codex (gpt-5) on the same plans emitted 7-9 findings including objectively-correct CRITICAL findings (e.g. plan says "5 funding methods" but `research_universe.vendor_candidates` enumerates 8). Output tokens: Gemini 31/call vs Codex ~2800/call. Gate was operating at half-design-capacity (Codex-only).
- **Bug 53a (MEDIUM):** `runIntegration` catch-all in `plan-reviewer.ts:790` silently returned `null` on transport exceptions → no integration row in `plan_reviews` despite the loop iterating. Job 86d198fc had 0 integration rows in two-iter cycle (where da75bcdc had 1 in one-iter cycle).

## Trail

### v1 — Gemini round 1 (APPROVE_WITH_CHANGES, 2 MAJOR + 3 MINOR)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G-M1 | MAJOR | systemInstruction wording too adversarial ("MUST produce findings") → hallucinated compliance risk | **INTEGRATED v2:** softened `DEFAULT_GEMINI_SYSTEM_INSTRUCTION` to focus on quality (concrete plan-vs-manifest gaps, cite specific text) not quantity. Empty findings explicitly licensed when plan aligns. |
| G-M2 | MAJOR | No tests asserting new config keys propagate | **INTEGRATED v2:** +5 tests in `plan-transports.test.ts` covering systemInstruction + temperature + thinkingConfig propagation, env override + opts override env, invalid-env fallback. |
| G-m3 | MINOR | `thinkingBudget=-1` may cause API 400 on strict validators; conditional omit | **INTEGRATED v2** (later superseded by Codex v2 MAJOR-1 — see below): spread-conditional omitting when budget < 0. |
| G-m4 | MINOR | Bug 53a `total_cost_usd: 0` loses sunk tokens on throw | **DEFERRED:** prompt not accessible in `runIntegration` catch without refactoring `IntegrationTransport`. Acknowledged. |
| G-m5 | MINOR | $5 cost cap still sufficient | OBSERVATION (no action). |

**Gemini scope statement:** read sandbox files + live files for BEFORE/AFTER. Did not execute tests. Persona depth score 4 (for the brief's diagnostic quality).

### v2 — Codex round 2 on integrated v2 (REQUEST_CHANGES, 2 MAJOR + 2 MINOR)

Codex performed code-grounded SDK-semantics verification via web research against `@google/genai` source.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C-M1 | MAJOR | **Wrong knob for Gemini 3.x.** `thinkingBudget` is the Gemini 2.5 control; Gemini 3.x uses `thinkingConfig.thinkingLevel` (low/medium/high). Also: Gemini 3.1 Pro **cannot disable thinking** — `thinkingBudget=0` was a false promise. | **INTEGRATED v3:** replaced with `thinkingLevel` ("low" \| "medium" \| "high"); default "high"; `envEnum` helper validates enum value with fallback. Removed `envIntSigned`, all `thinkingBudget` references. Updated 5 tests + .env.example + comment block. |
| C-M2 | MAJOR | **Missing `thoughtsTokenCount`.** Gemini 3.x emits reasoning tokens separate from `candidatesTokenCount`. Without summing them in, cost cap under-counts AND the Bug 52 success criterion (output-token delta) misses the reasoning entirely. | **INTEGRATED v3:** extended `usageMetadata` type with `thoughtsTokenCount?` + `totalTokenCount?`. Output extraction sums `candidatesTokens + thoughtsTokens` into `outputTokens`. Added 2 tests asserting the sum logic + backward-compat path when field absent. |
| C-m3 | MINOR | No regression test for Bug 53a integration-throw → UNAVAILABLE row | **INTEGRATED v3:** +2 tests in `plan-reviewer.test.ts` (Error throw + non-Error throw). |
| C-m4 | MINOR | `(err as Error)` cast unsafe for `throw null` / `throw "string"` | **INTEGRATED v3:** `instanceof Error` narrow with `String(err)` fallback for both `.message` and `.stack`. |

**Cleared-checks (Codex verified ALL clear):**
- `systemInstruction`, `temperature`, camelCase nested `thinkingConfig.thinkingLevel` ARE accepted by `@google/genai` `GenerateContentConfig`.
- Spread-conditional was safe (later removed in v3 since thinkingLevel is now always passed).
- `UNAVAILABLE` for integration doesn't collide with the `oneReviewerDown` check (that logic only compares Gemini/Codex calls).

**Codex sources:** Google GenAI SDK `GenerateContentConfig` docs, `ThinkingConfig` docs, Gemini 3 guide, SDK usage metadata docs. Persona depth score 4.

### v3 — Codex QA fidelity pass (REQUEST_CHANGES → 1-character fix → CLEAN)

Codex QA verified v3 fidelity:
- ✅ MAJOR-2 (thoughtsTokenCount sum) — applied correctly
- ✅ MINOR-3 (Bug 53a regression tests) — applied correctly
- ✅ MINOR-4 (instanceof Error narrow) — applied correctly
- ⚠️ MAJOR-1 fidelity gap: the literal string `thinkingBudget` still appeared in two historical-context comments. **Functionally clean** (knob renamed, helper renamed, all functional refs gone). **Fixed in v3.1** (this synthesis doc): comment blocks reworded to remove the legacy literal. Historical context preserved in this synthesis doc instead. Re-grep clean across all 5 sandbox files.

**Codex QA scope statement:** read sandbox files + live files; attempted shell test execution but blocked by sandbox policy.

## Files shipped (v3.1)

| File | Live path | Change shape |
|---|---|---|
| `sandbox/plan-transports.ts` | `agent/lib/plan-transports.ts` | +~70 LOC additive (new defaults, env helpers, expanded SDK type, thinking-level pipeline, thoughts-token sum) |
| `sandbox/plan-reviewer.ts` | `agent/lib/plan-reviewer.ts` | +~30 LOC surgical (`runIntegration` catch block: synthetic UNAVAILABLE row + instanceof Error narrow) |
| `sandbox/plan-transports.test.ts` | `agent/test/plan-transports.test.ts` | +5 tests (config-key propagation, env override, invalid fallback, thoughts-token sum, backward compat) |
| `sandbox/plan-reviewer.test.ts` | `agent/test/plan-reviewer.test.ts` | +2 tests (Bug 53a regression: Error throw + non-Error throw) |
| `sandbox/.env.example` | `agent/.env.example` | +~12 LOC documenting GEMINI_THINKING_LEVEL + GEMINI_TEMPERATURE + GEMINI_SYSTEM_INSTRUCTION |

**Expected test counts post-promote:** 106 baseline + 7 new = **113 pass**. Will verify after promote.

## Cost summary

| Round | Reviewer | Wall-clock | Cost |
|---|---|---|---|
| v1 | Gemini CLI | ~3 min (with 429 retries) | $0 (CLI OAuth subscription quota) |
| v2 | Codex exec | ~6 min | $0 (CLI OAuth subscription quota) |
| v3 QA | Codex exec | ~5 min | $0 (CLI OAuth subscription quota) |
| **Total** | | **~14 min** | **$0** |

(Both CLI invocations run on subscription quota, not direct API. Production worker calls — the ones the gate fires — are paid API calls; this MRPF process itself runs free.)

## Dogfood observations

### 1. The Gemini-3 knob naming convention is a real footgun

The Gemini 2.5 → Gemini 3.x migration renamed `thinkingBudget` (numeric) to `thinkingLevel` (enum). Both are still in the SDK type union for back-compat, but only one is the "right" knob per model family. Without Codex's web-grounded check, my v2 patch would have shipped with the legacy knob — functioning suboptimally in production without obvious error signal. The cost of getting this wrong was hidden: the model just thinks suboptimally without a 400 to surface it.

**Memory candidate:** add `feedback_gemini_3_uses_thinkingLevel_not_thinkingBudget.md` — flag when copying Gemini 2.x code patterns to 3.x.

### 2. `thoughtsTokenCount` is critical for cost-cap accuracy

Without summing thoughts into output_tokens, the cost cap was under-counting Gemini 3 reasoning by ~50-80% of actual output. Production cost cap would have been too lax (jobs running over budget without tripping the breaker). And the Bug 52 success criterion ("output tokens should jump from 31 → 1000+") was wrong — the reasoning tokens would land in a field we weren't reading.

**Memory candidate:** add `feedback_gemini_3_thoughts_tokens_separate.md` — for any Gemini 3.x consumer code, capture `thoughtsTokenCount` from `usageMetadata`.

### 3. Sequential MRPF justifies its cost again

The v2 → v3 → v3.1 chain (Codex v2 catches Gemini missed + Codex QA catches author missed) is the third consecutive cycle where Codex's code-grounded round post-Gemini surfaces real bugs that holistic-only review would have missed. Each round here was ~5 min wall-clock at $0 (CLI quota). The MRPF v2.2 sequential pattern continues earning its keep on AGENT BEHAVIOR labels.

### 4. The QA round caught a comment-text fidelity gap that pure-function tests would never have surfaced

Codex's QA verified a literal string was absent from the file. The functional code was correct; only the comment text named the legacy term. Tests would have all passed even with the gap. This is exactly the value of a fidelity-QA round vs relying on test passing alone.

## Test plan post-promote

1. `pnpm -C agent exec tsc --noEmit && pnpm -C frontend exec tsc --noEmit` — must pass clean.
2. `node --import=tsx --test test/plan-*.test.ts` — expect 113 pass (was 106 + 7 new).
3. `bash scripts/test-phase-b-storage-paths.sh` — grep guard against legacy storage paths.
4. Restart worker daemon via `Start-ScheduledTask -TaskName DynamicResearchWorker` (current PID 30584 → new PID).
5. Re-pend job 23dea6c3 (currently `status=cancelled`) for live n=3 telemetry on the fixed gate.
6. Verify Gemini findings count > 0 on the new gate cycle (Bug 52 success criterion).
7. Verify `thoughtsTokenCount` in usageMetadata flows into `output_tokens` (cross-check via `plan_reviews.input_tokens` + `.output_tokens` columns after gate cycle).

## Related memory

- `feedback_multi_reviewer_gate_dependent_pattern.md` — MERGE-gate sequential pattern (Gemini → Codex)
- `feedback_codex_exec_readonly_blocks_own_verification.md` — Codex sandbox blocks own test execution; verifier supplies pre-verified results
- `feedback_long_bg_waits_kill_prompt_cache.md` — bg waits in MRPF round bracket cache TTL; total reviewer wall-clock ~14min here stayed inside one cache window
- `project_multi_reviewer_policy_framework_v2_shape.md` — Event Gate × Risk Label × Severity Mode policy
- `feedback_within_artifact_reviewer_blindspot.md` — sweep ALL occurrences of each pattern-level finding (executed here: re-grepped `thinkingBudget` literal across all 5 sandbox files after Codex QA flagged one)
