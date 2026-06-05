# DESIGN-Gate: PLAN_REVIEW_ENFORCE=true Flip Testing Protocol

**Status:** v1 DRAFT — pending sequential MRPF review (Gemini round 1 → integrate → Codex round 2 → final v3).
**Author:** Claude (Opus 4.7, S65 2026-05-29)
**MRPF classification:** Event Gate = DESIGN (irreversible-ish operational decision that autonomously blocks job execution). Risk Labels = **AGENT BEHAVIOR** (the gate becomes a real-time decision-maker on whether the user's research runs) + **DATA** (a misbehaving gate kills work the user paid for; failed jobs leave behind partial artifacts + Resend notifications). Severity = NORMAL (no production incident; deliberate planning exercise). → Sequential Gemini → integrate → Codex per HARD RULE.

**Target artifact on ship:** This doc as the canonical procedure for going from shadow to enforce. No code changes if telemetry already supports flipping; a small `agent/.env` flip + optional tuning if it doesn't.

---

## 1. Problem statement

`PLAN_REVIEW_ENFORCE` has been `false` (shadow mode) since the gate shipped in S59 (2026-05-27). Shadow rationale was correct: dark-launch the gate, gather signal before allowing it to autonomously block jobs. Per [[feedback_dark_launch_for_integration_gates]] — `<GATE>_ENFORCE=false` shadow for first 5-10 prod jobs catches >80% of multi-vendor integration bugs at $0 customer impact.

We are now at the natural decision point: should the gate flip to `true`? **The flip is consequential.** When enforce=true:
- A REQUEST_CHANGES or BLOCKED verdict from reviewers FAILS the job (no `claude -p` spawn, no deliverables produced)
- The submitter receives a plan-review-rejection Resend email asking them to revise inputs
- The user paid ~$0.05-0.30 for synth + review and got zero research output

If the gate over-blocks (rejects plans that would have produced good research), it destroys real value. If the gate under-blocks (approves plans that produce bad research), shadow mode is doing its job anyway and the flip adds no value. The cost of getting this wrong is asymmetric: a false-block destroys a paid run instantly + erodes user trust; a false-approve costs incremental research time, often recoverable.

This doc defines the testing protocol to determine **when we're ready to flip**, and **how we flip safely**.

---

## 2. Current state (S65 verified)

### 2.1 Shadow telemetry to date (n=4 jobs)

| Job | Cycle outcome under shadow | Underlying verdict | Cost | Source |
|---|---|---|---|---|
| 98bab573 (S59 smoke) | APPROVED-by-override | APPROVED (organic, 1 iteration) | $0.077 | S59 dryrun_handoff |
| da75bcdc (S61) | APPROVED-by-override | APPROVED (organic, 1 iteration) | $0.128 | S61 dryrun_handoff |
| 86d198fc (S62 n=2) | APPROVED-by-override | REQUEST_CHANGES | $0.137 | S62 dryrun_handoff |
| 0336c6d0 (S62 n=3 Tesla replay, second attempt) | APPROVED-by-override | REQUEST_CHANGES (Gemini emitted 2 findings, Codex 4+3 across 2 rounds) | $0.273 | S62 dryrun_handoff |

**Reading:** 2 of 4 (50%) ended organic APPROVED, 2 of 4 (50%) would have been blocked if enforce were on. Sample size is too small to be conclusive, but **flipping now would FAIL at least half the recent jobs** based on the verdict distribution we have.

### 2.2 Architecture state

- S58 plan-review gate fully wired (`agent/lib/plan-synthesizer.ts` + `plan-reviewer.ts` + `plan-transports.ts` + `executor.ts:runPlanReviewGate`)
- S61 Bug 51 audit table writes ALL reviewer calls to `public.plan_reviews` (verdict + findings + cost + duration_ms)
- S62 Bug 52 + Bug 53a closed: Gemini engaged (was 31 tok, now 1974+), integration UNAVAILABLE rows land when transport throws
- S64 preflight + circuit breaker SHIPPED + dogfood-validated. If the gate misbehaves and creates a failure cascade, the worker exits cleanly + cron backs off; no infinite queue-burn
- S64.1 dispatcher hotfix landed; worker PID 40492 polling normally on v3 code

### 2.3 Cost shape (per S62 telemetry)

| Component | Per cycle | Notes |
|---|---|---|
| Phase 0a synth | ~$0.05-0.13 | 1-2 attempts; depends on plan complexity |
| Phase 0b review (Gemini + integrate + Codex, 1-2 rounds) | ~$0.02-0.22 | Higher when reviewers engage (Bug 52 fix raised Gemini cost from $0 to $0.012-0.028/call) |
| Total Phase 0 gate cost | **~$0.07-0.35/cycle** | Burned regardless of verdict |
| `claude -p` spawn (if gate APPROVES) | $5-30 | Vendor evaluation + Studio products |

**Cost asymmetry (revised v2 per Gemini G-6 — implicit costs quantified):**

| Cost component | Per-event dollar value | Notes |
|---|---|---|
| Gate cost per cycle (synth + review) | $0.07-0.35 ($0.30 typical) | Always burned regardless of verdict |
| Saved `claude -p` spawn cost on true-block | $5-30 | The thing the gate is here to prevent |
| **Implicit cost of a FALSE-block** (added v2) | ~$5-50 | Comprises: (a) cost of the lost spawn the submitter paid for (recoverable via re-submission only with revised inputs), (b) submitter trust + LTV impact (hard to quantify but real), (c) support touch / manual reach-out time (~15 min @ operator-rate ≈ $5-15), (d) replay friction if the gate mis-classified and submitter needs to be talked through resubmission |
| Implicit cost of a TRUE-block | ~$0.30 (just gate cost) | This is the value-add of the gate |
| Implicit cost of a FALSE-approve | $5-30 (the bad spawn that should have been caught) | Same as not having the gate at all for this case |
| Implicit cost of a TRUE-approve | $0 (gate cost amortized) | The happy path |

**Surface-level ROI** (compute-only): gate burns ~$0.30 to potentially save ~$15. ROI positive if it correctly blocks >2% of bad-plan jobs.

**Implicit-cost ROI** (including trust/operations): false-block cost (~$25 avg) is ≥ true-block savings (~$15 avg), so the gate has NEGATIVE expected value if false-block rate ≥ true-block rate. The protocol must therefore strongly bias against false-blocks — supporting the G-5 v2 tighter rollback trigger and the G-3 v2 stricter verdict-stability test.

### 2.4 Known weak signals from existing telemetry

Per `feedback_intermittent_llm_marker_drift_needs_dual_defense.md` (Bug 49 S57): LLM-emitted exact-string markers drift non-deterministically. The reviewer verdict tokens (APPROVE, REQUEST_CHANGES, BLOCK) are LLM-emitted strings; we have not measured how stable these are within a single reviewer call (re-run same inputs, do we get the same verdict?).

Bug 53b (S62 IDENTIFIED, OPEN): integration validator rejects schema-violating revised plans, masking the underlying cause. Could correlate with REQUEST_CHANGES verdicts.

---

## 3. What "ready to flip" means

The flip is safe to make when ALL of the following are true:

| Criterion | Concrete threshold | Why it matters |
|---|---|---|
| **Approval rate (overall)** | ≥ 70% of jobs in the last n=10 ended organic-`verdict == APPROVED` (per §4.3 SQL that derives from `[SHADOW-MODE:%]` prefix) | Below 70% means flipping would block too many real jobs. Above 90% likely means the gate is too lenient and adds no value. |
| **Approval rate (per depth_target tier)** — Gemini G-2 v2 | For every `depth_target` tier represented in n=10 by ≥ 3 jobs, that tier's organic approval rate must be ≥ 50% | A flat overall metric can hide tier-specific over-blocking (e.g. 8 executive-tier approvals masking 2 expert-tier 100% rejections). If a tier has < 3 jobs in the sample, defer flip until more telemetry accrues for that tier. |
| **No CRITICAL findings on APPROVED plans** | 0 CRITICAL findings on jobs that ended verdict=APPROVED in the last n=10 | A CRITICAL on an APPROVED plan means the gate is mis-classifying. Sign of reviewer prompt drift or rubric mismatch. |
| **Reviewer cost is bounded** | p90 cost-per-cycle ≤ $0.50 over n=10 | If the gate is consistently running 2 rounds with 4+ findings each, the cost grows; needs prompt tuning or maxRounds reduction before flipping. |
| **Reviewer verdict stability** | 3 replays of the same job within 24h yield the same terminal verdict | Established via deliberate replay test; demonstrates non-determinism is not driving the outcome. |
| **Operator backstop in place** | `PREFLIGHT_NOTIFY_EMAIL` configured + Resend domain verified | Failed jobs trigger user-facing `sendPlanReviewEmail`; ops needs the parallel backoff signal if the gate ITSELF starts failing systemically. |
| **Bug 53b root-caused** | Either fixed or explicitly accepted as a known REQUEST_CHANGES cause | If 30% of REQUEST_CHANGES outcomes are integration-validator-rejection rather than real plan problems, the gate is rejecting on a bug, not on quality. |

If any criterion is unmet, flip is deferred until it's met. The doc captures the criteria; the operator (Dave) decides when they've been met based on the telemetry.

---

## 4. Phase 1 — Baseline collection (1-2 weeks of shadow operation)

**Codex E-2 v3 — RLS scope requirement:** the `plan_reviews` audit table has RLS enabled with owner + same-organization read policy (per `supabase/migrations/20260527_plan_review_gate.sql`). All §4 SQL queries MUST be run with the **service-role / admin connection string** (which bypasses RLS); otherwise an owner-scoped query would silently sample only one organization's rows and the global flip decision would be made on a partial dataset. Service-role credentials are in `agent/.env:SUPABASE_SERVICE_ROLE_KEY`; use the `psql` connection string from Supabase project settings → Database → Connection string (transaction pooler URL with `?role=service_role` is also acceptable). Alternative: make the flip explicitly per-organization with `WHERE organization_id = $1` filters on every query — viable but adds operational complexity. **Default decision: run all queries with service-role.**

Goal: get to **n=10 jobs** in shadow with clean telemetry on the criteria above.

### 4.1 Mechanics

- Keep `PLAN_REVIEW_ENFORCE=false` in `agent/.env`
- Run real production research jobs (NOT artificial test jobs — gate behavior on synthetic queries is not representative)
- After each job ends, query `public.plan_reviews` for the verdict + findings + cost trail
- Aggregate into a running scoreboard

### 4.2 Scoreboard query (run after each job)

```sql
-- Per-job verdict + cost + findings count
SELECT
  rq.topic_slug,
  rq.plan_review_status,
  rq.plan_review_iterations,
  COUNT(pr.id) AS reviewer_calls,
  SUM(pr.total_cost_usd) AS gate_cost_usd,
  SUM(jsonb_array_length(pr.findings)) AS total_findings,
  SUM(CASE WHEN pr.verdict = 'REQUEST_CHANGES' THEN 1 ELSE 0 END) AS request_changes_count,
  SUM(CASE WHEN pr.verdict = 'BLOCK' THEN 1 ELSE 0 END) AS block_count
FROM research_queue rq
LEFT JOIN plan_reviews pr ON pr.research_queue_id = rq.id
WHERE rq.created_at > (NOW() - INTERVAL '14 days')
  AND rq.plan_review_status IN ('approved','request_changes','blocked','system_blocked')
  AND rq.plan_review_iterations > 0   -- C-1: filter to jobs that actually traversed the gate (skip pending/reviewing)
GROUP BY rq.id, rq.topic_slug, rq.plan_review_status, rq.plan_review_iterations
ORDER BY rq.created_at DESC;
```

### 4.3 Rolling aggregate (run weekly)

**CRITICAL — Gemini G-1 fix in v2:** In shadow mode, `research_queue.plan_review_status` is **force-written to `approved`** by `plan-reviewer.ts:finalize()` for every non-SYSTEM_BLOCKED outcome. Querying that column directly would falsely report ~100% approval. To recover the **organic** (pre-override) verdict, derive it from:
- `error_message LIKE '[SHADOW-MODE: would have been %]%'` — the override prefix added by `finalize()` carries the underlying status verbatim
- Combined with per-call verdicts in `plan_reviews` (which are NOT shadow-overridden — they're the raw reviewer outputs)

```sql
-- The "ready to flip?" snapshot — derives ORGANIC verdict from override prefix
WITH last_10 AS (
  SELECT
    id,
    topic_slug,
    plan_review_status AS effective_status,        -- shadow-overridden
    plan_review_iterations,
    error_message,
    -- Recover the underlying organic status from the [SHADOW-MODE: would have been X]
    -- prefix written by plan-reviewer.ts:finalize() when overriding.
    CASE
      WHEN error_message ~* '^\[SHADOW-MODE: would have been APPROVED\]' THEN 'approved'
      WHEN error_message ~* '^\[SHADOW-MODE: would have been REQUEST_CHANGES\]' THEN 'request_changes'
      WHEN error_message ~* '^\[SHADOW-MODE: would have been BLOCKED\]' THEN 'blocked'
      WHEN error_message ~* '^\[SHADOW-MODE: would have been SYSTEM_BLOCKED\]' THEN 'system_blocked'
      -- No SHADOW-MODE prefix = organic + effective agree (or SYSTEM_BLOCKED, which is preserved)
      ELSE plan_review_status
    END AS organic_status,
    created_at
  FROM research_queue
  WHERE plan_review_status IN ('approved','request_changes','blocked','system_blocked')  -- C-1: terminal only
    AND plan_review_iterations > 0
  ORDER BY created_at DESC
  LIMIT 10
)
SELECT
  COUNT(*) AS n,
  SUM(CASE WHEN organic_status = 'approved' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS organic_approval_pct,
  SUM(CASE WHEN effective_status = 'approved' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS effective_approval_pct,
  AVG(plan_review_iterations) AS avg_iterations
FROM last_10;
```

Target: **n ≥ 10, organic_approval_pct ≥ 70%**. `effective_approval_pct` is informational (will be ~100% in shadow); it's the **organic** column that gates the flip decision.

### 4.4 Per-finding-severity audit (run weekly)

**G-1 fix:** filter to jobs where the ORGANIC status was approved (not the shadow-overridden effective status). Otherwise REQUEST_CHANGES-with-CRITICAL findings would be counted as "CRITICAL on APPROVED job" — false positive that blocks the flip on a misreading.

```sql
SELECT severity, origin, COUNT(*) AS occurrences
FROM (
  SELECT
    jsonb_array_elements(pr.findings)->>'severity' AS severity,
    jsonb_array_elements(pr.findings)->>'origin' AS origin
  FROM plan_reviews pr
  JOIN research_queue rq ON rq.id = pr.research_queue_id
  WHERE rq.created_at > (NOW() - INTERVAL '14 days')
    AND pr.iteration = rq.plan_review_iterations   -- C-2: terminal iteration only (intermediate-round CRITICALs already addressed by integrator)
    AND (
      -- Organic approved: either no shadow override (organic == effective == approved)
      -- OR shadow override said "would have been APPROVED"
      (rq.plan_review_status = 'approved'
       AND (rq.error_message IS NULL OR rq.error_message !~* '^\[SHADOW-MODE:'))
      OR rq.error_message ~* '^\[SHADOW-MODE: would have been APPROVED\]'
    )
) f
GROUP BY severity, origin
ORDER BY occurrences DESC;
```

Target: **0 rows where severity = 'CRITICAL'** on organic-APPROVED jobs.

### 4.5 Cost p90 check (run weekly)

```sql
SELECT
  PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY total) AS p50_cost,
  PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY total) AS p90_cost,
  MAX(total) AS max_cost
FROM (
  SELECT rq.id, SUM(pr.total_cost_usd) AS total
  FROM research_queue rq
  JOIN plan_reviews pr ON pr.research_queue_id = rq.id
  WHERE rq.created_at > (NOW() - INTERVAL '14 days')
  GROUP BY rq.id
) per_job;
```

Target: **p90 ≤ $0.50**.

---

## 5. Phase 2 — Verdict stability test (manual replay)

Before flipping, run a **deliberate replay experiment** to measure reviewer determinism. Non-deterministic verdicts are a deal-breaker — they mean the flip would produce different outcomes for the same submission depending on coin flips.

### 5.1 Procedure

1. Pick 3 jobs from Phase 1 telemetry that ended with different terminal verdicts (1 APPROVED, 1 REQUEST_CHANGES, 1 SYSTEM_BLOCKED if available)
2. Use the existing Replay button (S60 frontend) to clone each into 3 fresh queue rows (n=9 total replays)
3. Let the worker process all 9 replays under shadow telemetry
4. Compare terminal verdict for each {original, replay-1, replay-2, replay-3} quadruplet

### 5.2 Pass criteria (Gemini G-3 v2 — adds finding-overlap)

For each of the 3 jobs:

1. **Terminal-verdict agreement:** at least 3 of the 4 outcomes (75%) agree on terminal verdict.
2. **Finding-set overlap (NEW G-3):** for the outcomes that AGREE on terminal verdict, the union of their `findings[].origin` values must overlap ≥ 60%. This catches the "whack-a-mole rejection" failure mode where reviewers reach the same verdict via entirely non-deterministic / conflicting reasons. Without this, submitters could revise one set of findings only to hit a different set on re-submit — making the gate operationally unusable.
3. **Severity-distribution stability:** for outcomes that agree on terminal verdict, the count of CRITICAL findings must be within ±1 across replays. Wild swings in CRITICAL count signal reviewer-prompt drift.

If ANY of the three criteria fail across ANY of the three jobs, gate is too non-deterministic to flip. Investigate root cause (reviewer temperature, rubric clarity, input ambiguity) and re-test after tuning.

### 5.3 Cost budget

3 replays × $0.30/cycle = ~$0.90. Plus 3 original-vs-replay-with-same-data comparisons that incur full pipeline cost ONLY if the gate APPROVES (shadow mode preserves spawn). So worst-case $30-90 in `claude -p` burn if all replays approve. Mitigate by using `pipeline_mode='studio_only'` for replays where applicable (skips Phase 1-6, regenerates Studio only — much cheaper, $0.50-2/run).

---

## 6. Phase 3 — Tuning (CONDITIONAL — only if Phase 1 doesn't meet criteria)

If Phase 1 telemetry shows organic_approval_pct < 70% or a depth_target tier below 50% or persistent CRITICAL findings on organic-APPROVED, tune BEFORE flipping. **Tuning levers MUST be applied in priority order (Gemini G-7 v2)** — earlier levers are less destructive to research quality than later ones, so prefer them when both could plausibly solve the symptom:

**Priority 1 — Synthesizer prompt enhancement (§6.2).** Try this FIRST. Sharper synthesizer output reduces reviewer rejections without weakening the rubric. The cost is one prompt-engineering iteration + a fresh Phase 1 baseline.

**Priority 2 — Submitter input quality (§6.3).** Try this SECOND. UI/form helper text + rubric surfacing improves the quality of submitted topics at zero gate-cost. Slower to validate (depends on user adoption) but most durable.

**Priority 3 — Round reduction (§6.4).** Consider THIRD if Phase 1 shows reviewer-cost issues but verdict-quality is OK. Reducing iterations cuts cost ~40% with predictable verdict-quality trade-off.

**Priority 4 — Rubric softening (§6.1).** LAST resort. Lowering Persona Depth thresholds reduces gate strictness — meaning real bad plans now slip through. Only justify this when telemetry shows the gate consistently rejecting plans that would have produced good research (i.e. measured false-block rate, not theoretical).

After ANY tuning intervention, return to Phase 1 baseline collection with fresh n=10 (pre-tuning telemetry is contaminated and cannot inform the readiness criteria).

Options below describe each lever in detail (now ordered by priority rather than alphabetical):

### 6.1 Rubric softening (PRIORITY 4 — last resort)
- **Persona Depth threshold** (in `plan-reviewer.ts:PERSONA_DEPTH_THRESHOLDS`): currently `executive=2, practitioner=3, expert=4`. If too many `expert` plans fail, consider lowering to 3, OR adjusting at synthesizer time to recommend a lower depth_target when the topic is broad.
- **`looksLikeHedgeBet` heuristic** (in `plan-types.ts`): currently flags plans with `>10 vendor candidates AND no exclusions AND no risk_flags AND thin rubric`. May need calibration on real production data.

### 6.2 Synthesizer prompt enhancement (PRIORITY 1 — try first)
- Update `agent/lib/plan-synthesizer.ts:SCHEMA_HINT` to explicitly produce plans that satisfy Persona Depth thresholds.
- Reinforce "concrete exclusions with rationale" requirement (S62 finding: synthesizer often omits these on first attempt).

### 6.3 Topic-input quality at submission (PRIORITY 2)
- Frontend form helper text: tell users "for expert-tier research, include domain constraints, named vendors to evaluate, and explicit out-of-scope items in the constraints field." Surface the rubric to the submitter.

### 6.4 Reduce iterations from 2 → 1 (PRIORITY 3 — cost-driven)
- If Round 2 rarely changes outcomes, reduce `DEFAULT_MAX_REVIEW_ROUNDS` to 1. Cuts gate cost ~40%. Trade-off: less revision opportunity, more false-REQUEST_CHANGES.

### 6.5 Threshold to re-enter Phase 1
After any tuning, return to Phase 1 baseline collection (n=10 fresh jobs post-tuning). Pre-tuning telemetry is contaminated.

---

## 7. Phase 4 — The flip itself

When all Phase 1 + 2 criteria are met:

### 7.1 Pre-flip checklist (within 24h before flip)

- [ ] Phase 1 scoreboard shows organic_approval_pct ≥ 70% across last n=10 (per §4.3)
- [ ] Phase 1 per-tier scoreboard shows ≥ 50% organic approval for each depth_target tier with n≥3 representation (per §3 row 2)
- [ ] Phase 1 severity audit shows 0 CRITICAL on organic-APPROVED (per §4.4)
- [ ] Phase 1 cost p90 ≤ $0.50
- [ ] Phase 2 verdict-stability test passed (terminal-verdict AND finding-overlap AND severity-distribution per §5.2)
- [ ] `PREFLIGHT_NOTIFY_EMAIL` configured + verified delivering (test by triggering artificial preflight failure)
- [ ] `RESEND_API_KEY` valid + verified-domain configured (per `feedback_resend_free_tier_own_email_only`)
- [ ] **Gemini G-4 v2 — REJECTION-EMAIL TEMPLATE UPDATED.** Current `sendPlanReviewEmail` REQUEST_CHANGES template says "needs a quick look" implying paused/awaiting-input; in enforce mode the job is FAILED. The template MUST be updated BEFORE the flip to: (a) explicitly state the job was TERMINATED (not paused), (b) state the submitter must submit a new request (not reply), (c) clarify the billing status of the failed run. This was previously listed as a future iteration; now a hard flip prerequisite. Implementation lives in `agent/lib/notify.ts:buildPlanReviewEmail` `subjectByStatus.REQUEST_CHANGES` and `headlineByStatus.REQUEST_CHANGES` + body copy update.
- [ ] Bundle commit S52-S64 + tuning changes + email-template change carry-forward committed + pushed
- [ ] Worker daemon healthy + circuit breaker file ABSENT
- [ ] Communication to submitters / team about the change (if applicable)

### 7.2 Flip procedure

```powershell
# 1. Verify current state
Select-String -Path "C:\Users\ceo\Documents\AI Training\Anti Gravity\Dynamic Research\agent\.env" -Pattern "^PLAN_REVIEW_ENFORCE="

# 2. Update env (using Python edit to handle quote semantics correctly)
python -c @"
import io
p = 'C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/.env'
with io.open(p, 'r', encoding='utf-8') as f: s = f.read()
s = s.replace('PLAN_REVIEW_ENFORCE=false', 'PLAN_REVIEW_ENFORCE=true', 1)
with io.open(p, 'w', encoding='utf-8') as f: f.write(s)
print('FLIPPED PLAN_REVIEW_ENFORCE=true')
"@

# 3. Re-verify
Select-String -Path "C:\Users\ceo\Documents\AI Training\Anti Gravity\Dynamic Research\agent\.env" -Pattern "^PLAN_REVIEW_ENFORCE="

# 4. Restart worker to pick up new env (Codex D-1 v3 — PID-scoped, NOT all node processes)
$pidFile = "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/.worker.pid"
$workerPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
if ($workerPid) { Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName DynamicResearchWorker

# 5. Confirm new worker loaded enforce=true
Get-Content -Path "C:\Users\ceo\Documents\AI Training\Anti Gravity\Dynamic Research\agent\worker.log" -Tail 20 -Wait
# Look for: [plan-review] gate fired (enforce=true, shadow=false) on the first job
```

### 7.3 Initial post-flip monitoring window (first 5 jobs after flip)

**Codex E-1 v3 — throttled rollout to contain false-block cascade.** The S64 preflight + circuit breaker contains TERMINAL PROVIDER errors (credit-out, auth-out, etc) but does NOT contain plan-review false-block cascades — REQUEST_CHANGES / BLOCKED outcomes call failJob + sendPlanReviewEmail and the worker continues polling. Without throttling, an over-strict gate could fail multiple queued jobs before manual review catches the first one. Protocol:

1. **Before the flip:** stop the worker and disable the scheduled task (`Disable-ScheduledTask -TaskName DynamicResearchWorker`). The queue stays empty / accumulates.
2. **For each of the first 5 post-flip jobs:**
   - Re-enable the scheduled task (`Enable-ScheduledTask -TaskName DynamicResearchWorker`)
   - Trigger ONE worker spawn (`Start-ScheduledTask -TaskName DynamicResearchWorker`)
   - Wait for the worker to claim + process EXACTLY ONE job (observe via worker.log)
   - As soon as the gate decision is written (plan_review_status finalizes), `Stop-Process -Id <worker-pid>` to prevent the next claim
   - Disable scheduled task again
   - Manually review the gate outcome (see SQL below)
   - Decide: proceed to next job, or rollback
3. **After 5 successful gate-decisions WITHOUT rollback:** re-enable scheduled task permanently; remove the per-job pause.

This is operationally heavy (~30 min per job over an hour-spaced sequence) but contains the blast radius. Skip the throttle ONLY if Phase 1 + 2 telemetry was unusually strong (e.g. n >= 30 jobs with >= 90% organic approval and stable verdicts).

**Per-job monitoring SQL (run after each of the first 5):**

```sql
SELECT
  topic_slug,
  status,             -- 'failed' is now possible when gate rejects
  plan_review_status, -- 'approved' / 'request_changes' / 'blocked' / 'system_blocked'
  plan_review_iterations,
  error_message
FROM research_queue
WHERE created_at > (NOW() - INTERVAL '6 hours')
  AND plan_review_status IN ('approved','request_changes','blocked','system_blocked')   -- C-1: terminal only
  AND plan_review_iterations > 0
ORDER BY created_at DESC LIMIT 5;
```

**For each rejection (REQUEST_CHANGES / BLOCKED / SYSTEM_BLOCKED):**
1. Manually review the plan + findings from `public.plan_reviews`
2. Decide: was the rejection legitimate (plan really was bad), or a false-block?
3. Log the decision somewhere persistent (e.g. append to `Documentation/plan-review-enforce-flip-rollout-log.md`)

**Threshold for rollback (Gemini G-5 v2 — TIGHTENED):** ROLL BACK immediately on the **FIRST** clear false-block during the initial monitoring window. Rationale: a 40% false-block tolerance (the prior 2-of-5 rule) accepts an unacceptably high rate of destroying paid runs + eroding user trust. Pre-flip telemetry should have already de-risked false-blocks via Phase 1 + 2; a false-block in the first 5 post-flip jobs means the protocol's de-risking signal is wrong, which warrants immediate retreat to shadow + tuning. A "warn" tier at 0 false-blocks (i.e. early signal before rollback) is captured by §7.5 manual outreach, which surfaces qualitative submitter signal before the next job arrives.

### 7.4 Quick rollback procedure (Codex D-1 v3 — PID-scoped)

```powershell
# Same as Section 7.2 in reverse
python -c @"
import io
p = 'C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/.env'
with io.open(p, 'r', encoding='utf-8') as f: s = f.read()
s = s.replace('PLAN_REVIEW_ENFORCE=true', 'PLAN_REVIEW_ENFORCE=false', 1)
with io.open(p, 'w', encoding='utf-8') as f: f.write(s)
print('ROLLED BACK PLAN_REVIEW_ENFORCE=false')
"@

# Codex D-1 v3 — target ONLY the worker PID (not all node processes — could be dev/test sessions)
$pidFile = "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/.worker.pid"
$workerPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
if ($workerPid) { Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue }
else { Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'worker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }
Start-ScheduledTask -TaskName DynamicResearchWorker
```

Rollback wall-clock: ~30 seconds. Cost of rollback: $0. The PID-scoped `Stop-Process -Id <pid>` targets only the worker process, not all node processes (dev servers, tsx test runs, etc).

**Why the env-edit assertion matters:** the `.env` Python edit should be hardened with `before = s.count('PLAN_REVIEW_ENFORCE=true'); assert before == 1` so a malformed `.env` (e.g. comment lines or duplicate vars) fails LOUD instead of silently doing the wrong thing. Hard-fail is safer than soft-fail at rollback time.

### 7.5 Submitter communication (Codex C-3 v3 — consistent with §7.1 G-4 email-template prereq)

When a job FAILS due to plan-review-rejection (post-flip), `agent/lib/notify.ts:sendPlanReviewEmail` fires. **Per §7.1 pre-flip checklist (Gemini G-4 + Codex C-3 reinforced), the template MUST have been updated before the flip** — the old copy ("needs a quick look") implied a paused/awaiting-input job; in enforce mode the job is terminated. Required v3 template state (concrete strings to land in `agent/lib/notify.ts:buildPlanReviewEmail`):

- `subjectByStatus.REQUEST_CHANGES`: e.g. `"Your research run was halted before execution — ${topicShort}"` (instead of "needs a quick look")
- `headlineByStatus.REQUEST_CHANGES`: e.g. `"Your research run was halted — please resubmit with revisions"`
- Body: explicitly states the job was NOT charged for `claude -p` spawn (only for the gate cycle, ~$0.30); explicitly states the user must submit a new request from the form rather than replying; lists findings with `severity / origin / message`.
- CTA: link to the form pre-filled with prior inputs (frontend enhancement; if not ready, link to the run page so the submitter can see findings + start over).

For the first 5 post-flip rejections — even with the corrected template — ALSO reach out manually to the submitter (Slack/email) to:
- Explain the new gate behavior at a person-to-person level
- Ask whether they agreed with the rejection
- Capture qualitative feedback for §8 failure-mode iteration

The combination of corrected email + manual outreach is the operator's belt-and-suspenders for the initial monitoring window.

---

## 8. Failure modes considered

| Failure mode | Detection | Mitigation |
|---|---|---|
| Gate over-blocks legitimate plans | Manual review of first 5 rejections post-flip flags ≥ 2 as false-blocks | §7.4 rollback within ~30s; revisit tuning Phase 3 |
| Gate under-blocks (no value-add over shadow) | All n=10 jobs end APPROVED with 0 findings | Gate is too lenient; either tighten rubric OR consider whether gate earns its $0.30/cycle cost |
| Reviewer transport outage during flip | `plan_review_status='system_blocked'` rate spikes | SYSTEM_BLOCKED blocks in BOTH modes; not affected by flip. Worker preflight + circuit breaker catches transport-level Anthropic/Google/OpenAI auth-out (S64 architecture) |
| Reviewer cost balloons | Phase 1 + ongoing cost p90 monitoring | Reduce `MAX_REVIEW_ROUNDS` from 2 to 1; OR add a hard cycle-cost cap that BLOCKS the gate before reviewers run again |
| Verdict non-determinism causes random outcomes | Phase 2 verdict-stability test | If <75% agreement, defer flip; investigate temperature + rubric clarity |
| Bug 53b false-REQUEST_CHANGES via integration validator | Phase 1 finding audit shows high `origin=integration-validator-rejection` rate | Defer flip; fix Bug 53b first (correlated REQUEST_CHANGES on schema-violating revisions) |
| Single bad reviewer (Gemini OR Codex) destabilizes verdicts | Phase 2 + per-reviewer verdict break-down | Temporarily set the bad reviewer's transport to null (operates under-reduced-review per design §6 — auto-flagged in user_message) until fixed |
| Submitter doesn't understand rejection email | Pre-flip checklist §7.1 G-4 update was applied (preventive) + manual outreach §7.5 during initial window (detective) | Email template MUST be updated BEFORE flip per §7.1 G-4; the in-flight detection comes from manual outreach catching residual confusion. Combined gives defense in depth. |
| Frontend form doesn't preview likely verdict | Out of scope for this flip — submitters submit blind | Future enhancement: synth+review on submit (no spawn), show preview before commit. Not in scope for the flip itself. |

---

## 9. Decisions confirmed (pre-MRPF)

These are author-decided + LOCKED for MRPF review unless reviewer flags as MAJOR-REVISIT:

| # | Decision | Rationale | Where applied |
|---|---|---|---|
| A | Flip threshold = 70% approval over n=10 | Below 50% means gate is broken; 50-70% means tuning is needed; above 70% means a clear majority of real plans pass | §3 |
| B | Verdict-stability test = 3 replays per quadruplet | n=4 quadruplets gives N=12 observations, enough to detect coin-flip non-determinism but not so many that the test alone is expensive | §5 |
| C | Initial monitoring window = first 5 post-flip jobs | First 5 is enough signal to detect catastrophic over-blocking; longer would just delay rollback | §7.3 |
| D | Rollback trigger = **FIRST** clear false-block (Gemini G-5 v2) | A 40% false-block rate destroys paid runs + user trust; pre-flip Phase 1 + 2 should have already eliminated false-block risk. A surviving false-block past those de-risking phases means protocol assumptions are wrong → retreat immediately, tune, re-attempt. §7.5 manual outreach catches sub-threshold concerns | §7.3 |
| E | Tuning levers ordered by priority (Gemini G-7 v2): synthesizer prompt → input quality → round reduction → rubric softening | Earlier levers preserve research quality; later ones weaken the gate. Operator may skip a priority if telemetry clearly points at a later one, but defaults to the order | §6 |
| F | Submitter manual outreach during initial window | Builds qualitative dataset that informs whether to keep going, tune, or revert | §7.5 |
| G | Studio-only replay mode for verdict-stability test where applicable | Cost-optimization for the test phase ($0.50-2/replay vs $5-30/full-pipeline) | §5.3 |
| H | No new code changes required for the flip itself | Env-var-only change; existing code paths already handle enforce semantics (per `executor.ts:runPlanReviewGate` shadow vs enforce branches) | §7.2 |

---

## 10. Out of scope (future S66+ work)

- **Frontend gate preview** (synth + review on submit before commit). Would let submitters iterate on their inputs without spending a queue slot. Larger UX project. [v2 note: per Gemini G-4, this is desirable BUT not blocking — the email-template update in §7.1 covers the immediate communication gap.]
- **Per-job enforce override** (e.g. metadata flag that lets specific jobs bypass the gate). Adds complexity; reconsider only if there's a clearly valid use case (e.g. internal smoke tests).
- **Gate tier-shifting** (different thresholds for different topic types — e.g. expert-depth_target gets strict gate, executive-depth_target gets lenient). Premature optimization; consider only after the binary flip has been operating for 1+ month.
- **Verdict-aggregation across reviewers** (currently treated as either-can-veto; could be voting-based). Architectural change; out of scope.
- **Bug 53b root-cause** — listed as a flip prerequisite but the fix itself is a separate engineering exercise (likely in `plan-reviewer.ts:runIntegration` validation path).

---

## 11. Reviewer focus areas

### 11.A For Gemini (round 1, holistic long-context)

Use this doc + `Documentation/preflight-cost-architecture-design-gate.md` (v3.1) + `agent/lib/plan-reviewer.ts:finalize()` + `agent/executor.ts:runPlanReviewGate` + `agent/lib/notify.ts:sendPlanReviewEmail` as read-context. Specifically critique:

1. **The 70% approval threshold itself.** Is this the right shape? Should it be measured differently (e.g. weighted by submission tier, by depth_target, by cost)?
2. **Verdict stability methodology.** 3 replays per job, 3 jobs, n=12. Is the sample size adequate? Is "same terminal verdict" the right success metric (vs. e.g. "same findings count" or "same persona_depth_score")?
3. **The rollback trigger (2 of 5 false-blocks).** Too aggressive (we revert too easily)? Too lax (we let too much damage accrue)? Should there be a count-window other than 5?
4. **What's missing from the failure-mode table.** What classes of failure haven't I considered? Specifically thinking about: schema drift in `public.plan_reviews` between now and flip, reviewer-model deprecation forcing migration, RLS edge cases on the audit table.
5. **The tuning phase is conditional but unspecified.** Should it have more concrete pre-commitments (e.g. "if approval_pct < 70%, first lever is X, then Y, then Z")? Or is the operator-judgment latitude correct?
6. **Cost asymmetry analysis.** The doc claims ROI is positive if blocks >2% of bad jobs. Is that math right? What's the dollar value of a false-block (lost trust + comms overhead) vs a true-block ($5-30 saved spawn)?
7. **Submitter communication strategy.** Is the existing `sendPlanReviewEmail` template adequate for a hard-rejection world? Should there be a UI element (frontend banner explaining the gate) before the flip rather than after?

### 11.B For Codex (round 2 — code-grounded on integrated v2)

After Gemini findings are integrated, Codex's strength is verification against shipped code + SQL queries + actual schema. Specifically:

1. **Verify the SQL queries in §4 + §7.3.** Run them in your head against `public.plan_reviews` schema (created by `supabase/migrations/20260527_plan_review_gate.sql`). Will they produce what the doc claims?
2. **Verify `agent/.env` parsing semantics.** The flip uses Python to replace `PLAN_REVIEW_ENFORCE=false` → `PLAN_REVIEW_ENFORCE=true`. What if the .env has quotes (`PLAN_REVIEW_ENFORCE="false"`), comments on the same line, or extra whitespace? Does the substitution still work?
3. **Verify worker.ts loads the new env on restart.** Per CLAUDE.md §7, `conventions.json` static-import requires daemon restart. Does the same apply to env vars consumed at module-load? Read `agent/lib/plan-reviewer.ts:reviewPlan` callers to confirm the enforce read happens at job-claim time (per-job), not module-load time (per-process).
4. **`sendPlanReviewEmail` behavior in enforce mode.** Read `agent/executor.ts:runPlanReviewGate` lines that call it. Confirm the email actually fires when gate rejects (enforce=true). Verify it doesn't double-fire (once from runPlanReviewGate and once from somewhere else).
5. **Migration safety of the audit-table queries.** Does `plan_reviews.findings` JSONB schema match what the §4.3 query assumes? Check column types.
6. **The Python-edit env flip** (§7.2) — does it survive odd `.env` content like multiline VAR values or escaped characters? Suggest a safer pattern if not.
7. **Bug 53b prerequisite** — is the doc right that Bug 53b is a flip-blocker? Check `plan-reviewer.ts:runIntegration` for whether schema-violating revised plans surface as REQUEST_CHANGES or as UNAVAILABLE. If UNAVAILABLE, the gate doesn't actually block on it — the doc would be over-cautious.

### 11.C What both reviewers should NOT critique

- The DECISION to flip eventually — the user has stated intent; this doc is about HOW, not WHETHER.
- The shadow-mode → enforce-mode architectural design — that landed in S58 and was reviewed then.
- The choice of Gemini + Codex as the reviewers — locked architectural decision.

---

## 12. Rollout plan summary

1. **MRPF round 1** — Gemini holistic review of this v1 doc. Focus areas in §11.A.
2. **Integrate findings → v2.**
3. **MRPF round 2** — Codex code-grounded review on integrated v2. Focus areas in §11.B.
4. **Integrate findings → v3 (final).** Synthesis at `Documentation/plan-review-enforce-flip-design-gate-peer-review.md`.
5. **Phase 1 execution** (operator-driven, 1-2 weeks): baseline collection until n=10.
6. **Phase 2 execution** (~30 min operator-time + ~3-90 dollars depending on full-pipeline vs studio-only): verdict-stability test.
7. **Phase 3 execution** (conditional, only if Phase 1 fails criteria): tuning + return to Phase 1.
8. **Phase 4 execution** (~2 min operator-time for flip + 2-5 days for first-5-jobs monitoring window): the flip itself.

**Total wall-clock to safe flip:** 2-3 weeks under normal job volume. Faster if job volume is high; longer if Phase 3 tuning is required.

---

## 13. Companion doc updates on ship

When v3 ships:
- This file → `Documentation/plan-review-enforce-flip-design-gate.md`
- Synthesis → `Documentation/plan-review-enforce-flip-design-gate-peer-review.md`
- Project `CLAUDE.md` §10 SECURITY block — note the enforce-flip plan exists, link to this doc
- `dryrun_handoff.md` — S65 entry documenting the DESIGN-gate ship
- Memory: `feedback_enforce_flip_phased_rollout.md` capturing the protocol shape for re-use on future gate flips
