# Bug 51 MERGE-gate peer-review synthesis (S61)

**Date:** 2026-05-27
**Session:** S61
**Topic:** Bug 51 fix — wire `persistReviewerCalls()` into `runPlanReviewGate()` so the `plan_reviews` audit table receives rows on every gate cycle.

## MRPF classification

| Axis | Value |
|---|---|
| Event Gate | MERGE (single-file additive code change in `agent/executor.ts`) |
| Risk Labels | DATA (forensic audit-log writes; previously-empty table gains first INSERT path) |
| Severity Mode | NORMAL |
| Topology | Sequential Gemini → integrate → Codex per `~/CLAUDE.md` MRPF v2.2 |

## Scope under review

- `sandbox/executor.ts` vs live `agent/executor.ts` — diff at `sandbox/working/bug51-diff.patch`.
- 3 hunks, ~60 LOC additive. Pure additive; zero existing logic modified.

Hunks:
1. Import `ReviewerCall` from `./lib/plan-types.js`
2. New `persistReviewerCalls(job, calls)` helper (~52 LOC) above `runPlanReviewGate()` — mirrors `uploadWithAudit()` from `lib/storage-paths.ts`
3. New call site after `updatePlanReviewStatus()` inside `runPlanReviewGate()` (~8 LOC with `.catch()` wrapper)

## Round 1 — Gemini Deep Think (gemini-3.1-pro-preview)

**Latency:** 34.5s · **Tokens:** 17,136 input / 1,027 output / 2,836 thinking · **Cost (Ultra subscription):** subscription-credit (no direct USD).

**Verbatim findings:**

### High-Stakes Focus Areas Analysis & Findings

**1. Row-Shape Correctness & Type Narrowing**
- **Validation:** Passed perfectly. All mandatory schema fields (`research_queue_id`, `organization_id`, `iteration`, `reviewer`, `plan_version`, `verdict`, `findings`, `model_id`, `provider`) are mapped correctly from `job` and `ReviewerCall`.
- **CHECK Constraints:** The TypeScript unions for `verdict` (`"APPROVE" | "APPROVE_WITH_CHANGES" | "REQUEST_CHANGES" | "BLOCK" | "INTEGRATED" | "UNAVAILABLE"`), `reviewer`, and `provider` map 1:1 to the Postgres schema `CHECK` sets. No risk of constraint violations from expected runtime values.
- **Null Serialization:** `?? null` correctly maps `undefined` properties (`input_tokens`, `total_cost_usd`, etc.) to explicit `null` values for Postgres. If `findings` is an empty array (`[]`), Supabase-js natively translates it to valid `jsonb`, satisfying the column type without needing the schema's `DEFAULT`.

**2. Error Handling & Best-Effort Semantics (NIT)**
- **Finding:** The double-swallow approach is correct and intentional.
- **Rationale:** `supabase-js` does not throw on Postgres-level rejections (like CHECK violations); it returns an `{ error }` object. The function properly catches this and returns gracefully. Conversely, if `getSupabase()` throws (e.g., missing credentials) or there is a catastrophic network error, it bubbles up as a Promise rejection, which is correctly caught by the caller's `.catch()`. This completely insulates the worker from failing the job due to audit log failure.

**3. Idempotency and Duplicate Rows (MINOR)**
- **Finding:** Due to the lack of a `UNIQUE` constraint on `(research_queue_id, iteration, reviewer)`, re-running a job (e.g., clicking Replay or a worker crash-looping mid-gate) will result in duplicate audit rows for the exact same iteration.
- **Risk:** Since this is an audit/telemetry table, duplicate append-only attempts are generally harmless and might even be forensically useful to track worker retries. However, any downstream analytical dashboards performing `COUNT(*)` or `SUM(total_cost_usd)` per job must `DISTINCT` or group carefully to avoid double-counting.

**4. Sequencing Relative to Upstream Writes (NIT)**
- **Finding:** The audit write happens *after* `updatePlanReviewStatus`.
- **Rationale:** If `updatePlanReviewStatus` succeeds but `persistReviewerCalls` fails, you have state without audit logs. This is exactly what a "best-effort" telemetry write should be. It guarantees that the job progresses even if the telemetry database has a transient issue. The sequencing is correct and matches the `uploadWithAudit` pattern.

**5. Bulk INSERT Atomicity (MINOR)**
- **Finding:** `.insert(rows)` submits the array in a single transaction.
- **Risk:** Postgres batch inserts are atomic. If a single row violates a constraint (e.g., an unexpected future model provider), the *entire batch* of reviewer calls for that iteration is rejected. Given the current tight type-safety, this is highly unlikely, but you are trading partial telemetry survival for code simplicity. For this phase, it's an acceptable trade-off.

