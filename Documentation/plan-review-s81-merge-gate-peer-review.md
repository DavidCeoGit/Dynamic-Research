# MRPF MERGE-gate peer review — S81 #7 (topic_resolved cap + plan-synthesizer prompt strengthening)

**Session:** S81 · **Date:** 2026-06-02 UTC · **Topology:** Sequential Gemini → integrate → Codex on v2 → final v3 · **Severity:** NORMAL · **Risk Labels:** AGENT BEHAVIOR

## Context

Production job `e18e1931-96d8-4b23-b05e-a801fa077773` `system_blocked` at the plan-synthesis stage 2026-06-02 19:18:10 UTC. The user-submitted topic was 603 chars (auto-detailing business naming research). On both retries the synthesizer LLM emitted a `topic_resolved` field that exceeded the 200-char validator cap, with both attempts failing identically and the job dying via the `plan-synthesis` system_blocked path.

The root cause was a soft contract enforced too tightly:
- `agent/lib/plan-types.ts:236-237` rejected `topic_resolved.length > 200` as a hard validator error.
- `agent/lib/plan-synthesizer.ts:241` instructed the LLM with a single non-imperative comment (`"<= 200 char canonical topic statement"`).
- No example showed the LLM what canonicalization vs. echo looked like.
- No fail-safe absorbed the tail when the model produced verbose output anyway.

## Risk classification (HARD RULE — `~/CLAUDE.md`)

