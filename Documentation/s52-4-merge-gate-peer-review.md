# S52 #4 — MERGE-gate Peer Review Synthesis

**Gate:** MERGE | DATA + COST + AGENT BEHAVIOR labels | NORMAL severity | Sequential Gemini → Codex.

**Artifacts under review:**
- `sandbox/20260525_research_usage_telemetry.sql` (intended: `supabase/migrations/`)
- `sandbox/usage-tracking.ts` (intended: `agent/lib/usage-tracking.ts`)
- `sandbox/executor-s52-4.ts` (intended: `agent/executor.ts`)
- `sandbox/s52-4-telemetry-design.md` (design doc, reference)

---

## Round 1 — Gemini Deep Think (web paste, 2026-05-25 morning)

**Verdict:** REQUEST CHANGES (1 CRIT, 2 MAJ, 1 MIN, 1 question).

**What Gemini saw (per its own report):**
- Source files: 2 sandbox drafts (migration SQL + usage-tracking.ts)
- Tests: none embedded
- Probes: §5 of bundle (CLI v2.1.146 layout summary)

Gemini did NOT see the executor.ts diff in its review (which is in §4 of the bundle but not explicitly listed in its "What I saw"). One implication: Gemini's M2 disposition reasoned about heartbeat behavior without visibility into state.json watcher's per-phase `log()` calls.

### Findings + dispositions

| # | Severity | Finding | Disposition | Evidence / rationale |
|---|---|---|---|---|
| C1 | CRITICAL | View `research_usage_daily` lacks `WITH (security_invoker = true)` → bypasses base-table RLS | **ACCEPT** | PostgreSQL 15+ defaults views to security-definer-like behavior (run as view creator). Supabase migrations run as `postgres`/`supabase_admin`, so the view bypasses base-table policies. Fix: add `WITH (security_invoker = true)`. **APPLIED** in migration §4. |
| M1 | MAJOR | RLS policy `(select private.auth_user_is_owner())` is wrong — live function is `auth_user_is_org_owner(target_org_id uuid)` requiring a UUID arg | **REJECT** | Verified against live `supabase/migrations/20260523_phase_b_auth_rls_helpers.sql:182` — function IS parameterless: `CREATE OR REPLACE FUNCTION private.auth_user_is_owner()`. Lines 143-147 of the same file explicitly document the S49 Gemini round-1 refactor FROM `auth_user_is_org_owner(target_org_id uuid)` TO the parameterless form (InitPlan-friendly). The asw_select policy on `audit_storage_writes` at line 506 uses the parameterless form — my new ru_select policy correctly mirrors it. Gemini round-1 of this gate is hallucinating the same defect that prior-round Gemini fix already resolved. **NO CHANGE.** |
| M2 | MAJOR | Dropping `--verbose` leaves worker.log silent for 90min, breaking heartbeat | **ACCEPT (modified)** | Partially correct. State.json watcher `log()` at `executor.ts:640` writes to worker.log on every phase transition (~12 phases over a typical job, 2-7min gaps), so "completely dark" overstates. But the gap during long single-phase intervals IS real visibility loss. **Modified fix: re-add `--verbose` to spawn args; update parser to handle JSON-ARRAY-of-events shape (walk array in reverse, find `type==="result"` element); preserve per-line passthrough log.** Avoids the fragile `lastIndexOf` Gemini suggested, except as a degraded-recovery fallback when buffer truncation breaks the whole-buffer parse. **APPLIED** in spawnClaude + parseUsageSummary. |
| m1 | MINOR | Unbounded `stdoutBuf` memory growth on long runs | **ACCEPT** | Real concern. Result event is always the last element; tail-preserve trim is safe. **APPLIED:** 8MB MAX with 6MB TRIM_TO; parser's lastIndexOf recovery path covers the case where trim corrupts JSON.parse. |
| Q1 | QUESTION | Edge case: claude diagnostic on stdout (vs stderr) during interrupt — does trimmer handle? | **DEFERRED** | Probe coverage doesn't exhibit this; out-of-band stdout would fail JSON.parse → no-summary fallback already covers. Codex round-2 can re-test. |

### Net code changes from Gemini round 1

1. Migration: add `WITH (security_invoker = true)` to the view. (+2 lines comment, +1 line clause.)
2. usage-tracking.ts: replace single-shape parse with array-or-object + recovery-via-lastIndexOf. (+~70 lines including bracket-balanced walker.)
3. executor.ts: re-add `--verbose` to args, add 8MB tail-preserve cap, restore per-line passthrough log. (+~10 lines.)

---

## Round 2 — Codex `exec` (CLI, 2026-05-25 morning)

**Verdict:** REQUEST CHANGES (0 CRIT, 2 MAJ, 1 MIN, 1 NIT). Independent verification on Gemini M1 + C1 disposition.

**What Codex saw:**
- Full/near-full reads: `sandbox/20260525_research_usage_telemetry.sql`, `sandbox/usage-tracking.ts`
- Targeted reads: `sandbox/executor-s52-4.ts`, live `agent/executor.ts`, `agent/lib/storage-paths.ts`
- Targeted refs: design doc, this synthesis, `20260523_phase_b_auth_rls_helpers.sql`
- External: PostgreSQL 15 `CREATE VIEW`/`CREATE POLICY` docs, Supabase RLS docs (for C1 verification)

### Codex independent verification of round-1 dispositions

