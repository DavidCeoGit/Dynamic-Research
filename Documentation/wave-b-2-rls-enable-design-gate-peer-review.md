# Wave B-2 DESIGN-gate — sequential MRPF peer review synthesis

> **Artifact reviewed:** `Documentation/wave-b-2-rls-enable-design-gate.md` (currently at `sandbox/wave-b-2-rls-enable-design-gate.md` pending /promote).
> **Authored / synthesized:** 2026-06-01 UTC (S80).
> **MRPF classification:** Event Gate = DESIGN; Risk Labels = SECURITY + DATA; Severity Mode = NORMAL.
> **Topology:** Sequential per `~/CLAUDE.md` HARD RULE: Gemini round 1 → integrate to v2 → Codex round 1 → integrate to v3 → loop closure.
> **Outcome:** v3 ready for the Phase 1 → 2 user-gate.

---

## 0. TL;DR

- **9 total findings**, **all ACCEPTED**. 0 CRITICAL, 3 MAJOR (G-MAJ-1, G-MAJ-2, C-MAJ-1), 5 MINOR, 1 NIT.
- **No SECURITY-CRITICAL / DATA-CRITICAL STOP triggers.** No reviewer disagreement requiring tiebreaker.
- **Loop closed at v3** per S77/S79 mechanical-fix fidelity-skip precedent — all Codex round 1 findings resolved to deterministic text/SQL substitutions; no new code surface introduced.
- **Material design changes from Gemini:** scope expanded from "DROP DEFAULT" alone to "DROP DEFAULT + CHECK (organization_id IS NOT NULL)" (Option B in v1 §4.4). User to re-affirm at the Phase 1 → 2 gate (pre-auth was Option A wording).
- **Material design changes from Codex:** `SET LOCAL` → `SET` (real bug — would have shipped a no-op guard); INSERT-path inventory corrected to include `replay/route.ts`; catalog assertion added to B2-T7.5; CHECK-idempotency framed as intentional fail-loud.
- **Total MRPF cost this session:** ~$0.15-0.25 (Gemini ~$0.05 via 3-flash-preview fallback after 3-pro-preview capacity exhaustion; Codex ~$0.10-0.20).

---

## 1. Round 1 — Gemini (gemini-3-flash-preview)

**Capacity note:** Original target model `gemini-3-pro-preview` exhausted capacity at 10/10 retries (HTTP 429 `MODEL_CAPACITY_EXHAUSTED`). Fell back to `gemini-3-flash-preview` per `reference_ai_models_latest.md` alternates list. This is a one-line memory file update post-session: capacity exhaustion on the pro preview channel is observable and warrants documenting as a fallback procedure.

**Pass scope:** Long-context whole-codebase holistic read on **v1**. Workspace access permitted via Gemini CLI's file-read tooling. Output captured to `/c/tmp/wave-b-2-gemini-round-1-output.md`.

### 1.1 Findings + dispositions

#### G-MAJ-1 — Close the silent-NULL gap via Option B (CHECK constraint) — **ACCEPT**

- **Category:** SECURITY / DATA
- **Reviewer claim:** v1 §4.4 deferred SET NOT NULL to Phase C, leaving a "silent NULL" window where authenticated readers see an empty result for NULL-org rows and service-role still writes them. Recommend `ALTER TABLE … ADD CONSTRAINT … CHECK (organization_id IS NOT NULL)` in B-2 itself.
- **Author position:** ACCEPT. CHECK constraint is enforced at relation level (all roles, including service-role) without the SET-NOT-NULL semantic baggage. 44 existing rows are all non-NULL → validation succeeds in microseconds. Migration diff still 1 table / 1 file — within pre-auth bounds. Phase C will canonicalise via SET NOT NULL; both can coexist (over-determined, not erroneous).
- **Open dependency for user gate:** pre-auth scope §1.3 nominally authorised "DROP DEFAULT" only. Adopting CHECK is a small scope expansion. User explicitly re-affirms at Phase 1 → 2.
- **v2 integration:** new §4 in the migration SQL; v1 §4.4 rewritten as "RESOLVED — Option B adopted"; executive summary updated.

#### G-MAJ-2 — Correct B2-T11 idempotency assertion — **ACCEPT**

- **Category:** AGENT BEHAVIOR / TEST COVERAGE
- **Reviewer claim:** v1 wrote "DROP DEFAULT on already-dropped is no-op (PG raises 'column … does not have a default')" — wrong. PostgreSQL ≥ 15 `ALTER COLUMN … DROP DEFAULT` is silent and non-throwing when no default exists.
- **Author position:** ACCEPT. v1 text was incorrect. Documentation-fidelity bug.
- **v2 integration:** B2-T11 wording corrected; further refined by Codex C-MIN-3 (see §2.1.3).

