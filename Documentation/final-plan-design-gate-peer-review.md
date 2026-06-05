# Final-Plan DESIGN-Gate — Peer Review Synthesis

**Date:** 2026-05-26 (S57)
**Author:** Claude Opus 4.7 (1M context)
**Reviewers:** Gemini 3 Pro Preview, Codex GPT-5.5 (sequential)
**Status:** APPROVED — pending explicit user sign-off before any implementation

---

## Subject

`sandbox/final-plan-design-gate.md` (v3). Proposes a new pre-spawn multi-reviewer quality gate in the Dynamic Research worker pipeline. Fires AFTER queue claim + manifest write, BEFORE `claude -p` spawn. Reviews a NEW structured "Research Plan" JSON synthesized from the user's manifest. Sequential Gemini → integrate → Codex → integrate → verdict, with auto-retry on infrastructure failure and explicit Origin-mapped findings on plan-quality rejection.

## Risk classification (per MRPF v2.2)

- **Event Gate:** DESIGN
- **Risk Labels:** AGENT BEHAVIOR + INFRA + ARCHITECTURE + DEPENDENCY
- **Severity Mode:** NORMAL
- **Topology:** Sequential Gemini → Codex (HARD RULE)
- **Test coverage:** Phase 1 MVP requires tests landing WITH implementation (not deferred to fast-follow). Adversarial-safe-plan fixtures + 15 Persona Depth rubric fixtures mandatory pre-ship.

---

## Round-by-round audit trail

### v1 (author draft) → Gemini v2 review

**Gemini verdict:** APPROVE-WITH-CHANGES. 2 CRITICAL + 2 MAJOR + 2 MINOR.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G-C1 | CRITICAL | Review timeout → REQUEST_CHANGES (blamed user for system issue). Should be SYSTEM_BLOCKED. | INTEGRATED v2 §6 |
| G-C2 | CRITICAL | Adversarial Claude mitigation "soft prompt instruction" insufficient — needs structural reviewer-check for Persona Depth | INTEGRATED v2 §12 #1 |
| G-M1 | MAJOR | REQUEST_CHANGES UX needs to map findings back to specific upstream user inputs (else user trapped guessing) | INTEGRATED v2 §7 (Origin field) |
| G-M2 | MAJOR | Cost-model "1-in-3 break-even" math flawed | INTEGRATED v2 §6 (retracted, reframed as quality cost) |
| G-m1 | MINOR | Add adversarial-safe-plan test fixture | INTEGRATED v2 §10 |
| G-m2 | MINOR | trusted-bypass as per-job dry_run vs per-user flag | INTEGRATED v2 §8 Q5 (recommend per-job) |

### v2 (integrated) → Codex v2 review

**Codex verdict:** BLOCK. 3 CRITICAL + 8 MAJOR + 3 MINOR.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C-C1 | CRITICAL | Proposed `research_queue.status` enum values would be rejected by existing JobStatus validation (`agent/types.ts:8`, `frontend/lib/validate.ts:174`) | INTEGRATED v3 §3 + §5 (status enum split — research_queue.status unchanged; new plan_review_status field) |
| C-C2 | CRITICAL | Auto-retry semantics had no owner, no DB fields, no claim predicate | INTEGRATED v3 §5 (3 new DB fields + worker release pattern + extended claim predicate using FOR UPDATE SKIP LOCKED) |
| C-C3 | CRITICAL | `plan_reviews` RLS can't "inherit" from research_queue — Postgres doesn't work that way | INTEGRATED v3 §5 (explicit organization_id NOT NULL + concrete pr_select + pr_service_role_all policies modeled on research_usage telemetry) |
| C-M1 | MAJOR | Executor entry point is `executeJob()`, not `runFullPipeline()` — and pre-spawn already does manifest write + sandbox-allowlist + studio_only branch | INTEGRATED v3 §3 + §4 (corrected name + explicit phase ordering + studio_only Option A bypass decision) |
| C-M2 | MAJOR | Persona Depth criterion not implementable — needs concrete 0-4 rubric | INTEGRATED v3 §12 #1 (verbatim Codex rubric + 15 test fixtures) |
| C-M3 | MAJOR | Origin enum incomplete + inconsistent across §7/§10/§12 | INTEGRATED v3 §7 (9-value enum, cross-section aligned) |
| C-M4 | MAJOR | Migration filename + no-BEGIN/COMMIT + pg_class.relrowsecurity preflight need to be EXPLICIT in §5 | INTEGRATED v3 §5 |
| C-M5 | MAJOR | Reviewer prompts MUST use `<untrusted_input>` fence pattern per project policy | INTEGRATED v3 §4 (both synthesizer + reviewer) |
| C-M6 | MAJOR | `openai` + `@google/generative-ai` net-new deps → DEPENDENCY label required | INTEGRATED v3 §11 (label added) + §4 (deps called out) |
| C-M7 | MAJOR | Env var trim required per [[feedback_vercel_env_add_stdin_trailing_newline]] | INTEGRATED v3 §4 |
| C-M8 | MAJOR | Plan schema misuses Confidence Index terminology — CI dimensions are FIXED per `~/.claude/skills/confidence-index.md` | INTEGRATED v3 §2 (renamed to `evaluation_framework` with explanation note) |
| C-m1 | MINOR | Cost-model correction honest — no action | NO CHANGE |
| C-m2 | MINOR | §8 vs Phase 2 self-contradicts on bypass mechanism | INTEGRATED v3 §8 Q5 + §9 Phase 2 (aligned to per-job skip_review only) |
| C-m3 | MINOR | Doc still says "v1 artifact" | INTEGRATED v3 §11 (corrected to v3 + history described) |

