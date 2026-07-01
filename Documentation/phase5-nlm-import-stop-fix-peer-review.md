# PEER-REVIEW RECORD — Fix A: Phase-5 NLM-Import-Stop Durable Fix (DESIGN gate)

**Artifact under review:** `sandbox/phase5-nlm-import-stop-fix-design-gate-v2.md` (v2: Gemini holistic already integrated; L2 cut, L3 precheck no-attempt-bump, O9 added).
**Gate:** DESIGN. `agent/` PROD-reaching (anti-stop CRITICAL rides the live worker spawn brief) → per project §11, the downstream L1+E MERGE gate is FULL tri-vendor BEFORE merge.
**Topology:** Sequential — Gemini holistic-adversarial (v1) → integrate v2 → Codex grounded-adversarial (on v2). Reviewer order Gemini → Codex, per `~/CLAUDE.md` Review Topology.
**Severity:** NORMAL.
**Both reviewers: BLOCK.** Outcome: **v3 ships L1 + E; L3 deferred (corrected spec captured); L2 stays cut.**

---

## What each reviewer saw

- **Gemini (holistic-adversarial, breadth):** the **design doc text only** (v2). No code access — a whole-artifact read prompted to find the strongest system-level case to BLOCK. Model: `gemini-3.1-pro-preview` (run banner: `prompt=13392 thoughts=8255 output=1714 total=23361 | finish=STOP`).
- **Codex (grounded-adversarial, depth):** the v2 doc **PLUS a grounded read of the actual `agent/` code** (`codex exec` read-only sandbox + web research against the installed NotebookLM CLI Python source). Codex cited, with file:line evidence, reads of: `state-evaluation.ts`, `executor.ts`, `studio-recovery-sweep.ts`, `regenerate-studio-products.ts`, `job-manifest.ts`, `finalize-recovered-run.ts`, `nlm-artifact-cli.ts`, `api-client.ts`, `claude-spawn.ts`, the migration `20260623_studio_recovery_dimension.sql`, the live `research-compare.md`, and the notebooklm CLI Python (`rpc/types.py`, `cli/source.py`, `cli/generate.py`, `_artifacts.py`, `_sources.py`). Tokens used: 247,228. Model: ChatGPT-Codex (grounded pass).

This split is exactly the intended breadth/depth division: Gemini reads the whole artifact for system-level coherence; Codex verifies the design's claims against the shipped code.

---

## Gemini — verdict + findings VERBATIM

