# state.json Validation Schema — DESIGN-gate peer review (synthesis)

Companion to `Documentation/state-schema-design-gate.md`. Sequential §11
tri-vendor DESIGN gate, S179 (2026-06-26).

## Outcome (one line)
**UNANIMOUS DEFER.** Both reviewers independently concluded the audit's
Zod-schema + `_version` remedy is net-negative; the existing scattered guards are
the correct architecture; the audit MEDIUM is closed-with-rationale, NOT built.

## Topology + what each reviewer saw
Sequential: Gemini (holistic-adversarial, BREADTH) → integrate → Codex
(grounded-adversarial, DEPTH) on the integrated v2. Reviewer order per §11.

- **Gemini 3.1-pro-preview** (via `@google/genai` SDK): saw the **design doc v1**
  + the FULL text of the supporting source files (`types.ts`, `read-state-file.ts`,
  `state-evaluation.ts`, `publish-gate.ts`, `plan-types.ts` header,
  `agent/package.json`) pasted into the prompt — i.e. doc + the load-bearing
  source, NOT the whole repo, NOT tests run. Holistic breadth lens.
- **Codex gpt-5.5 (xhigh)** (via `codex exec -s workspace-write`, run-banner
  asserted `model: gpt-5.5`): saw the **integrated design doc v2 + the LIVE repo**
  — read the source files itself AND **executed counterexamples** against the real
  compiled modules (ran `evaluateCompletion`, `logPublishFlagDiagnostics`,
  inspected `tsconfig` strict). Grounded depth lens. Full log:
  `/c/tmp/dr-s179/review/codex-v1.log` (323 KB, 127k tokens).

## How the verdicts compose
Gemini's verdict was **BLOCK** — but BLOCK on **v1's Zod + eager-validation
design**, with an explicit constructive redirect to plain-TS / DEFER. Those
findings were integrated into v2 (the DEFER-lead design). Codex then reviewed v2
and returned **ENDORSE**, grounding every load-bearing claim. So the **final
design direction (DEFER, option A as scoped alternative) carries both reviewers'
agreement** — Gemini recommended it, Codex ratified it against the code.

---

## Reviewer 1 — Gemini 3.1-pro-preview (holistic-adversarial) — VERDICT: BLOCK (of v1)

> CRITICAL 1: The Value-vs-Cost equation fails entirely. DESCOPE to plain-TS
> (D1, Q1, Q2). … Adding a new `zod` runtime dependency to a lean 7-dep worker to
> enforce a *hyper-lenient* schema is gold-plating. … using `z.infer` to generate
> a `ValidatedPipelineState` type where load-bearing fields (`userContext`,
> `selectedProducts`) are `.optional()` will create a **massive type conflict**.
> The canonical `PipelineState` … declares these fields as *required*. …
> **Recommendation:** Reject D1-a. Adopt D1-b (hand-rolled plain-TS).
>
> CRITICAL 2: Guaranteed Production Regressions via False-Rejects (Q3, D3).
> 1. `{ "phase": 7 }` — LLMs frequently write numbers instead of strings. Your
>    existing `evaluateCompletion` handles this elegantly (`parseFloat`). If your
>    schema dictates `phase: z.string()`, it will reject … Progress sync halts;
>    recovery drops the job.
> 2. `{ "publish_required": "yes" }` — The publish-gate has a deliberate, hardened
>    diagnostic alarm (`logPublishFlagDiagnostics` / S120) … If your read-boundary
>    schema strictly requires `boolean | "true"`, it will reject `"yes"` outright,
>    failing the entire state file read … and the **security alarm will never
>    fire**. You have inadvertently silenced a security observability feature by
>    validating too early.
>
> MAJOR 1: Dead Code and Testing Blast Radius (D6, Q5). … If `readPipelineState`
> filters out all non-primitives at the boundary, the `isNonPrimitiveStateField`
> guards … become completely unreachable dead code. … the 27 tests in
> `state-coercion-guards.test.ts` … are asserting on a state that can no longer
> occur. … If you centralize validation, you must *delete* the downstream guards
> and move the tests.
>
> INFO 1 (D4 versioning): Your logic … is 100% sound. … your reinterpretation is
> correct. INFO 3 (D2): Typing `publish_verification` … while leaving the actual
> enforcement to the battle-tested `publish-gate.ts` is a pragmatic and coherent
> line.
>
> CONCLUSION: The author's instinct in §7 was correct: the value of this design
> does not justify the architectural churn, the test breakage, or the new
> dependency. … The audit requirement … can and should be satisfied by following
> the `plan-types.ts` precedent: write a single, testable, plain-TS
> `validatePipelineState` … and leaves the canonical `types.ts` unchanged.
>
> VERDICT: BLOCK

