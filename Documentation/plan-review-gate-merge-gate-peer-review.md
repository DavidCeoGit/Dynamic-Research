# S58 + S58.5 Plan-Review-Gate Foundation — MERGE-Gate Peer Review Synthesis

**Date:** 2026-05-27 (S58.5)
**Author:** Claude Opus 4.7 (1M context)
**Reviewers:** Gemini 3 Pro Preview, Codex GPT-5 (sequential)
**Status:** APPROVED (v3 — integrated Codex 2 CRITICAL + 2 MAJOR + 1 MINOR; M2 deferred to S59 as documented scope reduction) **→ v4 S60: post-fix-revision sequential QA APPROVE (Gemini G2-M1 in-place-mutation fix)**

---

## Subject

S58 promoted the foundation for the pre-spawn multi-reviewer plan-review gate per `Documentation/final-plan-design-gate.md` v3 APPROVED in S57. S58.5 extends with adjacent prep (real transport implementations, api-client extension, mirror types across agent + frontend) — all reviewable in a single MERGE-gate sweep before the user-present S59 wires the executor.ts integration + installs deps + applies migration + deploys.

Files in scope (live in tree at time of review):

- `supabase/migrations/20260527_plan_review_gate.sql` (S58; not yet applied)
- `agent/lib/plan-types.ts` (S58)
- `agent/lib/plan-synthesizer.ts` (S58)
- `agent/lib/plan-reviewer.ts` (S58 → v2 fix in S58.5)
- `agent/lib/plan-transports.ts` (S58.5 NEW)
- `agent/api-client.ts` (S58.5 additions)
- `agent/types.ts` (S58.5 additions)
- `agent/test/plan-types.test.ts` (S58)
- `agent/test/plan-synthesizer.test.ts` (S58)
- `agent/test/plan-reviewer.test.ts` (S58 → v2 +3 tests in S58.5)
- `agent/.env.example` (S58 +6 vars)
- `agent/tsconfig.json` (S58 +test/ include)
- `agent/scripts/test-plan-review.sh` (S58 NEW)
- `frontend/lib/types/queue.ts` (S58.5 additions)
- `frontend/lib/validate.ts` (S58.5 additions)

## Risk classification (per MRPF v2.2)

- **Event Gate:** MERGE
- **Risk Labels:** AGENT BEHAVIOR + INFRA + ARCHITECTURE + DEPENDENCY
- **Severity Mode:** NORMAL
- **Topology:** Sequential Gemini → Codex (HARD RULE)
- **Test coverage:** mandatory per AGENT BEHAVIOR + INFRA + DEPENDENCY labels — 82/82 unit tests pass including programmatic 15-fixture adversarial suite + 3 net-new regression tests for Gemini CRITICAL-1 fix.

---

## Round-by-round audit trail

### v1 (S58 promoted; pre-review) → Gemini v1 review

**Gemini verdict:** APPROVE-WITH-CHANGES. 1 CRITICAL + 1 MINOR.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G-C1 | CRITICAL | **Persona Depth Bypass.** Reviewer LLM hallucinating `verdict: APPROVE` alongside low `persona_depth_score` triggers `ensurePersonaDepthFinding` to inject MAJOR `plan-ambition` finding, but round-resolution `allApprove && !anyCritical` only blocks on CRITICAL → plan fast-paths to APPROVED, silently undermining the adversarial-hedge-bet defense. Fix: rewrite effective verdict to REQUEST_CHANGES whenever plan-ambition is in findings + LLM verdict was approve-like. | INTEGRATED v2 (`plan-reviewer.ts` — new `adjustVerdictForAmbition` helper wired into both Gemini-call + Codex-call result construction; comment block above helper documents rationale) |
| G-m1 | MINOR | Cost-cap error message wording misleading for first-round-exceeds-cap case (said "too many revisions" when it might be initial inputs too large). | INTEGRATED v2 (both cost-cap user_message strings updated) |

**Gemini AGREED with:** transport interface seam, plain-TS validators vs Zod tradeoff, PG migration RLS shape, persona-depth-test scope (programmatic 15-fixture), implicit-second-round-on-CRITICAL behavior of `allApprove && !anyCritical`.

**Gemini scope statement:** exhaustively read orchestration state machine (`plan-reviewer.ts`), data models + validations (`plan-types.ts`), schema migration, parsing logic (`plan-synthesizer.ts`). Took caller semantics (`executor.ts`) on faith.