#### G-MIN-1 — Verify Service-Role Audit Write via B2-T7.5 — **ACCEPT**

- **Category:** TEST COVERAGE / SECURITY
- **Reviewer claim:** Worker's ability to INSERT into RLS-enabled `audit_storage_writes` is a load-bearing assumption; deserves an explicit smoke test.
- **Author position:** ACCEPT. v1 implicitly relied on the B-1 design plus "service-role bypasses RLS" claim — explicit test makes the dependency observable + regression-detectable.
- **v2 integration:** B2-T7.5 added in §7. Codex C-MIN-2 then split it into B2-T7.5a + B2-T7.5b (see §2.1.2).

#### G-MIN-2 — Formalise 20260527 history-gap triage — **ACCEPT**

- **Category:** DOC QUALITY / ARCHITECTURE
- **Reviewer claim:** v1 §1.6 noted `20260527_plan_review_gate.sql` exists on disk but is not in `supabase_migrations.schema_migrations`. Recommend recording in DR memory.
- **Author position:** ACCEPT as action item. Memory file `feedback_studio_applied_migration_not_in_history.md` to be written post-B-2 (avoids the "supabase db push behaves unexpectedly on fresh clone" surprise).
- **v2 integration:** §8 R5 augmented with the action item.

#### G-NIT-1 — `COMMENT ON COLUMN` rewording — **ACCEPT**

- **Category:** DOC QUALITY
- **Reviewer claim:** Remove "DROP/dropped" redundancy.
- **Author position:** ACCEPT.
- **v2 integration:** comment now reads "transitional DEFAULT removed; CHECK NOT NULL constraint added" — captures the v2 design state simultaneously.

### 1.2 Gemini's R-area answers

- **R1 (Option A/B/C):** push to Option B.
- **R2 (idempotent ENABLE):** useful — no objection.
- **R3 (preflight stringency):** sufficient.
- **R4 (rollback completeness):** OK.
- **R5 (smoke-test coverage):** add B2-T7.5; clarify B2-T11.
- **R6 (worker daemon impact):** none.
- **R7 (test-coverage explicit answer):** YES.
- **R8 (verdict):** REQUEST_CHANGES (load-bearing finding: G-MAJ-1).

### 1.3 What Gemini saw (per the MRPF synthesis rule)

- v1 of the design doc (full read).
- B-1 migration `20260523_phase_b_auth_rls_helpers.sql` (full read).
- `agent/scripts/test-phase-b-rls.sh` (T10 + harness pattern).
- `frontend/app/api/queue/route.ts` (full read).
- Did NOT execute psql/SQL against the live DB. Treated the artifact's recorded live probe as live-state evidence.

---

## 2. Round 2 — Codex (codex exec -s read-only, gpt-5.5 default + xhigh reasoning)

**Pass scope:** Code-grounded pass on the Gemini-integrated **v2**. `codex exec -s read-only -C "<repo root>"` workspace access. Output captured to `/c/tmp/wave-b-2-codex-round-1-output.md`.

Codex was explicitly told (a) which 5 Gemini findings were already integrated into v2, (b) not to re-litigate them, and (c) to focus on the LATEST direction.

### 2.1 Findings + dispositions

#### C-MAJ-1 — `SET LOCAL` is a no-op under Supabase migration path — **ACCEPT**

- **Category:** OTHER / OPERATIONS (real correctness bug despite the "OTHER" label)
- **Reviewer claim:** v2 §5 used `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout`. Repo memory `feedback_set_local_in_supabase_migration_warns.md` + CLAUDE.md `§8` + newer migrations (`20260525`, `20260527`) all forbid `SET LOCAL` because it warns SQLSTATE 25P01 and has no effect outside an explicit transaction block. Replace with plain `SET`.
- **Author position:** ACCEPT. Cite chain is correct; my v2 introduced a known anti-pattern. This is a real correctness bug — without the fix, the intended `statement_timeout` guard on the §1 preflight `SELECT COUNT(*)` would not actually apply.
- **Severity assessment:** Codex labeled this MAJOR; concur. Could have shipped a benign warning + unenforced guard. No data risk; operational guard absent.
- **v3 integration:** `SET LOCAL` → `SET` everywhere in §5 and §6.2. Migration-header note updated.

#### C-MIN-1 — INSERT-path inventory incomplete — **ACCEPT**

