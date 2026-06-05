# Wave B-2 MERGE-gate — sequential MRPF peer review synthesis

> **Artifact reviewed:** `supabase/migrations/20260602_phase_b_2_rls_enable.sql` (currently at `sandbox/20260602_phase_b_2_rls_enable.sql` pending /promote).
> **Authored / synthesized:** 2026-06-02 UTC (S80 Phase 2).
> **MRPF classification:** Event Gate = MERGE; Risk Labels = SECURITY + DATA; Severity Mode = NORMAL.
> **Topology:** Sequential per `~/CLAUDE.md` HARD RULE for MERGE gate fresh code/SQL: Gemini round 1 → integrate to v2 → Codex round 1 → integrate to v3 → loop closure.
> **Outcome:** v3 is **SQL-ready** but apply is **BLOCKED on Codex C-MAJ-1** (pending user authorization on `supabase migration repair` for the unrecorded `20260527_plan_review_gate.sql`).

---

## 0. TL;DR

- **6 total findings**, **all ACCEPTED**. 0 CRITICAL, 1 MAJOR (Codex C-MAJ-1, BLOCKING on apply not SQL), 4 MINOR, 1 NIT.
- **The B-2 SQL itself is structurally sound.** Both reviewers concur on the structural shape; minor edges polished.
- **C-MAJ-1 blocks the apply step**, not the SQL. The local-disk `supabase/migrations/20260527_plan_review_gate.sql` is NOT in the remote `supabase_migrations.schema_migrations` history (it was applied via Studio per the standing pattern). Running `supabase db push --linked` would attempt to apply BOTH `20260527` AND `20260602`. This trips the pre-auth STOP trigger "Migration diff exceeds 1 migration file + 2 documentation files (refactor creep)".
- **HARD PAUSE pending user input** on the reconciliation method (see §6).
- **Total MRPF MERGE-gate cost this session:** ~$0.15–0.25 (Gemini ~$0.05; Codex ~$0.10–0.20).

---

## 1. Round 1 — Gemini (gemini-3-flash-preview)

Same fallback model as the DESIGN-gate (3-pro-preview hit capacity exhaustion 10/10 at S80 start). Output captured to `/c/tmp/wave-b-2-merge-gate-gemini-output.md`.

### 1.1 Findings + dispositions

#### G-MIN-1 — Design doc §6.2 rollback still had `SET LOCAL` — **ACCEPT**

- **Category:** FIDELITY / OPS
- **Reviewer claim:** v1 of the migration SQL got `SET LOCAL → SET` correctly (per DESIGN-gate Codex C-MAJ-1), but the design doc's §6.2 rollback snippet was missed in the integration. Both surfaces should use plain `SET`.
- **Author position:** ACCEPT. Documentation-fidelity sync. Mechanical fix.
- **v2 integration:** design doc §6.2 updated to plain `SET lock_timeout = '5s';` + comment line citing C-MAJ-1 / G-MIN-1.

#### G-MIN-2 — Preflight §1 omitted `audit_storage_writes` — **ACCEPT**

- **Category:** SECURITY / COMPLETENESS
- **Reviewer claim:** §1 of the SQL preflight only checked 4 tables; the B-2 design's "tenant-boundary perimeter" is 5 tables (the 4 Phase-A + audit_storage_writes). For defense-in-depth, the preflight should verify the entire perimeter.
- **Author position:** ACCEPT. Audit table's RLS was enabled at create-time (B-1 §6), so today's prod state passes either way — but a future regression that DISABLEs RLS on audit_storage_writes should still fail-fast.
- **v2 integration:** SQL §1 `IN (…)` list expanded to 5 tables.

#### G-NIT-1 — Comment date / constraint name enrichment — informational, no action

- **Category:** DOC QUALITY
- **Reviewer claim:** §5 `COMMENT ON COLUMN` correctly used `2026-06-02` (file creation date) + explicit constraint name `research_queue_org_id_not_null`. Approve as authorial improvement over the v3 design skeleton which used `2026-06-01`.
- **Author position:** Note + no change required.

### 1.2 Gemini's verdict

- **Overall:** APPROVE
- **Fidelity to design v3:** PASS — all 9 DESIGN-gate findings carried through correctly.
- **Test-coverage answer:** YES (smoke harness in §7 is in scope; implementation is Phase 2.7 work).
- **Most load-bearing finding:** §4 CHECK constraint (the actual structural advance of B-2).

### 1.3 What Gemini saw

- v1 of the migration SQL (full read).
- `sandbox/wave-b-2-rls-enable-design-gate.md` v3 (full read).
- `sandbox/wave-b-2-rls-enable-design-gate-peer-review.md` (DESIGN-gate synthesis).
- Reference migrations: `20260522`, `20260523`, `20260525`, `20260527`.
- `agent/scripts/test-phase-b-rls.sh` (for the smoke harness reference).
- Did NOT execute psql against the live DB.

---

## 2. Round 2 — Codex (codex exec -s read-only, gpt-5.5 + xhigh reasoning)