(Full text: `/c/tmp/dr-s179/review/gemini-v1.log`.)

---

## Reviewer 2 — Codex gpt-5.5 xhigh (grounded-adversarial, on integrated v2) — VERDICT: ENDORSE

Codex executed real counterexamples against the compiled modules. Key evidence:

```
// ran: evaluateCompletion({ phase: 7, phase_status: "running" })
{ "today": { "success": true, "reason": "Pipeline reached terminal state (phase 7 …)" },
  "stringStrictSchemaWouldAccept": false }      // numeric phase → a string-strict schema would REJECT it

// ran: logPublishFlagDiagnostics("job-1", [{value:"yes", source:"state.publish_required"}], …)
"[SECURITY] job=job-1 publishRequired source=state.publish_required rawType=string
 rawValue=yes accepted=false rejected=true — non-boolean publishRequired reached the
 gate (a normalization boundary was bypassed); REJECTED by strict core → SILENT gate-skip risk"
```

> No CRITICAL or MAJOR blockers found. I endorse the design direction: defer the
> Zod/eager-validation build; option A is the only defensible build path if the
> team wants a refactor.
>
> 1. INFO - CONFIRMED: Numeric phase regression is real. `evaluateCompletion`
>    accepts `{"phase":7,…}` … a strict `phase: string` boundary would reject
>    (`state-evaluation.ts:297,304`).
> 2. INFO - CONFIRMED, with nuance: S120 alarm suppression is real. … The
>    executor logs state sources before gate applicability in BOTH full pipeline
>    and studio_only (`executor.ts:413` and `executor.ts:774`). So this is not
>    studio_only-only; that strengthens the claim.
> 3. INFO - CONFIRMED: Type conflict is real. `PipelineState` requires
>    `userContext, selectedProducts, customizations, vendorEvaluation, artifacts,
>    files_written` … With `strict: true`, an all-optional inferred type would not
>    be assignable (`types.ts:286`, `tsconfig.json:6`).
> 4. MINOR - PARTIAL: Option-A cost is bounded but slightly understated. … Hidden
>    coupling: `summarizeStateProgress` shares private `PHASE_MAP` with
>    `evaluateCompletion` (`state-evaluation.ts:8,317`). Also … `watch-state-progress`
>    has 9 more tests … not literally "import-path re-points only."
> 5. INFO - CONFIRMED: DEFER remains the right lead. A smaller helper that merely
>    wraps the bare casts would capture little value … not clearly better than
>    closing the audit item with rationale.
> 6. INFO - CONFIRMED: No latent must-build bug found. The acute crash/fail-open
>    cases are guarded (`read-state-file.ts:100`, `state-evaluation.ts:291,56`).
>    One minor hardening opportunity: `enforceStudioCompleteness` reads
>    `state.notebook_id` without that helper (`studio-completeness.ts:224`), but
>    `realListArtifacts` … returns `null` (`nlm-artifact-cli.ts:99`), so this
>    fails closed rather than crashing or passing.
>
> VERDICT: ENDORSE

---

## Synthesis + decision

**Agreement (high weight — two lineages, two methods, same conclusion):**
1. The Zod approach is wrong (gold-plating + a `z.infer`-optional vs
   required-`PipelineState` type conflict). Use plain-TS if anything.
2. Eager read-boundary validation is a **production regression**: it would reject
   a numeric `phase` (breaking completion/recovery) and a non-boolean
   `publish_required` (breaking the job AND silencing the S120 `[SECURITY]`
   alarm). Codex grounded BOTH by execution; the alarm fires on both pipeline
   paths.
3. The acute crash class is already closed by the S166/S168 guards; a new
   validator only *consolidates*, and that consolidation has real (≈36-test +
   shared-`PHASE_MAP`) blast radius on the worker hot-path for marginal value.
4. Reuse the CLI-owned `version`; a worker `_version` is inert. (Gemini "100%
   sound.")

**Decision: DEFER / CLOSE the audit MEDIUM with this rationale.** Do not build.
Recorded in the audit-remediation tracker (`project_audit_2026_06_24_remediation_s178`).

**The fork left for the user:** if code-hygiene appetite favors it, **option A**
— a behavior-preserving plain-TS `validatePipelineState` consolidation — is the
ONLY defensible build, as a pure move under a full tri-vendor MERGE gate (≈36
tests relocated + shared `PHASE_MAP`, originals deleted, optionally folding the
§9.6 `notebook_id` hardening). Both reviewers rate its value at or below the cost
of just closing the item. **Lead recommendation: DEFER.**

**Disagreement procedure:** none — reviewers agree; no SECURITY-CRITICAL finding;
standard synthesis, proceed (to DEFER).