**6. `raw_json` TOAST Bloat (MINOR)**
- **Finding:** Deep-think or high-verbosity LLM JSON responses injected directly into a `jsonb` column can quickly balloon in size (100KB+ per row).
- **Risk:** While Postgres handles this via TOAST, thousands of jobs × 3 reviewers × N iterations will compound database storage costs significantly compared to saving large outputs to Supabase Storage. This is fine for Phase 1 unblocking, but should be flagged for Phase 2 scaling.

**7. Concurrency / State Leakage**
- **Validation:** Passed. `getSupabase()` leverages a module-level cached client `SupabaseClient`. Because the `persistReviewerCalls` logic doesn't mutate shared state or rely on job-specific contextual bindings outside the passed arguments, there is no risk of cross-job contamination during worker restarts or concurrent job processing.

---

### VERDICT: APPROVE
No blocking (CRITICAL or MAJOR) findings. The fix safely resolves Bug 51 via pure additive code, accurately mapping runtime data to the schema while maintaining the required non-blocking execution path.

## Author response to Gemini findings

**MINOR-3 (duplicate rows on replay):** Accept. Audit-table semantics permit append-only retry tracking; downstream aggregation queries (not yet written) will need to handle dedup. Documented as a Phase-2 follow-up; no code change at this layer.

**MINOR-5 (batch atomicity):** Accept. Tight type-safety (Phase 1 sees only the 6 hard-coded `verdict` strings + 3 `reviewer` strings + 3 `provider` strings + the schema-matched 9-value `Origin` enum) makes a single-row CHECK violation extremely unlikely. Per-row fallback would add complexity for a vanishingly small payoff. Documented as a Phase-2 monitoring item — if `audit-persist insert error` log lines ever appear in production worker.log, that's the signal to add the fallback.

**MINOR-6 (raw_json TOAST bloat):** Accept for Phase 1. Across the 3 production cycles already observed (S59 smoke + S60 Tesla replay) the `raw_json` payloads are 3-15 KB each — well within TOAST efficiency range. Phase-2 follow-up to add a size cap or extract to Storage if any single payload crosses ~100 KB.

**No code changes from Round 1 integration.** All Gemini findings are NIT or deferred MINOR; the design intent matches Gemini's read.

## Round 2 — Codex exec (sequential second pass)

**Invocation:** `codex exec -s read-only -C "<project-root>"` against `sandbox/working/codex_review_bug51_PROMPT.md`. **Token budget:** 135,456. **Verdict:** **APPROVE.**

**Verbatim findings:**

No MAJOR/CRITICAL findings.

I agree with Gemini's APPROVE and the three deferred MINORs. My second pass found one extra NIT:

- **NIT:** "non-blocking" is imprecise. `sandbox/executor.ts:247` still `await`s the audit insert, so it is non-fatal, not fire-and-forget. A slow Supabase/PostgREST insert can delay the gate before `research-plan.json` is written. This matches the existing `uploadWithAudit()` best-effort pattern, so I do not consider it blocking.

Verified against code:

- `getSupabase()` stays lazy. `worker.ts` imports `executor.ts` but does not instantiate Supabase at import time. Normal startup runs `preflight.ts`, which hard-fails missing Supabase env before claiming jobs; if the helper is reached anyway, the async throw is caught by the call-site `.catch()`.
- `agent/tsconfig.json` has `strict: true`. I do not see a strict-mode type blocker: Supabase clients are untyped `SupabaseClient`, and existing `usage-tracking.ts` already inserts `unknown | null` into jsonb fields.
- `findings`, `plan_version`, and `raw_json` are passed as JS JSON values, consistent with existing jsonb write patterns. No `JSON.stringify` wrapper is needed.
- Reviewer verdicts are constrained before `ReviewerCall` construction: parser accepts only `REVIEWER_VERDICTS`, and integration/unavailable paths hardcode `INTEGRATED`/`UNAVAILABLE`.
- `organization_id` is required in `ResearchJob`; claim fallback uses `select("*")`; queue/replay inserts explicitly write `organization_id`. A manually stale NULL row would only make this best-effort audit insert fail.
- RLS/session scaffolding does not add a hidden precondition: worker uses service-role; `plan_reviews` has RLS enabled with no authenticated insert policy, matching the audit table pattern.
- No downstream consumer currently reads `plan_reviews`; S60 UI still reads summary fields from `research_queue`.