- **Category:** DOC QUALITY / TEST COVERAGE
- **Reviewer claim:** v2 said `frontend POST /api/queue` is the only live INSERT path. Grep found a second: `POST /api/runs/[slug]/replay` at `replay/route.ts:180-184`, also explicitly writing `organization_id: orgId` from `getOrgContextDualPath()`. UI entry at `page.tsx:89`.
- **Author position:** ACCEPT. Documentation-fidelity bug. The replay INSERT is pre-B-2-compatible (writes org_id explicitly) so no safety implication, but the design's evidence was not exhaustive.
- **v3 integration:** §3.2, §4.3 safety table, and §5 migration header all updated to list both paths.

#### C-MIN-2 — B2-T7.5 does not prove `relforcerowsecurity = false` — **ACCEPT**

- **Category:** TEST COVERAGE / DOC QUALITY
- **Reviewer claim:** A successful service-role INSERT shows "privileged writer can write," not specifically that the catalog flag holds. If `relforcerowsecurity` ever got flipped to `true`, the test would still pass (because the postgres / service-role posture has its own bypass via BYPASSRLS). Add a direct catalog assertion.
- **Author position:** ACCEPT. Codex's distinction is correct — INSERT-succeeded ≠ catalog-flag-held.
- **v3 integration:** B2-T7.5 split into B2-T7.5a (INSERT) + B2-T7.5b (catalog SELECT expecting `t | f`).

#### C-MIN-3 — `ADD CONSTRAINT IF NOT EXISTS` not supported for CHECK on PG17 — **ACCEPT**

- **Category:** DOC QUALITY / OTHER
- **Reviewer claim:** v2 B2-T11 left an author-note about `IF NOT EXISTS`. Codex verified against PG17 docs that the syntax does NOT support `IF NOT EXISTS` for `ADD table_constraint`. Accept fail-loud (duplicate_object on direct psql replay; supabase db push skips applied migrations via history).
- **Author position:** ACCEPT. Mechanical wording resolution.
- **v3 integration:** B2-T11 reworded to explicitly accept the fail-loud `duplicate_object` (SQLSTATE 42710) on direct replay.

### 2.2 Codex's R-area answers + explicit verifications

- **Focus 1 (CHECK × immutable-trigger interaction):** held up. Non-NULL to non-NULL UPDATE does not synthesize an intermediate NULL state; a two-step `UPDATE … SET org_id = NULL` would be blocked by CHECK on statement 1.
- **Focus 2 (CHECK idempotency):** PG17 has no `ADD CONSTRAINT IF NOT EXISTS` for CHECK → C-MIN-3.
- **Focus 3 (§1 preflight idempotency):** OK; `v_null_count` SELECT trivial on 44 rows; protected by `SET statement_timeout` after C-MAJ-1 fix.
- **Focus 4 (`relforcerowsecurity` posture):** C-MIN-2 catches the missing direct catalog assertion.
- **Focus 5 (exhaustive INSERT-path grep):** C-MIN-1.
- **Focus 6 (`SET LOCAL` rule):** C-MAJ-1.
- **Focus 7 (DESIGN-gate readiness):** REQUEST_CHANGES at v2; v3 with all four fixes ready for user gate.

### 2.3 What Codex saw