> **VERDICT: BLOCK**
>
> This design is a highly thoughtful defense-in-depth approach, and the addition of the L3 source-readiness precheck ($0 wait) is an excellent piece of system design. However, there are two **CRITICAL** mechanical flaws where the stated bounds do not match the actual implementation logic, leading to a hard cap-breach and a premature exhaustion failure. Furthermore, the L2 layer is dangerously over-engineered given the safety of the new L3 precheck.
>
> ### [CRITICAL] L2 Budget Arithmetic / `waitForProcess` Signature Gap
> **Concern:** The design claims in §5.2 that a continuation "must inherit `MAX_JOB_DURATION − elapsed` so first-spawn + continuation can never exceed the 90-min ceiling." However, Change 2.4 only modifies `waitForProcess` to *return* `activeMs`. There is no specified change to `waitForProcess`'s input signature to *accept* a dynamic timeout.
> **Why it matters:** If `waitForProcess` internally relies on a static environment variable or constant for its timeout (as is standard for single-shot spawns), the second spawn will receive a *fresh* 90-minute allowance. 90 mins (first spawn) + 67.5 mins (second spawn) = 157.5 minutes. This will breach the infrastructure's hard container/worker timeout, resulting in an ungraceful SIGKILL and a terminally stranded job (fail-open on the duration bound).
> **Fix:** Explicitly update the `waitForProcess` signature to accept a `remainingBudgetMs` parameter, and pass `maxJobDurationMs - cumulativeActiveMs` into it from the executor loop.
>
> ### [CRITICAL] L3 Precheck Burns Attempt Cap on Cheap Waits
> **Concern:** Change 3.4 introduces the $0 source-readiness precheck, stating it returns `continued-transient` if sources are still pending. Test E.27 confirms that `continued-transient` bumps the attempt counter. Concurrently, Change 3.4 reduces the attempt cap for `resumeKind: "studio"` to **3**.
> **Why it matters:** If the sweep runs on a standard backoff (e.g., 5 minutes), 3 attempts equal 15 minutes of waiting. If a corpus import takes 25 minutes, the sweep will check 3 times, increment the counter to 3, and then hard-fail the job via `finishExhausted("attempt-cap")` *before the import finishes*. This completely defeats the purpose of the cheap wait and guarantees a hard-fail for slow imports.
> **Fix:** The precheck must yield a state (e.g., `delayed-precheck`) that reschedules the sweep **without** incrementing the `attempts` counter. The attempt counter should only increment when `resumeStudio` (the paid regen script) is actually spawned.
>
> ### [MAJOR] L2 is Over-Engineered and Introduces Hallucination Risk
> **Concern:** The design justifies demoting L3 to "last resort" because it originally "retried blind against a lagging import." But Change 3.4 brilliantly fixes this by adding the $0 source-readiness precheck. With this precheck, L3 is safe, decoupled, deterministic, and cheap. L2, by contrast, respawns a fresh LLM context and relies entirely on a probabilistic prompt (`Change 2.3`) to prevent the agent from duplicating paid Perplexity searches or re-importing 100 NotebookLM sources.
> **Why it matters:** You are introducing a highly complex, stateful loop (L2) with budget arithmetic and crash-safety edge cases, just to avoid falling back to a sweep arm (L3) that is now perfectly safe. If the agent drifted off the L1 prompt, it is highly likely to drift off the L2 continuation prompt and hallucinate state.
> **Fix:** Strongly consider **cutting L2 entirely**. L1 (Prompt) + L3 (Sweep with precheck) + E (Heartbeat) is a complete, robust, and much simpler fix. If you insist on keeping L2, it must be strictly limited (see O1/O2 below).
>
> ### [MAJOR] L1 Fail-Forward vs NotebookLM API Lock
> **Concern:** §3.1.2 states that if the 25-minute L1 bound elapses, the agent should "proceed to Studio generation with the sources already processed."
> **Why it matters:** Does the NotebookLM API allow `notebooklm generate` calls while a corpus import is actively processing in the background? If the API locks the notebook during import, the generation will throw an API error, causing the agent to exit with an error status.
> **Fix:** Verify NotebookLM's concurrency behavior. If it locks, document that the expected behavior is for the agent to catch the API error, exit, and safely fall through to L3 (which will park and wait). The system still recovers gracefully, but the mental model in the design needs to acknowledge this API constraint.
>
> ### [MINOR] L2 Check 6 Regex Strictness
> **Concern:** `shouldContinuePipeline` check 6 looks for `/^error[:\s-]/i` and `"PUBLISH fail-closed"`. If the agent writes `"Publish verification failed"` or `"API Failure: credit out"`, it bypasses this check and L2 respawns it.
> **Fix:** This is acceptable as a backstop because the worker-side PUBLISH gate (`evaluatePublishGateForJob`) is hardcoded and cannot be bypassed by the agent fabricating success on the second spawn. However, be aware that the regex is brittle.
>
> ### Open-Question Adjudication
> * **O1 — L2 max attempts:** **1**. (Or 0, if you accept the MAJOR finding to cut L2). Do not increase to 2; the risk of hallucinated duplicate work on a fresh context is too high.
> * **O2 — L2 crash-safety column:** **In-memory only**. Do NOT add `phase5_continuation_at` to the database. If the worker crashes mid-continuation, let the job time out or fall to L3. Adding a DB migration for a backstop layer is the definition of over-engineering.
> * **O3 — `regenerate-studio-products.ts` contract:** **BLOCKING.** You must ground-verify that this script uploads to the original job's `<orgId>/<slug>/` prefix. If it uploads to a new slug, the frontend gallery will never see the products, resulting in a silent data strand.
> * **O4 — Fix E UI surface:** **Keep the generic "Finalizing media" chip.** Do not add `<P>/<M>` to the UI chip. The process page's `phase_status` already shows the detailed string. Adding it to the chip requires unnecessary frontend schema/prop changes for a transient state.
> * **O5 — L3 bypass-snapshot semantics:** **Original job's snapshot.** The resume arm MUST pass the original pre-spawn `bypassSnapshot`. Allowing a fresh read would create a race condition where an agent could theoretically approve its own bypass post-hoc.
> * **O6 — L3 resume→render chaining:** **Accept the v1 non-goal.** Keep it scoped. If the regen script fails, let it fail closed. Do not chain into Mode-A.
> * **O7 — L3 false-positive on deterministic crash:** **Keep attempt cap 3.** As long as you fix the CRITICAL flaw where the precheck burns attempts, 3 attempts is perfectly fine for actual deterministic crashes. It will exhaust safely.
> * **O8 — L1 fail-forward quality trade:** **Acceptable.** The PUBLISH gate independently re-verifies claims against the generated text. If missing sources cause a claim to be unsupported, the gate will fail closed, which is the correct and safe behavior.

