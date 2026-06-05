# Codex GPT-5.5 (xhigh) — MERGE-Gate Sequential QA on Phase A SQL/Scripts v2

**Reviewer:** Codex GPT-5.5 with `model_reasoning_effort = "xhigh"` (`codex exec -s read-only`, detached PowerShell pattern)
**Date:** 2026-05-22 (S46)
**Wall-clock:** ~9 min (T+90s 134KB → T+3min 545KB → T+4.5min 2.5MB → T+7.5min idle → T+9min DONE, final 2.6MB)
**Topology:** MERGE-gate sequential QA on v2 (Gemini went first in parallel; Codex final on revision).

Codex grounded against actual project files (`Documentation/multi-tenancy-phase-a-plan.md`, existing migrations, Supabase CLI source on GitHub via web search). This is the same advantage that delivered 5 unique findings in the S45 DESIGN-gate review — here Codex again delivered findings Gemini did not surface.

---

## Codex Critical findings (block merge)

1. **Migration filename will be SKIPPED by `supabase db push`.** Supabase CLI's `ListLocalMigrations` filter requires `<digit-prefix>_<name>.sql`, not `<digit-prefix>-<name>.sql`. Existing migrations `20260511-...sql` / `20260514-...sql` used dashes but were applied via Studio (their comments admit this) — they never went through `supabase db push`. Phase A explicitly switched to `supabase db push` (Codex S45 M6), so the filename pattern matters now.
   - Citation: `sandbox/20260522-phase-a-multi-tenancy.sql:1`; Supabase CLI `ListLocalMigrations`: https://raw.githubusercontent.com/supabase/cli/main/pkg/migration/list.go
   - Recommendation: rename to `20260522_phase_a_multi_tenancy.sql` (or full 14-digit form). Align test 1's `version` check.

2. **Explicit `BEGIN; ... COMMIT;` in the migration file BREAKS Supabase CLI's atomicity.** Supabase CLI wraps the migration file's contents AND the `supabase_migrations.schema_migrations` insert in ONE implicit transaction via `ExecBatch`. Our explicit COMMIT closes our transaction early, so the migration-history insert happens in its own separate transaction. Net effect: if the history insert fails, our schema changes are still committed without the corresponding history row — silent "missing from history" desync.
   - Citation: `sandbox/20260522-phase-a-multi-tenancy.sql:58, 327`; Supabase CLI source: https://raw.githubusercontent.com/supabase/cli/main/pkg/migration/file.go
   - Recommendation: remove file-level `BEGIN`/`COMMIT`. Rely on `ExecBatch` atomicity.

3. **Bootstrap state file is NOT rollback-safe — idempotent rerun overwrites `created_user=true` with `created_user=false`, leaving the rollback script unable to know who created the auth.users row.** Scenario: first run creates user → `created_user=true` written. Second idempotent rerun (script runs again post-deploy, finds owner already there) → writes `created_user=false`. Now rollback reads state, sees `created_user=false`, leaves the user behind even though Phase A created it.
   - Citation: `sandbox/phase-a-bootstrap-primary-user.ts:122` (no-op exit overwrites state) and `:225` (final write); `Documentation/multi-tenancy-phase-a-plan.md:372` (rollback reads `created_user` flag)
   - Recommendation: make state file monotonic — if existing state file has `created_user=true` for the same user_id, preserve it on no-op reruns. Update Test 9 expectation accordingly.

## Codex Major findings (must address)

1. **`createUser` is NOT race-idempotent.** Two simultaneous bootstrap processes can both miss the user in `listUsers`, both call `createUser`. Supabase Auth's second call returns `user_already_exists` error code; current script exits with fail(2), instead of recovering.
   - Citation: `sandbox/phase-a-bootstrap-primary-user.ts:148, 172`; https://supabase.com/docs/guides/auth/debugging/error-codes
   - Recommendation: catch `createErr.code === "user_already_exists"`, re-run paginated lookup, set `createdUser=false`, continue to membership insertion.

2. **Test 7c logic is WRONG — does not actually test the cross-org bypass vector.** Current setup: insert sole owner in org A, then UPDATE organization_id to org B. After the move: org A has 0 members, 0 owners. Trigger explicitly permits zero-member orgs (`member_count = 0` → no exception). So the move SUCCEEDS, not raises — but the test asserts EXCEPTION. The test would fail in either direction depending on PG behavior.
   - Citation: trigger permits zero-member orgs at `sandbox/20260522-phase-a-multi-tenancy.sql:207, 255`; broken test setup at `sandbox/test-phase-a-migration.sh:397`
   - Recommendation: leave a non-owner member in org A BEFORE moving the owner. Then post-move org A has 1 member + 0 owners → trigger correctly raises. That's the actual bypass vector.