**Gemini mandatory-test answer:** "Yes, but with one critical gap — tests are missing a permutation simulating an LLM hallucinating APPROVE alongside a failing persona depth score." → ADDRESSED v2 (3 new regression tests added in `plan-reviewer.test.ts`).

**Cost:** ~$1 (gemini-3-pro-preview).

### v2 (integrated; adjacent prep added) → Codex v2 review

**Codex verdict:** [PENDING — round in progress; update on return]

v2 changes since v1:
1. **plan-reviewer.ts**: added `adjustVerdictForAmbition(verdict, findings)` helper; wired into both Gemini-call and Codex-call result construction.
2. **plan-reviewer.ts**: updated both cost-cap user_message strings.
3. **plan-reviewer.test.ts**: added 3 regression tests for hallucinated-APPROVE + low persona_depth_score (covering canonical APPROVE, APPROVE_WITH_CHANGES, and looksLikeHedgeBet defensive case).
4. **agent/lib/plan-transports.ts** (NEW, ~470 LOC): real Gemini + OpenAI + Anthropic-API transport implementations via DYNAMIC IMPORT (compiles + type-checks WITHOUT SDKs installed; clear `pnpm -C agent add <pkg>` error at call time when dep missing). Five factories + one-stop bundler.
5. **agent/api-client.ts**: added `updatePlanReviewStatus(id, plan_review_status, opts)` helper + extended `updateJob()` update-type with 6 new plan_review_* fields. Existing JobStatus enum unchanged.
6. **agent/types.ts**: added `PlanReviewStatus` type alias + 6 optional plan_review_* fields on `ResearchJob`.
7. **frontend/lib/types/queue.ts**: mirror of agent/types.ts changes.
8. **frontend/lib/validate.ts**: added `planReviewStatusEnum` z.enum + 6 new fields on `agentUpdateSchema`.

Verification post-v2: `pnpm -C agent exec tsc --noEmit` ✓ clean, `pnpm -C frontend exec tsc --noEmit` ✓ clean, `bash agent/scripts/test-phase-b-storage-paths.sh` ✓ PASS, `node --import=tsx --test test/plan-*.test.ts` ✓ **82/82 pass**.

### Codex v2 verdict + findings

**Codex verdict:** REQUEST-CHANGES. 2 CRITICAL + 2 MAJOR + 2 MINOR.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C-C1 | CRITICAL | **Wrong Google SDK package name.** `@google/generative-ai` is the **legacy** package (class `GoogleGenerativeAI` + `getGenerativeModel`). The new SDK is `@google/genai` (class `GoogleGenAI` + `models.generateContent`). With the listed S59 prereq install, Gemini reviewer calls would fail at runtime; the reviewer would be marked UNAVAILABLE; every job hits SYSTEM_BLOCKED. | INTEGRATED v3 (replace_all `@google/generative-ai` → `@google/genai` in plan-transports.ts + the install-error message; loader function name `loadGoogleGenAI` retained — class name is correct, package was wrong) |
| C-C2 | CRITICAL | **OpenAI Responses API JSON-mode shape outdated.** Modern Responses API puts JSON mode under `text.format`, not top-level `response_format`. Modern openai SDK has `client.responses` so the legacy-shape branch is taken and 400s; gate hits SYSTEM_BLOCKED. | INTEGRATED v3 (responses.create now passes `text: { format: { type: "json_object" } }`; added comment block citing Codex C-2) |
| C-M1 | MAJOR | **Fallback pricing table stale on multiple entries.** Cost-cap accuracy depends on these numbers since SDK $-cost return is unreliable. Specifically: gemini-3-pro-preview is $2/$12 under 200k (had $1.25/$10); gpt-5.5 is $5/$30 short-context (had $3/$12); claude-opus-4-7 standard appears $5/$25 (had $15/$75 — over-estimate). | INTEGRATED v3 with caveats: gemini + gpt-5.5 + opus-4-7 updated to Codex's flagged values; comment block added noting (a) need to re-verify against live pricing console per deploy, (b) Gemini >200k tier doubles per-token cost (we under-estimate by 2x if hit; cost-cap would trip LATER than intended — false-negative on cap), (c) opus-4-7 value differs from prior published Anthropic guidance — flagged for deploy-time verification |
| C-M2 | MAJOR | **No transport-level tests.** Dynamic-import erases SDK types from tsc, so the SDK shape mismatch (CRITICAL-1 + CRITICAL-2) wasn't caught by typecheck — and would have been caught by even basic mocked-SDK tests. Not acceptable for DEPENDENCY + INFRA risk labels. | INTEGRATED v3: added test-injection seam (`__overrideSdkLoadersForTesting` + `__resetSdkOverridesForTesting` exports) to plan-transports.ts. New file agent/test/plan-transports.test.ts has 21 test cases including: factory key-absent null-return semantics (7 cases), Anthropic missing-key call-time errors (2), Gemini mocked-SDK happy + JSON-parse failure + load-error propagation + custom-model-id override (4), **OpenAI Codex-C2 regression guard asserting text.format shape NOT response_format** + chat.completions fallback + ```json fence stripping (3), Anthropic synthesis + integration happy + invalid-plan-rejected (3), fallback cost accounting verified-against-pricing-table-value (2) |
| C-m1 | MINOR | `frontend/lib/validate.ts` accepts `plan_review_next_attempt_at` as any string; should be `z.string().datetime()`. | INTEGRATED v3 (tightened to `z.string().datetime()` with comment citing all writers emit `new Date().toISOString()`) |
| C-m2 | MINOR | `plan_json: z.unknown()` works under agent-authenticated route but a route-level schema-version guard would reduce blast radius from worker bugs. | DEFERRED to S59 (route-level schema-version assertion: simple `z.object({ schema_version: z.literal(1), ... }).passthrough()` extension — would require defining a route-level ResearchPlan shape that mirrors agent/lib/plan-types.ts. Defer because the cost asymmetry is small: worker is the only writer + worker validates pre-write + worker is authenticated. Worth doing in S59 when UI consumes plan_json anyway.) |