### Gemini findings — disposition

| Finding | Sev | Disposition |
|---|---|---|
| L2 budget / `waitForProcess` signature gap | CRITICAL | **RESOLVED by cutting L2** (§X-L2). The fail-open (fresh 90-min → 157.5-min breach) dissolves entirely — L2 is not in v3. Gemini reviewed v2 text that still carried the L2 rationale in §X; the live build already had L2 cut. |
| L3 precheck burns attempt cap on cheap waits | CRITICAL | **Already addressed in v2** (the `delayed-precheck` no-bump outcome, D2). **Superseded by Codex C3/M1** — Codex proved the no-bump outcome does not fit the *current sweep shape* (bump-on-every-path at `:241-242`; validator requires `products>0`; park writes `attempts=1` vs CHECK `>=1`). Carried into the deferred-L3 spec (§X-L3 items 3+4) with the correct mechanical fixes. |
| L2 over-engineered / hallucination risk | MAJOR | **ACCEPTED — L2 CUT.** Directly endorses the v2 direction. |
| L1 fail-forward vs NLM API lock (O9) | MAJOR | **ACCEPTED as an open live-test (O9).** v3 keeps the O9 note in L1 Step A.1 (catch the generate error, exit terminal); Codex's O9 answer confirms it is not determinable from code alone → **live-test required** (§X-L3 item 6). Non-blocking for L1's poll-wait itself. |
| L2 check-6 regex brittleness | MINOR | **MOOT — L2 cut.** Recorded; the worker-side PUBLISH gate is the hardcoded backstop regardless. |
| O1–O8 adjudications | — | **All accepted** and consistent with v2/v3. O3/O5/O6/O7 fold into the deferred-L3 spec; O4/O8 apply as-is (O4 keep generic chip; O8 fail-forward acceptable). |

**Net Gemini read:** Gemini's substantive live finding is "cut L2, the L1+L3+E shape is the complete fix" — which v2 had already done. Its two CRITICALs both point at L2 (already cut) and the precheck attempt semantics (already patched in v2, then re-specified correctly by Codex). Gemini validated the overall direction; it did not, and could not (no code), catch the L3 grounding errors.

---

## Codex — verdict + findings VERBATIM