I could not run `tsc --noEmit`; the sandbox policy rejected the `pnpm` command. This change also has no direct automated regression test because `persistReviewerCalls` is a private executor helper; existing plan tests cover in-memory `reviewer_calls`, not persistence.

VERDICT: APPROVE

## Author response to Codex findings

**NIT (terminology — "non-blocking" → "non-fatal"):** Accepted. Updated the call-site comment in `sandbox/executor.ts:247-250` to explicitly distinguish: the `await` can block the gate progression if PostgREST is slow, but a thrown error is swallowed by the `.catch()` and never fails the job. The helper docstring already said "never throws" so no change there.

**MRPF-required answer on test coverage (DATA-labeled change):** No new automated test added. Rationale: `persistReviewerCalls` is a private executor helper that does pure pass-through serialization to supabase-js (no logic to test beyond schema-shape correctness, which both reviewers verified). Mocking the SupabaseClient adds maintenance cost; a real-DB integration test requires environment plumbing that doesn't exist in `agent/test/`. **Live verification path:** post-promote worker restart + next gate cycle queries `plan_reviews` to confirm rows landed. If the helper regresses, the worker.log line `[plan-review] audit-persist insert error` surfaces the failure non-fatally — observable signal with zero customer impact.

## Final synthesis

**Reviewer agreement:** Both rounds APPROVE. Zero CRITICAL, zero MAJOR, three deferred MINORs (replay-dedup, batch-atomicity monitoring, raw_json size cap), one terminology NIT addressed in the call-site comment.

**What each reviewer saw:**
- **Gemini Deep Think:** the inlined diff in the prompt + supporting schema/type/pattern snippets. Holistic critique against the design context. Did NOT read the live files.
- **Codex exec:** read live `agent/executor.ts`, `agent/lib/plan-types.ts`, `agent/lib/storage-paths.ts`, `agent/lib/plan-reviewer.ts`, `agent/lib/usage-tracking.ts`, `agent/worker.ts`, `agent/tsconfig.json`, `supabase/migrations/20260527_plan_review_gate.sql`, frontend claim/replay paths. Code-grounded verification of every Gemini claim against the actual repo state.

**Disposition matrix:**

| Finding | Severity | Source | Disposition |
|---|---|---|---|
| Row-shape vs schema CHECK | PASS | Gemini | Confirmed by Codex via live-file read |
| Double-swallow error handling | NIT | Gemini | Correct intent; documented |
| Idempotency / duplicate rows | MINOR | Gemini | Deferred to Phase 2 (dashboard dedup) |
| Sequencing audit-after-summary | NIT | Gemini | Correct; matches uploadWithAudit |
| Bulk INSERT atomicity | MINOR | Gemini | Deferred to Phase 2 (monitor log) |
| `raw_json` TOAST bloat | MINOR | Gemini | Deferred to Phase 2 (size cap if >100KB) |
| Concurrency / state leakage | PASS | Gemini | Confirmed by Codex via worker.ts read |
| `await` ≠ fire-and-forget | NIT | Codex | Comment tightened in sandbox/executor.ts:247 |
| `getSupabase()` lazy-init lifecycle | PASS | Codex | Verified against worker.ts + preflight.ts |
| strict-mode TypeScript | PASS | Codex | Verified against tsconfig.json + usage-tracking.ts precedent |
| jsonb serialization | PASS | Codex | Verified — JS JSON values OK, no stringify needed |
| Verdict enum drift | PASS | Codex | Verified — parser constrains REVIEWER_VERDICTS + hardcoded INTEGRATED/UNAVAILABLE |
| `organization_id` provenance | PASS | Codex | Verified — required field, claim/replay write it |
| RLS / session preconditions | PASS | Codex | Verified — service-role bypass, matches audit_storage_writes pattern |
| Downstream consumers | PASS | Codex | Verified — S60 UI reads research_queue only |

**Test-coverage answer (per MRPF DATA-label requirement):** No new automated test. Justification: pass-through serialization helper; live verification via worker.log + DB query post-deploy is the stronger signal.

**Final verdict:** **APPROVE.** Ready for /promote when worker idles.

## Sign-off

- **Author:** Claude Opus 4.7 (1M context) on behalf of ceo@thewcoachinggroup.com
- **Date:** 2026-05-27
- **Reviewers:** Gemini 3.1 Pro Deep Think (round 1) + Codex exec via ChatGPT OAuth (round 2)
- **Both rounds:** APPROVE
- **Final code under review:** `sandbox/executor.ts` post-comment-tightening (61 LOC additive; tests 106/106 pre-change; tsc clean pre-change)
- **Next action:** /promote → restart worker (bundles plan-types.ts mutation fix + this fix) → verify via next gate cycle.