- **M1 rejection** → Codex AGREES. Independent file:line citation: `auth_user_is_owner()` is parameterless at `supabase/migrations/20260523_phase_b_auth_rls_helpers.sql:182`, refactor documented at lines 175-180, GRANT at 521-525. My ru_select policy at line 111 of the migration correctly uses the parameterless form. **CONFIRMED REJECT** (two-reviewer agreement).
- **C1 fix** → Codex AGREES. `WITH (security_invoker = true)` at migration line 133 correctly addresses cross-tenant view-owner bypass per PG 15 `CREATE VIEW` docs + Supabase RLS Views guidance. **CONFIRMED APPLIED** (two-reviewer agreement).
- **M2/m1 implementation** → Codex AGREES. Parser handles array-with-result + single-object + truncated-buffer recovery; buffer cap is 8MB/6MB tail-preserve at executor.ts line 586. **CONFIRMED APPLIED** (two-reviewer agreement).

### New findings (Codex round-2) + dispositions

| # | Severity | Finding | Disposition | Evidence / rationale |
|---|---|---|---|---|
| C2 | MAJOR | `recordUsage` records `job_status=complete` when `exitCode===0`, BEFORE `verifyPipelineCompletion()` runs (Bug-35) and BEFORE `uploadOutputs()` runs (partial-upload failure). So exit-0-but-worker-failed jobs land in `research_usage_daily.jobs_complete` cost aggregates as complete. | **ACCEPT** | Real cost-aggregate corruption. **APPLIED:** restructured executeJob with try/finally; telemetry write deferred to finally with worker-determined `finalJobStatus` ("complete" only after all success checks pass; "failed" otherwise). `parseUsageSummary` extended with optional `finalJobStatus` override that beats exit-code derivation but does NOT override parser-side "no-summary" (preserves "ran but couldn't read" semantics). |
| C3 | MAJOR | `raw_json` stores the FULL `parsedRaw` payload — with `--verbose`, that's the array of events INCLUDING `assistant` events carrying the FULL LLM response text. DATA exposure + storage bloat. Migration's `COMMENT ON COLUMN` already promises only the "final-event summary". | **ACCEPT** | Real DATA risk. **APPLIED:** changed happy-path `raw_json: parsedRaw` → `raw_json: result` (the selected result event only). Failure-path raw_json (no-summary cases) keeps minimal recovery wrapper — already small. |
| C4 | MINOR | `createClient(SUPABASE_URL, SUPABASE_KEY)` is constructed inside the `recordUsage()` call argument; the `.catch()` only catches Promise rejections, not synchronous throws from `createClient` itself. | **ACCEPT** | Defensive. **APPLIED:** moved `createClient()` inside its own `try/catch` block, separate from the recordUsage Promise chain. |
| C5 | NIT | Recovery marker `lastIndexOf('{"type":"result"')` is whitespace-rigid; future CLI shape variants (`{ "type" : "result"`) won't match. | **ACCEPT** | Cheap fix. **APPLIED:** replaced literal lastIndexOf with regex `/\{\s*"type"\s*:\s*"result"/g` + matchAll, taking the last match. |
| QQ1 | QUESTION | Is `raw_json` required to preserve full event stream? | **ANSWERED via C3 fix** — no, result event only. |
| QQ2 | QUESTION | Should migration explicitly `GRANT SELECT`/`REVOKE` on the new table/view? | **DEFERRED** — current Supabase posture (matches `audit_storage_writes`, no explicit grants) is consistent with existing tables. Codex didn't flag this as REQUEST CHANGES; deferring to follow-up if grants policy hardens. |

### Round 2 → v3 integration evidence (TSC verified)

Temp-copied sandbox versions to live `agent/executor.ts` + new `agent/lib/usage-tracking.ts`, ran `cd agent && pnpm exec tsc --noEmit` → **EXIT 0 (clean)**. Reverted live; sandbox holds the v3.

**Reviewer agreement summary:** Gemini round-1 + Codex round-2 = 1 disposition CONFIRMED REJECT (M1), 4 dispositions CONFIRMED APPLIED (C1, M2, m1, NIT). No outstanding disagreements. Codex's 2 new MAJOR findings + 1 MINOR + 1 NIT all integrated into v3.

---

## Final v3 state — ready for promote (pending user sign-off)

### Final code diff scope

- `supabase/migrations/20260525_research_usage_telemetry.sql` (NEW, 152 lines)
- `agent/lib/usage-tracking.ts` (NEW, ~340 lines after C1-C5 fixes)
- `agent/executor.ts` (MODIFIED, ~+50 lines net for spawn args / accessor / try-finally telemetry / imports)

### Promote sequence (USER SIGN-OFF gates)

| Step | Action | Risk | User sign-off needed? |
|---|---|---|---|
| 1 | sandbox → live via cp + mv -s52 (3 files) | Reversible | NO — author judgment after TSC clean |
| 2 | Commit to SoT git (parent Anti Gravity repo) | Reversible | NO |
| 3 | `supabase db push` from `Dynamic Research/` | Adds new RLS-enabled table + view | **YES — DATA-label change** |
| 4 | Kill worker PID 50056 + Start-ScheduledTask `DynamicResearchWorker` | Brief daemon downtime (Scheduled Task auto-restarts) | **YES — AGENT BEHAVIOR change** |
| 5 | Smoke job (submit a tiny test research request) | Real cost ~$0.50-2 | **YES — cost** |

Steps 3, 4, 5 each require explicit user authorization. None of them in the original v4-FINAL overnight plan; this is morning execution under the user's "go" message after the overnight plan landed.

---

## Reviewer-fidelity record (per MRPF v2.2)

- Gemini's "What I saw" omitted executor.ts diff → it inferred M2 from §1 doc text rather than the actual log() call sites. Codex round-2 will have full source access via filesystem.
- Gemini's M1 hallucination matches the [[feedback_within_artifact_reviewer_blindspot]] + [[feedback_gemini_paste_truncation_hallucination]] pattern family: confidently asserting a missing-overload that was already fixed in prior-round work. Mitigation: every Gemini finding must be verified against live source before integration; this synthesis records the verification trail.