Workspace-grounded code-walk on the Gemini-integrated v2 SQL. Output captured to `/c/tmp/wave-b-2-merge-gate-codex-output.md`. Codex was explicitly told that G-MIN-1 + G-MIN-2 were already integrated and to focus on the latest direction.

### 2.1 Findings + dispositions

#### C-MAJ-1 — `20260527` migration history gap makes `supabase db push --linked` not B-2-only — **ACCEPT — BLOCKING on apply, not SQL**

- **Category:** Deployment / migration ordering
- **Reviewer claim:** `supabase/migrations/20260527_plan_review_gate.sql` exists on disk + mutates `research_queue` at lines 67-82 of that file. Live history (per design doc §1.6) only shows `20260522`, `20260523`, `20260525`. `supabase db push --linked` will try to apply `20260527` first, then `20260602` — TWO migrations applied instead of one. Out-of-scope DDL + locks the worker (mid-job) would have to wait for.
- **Author position:** ACCEPT — but the SQL itself does not need to change. Codex confirms "B-2 SQL itself is otherwise structurally sound." The blocker is the apply workflow, not the artifact.
- **Pre-auth STOP-trigger impact:** YES. "Migration diff exceeds 1 migration file + 2 documentation files (refactor creep)" fires if we apply via the naive `supabase db push --linked` path.
- **Resolution paths (presented to user, see §6):**
  - **Path A (recommended):** `supabase migration repair --status applied 20260527` — marks the file as applied in remote history without running it. Safe because the file's DDL IS already applied (verified live: worker log shows `[plan-review] audit-persist ok: 6 rows written to plan_reviews` on 2026-06-01, proving the `plan_reviews` table exists; and `20260527`'s columns/indexes on `research_queue` should be present too — psql probe recommended before repair). Then `supabase db push --linked` applies ONLY `20260602`.
  - **Path B:** Apply `20260602` directly via psql, bypassing `supabase db push`. Have to manually insert the history row. Per CLAUDE.md §8 the apply-via-CLI path is the canonical "atomic" deployment surface and bypassing it is discouraged.
  - **Path C:** Defer Phase 2 to a future session; first do an "S81 history reconciliation" session focused on `20260527` (and any other studio-applied files); then return to B-2 in S82.
- **v3 integration:** None needed in the SQL. Documented in this synthesis + HARD PAUSE raised to the user.

#### C-MIN-1 — Preflight not schema-qualified — **ACCEPT**

- **Category:** Preflight correctness
- **Reviewer claim:** `WHERE relname IN (…) AND relkind = 'r'` would over-match (table with same name in a different schema) or under-match (table missing entirely). Use `to_regclass('public.<name>')` instead.
- **Author position:** ACCEPT. Defensive-coding improvement. Missing-table is now a fail-loud case too.
- **v3 integration:** §1 SQL rewritten with `to_regclass()`-based loop over the 5-element `v_perimeter` array. New `v_missing` accumulator. Two new RAISE branches: missing-table + disabled-RLS.

#### C-MIN-2 — `b2-postmerge` smoke mode not implemented — **ACCEPT**