> VERDICT: BLOCK
>
> [CRITICAL]
>
> 1. O3 blocks L3: `regenerate-studio-products.ts` cannot resume a failed non-clone original run.
> Evidence: the script is clone-oriented by design, uploading "under the cloning run's own slug" (`agent/scripts/regenerate-studio-products.ts:4-8`, `:26-29`); it requires `parent_run_id` and exits without it (`:401-407`); it resolves `notebook_id` by listing/downloading the parent run's uploaded Storage `state.json` (`:472-518`). A phase-5/6 stopped original run has not reached the executor upload path (`agent/executor.ts:639-675`), so that Storage state file is absent.
> Failing scenario: L3 parks an original full-pipeline job with `parent_run_id=null`; resume invokes this script; it exits before generating. If L3 fakes `parent_run_id=self`, it still fails because the parent Storage `state.json` was never uploaded.
> Fix: add a recovery mode/script that accepts `jobId`, original `orgId`, original `slug`, `notebookId` from the recovery payload, and selected products. Do not resolve through parent lineage or Storage state. Generate into the original workdir, then complete through `finalizeRecoveredRun(... extraPatch: { studio_recovery_status:"recovered" })`.
>
> 2. The L3 "source-readiness precheck" is specified against the wrong API and wrong status code.
> Evidence: the doc says to use `realListArtifactsWithStatus`, but that wrapper runs `notebooklm artifact list ... --type <nlmType>` (`agent/lib/nlm-artifact-cli.ts:152-160`), not `source list`. The installed NotebookLM CLI source status mapping is `PROCESSING=1`, `READY=2`, `ERROR=3`, `PREPARING=5` (`.../notebooklm/rpc/types.py:334-346`), and `source list --json` emits `status_id: src.status` (`.../notebooklm/cli/source.py:175-188`).
> Failing scenario: implemented literally, the precheck cannot observe Phase-3 source import readiness, and `status_id==3` treats errored sources as "ready" while ready sources are actually `2`.
> Fix: add a real source-list wrapper invoking `notebooklm source list -n <id> --json`; wait while `status_id` is `1` or `5`; treat `2` as ready and `3` as failed/error.
>
> 3. The no-attempt-bump design is not compatible with the current sweep shape as written.
> Evidence: the sweep computes `newAttempts = attempts + 1` immediately after selecting a due row (`agent/lib/studio-recovery-sweep.ts:241-242`), and every ordinary non-terminal path patches `studio_recovery_attempts: newAttempts` (`:333-344`). There is no `delayed-precheck`/no-bump outcome today. Also, the existing payload validator requires `products.length > 0` and per-product `artifactId` (`:261-281`), so `resumeKind:"studio", products:[]` would be exhausted before the proposed "before per-product loop" branch at `:395`.
> Failing scenario: pending import causes repeated sweep retries; attempts increment and cap out before import finishes, or the resume payload is classified malformed immediately.
> Fix: dispatch/validate `resumeKind:"studio"` before product-array validation; add a distinct no-bump path that patches only `studio_recovery_next_attempt_at`; adjust tests around the current bump tail.
>
> [MAJOR]
>
> 1. The doc's attempt semantics conflict with the existing DB constraint and "mirror exactly" park instruction.
> Evidence: the current atomic park writes `studio_recovery_attempts: 1` (`agent/executor.ts:583-592`), and the migration requires pending rows to have `studio_recovery_attempts >= 1` (`supabase/migrations/20260623_studio_recovery_dimension.sql:103-110`). The doc also says attempts increment only when paid `resumeStudio` spawns.
> Failing scenario: the L3 park itself consumes attempt 1 before any paid regen, so cap-3 is not "paid regens only."
> Fix: either change the CHECK/initial value for resume-kind rows, or add a separate paid-attempt counter. Do not claim paid-only attempts while mirroring the existing attempts=1 park.
>
> 2. `runStudioOnly` is not a sweep-safe completion primitive.
> Evidence: `runStudioOnly` reads a fresh `readUrgentBypass` snapshot (`agent/executor.ts:760-764`) and then calls `completeJob` directly (`:859-865`). `completeJob` patches `status="completed"` but not `studio_recovery_status` (`agent/api-client.ts:115-122`). The atomic recovered edge exists in `finalizeRecoveredRun` via one patch body with `status`, `result_slug`, and `extraPatch` (`agent/scripts/finalize-recovered-run.ts:382-395`).
> Failing scenario: L3 reuses `runStudioOnly`; the row can become completed while `studio_recovery_status` remains pending, and the publish bypass read is post-original-spawn rather than the original snapshot.
> Fix: split "generate products" from "complete job." Let the sweep own completion through `finalizeRecoveredRun` with `studio_recovery_status:"recovered"` in the same PATCH, and persist/thread the original publish/bypass decision if publish is re-evaluated.
>
> [MINOR]
>
> 1. The prompt insertion seam is real, but the live anti-stop block is not present yet.
> Evidence: `buildPrompt()` always emits the top-level no-AskUser and untrusted-data CRITICALs (`agent/lib/job-manifest.ts:218-224`), then appends the publish block only when publish-required (`:191-216`). `claude -p` receives this prompt directly (`agent/lib/claude-spawn.ts:199-224`). The live slash prompt still says NLM runs in background and video can poll in background (`C:/Users/ceo/.claude/commands/research-compare.md:371-375`, `:815`).
> Fix: insert the anti-stop CRITICAL outside `publishBlock`, and edit the live slash prompt background language.
>
> [INFO]
>
> Confirmed anchors: completion fails when not complete with reason `Pipeline stopped at phase ... expected phase_status="complete" OR phase>=7` (`agent/lib/state-evaluation.ts:317-331`). Spawn has no `--max-turns`; turn end is child process `exit` (`agent/lib/claude-spawn.ts:199-224`, `:361-364`). Executor ordering matches the doc: nonzero recovery block (`agent/executor.ts:315-374`), Gate-A video-defer (`:400-445`), terminal fail (`:447-450`), existing atomic recovery park (`:553-592`). Sweep query is `status='failed' AND studio_recovery_status='pending'` with `LIMIT 1` (`agent/lib/studio-recovery-sweep.ts:747-765`). L2 is cut from code; `rg` found no `EXECUTOR_CONTINUATION`/`shouldContinuePipeline`.
>
> O3 ANSWER: The script uploads under `manifestOrgId` + `manifestSlug` (`agent/scripts/regenerate-studio-products.ts:729-746`). For normal studio-only clone jobs, that is the new clone slug, not the parent/original slug. It requires `parent_run_id` (`:401-407`) and reads the notebook id from the parent run's Supabase Storage `state.json` (`:472-518`). Therefore L3 resume is not feasible for a non-clone original job with `parent_run_id=null`. L3 needs a dedicated recovery contract using the parked payload's `notebookId` and original job org/slug.
>
> O9 ANSWER: Not determinable from wrappers alone whether the live service permits `generate` during source processing. The CLI does not preflight source readiness before `generate`; it resolves source IDs then calls artifact generation RPC (`.../notebooklm/cli/generate.py:381-399`, `:493-519`; `_artifacts.py:1953-1987`). Source code comments say sources must finish processing before chat/artifact generation (`.../notebooklm/rpc/types.py:334-339`; `_sources.py:176-213`). Live-test service behavior, and catch nonzero/failed `generate` in L1.
>
> EXIT=0