3. **Test 7d does NOT test the trigger — it passes via FK failure on the synthetic `gen_random_uuid()` user_id.** The trigger never fires; the FK to `auth.users(id)` fails first. Updating user_id to a REAL existing user wouldn't violate min-owner anyway (org still has 1 member + 1 owner).
   - Citation: `sandbox/test-phase-a-migration.sh:424, 432`
   - Recommendation: convert to DEFERRED-MANUAL (or remove). UPDATE user_id is not a real bypass vector against min-owner.

4. **`phase-a-rollback-primary-user.ts` script claimed by the plan + test does NOT EXIST.** v3 plan §6 specs the script. Test 11 deferred-manually references it. No file in sandbox or repo.
   - Citation: `Documentation/multi-tenancy-phase-a-plan.md:360`; `sandbox/test-phase-a-migration.sh:549`
   - Recommendation: create the script as specified in v3 §6, OR change Test 11/rollback docs to not claim coverage.

## Codex Minor findings (worth fixing)

1. **Test harness STILL uses `i.indkey[0]` in catalog checks at tests 0.6 and 5** even after the migration moved to `ANY(i.indkey)`.
   - Citation: `sandbox/test-phase-a-migration.sh:158, 269`
   - Recommendation: same `a.attnum = ANY(i.indkey)` pattern in tests.

2. **`jq` listed as a required binary in the dependency guard but never actually used.**
   - Citation: `sandbox/test-phase-a-migration.sh:41, 63`
   - Recommendation: drop `jq` from the guard.

## Codex on Gemini Critical-2 (engaging with rejection)

> "I agree with Claude's rejection. `INITIALLY IMMEDIATE` is the right default for Phase A because normal operations either insert an owner directly, add members to an org that already has an owner, or delete/update rows that should fail immediately if they orphan remaining members. The concrete multi-statement case that needs commit-time evaluation is an operator/admin owner swap that first removes the last owner and then adds a replacement in the same transaction; that can opt in with `SET CONSTRAINTS trg_organization_members_min_owner DEFERRED`. I do not see a Phase A required operation that `INITIALLY IMMEDIATE` breaks."

**Confirmed rejection of Gemini C2.** Codex validated the v3 §3 design decision.

## Codex confirmation of correctness

- v2 trigger rewrite correctly avoids NEW reference during DELETE / OLD reference during INSERT, while still evaluating BOTH old and new org_ids on UPDATE.
- listUsers pagination loop correctly handles the exactly-100-users edge case (requests next page before deciding user is absent).
- `code === "23505"` is the right shape for PostgREST duplicate-key errors via supabase-js.

---

## Claude's application decisions (v3 changes)

**APPLYING ALL 9 findings.** Codex's analysis is empirically grounded — every finding cites actual file:line + external source (Supabase CLI GitHub, Supabase docs). No structural disputes.

| # | Finding | Action |
|---|---|---|
| C1 | Migration filename dash→underscore | Rename to `20260522_phase_a_multi_tenancy.sql`; update test 1 version check |
| C2 | Remove BEGIN/COMMIT wrapping | Delete the file-level BEGIN; line and COMMIT; line |
| C3 | Monotonic state file | Read-before-write: if existing has `created_user=true` for same user_id, preserve it |
| M1 | createUser race recovery | Catch `user_already_exists`, re-fetch via pagination, set createdUser=false |
| M2 | Test 7c add non-owner member | Insert non-owner member to org A before owner move |
| M3 | Test 7d convert to DEFERRED-MANUAL | Remove from active matrix; document rationale |
| M4 | Create rollback script | New file `sandbox/phase-a-rollback-primary-user.ts` with state-file-aware logic per v3 §6 |
| m1 | Test catalog checks use ANY(indkey) | Same pattern in tests 0.6 and 5 |
| m2 | Drop jq dependency | Remove from guard |

---

## Files produced

- `sandbox/codex-review-phase-a-sql.md` (this synthesis)
- `sandbox/codex-review-phase-a-sql-raw.md` (full Codex output, 2.6MB; audit trail)
- v3 of: SQL migration, bootstrap TS, test bash, + NEW rollback script

Next: apply migration via `supabase db push`, run bootstrap, run 11-test matrix. Per Codex's dual review of v1 (S45 DESIGN) + v2 (S46 MERGE) the artifact is now ready for staging-clone application. Production push pending one full clean test cycle.