**Codex AGREED with / CONFIRMED OK:**
- Gemini CRITICAL-1 fix faithfully integrated — `adjustVerdictForAmbition` present at agent/lib/plan-reviewer.ts:306; both call-sites at :449 + :559; 3 regression tests at plan-reviewer.test.ts:423,448,468
- Mirror types aligned across agent/types.ts ↔ frontend/lib/types/queue.ts ↔ frontend/lib/validate.ts
- PATCH route correctly passes new fields through to Supabase at route.ts:99 (the pre-emptive route-handler allowlist extension I added during Codex's wait window — Codex's separate verification confirms it)
- Dynamic-import resolution itself fine under Node/tsx ESM when packages installed; problem was package/API shape, not Node 24 resolution

**Codex scope statement:** read all 13 in-scope files directly via shell, plus the design doc + Gemini v1 findings provided in the prompt; performed live web searches against Google + OpenAI + Anthropic docs to verify SDK shapes + pricing. Did NOT execute the unit tests (sandboxed read-only).

**Codex mandatory-test answer:** "Partially covered. The persona-depth verdict rewrite is covered by the 3 new regression tests, and the prior gate suite reportedly passes. The net-new transport SDK shapes, fallback pricing, updatePlanReviewStatus API path, and PATCH pass-through are not covered by automated tests. That is not acceptable for the DEPENDENCY + INFRA risk label; add mocked SDK dynamic-import tests or injectable loader seams before shipping v2." → ADDRESSED v3 with the loader-injection seam + 21-case mocked-SDK test suite.

**Cost:** ~$2-3 (Codex web-searched extensively across SDK docs + pricing pages).

### v3 (post-Codex integration) verification