- v2 of the design doc (full read).
- B-1 migration `20260523_phase_b_auth_rls_helpers.sql` (full read).
- Phase A migration `20260522_phase_a_multi_tenancy.sql` (relevant fragments around DEFAULT).
- `agent/scripts/test-phase-b-rls.sh` (T10 + JWT GUC pattern at T13).
- `frontend/app/api/queue/route.ts` (lines 1-165).
- `frontend/app/api/queue/[id]/route.ts` (lines 1-50).
- `frontend/app/api/runs/[slug]/replay/route.ts` (lines around 44, 180, 184).
- `frontend/app/runs/[slug]/page.tsx:89` (UI entry point for replay).
- `frontend/lib/auth.ts` (`getOrgContextDualPath()`).
- `agent/lib/storage-paths.ts:133` (`uploadWithAudit()` hook).
- `agent/lib/supabase.ts` (service-role client).
- Newer migrations `20260525_research_usage_telemetry.sql:30` + `20260527_plan_review_gate.sql:22` (for the `SET LOCAL` precedent).
- `supabase/config.toml:36` (Postgres major-17 pin).
- PostgreSQL 17 docs (ALTER TABLE syntax, SET statement, RLS).
- Supabase service-role troubleshooting doc (for BYPASSRLS posture).
- Did NOT execute psql against the live DB (`DATABASE_URL` was unset in Codex's sandbox env); treated the artifact's §1 probe as live-state evidence.

---

## 3. Sequential round closure rationale

Per S77 mechanical-fix fidelity-skip precedent (also reapplied at S79): when reviewer round N's findings are all mechanical text/SQL substitutions with no new code surface for adversarial critique, the loop can close at the integrated v(N+1) instead of running a redundant round (N+1).

**C-MAJ-1** is a `SET LOCAL` → `SET` substitution (one-word swap at 2 sites).
**C-MIN-1** is documentation correction (add a known file path).
**C-MIN-2** is adding a `SELECT relrowsecurity, relforcerowsecurity FROM pg_class` assertion (one-line SQL).
**C-MIN-3** is reframing the B2-T11 wording.

None of these introduce new logic surface that a subsequent reviewer could adversarially analyse. The author integration is mechanical fidelity, not interpretation. **Loop closed at v3.**

This precedent is dogfood-validated across S77, S78, and S79 of this project — three prior MERGE-gate rounds where the same closure rule applied without later regret.

---

## 4. Disagreement procedure — N/A this round

Both reviewers REQUEST_CHANGES at their respective rounds; no disagreement between reviewers (Gemini saw v1; Codex saw v2 with Gemini's findings integrated). Standard synthesis applies — every finding's disposition recorded above; no third-model tiebreaker invoked.

---

## 5. Test-coverage explicit answer (MRPF HARD RULE for SECURITY/DATA-labeled work)

**Q:** Is this change covered by automated tests, and if not, why?

**A:** YES (post-v3). The B-2 migration is covered by **12 distinct smoke tests** (B2-T1 through B2-T11, with T7.5 split into a/b) defined in §7 of the design. The tests cover:

- Migration history recording (B2-T1)
- DEFAULT removal (B2-T2)
- CHECK constraint installation (B2-T2.5)
- RLS state on all 5 tables (B2-T3, B2-T7.5b)
- Positive tenant-isolation (B2-T4, B2-T7)
- Negative tenant-isolation (B2-T5, B2-T6)
- Service-role audit write path (B2-T7.5a)
- Worker daemon polling unaffected (B2-T8)
- CHECK constraint blocks NULL INSERT (B2-T9)
- Preflight assertion (B2-T10)
- Idempotency posture (B2-T11)

The harness will live at `agent/scripts/test-phase-b-2.sh` (or extend `test-phase-b-rls.sh` with a `b2-postmerge` mode). Implementation is Phase 2 work, but the test plan is binding.

**Caveat:** smoke tests only fire post-apply. A pre-apply dry-run of the migration in a staging clone is recommended but out of pre-auth scope.

---

## 6. Cost summary

| Round | Model | Approx tokens | Approx cost |
|---|---|---|---|
| Gemini round 1 (3-flash-preview fallback after 3-pro-preview capacity exhaustion) | `gemini-3-flash-preview` | ~25K in / ~3K out | ~$0.02–0.05 |
| Codex round 1 (xhigh reasoning + workspace read) | `gpt-5.5` | 242,721 (reported) | ~$0.10–0.20 |
| Author integration time (v1 → v2 → v3 edits) | n/a | n/a | $0 (local) |
| **Total MRPF cost this DESIGN-gate** | | | **~$0.12–0.25** |

Well below the pre-auth $2.00 early-warning + $3.00 hard ceiling.

---

## 7. Artifacts produced

- `Documentation/wave-b-2-rls-enable-design-gate.md` v3 (this DESIGN gate; currently in `sandbox/`)
- `Documentation/wave-b-2-rls-enable-design-gate-peer-review.md` (this synthesis; currently in `sandbox/`)
- (No SQL written yet — Phase 2 work, post user-gate.)

---

## 8. Recommendation for the Phase 1 → 2 user-gate

**Recommend:** "yes" — proceed to Phase 2 (MERGE-gate). The design is internally consistent at v3; both reviewers' findings have been mechanically integrated; no STOP triggers fired.

**One scope-affirmation question** for the user:

> The pre-auth scope §1.3 named "DROP DEFAULT" only. Gemini's G-MAJ-1 expanded scope to also include `ADD CONSTRAINT … CHECK (organization_id IS NOT NULL)` (Option B in v1 §4.4). Both changes still touch only the `research_queue` table and still fit in 1 migration file — within all pre-auth STOP-trigger bounds — but the scope is wider than the literal "DROP DEFAULT" wording.
>
> **Confirm: proceed with Option B (DROP DEFAULT + CHECK constraint)?** Or revert to Option A (DROP DEFAULT only, defer all NULL guarding to Phase C)?

If "Option B confirmed" → Phase 2 writes the SQL exactly as in §5 of the design; sequential MRPF MERGE-gate runs on the SQL; smoke-tests run post-apply; bundle commit.

If "revert to Option A" → strip §4 from the migration, drop B2-T2.5 + B2-T9 (CHECK-related), re-run minimal Codex round 2 on the trimmed SQL (the strip-out is a structural change, not a mechanical fix), then Phase 2.