| Axis | Value |
|---|---|
| Event Gate | MERGE-gate (code adoption) |
| Risk Labels | AGENT BEHAVIOR (changes plan-synthesis prompt + validator contract, affects every future research job's gating) |
| Severity Mode | NORMAL |
| Topology | Sequential Gemini → integrate → Codex on v2 → final |

Per AGENT BEHAVIOR mandate: this review explicitly answers "is this change covered by automated tests, and if not, why?" → **Yes, fully covered.** v3 ships 55/55 passing tests across plan-types + plan-synthesizer, including 4 new topic_resolved-specific tests.

## v1 → v2 → v3 trace

### v1 (author DRAFT)

Three-file defense-in-depth fix:
- `agent/lib/plan-types.ts`: cap 200 → 500
- `agent/lib/plan-synthesizer.ts`: SCHEMA_HINT expansion — added TOPIC CANONICALIZATION discipline block (after JSON example)
- `agent/test/plan-types.test.ts`: replaced "rejects > 200" boundary test with "rejects > 500", added "accepts 500", added "accepts 201-499" regression test with the canonicalized e18e1931 shape.

Verification: `pnpm test` GREEN; `node --test plan-types.test.ts` 32/32 PASS via swap-and-revert.

### v1 → v2 — Gemini round 1 (APPROVE_WITH_CHANGES, 5 findings, ~$0.10, 164s wall-clock)

Model: `gemini-3-pro-preview`. All 5 findings ACCEPTED.

| ID | Severity | Title | Disposition |
|---|---|---|---|
| G-MAJ-1 | MAJOR | Missed downstream consumers of `topic_resolved` | ACCEPT — Updated `sandbox/plan-types.ts.meta` to document plan-reviewer.ts:169 + :216 (reviewer LLM via `fenceValue("plan", plan)`). No code change required (cap relax doesn't affect LLM prompts). |
| G-MIN-1 | MINOR | TOPIC CANONICALIZATION block placement | ACCEPT — Restructured `SCHEMA_HINT` so disciplines come BEFORE the JSON schema example. Schema reference line flipped "below" → "above". |
| G-MIN-2 | MINOR | Missing test asserting prompt strengthening | ACCEPT — Added `test("includes TOPIC CANONICALIZATION discipline block")` to `sandbox/plan-synthesizer.test.ts` asserting block presence + precedence. |
| G-NIT-1 | NIT | 200→500 cap correctness | ACCEPT (no action). Confirmation; 500 is right number. |
| G-NIT-2 | NIT | Missing rollback plan | ACCEPT (deferred). Documented in this peer-review doc (Rollback Plan section below). |

v2 tests on swap-and-revert: 53/53 PASS.

### v2 → v3 — Codex round 1 (APPROVE_WITH_CHANGES, 5 findings, ~$0.05-0.10, 309s wall-clock)

Model: `gpt-5-codex` via `codex exec -s read-only`. All 5 findings ACCEPTED.

| ID | Severity | Title | Disposition |
|---|---|---|---|
| C-MINOR-1 (AUDIT-1) | MINOR | Consumer audit still incomplete; partly misattributes `claude -p` | ACCEPT — Updated `sandbox/plan-types.ts.meta` consumer list to the verified set: plan-reviewer.ts:169 + :216 (reviewer/integrator LLMs); executor.ts:275-292 (writes `research_queue.plan_json` JSONB via `api-client.ts:updatePlanReviewStatus` + `workdir/research-plan.json`); executor.ts:127-143 (plan_version persistence). `claude -p` is NOT currently a topic_resolved consumer (verified by grep: `buildPrompt` doesn't embed plan_json; `research-compare.md` doesn't read research-plan.json). |
| C-MINOR-2 (COV-1) | MINOR | Validator boundary coverage misses 200/201/499 | ACCEPT — Added table-driven test pinning `[200, 201, 499, 500]` accept + `501` reject. |
| C-MINOR-3 (COV-2) | MINOR | Prompt test does not assert "above" schema-reference flip | ACCEPT — Added test asserting `includes("See TOPIC CANONICALIZATION above.")` AND `equals(includes("below"), false)`. |
| C-NIT-1 (META-1) | NIT | Test metadata overstates regression fixture | ACCEPT — Replaced "literal e18e1931 production topic (603-char)" with "e18e1931-shaped canonicalized auto-detailing topic in the newly accepted 201-499 range". |
| C-NIT-2 (DOC-1) | NIT | Design doc `final-plan-design-gate.md:33` still states `≤200 chars` | ACCEPT — Added `sandbox/final-plan-design-gate.md` updating line 33 to `<canonical topic statement; target ≤200 chars, hard limit 500 chars>`. |

v3 tests on swap-and-revert: **55/55 PASS** (added: table-driven boundary + schema-line precedence assertions).

**Loop closed at v3** per S78/S79 mechanical-fix fidelity-skip precedent. All 5 Codex changes were mechanical (metadata text, additive tests, design-doc one-line wording fix). No new code surface to re-critique adversarially.

## Final v3 — files shipped

| File | Type | Lines |
|---|---|---|
| `agent/lib/plan-types.ts` | MODIFIED | +6/-1 net (cap 200→500 + explanatory comment) |
| `agent/lib/plan-synthesizer.ts` | MODIFIED | +14/-1 net (SCHEMA_HINT discipline section moved above JSON + extended schema-example line) |
| `agent/test/plan-types.test.ts` | MODIFIED | +44/-4 net (cap test 201→501 + accepts 500 + accepts 201-499 regression + table-driven boundary) |
| `agent/test/plan-synthesizer.test.ts` | MODIFIED | +28/0 net (TOPIC CANONICALIZATION block-presence/precedence test + "above" schema-reference test) |
| `Documentation/final-plan-design-gate.md` | MODIFIED | +1/-1 net (line 33 schema example) |
| `Documentation/plan-review-s81-merge-gate-peer-review.md` | NEW | this file |

Plus sandbox/validated/ archives + .meta sidecars per S79/S80 promote pattern.

## What each reviewer saw

| Reviewer | Pass | Scope |
|---|---|---|
| Gemini round 1 | v1 sandbox | Full prompt with the 3 v1 file diffs inlined; long-context whole-artifact read; no FS access |
| Codex round 1 | v2 sandbox (post-Gemini integration) | Full prompt with Gemini findings + author dispositions; read-only sandbox FS access; verified C-MINOR-1 against live `agent/executor.ts` + `agent/api-client.ts` |

## Coverage answer (AGENT BEHAVIOR HARD RULE)

**Is the change fully covered by automated tests?** Yes.

| Surface | Test | File |
|---|---|---|
| Validator rejects > 500 chars | `rejects topic_resolved > 500 chars` | plan-types.test.ts |
| Validator accepts exactly 500 chars | `accepts topic_resolved exactly 500 chars` | plan-types.test.ts |
| Validator accepts 201-499 chars (regression) | `accepts topic_resolved 201-499 chars (was rejected pre-S81)` | plan-types.test.ts |
| Validator boundaries pinned | `topic_resolved length boundaries — table-driven` | plan-types.test.ts |
| Prompt includes TOPIC CANONICALIZATION block | `includes TOPIC CANONICALIZATION discipline block` | plan-synthesizer.test.ts |
| Discipline block precedes JSON schema example | (same test, precedence assertion) | plan-synthesizer.test.ts |
| Schema reference uses "above" not "below" | `schema example references TOPIC CANONICALIZATION as 'above'` | plan-synthesizer.test.ts |

55/55 total tests pass. The empty-topic and schema-version tests (untouched) continue to pass.

## Rollback plan

If post-deployment monitoring shows the cap relax or prompt change introduced regressions (e.g., the synthesizer LLM consistently emits 400+ char topics that downstream consumers handle poorly, or the prompt restructure breaks something unforeseen):

1. `git revert <bundle-commit-sha>` against the S81 #7 bundle commit
2. Restart the worker daemon: `Start-ScheduledTask -TaskName DynamicResearchWorker`
3. Verify preflight 4/4 green (env-sanity, claude-auth, anthropic-auth, nlm-auth)
4. Confirm `pnpm test` passes against the restored tree

Rollback is non-destructive (no schema migration, no irreversible state change). The only side effect is that future jobs with `topic_resolved` between 201-500 chars will once again fail validation as before S81.

## Cost summary

| Item | Spend |
|---|---|
| Gemini round 1 (gemini-3-pro-preview, 164s) | ~$0.10 |
| Codex round 1 (gpt-5-codex, 309s) | ~$0.05-0.10 |
| Author integration + swap-and-revert tests ×3 | $0 (local) |
| **S81 #7 grand total** | **~$0.15-0.20** |

Well below pre-auth ceilings ($2.00 early-warning, $3.00 hard).

## Sequential MRPF dogfood validation (S81 #7)

S81 #7 is another empirical win for sequential topology:

- **Gemini round 1** caught G-MAJ-1 (consumer audit miss) via holistic whole-artifact reasoning — but the audit it suggested was partial. Gemini named plan-reviewer.ts:169 + :216 + executor.ts:383 (claude-prompt.md).
- **Codex round 1** caught C-MINOR-1 (audit refinement) by code-grounded grep: `claude -p` is NOT currently a topic_resolved consumer because `buildPrompt` doesn't embed plan_json. Gemini's claim about claude-prompt.md was speculatively correct in spirit (the executor writes that file) but wrong on the consumption path. Codex's grep against live `executor.ts:382-384` + `research-compare.md` confirmed the divergence.

Pattern matches S78/S79: Gemini surfaces holistic concerns; Codex grounds them in code and refines or refutes via grep. Cost asymmetry ~$0.20 for a MERGE-gate fix on an AGENT BEHAVIOR change that ships with full test coverage; alternative cost (one more system_blocked job + manual investigation) would have exceeded this in ~1 cycle.

## Sources

- Worker log: `agent/worker.log` (2026-06-02 19:17:10 → 19:18:10 UTC)
- Failing job: Supabase `research_queue` row `e18e1931-96d8-4b23-b05e-a801fa077773` (status=`system_blocked`)
- Gemini round 1: `sandbox/working/s81-7-merge-mrpf-v1-PROMPT.md` + `s81-7-merge-mrpf-v1-response.txt`
- Codex round 1: `sandbox/working/s81-7-merge-mrpf-v2-codex-PROMPT.md` + `s81-7-merge-mrpf-v2-codex-response.txt`
- Live code verified during Codex finding integration: `agent/executor.ts:127-143, 275-292, 382-384`; `~/.claude/commands/research-compare.md`