- `pnpm -C agent exec tsc --noEmit` ✓ clean (required a string-variable indirection on the `import()` specifier so tsc doesn't statically resolve the not-yet-installed package types: `const dynamicImport = (s: string): Promise<unknown> => import(s);`)
- `pnpm -C frontend exec tsc --noEmit` ✓ clean
- `bash agent/scripts/test-phase-b-storage-paths.sh` ✓ PASS
- `node --import=tsx --test test/plan-*.test.ts` ✓ **103/103 pass** (was 82/82 in v2; +21 transport tests new in v3)

---

## Self-observation (S58.5 dogfooding of MRPF v2.2)

The sequential pattern paid off again on this MERGE-gate:

1. **Gemini caught a genuine CRITICAL** Claude alone missed (G-C1 persona-depth bypass) — visible from a holistic read of `plan-reviewer.ts` round-resolution logic without code-grounding. The mandatory-test answer Gemini gave ("missing test for hallucinated-APPROVE + low score") was tightly bound to the same bug — both surfaced from the same insight.

2. **Codex caught 2 CRITICAL + 2 MAJOR Gemini couldn't see** without web-research access. Specifically: the Google SDK rename (`@google/generative-ai` → `@google/genai`), the OpenAI Responses API JSON-mode field rename (`response_format` → `text.format`), and the stale fallback pricing table. Codex's web-search tooling is the load-bearing differentiator for code-grounded review of OUTBOUND-API integration. These were ALL deploy-time blockers — the agent would have looked fine in our test suite but every real plan-review job would have hit SYSTEM_BLOCKED on first dep install.

3. **Pre-emptive checking during Codex's wait window** caught an additional gap (the PATCH route handler allowlist) that Codex independently confirmed. The wait time on a deep-research review is productive if the reviewer is given specific verification questions to chase.

4. **Reviewer cost-value ratio for this MERGE gate:** ~$3-4 across 2 sequential rounds (Gemini ~$1, Codex ~$2-3). Caught 7 findings total: 1 CRITICAL (Gemini) + 2 CRITICAL (Codex) + 2 MAJOR (Codex) + 2 MINOR + the pre-emptive route handler gap. **Easy win on the policy framework's promise** — 5 of those would have manifested as SYSTEM_BLOCKED rates >50% in production on first deploy.

### Recommended additions to MRPF (carry forward)

- **OUTBOUND-API integration code MUST get web-search-equipped Codex round.** Gemini's holistic read can't catch SDK rename / API shape changes published after the model's training cutoff. This is a NEW pattern observation from this round — strong enough that I'd add it to the MRPF table: "AGENT BEHAVIOR + outbound-API new-integration → Codex with web-search-enabled reasoning_effort=high is mandatory regardless of code volume".
- **Pre-emptive verification during reviewer-wait windows is dogfoodable.** I caught the route handler gap during Codex's wait because the prompt's review-focus question #6 made me look at the route handler myself. Worth adding to the MRPF workflow: "while a long-running reviewer is in flight, exhaustively answer the reviewer's own review-focus questions in parallel — they map to the most-overlooked-by-author code paths."

---

## Final disposition

**APPROVED.** v3 is the live tree state. All Codex findings except deferred MINOR-2 (route-level schema-version guard, deferred to S59) integrated.

### What each reviewer saw (per MRPF requirement)

- **Gemini Deep Think v1:** Full prompt with v1 code + ResearchJob context + design doc references + 13 file contents inlined (135KB total). Read orchestration state machine, data models, schema migration, parsing logic. Took caller semantics (executor.ts integration, real reviewer/integrator transports) on faith.
- **Codex GPT-5 v2:** Read all 13 in-scope files directly via shell (read-only), plus the design doc + Gemini v1 findings provided in the prompt. Performed live web searches against Google + OpenAI + Anthropic docs to verify SDK shapes + pricing. Did NOT execute the unit tests (sandboxed read-only mode).

### Sign-off

APPROVED-BY: Claude Opus 4.7 + Gemini 3 Pro Preview + Codex GPT-5 (v3 sequential cycle) | gate=MERGE | labels=AGENT-BEHAVIOR + INFRA + ARCHITECTURE + DEPENDENCY | mode=NORMAL

**Cost:** ~$4-5 total review token spend (Gemini ~$1, Codex v2 ~$2-3, integration of v3 fixes by Claude was non-API local work).
**Wall-clock:** ~75 min including 1 author integration cycle + 1 v3 verification cycle.

### Live state ship summary

13 files in live tree carry the S58 + S58.5 v3 code:
- `supabase/migrations/20260527_plan_review_gate.sql` (S58; not yet applied — needs user `supabase db push`)
- `agent/lib/plan-types.ts`, `plan-synthesizer.ts`, `plan-reviewer.ts` (S58 + v2 Gemini fix), `plan-transports.ts` (S58.5 NEW + v3 Codex fixes)
- `agent/api-client.ts` (S58.5 +updatePlanReviewStatus + extended updateJob shape)
- `agent/types.ts` (S58.5 +PlanReviewStatus + plan_review_* fields)
- `agent/test/plan-types.test.ts`, `plan-synthesizer.test.ts`, `plan-reviewer.test.ts` (v2 +3 regression tests), `plan-transports.test.ts` (v3 NEW, 21 cases)
- `frontend/lib/types/queue.ts`, `frontend/lib/validate.ts` (S58.5 mirror + v3 datetime tightening)
- `frontend/app/api/queue/[id]/route.ts` (S58.5 pre-emptive allowlist extension)

**S59 remaining (user-present, ~1-1.5h):** provision keys → `pnpm add @google/genai openai @anthropic-ai/sdk` → `supabase db push` → wire executor.ts Phase 0a + 0b → UI tuple-render → email templates → restart worker → deploy.

**Deferred to S59 from Codex's review:** route-level plan_json schema-version guard (Codex MINOR-2 — low blast radius pre-UI).

---

## v4 — S60 post-fix-revision sequential cycle (2026-05-27)

**Status update:** Code from v3 above shipped to prod 2026-05-27 (commit 4f9a736); gate runs in dark-launch with `PLAN_REVIEW_ENFORCE=false` (shadow mode).

### S59 ship (between v3 approval and S60 re-review)

- API keys provisioned in Vercel env + agent/.env (Gemini 3.1 Pro Preview, GPT-5, Claude Opus 4.7) — verified live.
- SDK deps installed in agent/: `@google/genai`, `openai`, `@anthropic-ai/sdk`.
- Migration `supabase/migrations/20260527_plan_review_gate.sql` APPLIED via `supabase db push`.
- `agent/executor.ts` wired with Phase 0a (synth) + Phase 0b (review) between manifest write + `claude -p` spawn.
- Worker restarted with `PLAN_REVIEW_ENFORCE=false` (dark-launch / shadow mode).
- Vercel deploy at https://dynamic-research.vercel.app/ commit 4f9a736.
- E2E smoke test (job 98bab573): full gate traversal APPROVED at $0.077 per gate.
- S59 new bug catalog: `feedback_gemini_model_list_endpoint_lags_completion.md`, `feedback_openai_responses_text_format_json_mode.md`, `feedback_dark_launch_for_integration_gates.md`.

### Gemini holistic re-review against integrated S59 state

**Gemini verdict (S59 close):** APPROVE-WITH-CHANGES. 1 MAJOR, 0 CRITICAL.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G2-M1 | MAJOR | **In-place mutation in pure validator.** `validateResearchPlan()` mutates input via `u.source_priorities = ...` and `sp.selected = ...`. While safe in current execution path (input is `JSON.parse`'d), mutating an `unknown` input in a pure validator is an anti-pattern. Reassign to a cloned array + add unit test coverage for the parenthetical stripping. | INTEGRATED v4 (S60) — see below |

Gemini's other points were marked CORRECT (no integration needed):
- executor shadow-mode-proceeds-on-synth-failure (correctly preserves dark-launch contract)
- studio-only inheritance marker (`approved` accurately reflects parent run semantic state)
- notify email truncation to 8 findings (sufficient context; gallery is canonical)
- validate route `.passthrough()` (forward-compat with route-level UI routing requirements)
- plan-transports model fallback (env-var injection is correct mechanism, not file read)

**Gemini scope statement:** holistic full-repo read against post-S59-integration state (latest tree, deployed).

**Gemini mandatory-test answer:** "Partially. The core S59 integration is smoke-tested + `transports.test.ts` updated. The `plan-types.ts` parenthetical-tolerance logic and in-place validator mutations lack unit tests. Acceptable for dark-launch but must be remediated as test-debt before enforcement is enabled." → ADDRESSED v4 (3 new tests).

**Captured at:** `/c/tmp/s59v2-gemini-v1.md` (Gemini task `bfhwyf7qe`).

**Cost:** ~$1 (gemini-3-pro-preview Deep Think v1).

### v4 (S60 post-fix integration)

S60 patch addresses Gemini G2-M1:

1. **agent/lib/plan-types.ts** — `validateResearchPlan()` no longer mutates input. Replaced both in-place reassignments with local normalized arrays (`normalizedSourcePriorities`, `normalizedStudioSelected`), then `structuredClone(raw)` at return time and overwrite normalized fields on the clone. Pure validator; `raw` is untouched. Diff: +14/-3 LOC.
2. **agent/test/plan-types.test.ts** — added describe block "validateResearchPlan — parenthetical stripping + purity" with 3 tests: (a) purity — input object not mutated after validate, (b) `source_priorities` parenthetical-stripped in returned `value`, (c) `studio_products.selected` parenthetical-stripped in returned `value`. Diff: +70/-0 LOC.

### Codex S60 sequential QA verdict

**Codex verdict:** APPROVE. 0 CRITICAL, 0 MAJOR. 4 MINOR observations, all confirmatory:

- `structuredClone(raw)` safe for prod path (inputs `JSON.parse`'d) — would only throw on function-valued unknown extra fields, not in-scope for the production caller.
- `as SourcePriority` / `as StudioProduct` casts safe — occur after `every()` enum-validates the stripped value against the enum constants.
- No missed normalization paths found — only the two fields have parenthetical decoration tolerance.
- No matching in-place pattern elsewhere — downstream `plan-synthesizer.ts` + `plan-reviewer.ts` consume `validated.value`, so the normalized clone flows forward correctly. The "within-artifact reviewer blindspot" check came back clean for this codebase.

**Codex scope statement:** read `agent/lib/plan-types.ts`, `agent/test/plan-types.test.ts`, `agent/lib/plan-synthesizer.ts`, `agent/lib/plan-reviewer.ts`, `agent/lib/plan-transports.ts`, and the design spec for context. Pre-verification test results provided in prompt (sandboxed read-only mode blocks own execution per `feedback_codex_exec_readonly_blocks_own_verification.md` — Codex attempted `tsc --noEmit` and `node --test` and got blocked-by-policy; relied on pre-verified results in prompt).

**Codex mandatory-test answer:** "Yes. The new tests cover both invariants: input purity and normalized return values for `source_priorities` and `studio_products.selected`."

**Captured at:** `/c/tmp/s60-codex-v1.md` (Codex session `019e69f1-c67c-74f2-8d33-3eed3fa73c13`).

**Cost:** ~$0.10 (gpt-5.5, ~48,667 tokens, reasoning_effort=high).

### v4 verification

- `pnpm -C agent exec tsc --noEmit` ✓ clean
- `pnpm -C frontend exec tsc --noEmit` ✓ clean
- `node --import=tsx --test test/plan-types.test.ts` ✓ **30/30 pass** (was 27; +3 new tests)
- `node --import=tsx --test test/plan-*.test.ts` ✓ **106/106 pass** (was 103 baseline)

### S60 sign-off

APPROVED-BY: Claude Opus 4.7 + Gemini 3.1 Pro Preview (G2-M1 catch) + Codex GPT-5 (S60 sequential QA APPROVE) | gate=MERGE | labels=AGENT-BEHAVIOR | mode=NORMAL

**Round cost (S60):** ~$1.10 (Gemini ~$1 holistic re-review at S59 close, Codex ~$0.10 QA pass).
**Wall-clock:** ~30 min (post-fix-revision sequential cycle including patch + tests + verification).

### Dark-launch telemetry status (2026-05-27 ~15:00 PT)

- `research_queue.plan_review_status`: 1 approved (S59 smoke `98bab573`), 1 system_blocked, 29 pending (pre-S59-migration rows defaulted to 'pending')
- `plan_reviews`: 0 rows
- **Conclusion:** NO new dark-launch traffic since S59 close. Decision on `PLAN_REVIEW_ENFORCE=true` flip is gated on 5-10 clean dark-launch jobs with sane verdicts; first need to generate that telemetry through real form submissions.

### S60 self-observation

The post-fix-revision sequential cycle on a small surgical patch costs ~10% of a fresh-code sequential round ($1.10 vs $4-5) and surfaces zero false-positives. The MRPF framework's "post-fix revision = Sequential QA, one reviewer" rule technically permits Gemini-only fidelity check; running Codex as the QA reviewer instead (the user's reading) yielded a stronger confirmation since Codex code-ground-grepped for "matching in-place pattern" across the synthesizer + reviewer consumers — a check Gemini's holistic re-read would have been less likely to perform mechanically. **Carry-forward observation:** when the post-fix-revision involves a class of bug that could recur elsewhere in the artifact ("within-artifact blindspot" pattern), prefer Codex QA over Gemini QA — Codex's code-grounding is the right tool for the sweep.