### Codex findings — disposition

| Finding | Sev | Disposition |
|---|---|---|
| **C1** — `regenerate-studio-products.ts` is clone-only; cannot resume a non-clone original run (requires `parent_run_id`, reads notebook_id from parent Storage `state.json` a phase-5-stop never uploaded) | CRITICAL | **DECISIVE. L3 DEFERRED.** L3-as-designed is infeasible. The corrected requirement (dedicated recovery script taking `{jobId, orgId, slug, notebookId, selected}` from the parked payload, no parent-lineage/Storage resolution, generate into the original workdir, complete via `finalizeRecoveredRun`) is captured as the follow-on build contract (v3 §X-L3 item 1). |
| **C2** — precheck specified against WRONG API + WRONG enum (artifact list + `status_id==3=ready` instead of `source list` + SOURCE enum 1/5=wait, 2=ready, 3=error) | CRITICAL | **APPLIED to L1 (Change 1.2) AND folded into L3 spec.** L1 Step A.1 now uses `notebooklm source list --json` + the SOURCE enum; v3 explicitly keeps the artifact enum distinct for the video-render poll. Deferred-L3 spec item 2 mandates the same source-list wrapper. |
| **C3** — no-bump `delayed-precheck` + empty-`products` resume payload don't fit the current sweep (bump-on-every-path `:241-242`; validator requires `products>0` `:261-281`) | CRITICAL | **Folded into L3 spec (§X-L3 item 3).** Requires dispatching `resumeKind:"studio"` BEFORE the products validator + adding a real no-bump path that patches only `next_attempt_at`. Not in the v3 ship (L3 deferred). |
| **M1** — atomic park writes `attempts=1` + migration CHECK `>=1` contradicts "attempts only on paid regen" | MAJOR | **Folded into L3 spec (§X-L3 item 4):** reconcile via a separate paid-attempt counter OR an adjusted CHECK/initial value for resume-kind rows. |
| **M2** — `runStudioOnly` reads a fresh bypass snapshot + `completeJob` directly (doesn't set `studio_recovery_status`) → not sweep-safe atomic completion | MAJOR | **Folded into L3 spec (§X-L3 item 5):** split generate from complete; sweep completes via `finalizeRecoveredRun(... extraPatch:{studio_recovery_status:"recovered"})` in one atomic PATCH, threading the ORIGINAL job's bypass decision. |
| **MINOR** — prompt insertion seam real, live anti-stop block not present yet; live slash-prompt still normalizes "background" | MINOR | **This is the L1 work items.** Confirms Change 1.1 (anti-stop CRITICAL outside `publishBlock`) + Change 1.3 (gate background language) are the correct, real edits. v3 ships exactly these. |
| **INFO** — completion-gate reason, no `--max-turns`, executor ordering, sweep query, L2-already-cut all CONFIRMED | INFO | **Validates the L1/E seams.** Every anchor the L1+E fix depends on is confirmed against shipped code → high confidence L1+E is buildable exactly as specified. |
| **O3 ANSWER** — script uploads under clone `manifestOrgId`+`manifestSlug`; L3 needs a dedicated recovery contract | — | Same as C1; drives the deferred-L3 dedicated-primitive requirement. |
| **O9 ANSWER** — NLM generate-during-import concurrency not determinable from code; live-test needed; catch failed `generate` in L1 | — | **Applied:** v3 L1 Step A.1 catches the generate error and exits terminal; O9 flagged as a live-test in §X-L3 item 6. |

---

## Net synthesis (design lead's decision)

**DECISION: v3 ships L1 (poll-wait + anti-stop CRITICAL) + E (heartbeat). L3 (auto-recovery) is DEFERRED to a corrected follow-on. L2 (continuation) stays cut.**

**Why:**
1. **L1 + E fix the root cause directly for all 4 observed failures.** The failures are premature turn-ends while NLM work is pending; L1 forbids exactly that in the drift-resistant top-of-brief placement and gives the agent a bounded poll-wait; E makes the wait observable. Both reviewers validated these seams — Codex INFO confirmed the prompt insertion point, the completion gate, the spawn, and the executor ordering against shipped code; Gemini raised no blocking objection to L1/E.
2. **L1 is prompt-only, $0, fail-forward, zero new prod-risk surface** — it cannot be worse than today. Its worst case (an O9 lock-error exit) lands on the *same* terminal hard-fail we already recover manually.
3. **L3 is only for the rare residual (a post-L1 drift), and Codex proved it needs a dedicated recovery primitive** — not the clone-only `regenerate-studio-products.ts`, not the artifact enum, not the current attempt-bump/validator/CHECK shape. That is a real build with five distinct corrections (C1/C2/C3/M1/M2) plus an O9 live-test — not something to rush into the same MERGE. Build it right after L1+E ship, once we observe whether drift persists.
4. **Until L3 lands, a rare drift is recovered manually** — the same failure mode as today, now made rare. No regression; the common case is removed and the net for the residual is deferred and correctly specified.
5. **L2 stays cut** — both reviewers independently condemned the probabilistic re-spawn (duplicates the L1 risk-class + carried a CRITICAL budget fail-open); the deterministic L3 (once correctly built) is the safe backstop.

**The sequential topology worked exactly as designed:**
- **Gemini (holistic, breadth, no code)** caught the L2 over-engineering and the L2 budget fail-open at the system level — the whole-artifact "is this shape right?" question — and endorsed the L1+L3+E direction. It could not see the L3 grounding errors (no code access).
- **Codex (grounded, depth, code-read on the integrated v2)** caught the five L3 grounding errors (C1/C2/C3/M1/M2) that **neither the author nor Gemini could see without reading the code** — the clone-only script, the wrong API/enum, the sweep-shape incompatibility, the CHECK contradiction, the non-atomic completion primitive. This is precisely the "grounded-adversarial pass on the integrated v2 surfaces gaps the holistic v1 read missed every time" pattern the MRPF Review Topology predicts.
- The Gemini→integrate-v2→Codex order played each model's strength: breadth first on the whole artifact, then depth against the shipped code and the latest direction. Had L3 been rushed on v2's primitives, it would have shipped a recovery arm that silently strands the gallery (C1), never observes import readiness (C2), and caps out before slow imports finish (C3) — all fail-opens on a `agent/` PROD path.

**Downstream gate obligation:** the L1+E MERGE gate is `agent/` PROD-reaching → per project §11 HARD RULE it is a **FULL tri-vendor gate (Gemini + Codex + Claude-author) that must clear BEFORE merge**; if Codex is quota-out, WAIT or use the §1a API-key flip — do not substitute-and-owe. The deferred L3, when built, is its own full tri-vendor MERGE gate.
