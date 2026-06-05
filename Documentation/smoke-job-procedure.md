# Smoke-job procedure — minimal validation submission for plan-review pipeline

Use this when you've made a change to the plan-review path (`agent/lib/plan-transports.ts`, `plan-reviewer.ts`, `plan-synthesizer.ts`, or any transport/synthesizer) and want a cheap live-fire test before declaring the change validated. **Cost: $0.10-$1.00** depending on Phase-2 scope. **Wall-clock: ~5-30 min** depending on what reviewers find + Phase 2 complexity.

Born from S75 schema-migration validation (2026-05-31). See `Documentation/plan-transports-schema-migration-merge-gate-peer-review.md` for the inaugural use case.

---

## Pass / fail criteria

**Pass (one of):**

- **A — Best:** `plan_review_status: approved` with `iterations: 1` AND 3 rows in `plan_reviews` (codex + gemini + integration, even if integration=UNAVAILABLE). Both reviewers reached + emitted verdicts; no silent fallback.
- **B — Acceptable:** `plan_review_status: request_changes` with `iterations >= 1` AND ≥2 `plan_reviews` rows from real reviewer disagreement (not "codex unreachable"). Both reviewers ran; the topic just genuinely needed iteration.

**Fail:**

- **F1 — Codex unreachable (the failure class S75 closed):** `error_message` or worker.log contains "Operating under reduced review (codex unreachable)". Only 1 `plan_reviews` row (Gemini-only). The fix didn't take or regressed. Investigate via S74 `formatReviewerErr()` logging in `agent/worker.log`.
- **F2 — Schema rejection:** HTTP 400 from OpenAI logged via the bumped `text.slice(0, 4000)` diagnostic. The schema is malformed for strict mode. Check `OPENAI_REVIEWER_JSON_SCHEMA` against the OpenAI Structured Outputs spec. See `[[feedback_openai_strict_mode_json_schema_subset]]`.
- **F3 — Worker didn't claim:** No `[worker] Claimed job <id>` line within 60s of submit. Worker is wedged or queue-claim has a bug. Check `Get-ScheduledTask -TaskName DynamicResearchWorker` for `LastTaskResult != 0`.

---

## Step-by-step

### Step 0 — Pre-check

Verify worker is alive and queue is idle.

```bash
cd "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research"
node --env-file=agent/.env -e "
const r = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL+'/rest/v1/research_queue?status=in.(in_progress,pending,running)&select=id', {headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY}});
console.log('In-flight:', await r.text());
"
```

Expect `In-flight: []`. If not empty, wait for current job or investigate before submitting.

```powershell
Get-ScheduledTask -TaskName DynamicResearchWorker | Get-ScheduledTaskInfo | Format-List LastTaskResult, NextRunTime
```

Expect `LastTaskResult: 0`.

### Step 1 — Prepare submit script

Copy the S75 reference script and edit only the slug + topic:

```bash
cp c:/tmp/submit-smoke-s75.mjs c:/tmp/submit-smoke-<session>.mjs
```

Required edits inside the new file:
- `SLUG`: change to `<session>-validation-smoke-<unix-or-date>`
- `topic`: 2-5 lines, single-source acceptable, explicit exclusions to keep scope tight
- `selected_products`: `{audio: false, video: false, slides: false, report: true, infographic: false}` — report-only keeps Phase 2 cost under $1
- `customizations.notebookLM.researchMode`: `'shallow'` (not `'deep'`)
- `estimated_minutes`: 10

The default `ORG_ID` (`4ece2f20-f2fc-4f8f-afce-59806d92a11b`) and `notify_email` (`ceo@thewcoachinggroup.com`) stay as-is for owner-account-only Resend dispatch.

### Step 2 — Submit

```bash
cd "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research"
node --env-file=agent/.env c:/tmp/submit-smoke-<session>.mjs
```

Capture the returned `id` (UUID). Worker should claim within ~30s of submission.

### Step 3 — Monitor plan-review

Tail worker.log for the plan-review markers. **Filter on the job-id prefix (8 chars), NOT the full slug** — the slug doesn't always appear on every line, but the id-prefix tag (e.g. `[dbd421d2]`) is on every plan-review-tagged log line:

```bash
tail -f "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/worker.log" | grep -E "(plan-review|<id-prefix>|spawn)"
```