- **Category:** Test readiness
- **Reviewer claim:** v2 migration header referenced `bash agent/scripts/test-phase-b-rls.sh b2-postmerge` as a post-apply test mode that does not exist in the harness (which only accepts `preflight|postmerge`).
- **Author position:** ACCEPT but resolve via documentation rather than harness expansion. Two options:
  - **(a)** Add the `b2-postmerge` mode to test-phase-b-rls.sh now (~100 lines of new shell code per design §7's 12 tests; introduces new code surface requiring its own review; pre-auth STOP trigger risk).
  - **(b)** Update migration comment to acknowledge the harness mode is a follow-up; run smoke tests inline at apply time via direct psql.
- **Decision:** (b). Keeps B-2 diff small (1 migration + 2 docs is the pre-auth bound). The smoke-test queries from §7 of the design are well-defined; running them inline is mechanically equivalent to running them via a script. A dedicated harness mode can ship in a separate commit after B-2.
- **v3 integration:** Migration header comment updated to point to "inline psql per design §7" with explicit acknowledgment of the C-MIN-2 acceptance.

### 2.2 Codex's verdict + explicit answers

- **Overall:** REQUEST_CHANGES (driven by C-MAJ-1; SQL itself APPROVE-able)
- **Test-coverage answer:** No — B-1 postmerge exists, B-2 smoke mode is not yet shipped as a harness. Inline execution is the accepted compromise.
- **Apply-ready (Y/N):** **N until the 20260527 migration-history gap is reconciled.** B-2 SQL itself is structurally sound.
- **Worker-collision risk:** Low but non-zero. ACCESS EXCLUSIVE locks short at 44 rows; `lock_timeout = '5s'` gives the right fail-fast posture. Apply during a worker idle/poll window; `NOT VALID` + `VALIDATE` not necessary at this scale.
- **Most load-bearing finding:** C-MAJ-1.

### 2.3 What Codex saw

- v2 of the migration SQL (post-Gemini integration).
- v3 of the design doc (full read).
- Phase A + B-1 + 20260525 + 20260527 migrations.
- `supabase/config.toml` (PG17 pin).
- `agent/scripts/test-phase-b-rls.sh` (full read; specifically the dispatch table to verify b2-postmerge absence).
- `frontend/app/api/queue/route.ts` + `frontend/app/api/runs/[slug]/replay/route.ts` + `frontend/app/api/queue/claim/route.ts`.
- `agent/types.ts` (for the worker's row shape).
- PostgreSQL 17 docs (ALTER TABLE syntax + SET behavior + RLS posture).
- Did NOT execute psql against the live DB.

---

## 3. Sequential round closure rationale

C-MIN-1 and C-MIN-2 are mechanical fixes (SQL rewrite using `to_regclass`; migration-comment text update). No new code logic introduced. Per S77/S79/S80-DESIGN precedent, no Codex round 2 is needed for these.

**C-MAJ-1 is NOT a SQL fix.** It is a workflow / operational concern that requires user input. Treating C-MAJ-1 as a "loop-closure mechanical fix" would be wrong — it's the only finding in this session that cannot be resolved by author edits alone.

**Loop closed at v3 for the SQL artifact.** Apply step paused on C-MAJ-1.

---

## 4. Disagreement procedure — N/A

Both reviewers REQUEST_CHANGES at their respective rounds (Gemini saw v1, Codex saw v2). All findings ACCEPTED. No third-model tiebreaker invoked. No SECURITY-CRITICAL or DATA-CRITICAL findings.

---

## 5. Test-coverage explicit answer (MRPF HARD RULE)

**Q:** Is this change covered by automated tests, and if not, why?

**A:** Partially. The B-1 post-merge tests (`test-phase-b-rls.sh postmerge`) verify the policies, helpers, and triggers that B-2 inherits; they must not regress after B-2 applies (they are run as a pre-flight verification). The B-2-specific 12 tests (B2-T1 .. B2-T11) defined in design §7 are runnable inline via psql for this session. A dedicated `b2-postmerge` mode in the harness is a follow-up. **Inline execution is acceptable for this session.** A regression-detection automation layer is recommended within ~2 weeks.

---

## 6. HARD PAUSE — Codex C-MAJ-1 user-gate

The B-2 SQL is reviewed and approved. **Apply is blocked** on reconciling the unrecorded `20260527_plan_review_gate.sql`.

**Recommended path:** `supabase migration repair --status applied 20260527`.

- **Pre-condition to verify before repair:** psql probe confirming the schema mutations in `20260527` are already present in production (e.g. `plan_reviews` table exists + indexes on `research_queue` from `20260527` §2 are present). The worker-log evidence at 2026-06-01 20:56:40 ("[plan-review] audit-persist ok: 6 rows written to plan_reviews") proves `plan_reviews` exists. Index existence still needs verification.
- **Safety posture:** `supabase migration repair --status applied <version>` only inserts a row into `supabase_migrations.schema_migrations`. It does NOT execute any DDL. So if the underlying schema is already in the target state (verified), the operation is structurally a no-op + a history-row insert. Worker-impacting? No — the schema_migrations table is meta, not in any policy.

**Alternative paths described in §2.1 C-MAJ-1.**

---

## 7. Cost summary

| Round | Model | Approx tokens | Approx cost |
|---|---|---|---|
| Gemini MERGE-gate round 1 | `gemini-3-flash-preview` | ~30K in / ~3K out | ~$0.02–0.05 |
| Codex MERGE-gate round 1 (xhigh reasoning) | `gpt-5.5` | 117,451 (reported) | ~$0.10–0.20 |
| Author integration (v1 → v2 → v3 edits) | n/a | n/a | $0 |
| **Total MERGE-gate cost this session** | | | **~$0.12–0.25** |

Cumulative S80 MRPF total (DESIGN + MERGE): **~$0.24–0.50**. Still well below pre-auth $2.00 early-warning / $3.00 ceiling.

---

## 8. Artifacts produced

- `supabase/migrations/20260602_phase_b_2_rls_enable.sql` v3 (currently `sandbox/`)
- `Documentation/wave-b-2-rls-enable-design-gate.md` v3 + .meta (DESIGN-gate)
- `Documentation/wave-b-2-rls-enable-design-gate-peer-review.md` + .meta (DESIGN-gate synthesis)
- `Documentation/wave-b-2-rls-enable-merge-gate-peer-review.md` + .meta (this MERGE-gate synthesis)

All four files staged in `sandbox/` pending /promote (which requires C-MAJ-1 resolution + user approval first).

---

## 9. Recommendation

**Recommend the user choose Path A (`supabase migration repair --status applied 20260527`)** because:

1. The schema mutations from `20260527` are already in production (worker writes to `plan_reviews` succeed — observed in worker log).
2. Repair-mark-applied is structurally safe: it only inserts a `schema_migrations` row, no DDL runs.
3. Stays within the pre-auth "1 migration file + 2 docs" bound for B-2: after repair, `supabase db push --linked` applies ONLY `20260602`.
4. Sets the right pattern for any other studio-applied migrations: reconcile via the documented CLI command, don't silently work around it.

**Alternative paths** (B = direct psql apply, C = defer to S81 reconciliation session) are still on the table — both fully resolve C-MAJ-1 with different scope/cost trade-offs.