**Cross-coverage gaps (Codex flagged, integrated as additions in v3 §11):**
- Integrator-Claude clarification: integration pass uses same synthesizer-Claude with prior plan context (NOT fresh call)
- Slash command knowledge requirement: synthesizer prompt MUST embed/reference `/research-compare` phase markers to avoid hallucination

### v3 (integrated) → Codex v3 Sequential QA

**Codex QA round 1:** FAIL. 3 fidelity gaps where v3 didn't faithfully apply v2 findings:

| # | Gap | Disposition |
|---|---|---|
| QA-1 | §5 claim predicate had two separate OR-branches both rooted in `status='pending'` — system_blocked rows ignored next_attempt_at | FIXED v3-round-2 §5 (single AND-clause structure) |
| QA-2 | §9 line 394 still said `runFullPipeline()` (Phase 1 checklist missed during MAJOR 1 sweep) | FIXED v3-round-2 §9 (now `executeJob()` with explicit NOT-callout) |
| QA-3 | §6 lines 303-304 still used dash-form `system-blocked` (missed during CRITICAL 1/2 sweep) | FIXED v3-round-2 §6 (both branches use `plan_review_status='system_blocked'` + reference §5 retry schedule) |

**Codex QA round 2:** **PASS.** All 3 gaps closed. Full-doc grep clean — remaining `runFullPipeline` mentions only in explicit "NOT runFullPipeline" callouts (lines 74, 165, 398); no remaining `system-blocked` dash-form.

---

## Self-observation (S57 dogfooding of MRPF v2.2)

The sequential pattern paid off significantly on this design:

1. **Gemini caught conceptual issues** Claude alone missed: the fallback-blames-user pattern (G-C1), the "soft prompt instruction" insufficiency for known LLM behavior class (G-C2), the cost-model math error (G-M2). These are visible from holistic read without code access.

2. **Codex caught architectural mismatches** Gemini couldn't see without grep: the existing JobStatus enum incompatibility (C-C1), the missing retry-owner machinery (C-C2), the Postgres RLS inheritance misconception (C-C3), 5 more MAJORs grounded in actual repo file lookups. **The BLOCK verdict on v2 prevented shipping a design that wouldn't compile.** This is exactly the cost asymmetry MRPF v2.2 promises.

3. **Sequential QA caught fidelity drift** in v3 integration: the same self-fidelity-sweep gap [[feedback_self_fidelity_sweep_before_qa]] documents from S48 — author hallucinations recur in revisions. I should have grep-swept `runFullPipeline` and `system-blocked` BEFORE submitting to QA. The 3 gaps cost an extra QA round (~$0.50) but caught the regression.

4. **Reviewer cost-value ratio for this DESIGN gate:** ~$5-8 across 4 sequential rounds (Gemini v1 ~$1, Codex v2 ~$2-3, Codex QA r1 ~$0.50, Codex QA r2 ~$0.50). Caught 16+ findings any one of which would have surfaced as either an implementation rework or a production incident. **Easy win on the policy framework's promise.**

### Recommended additions to MRPF (carry forward)

- **Self-fidelity-sweep checklist** (already documented in [[feedback_self_fidelity_sweep_before_qa]]): before submitting any v(N+1) to sequential QA, run grep for stale literals from v(N) (function names, enum values, dash-vs-underscore variants).
- **Two-round QA budget normalization:** the v3 round-1 → round-2 cycle is acceptable cost for catching fidelity drift. Don't try to eliminate by demanding perfect-first-revision (impossible for human or LLM authors); budget the second round.

---

## Final disposition

**APPROVED.** Design v3 may proceed to user sign-off and then implementation per Phase 1 MVP scope (§9).

### What each reviewer saw (per MRPF requirement)

- **Gemini Deep Think v1:** Full design doc embedded in prompt; cross-referenced `Documentation/multi-reviewer-policy-framework.md` for fallback-semantics + gate-label alignment. Took stated current pipeline architecture and execution costs on faith.
- **Codex GPT-5.5 v2:** Read directly — v2 design doc, Bug 49 peer-review artifact, `~/CLAUDE.md`, project `CLAUDE.md`, MRPF doc, queue API routes, worker/executor/api-client/types, validation/types, relevant Supabase migrations, telemetry helpers, untrusted-input helpers, package manifests, `/research-compare.md` + relevant skills. Did NOT verify external model names or API pricing online (knowledge-cutoff scope).
- **Codex QA round 1:** v3 design doc + cross-referenced to v2 findings list. Specific re-grep on the 8 MAJORs.
- **Codex QA round 2:** v3 design doc lines 218-232 + 303-308 + 398; full-doc grep on `runFullPipeline` + `system-blocked`.

### Sign-off

APPROVED-BY: Claude Opus 4.7 + Gemini 3 Pro Preview + Codex GPT-5.5 (v3 sequential cycle) | gate=DESIGN | labels=AGENT-BEHAVIOR + INFRA + ARCHITECTURE + DEPENDENCY | mode=NORMAL

**Cost:** ~$5-8 total review token spend.
**Wall-clock:** ~90 min including 2 QA rounds + author integration time.
**Required next step:** explicit user approval of v3 before any code/schema work begins. Implementation is NOT authorized by this peer-review APPROVE alone — the design has prod-infra and cost implications (~50-80% per-run cost increase, new prod API keys) that need explicit operator-level decision.