Expected sequence (timestamps approximate):
1. `[worker] Claimed job <id>` (within ~30s of submit)
2. `[<id-prefix>] Manifest written to ...`
3. `[<id-prefix>] [plan-review] gate fired (enforce=true, shadow=false)`
4. `[<id-prefix>] [plan-review] synth ok: $0.0X (1 attempt, NNNN+NNNN tok)` (~30s after gate)
5. `[<id-prefix>] [plan-review] verdict=<APPROVED|REQUEST_CHANGES> iters=N calls=M cost=$0.0X` (~1-3 min total)
6. `[<id-prefix>] [plan-review] audit-persist ok: N rows written to plan_reviews`
7. If APPROVED → `[spawn] claude -p ...` (Phase 2 begins)

Stop the tail at marker 6 or 7. The plan-review is the validation target; Phase 2 cost/duration is incidental.

### Step 4 — Query plan_reviews for per-reviewer detail

```bash
cd "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research"
node --env-file=agent/.env -e "
const id = '<paste id>';
const h = {apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY};
const r = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL+'/rest/v1/plan_reviews?research_queue_id=eq.'+id+'&select=reviewer,iteration,verdict,provider,model_id,total_cost_usd,duration_ms,findings&order=created_at.asc', {headers: h});
const rows = await r.json();
console.log('Count:', rows.length);
for (const row of rows) {
  const findings = Array.isArray(row.findings) ? row.findings : [];
  console.log('iter=' + row.iteration, 'reviewer=' + row.reviewer, 'verdict=' + row.verdict, 'provider=' + row.provider, 'model=' + row.model_id, 'cost=\$' + row.total_cost_usd, 'dur=' + row.duration_ms + 'ms', 'findings=' + findings.length);
  for (const f of findings) console.log('  -', f.severity, '|', f.origin, '|', (f.message || '').slice(0, 100));
}
"
```

**Important column name:** `research_queue_id` (NOT `job_id`). The smoke-result table in handoff documents this footgun.

### Step 5 — Evaluate against pass/fail

Match the output to the pass/fail criteria at top of this doc. Document outcome in the handoff under a "smoke-job result" subsection of the current session.

If **Pass A**, the validation is closed end-to-end. The Phase 2 run completing or not is incidental — let it finish naturally and the deliverables land at `C:/tmp/research-compare/<slug>/`. If Phase 2 hits the 90-min cap on a video task, manual recovery per `[[feedback_worker_90min_cap_kills_nlm_video_poll]]`.

If **Pass B**, plan-review converged but with real critique. Re-submit with a tightened topic per the findings if you want APPROVED, OR accept REQUEST_CHANGES as the legitimate outcome.

If **Fail F1/F2/F3**, the change regressed something. The S74 logging (`formatReviewerErr` in `plan-reviewer.ts:325-334`) + the S75 bumped diagnostic (`text.slice(0, 4000)` in `plan-transports.ts:482, :585`) surface the raw error class. Investigate before re-shipping.

### Step 6 — Cleanup

- Mark `c:/tmp/submit-smoke-<session>.mjs` as ephemeral. No archive needed unless it becomes the canonical reference for the next session.
- The smoke job's `research_queue` row stays in the database with `status=completed` (or `failed`). Don't delete — keeps audit log clean.
- If the smoke generated deliverables at `C:/tmp/research-compare/<slug>/`, they can be moved to `Projects/<slug>/` for retention OR left ephemeral if the smoke wasn't substantively useful.

---

## Cost reference (S75 dogfood)

| Item | Cost | Notes |
|---|---|---|
| Plan-review synth | $0.0559 | Anthropic, 2840+1668 tok |
| Plan-review Gemini | $0.0120 | gemini-3.1-pro-preview, 38.4s |
| Plan-review Codex | $0.0455 | gpt-5, 46.6s |
| **Plan-review total** | **$0.0600** | converged iter 1 |
| Phase 2 (single-source BTC, report-only) | TBD | Expected <$1.00 with strict scope |

---

## Variants

- **Plan-review-only validation:** stop after Step 4. Don't wait for Phase 2 to finish. Use when you only need to validate the plan-review path itself (not the executor).
- **Full-pipeline validation:** let Phase 2 complete naturally. Use when validating a change that also touches Phase 2 (executor.ts, MCP proxy, NotebookLM integration).
- **Cost-bounded full-pipeline:** add `MAX_JOB_COST_CENTS=100` env override before submit to cap Phase 2 at $1. Useful when the topic might escalate unexpectedly.
