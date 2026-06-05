# Phase B-1 SQL — MERGE-gate Peer Review Synthesis (S49)

**Date:** 2026-05-23
**Trigger:** Multi-Reviewer Policy Framework HARD RULE in `~/CLAUDE.md` — MERGE gate, fresh code, SEQUENTIAL topology (Gemini first → revise → Codex on revised v2).
**Reviewers:**
- **Gemini Deep Think** (web app, manual paste) — see `sandbox/gemini-review-phase-b-sql.md`
- **Codex GPT-5.5 + xhigh reasoning** (`codex exec -s read-only`, detached headless, CODE-GROUNDED slot, ran against v2) — see `sandbox/codex-review-phase-b-sql.md` + raw output at `-raw.md`
- **Claude Opus 4.7 (1M)** — SQL author. v1 in sandbox (overwritten in place by v2); v2 in sandbox after Gemini-finding apply.

**Artifact under review:** `sandbox/20260523_phase_b_auth_rls_helpers.sql` (v2 at time of Codex; vN at synthesis close)
**Test harness:** `sandbox/test-phase-b-rls.sh` (matched-version)

**What each reviewer saw:**
- **Gemini:** the Phase B-1 SQL v1 + test harness v1 + Phase A schema excerpt in the paste-file (`sandbox/gemini-review-phase-b-sql-paste.md`, 892 lines). No live repo access.
- **Codex:** the v2 SQL + v2 test harness + Gemini's verbatim review + Phase A migration + live repo (worker, executor, API routes, frontend lib). Code-grounded slot per v2.1 framework.

---

## 1. Gemini findings — apply log (v1 → v2)

| # | Severity | Finding | v2 action | Rationale |
|---|---|---|---|---|
| C1 | CRITICAL | ACCESS EXCLUSIVE lock on `ALTER TABLE ... ADD CONSTRAINT UNIQUE` | **DEFER with documented rationale** | Current state: 1 row in `organization_members` → lock duration sub-millisecond. No live auth flow against this table yet (Phase B-2 not applied, frontend SSR refactor not landed). Production downtime Gemini warns about does not materialize at this scale. Additionally: CREATE INDEX CONCURRENTLY is incompatible with Supabase CLI ExecBatch transaction wrap (S46 C2 hard rule) — switching paths would require applying via direct psql with manual history insert. Future scaling path documented in `sandbox/20260523_phase_b_auth_rls_helpers.sql` §2 header comment block. |
| C2 | CRITICAL | Test harness script truncation at line 91 | **DISMISS as hallucination** | Disk file is 716 lines and ends correctly at `exit 0`. Either Gemini's input got truncated mid-paste or Gemini hallucinated the truncation. Direct evidence: `wc -l sandbox/test-phase-b-rls.sh = 716`; tail shows `case ... esac; echo Total ...; exit 0`. Bash syntax validated with `bash -n` clean. |
| M1 | MAJOR | Correlated subqueries force per-row SubPlan instead of InitPlan | **ACCEPT** | Replaced parameterized `auth_user_is_org_owner(target_org_id uuid)` with parameterless `auth_user_is_owner()`. Refactored every policy body in §5 + asw_select in §6 to `(select private.auth_user_is_owner()) AND <col> = (select private.auth_user_organization_id())` pattern. Semantically equivalent to v1 under UNIQUE(user_id) constraint; Postgres compiles parameterless `(select ...)` subqueries as InitPlan (O(1) per query) vs correlated form's SubPlan (O(N) per row). Test harness T4b/T5b/T6c/T6d updated to match new signature; added T5c for the trigger-fn search_path lock. |
| M2 | MAJOR | Audit log FK `ON DELETE SET NULL` orphans rows + breaks asw_select RLS | **ACCEPT** | Changed both `audit_storage_writes.organization_id` and `.research_queue_id` FKs from `ON DELETE SET NULL` to `ON DELETE RESTRICT`. Made `organization_id` `NOT NULL`. Forensic immutability is the primary purpose of an audit log; forcing admin tooling to explicitly handle audit data before deleting an org or queue row is the right operational posture. Org deletion is service-role only and rare; research_queue rows are not deleted in normal operation (status changes instead). Test harness T11e + T11f added to verify. |
| m1 | MINOR | `private.research_queue_immutable_org_id()` trigger fn lacks `SET search_path` | **ACCEPT** | Added `SET search_path = private, public, pg_temp` to the trigger function. Defense-in-depth against future modifications that introduce unqualified queries. Test harness T5c added to verify. |
| SCOPE | n/a | Single-tenancy via DB constraint is technical debt | **ACKNOWLEDGE** | Already documented in v3 plan §1.2 N2 as intentional v1 beta scope. If v2 ever relaxes "one membership per user," the parameterless helper `auth_user_is_owner()` would need to be re-parameterized and the (select ...) wrap would need a different optimization strategy. Tracked. |

---

## 2. Codex findings on v2 (sequential second pass) — verdict + drift check

**Codex verdict on v2:** REQUEST CHANGES (0 CRITICAL, 2 MAJOR, 1 minor). Captured at `sandbox/codex-review-phase-b-sql.md` + raw output at `-raw.md` (4.4 MB, ~9600 lines including reasoning trace).

### 2.1 Gemini-finding fidelity check (per Codex)
| Item | Status | Codex evidence |
|---|---|---|
| Gemini M1 (parameterless helper refactor) | **APPLIED** | v2 removed parameterized `auth_user_is_org_owner(uuid)`; policies + grants use parameterless helpers at SQL:242, :279, :456. Codex confirmed semantic equivalence under `UNIQUE(user_id)` and confirmed the scalar `(select private.helper())` form is non-correlated → InitPlan-eligible even across the `OR` boundary in `om_select`. |
| Gemini M2 (audit FK ON DELETE RESTRICT + NOT NULL org_id) | **APPLIED** | Both audit FKs are `ON DELETE RESTRICT` at SQL:414; `organization_id` is `NOT NULL`. Codex grepped the live repo and confirmed NO current queue-cleanup script that DELETEs `research_queue` rows, so the RESTRICT posture does not block any existing operational path. Codex flagged future queue retention as a forward-compat concern (acknowledged out-of-scope for v1). |
| Gemini m1 (trigger fn search_path lock) | **APPLIED** | All three SECURITY DEFINER functions lock `search_path`: helpers at SQL:139 + :162; trigger function at SQL:197. |
| Gemini C1 deferral (ACCESS EXCLUSIVE on UNIQUE) | **VALID** | Codex independently verified `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block + found no supported Supabase migration no-transaction directive in this repo. With 1 current member row the DDL is tiny; Codex recommended adding a short `lock_timeout` for clearer failure during production deploys (adopted in v3 §0). |
| Gemini C2 dismissal (test harness "truncation") | **VALID** | Codex confirmed harness present through `exit 0` at line 758. Gemini's truncation finding was hallucinated. |

### 2.2 New findings raised by Codex on v2
| # | Severity | Finding | Resolution (v3) |
|---|---|---|---|
| Codex M1 | MAJOR | `orgs_update` permits owners to UPDATE any row column once Phase B-2 enables RLS, including `slug` (Phase A treats as immutable infrastructure identity per migration line 80), `id`, and `created_at`. RLS WITH CHECK can't compare NEW vs OLD, so the policy alone can't constrain. | **ACCEPT — add BEFORE UPDATE trigger** at SQL §5.5: `private.organizations_immutable_columns()` blocks NEW vs OLD changes to `id`, `slug`, `created_at`; `name` UPDATE remains permitted. Fires for both service-role and authenticated callers. Test harness T15a/b/c/d added to verify each blocked column + `name` permitted control case; T16 verifies search_path lock on the new function. |
| Codex M2 | MAJOR | T13 test harness defects: (1) `SET LOCAL ROLE authenticated` is applied BEFORE `ALTER TABLE DROP CONSTRAINT`, but `authenticated` lacks ALTER privileges — would fail with `insufficient_privilege` not exercise the helper; (2) GUC name should be the dot-path `request.jwt.claim.sub`, not `request.jwt.claims` JSON form (both work via Supabase auth.uid() coalesce, but dot-path is unambiguous). | **ACCEPT — reorder + dot-path + PRECHECK**. T13 now: (a) DDL + data setup runs FIRST under default postgres/owner role; (b) `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '<uuid>'` applied immediately BEFORE the helper call; (c) PRECHECK assertion that `auth.uid()` resolves to expected user, so misbinding fails as `PRECHECK FAIL` instead of silently passing. |
| Codex m1 | MINOR | `.meta` `patch_summary` referenced "716 lines" (stale; harness was 758 at v2 review time). | **ACCEPT — remove line-count refs from .meta** (any number rapidly goes stale across iterative edits). |

### 2.3 Code-grounded checks Codex performed (verified vs live repo)
| Check | Codex result |
|---|---|
| Phase A schema cross-check (table/column names match) | PASS — all referenced tables exist with expected columns; new UNIQUE(user_id) does not conflict with existing composite PK on (organization_id, user_id). |
| `auth.uid()` semantics under SECURITY DEFINER context | PASS — Supabase confirms SECURITY DEFINER does NOT strip caller JWT GUCs; `auth.uid()` returns NULL only when unauthenticated. The helper pattern is sound. |
| `SET search_path` lockdown vs Supabase platform expectations | PASS — `search_path = private, public, pg_temp` is fine because all `auth.uid()` calls inside the helpers are schema-qualified. |
| `current_setting('app.allow_org_migration', true)` behavior under PgBouncer | PASS — `SET LOCAL` is transaction-scoped and works correctly under PgBouncer transaction-pooling mode. (Codex noted: avoid plain `SET` for this escape hatch — only the `LOCAL` variant is safe.) |
| `(select private.helper())` InitPlan caching across OR boundaries | PASS — the OR in `om_select` does NOT make the helper calls correlated; both `(select ...)` subqueries are eligible for InitPlan optimization. |
| Live worker compatibility (no UPDATE breakage from immutable-org_id trigger) | PASS — Codex grepped worker.ts + executor.ts + finalize-recovered-run.ts + regenerate-studio-products.ts; none mutate `research_queue.organization_id`. Trigger does not break any existing worker UPDATE path. |

### 2.4 Codex SCOPE DISPUTES (acknowledged, not blocking)
- SECURITY DEFINER + JWT GUCs: confirmed sound (no fix needed; clarification only).
- Helper `search_path` is fine because of schema-qualified `auth.uid()`.
- `SET LOCAL app.allow_org_migration = 'true'` is transaction-scoped + PgBouncer-safe; plain `SET` would be unsafe (documented in plan §2.3.5 + v3 SQL §4 header comment).

---

## 3. Resolved direction (v4 of SQL — harness unchanged after v3)

**SQL revision chain:** v1 → Gemini (REQUEST CHANGES) → v2 → Codex (REQUEST CHANGES, 2 MAJOR) → v3 → Codex QA (REQUEST CHANGES, 1 PARTIAL) → v4 → Codex QA (pending).

**Verdict on v4:** **APPROVE.** Codex v4 QA (~2 min, 53 KB output) confirmed: (a) scalar subquery raises `cardinality_violation` / SQLSTATE `21000` on 2+ rows; (b) equivalent to v3 in normal ops (0 rows → NULL; 1 row → that org_id); (c) T13 now exercises the fail-loud path; (d) no drift introduced; (e) RLS policies still get InitPlan caching because the outer `(select private.auth_user_organization_id())` wrap is unchanged. No T13 tweak required. **vN = v4. Ready to ship.**

### 3.1 SQL changes v2 → v3
1. NEW §0 — `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s';` at file top (Codex Recommendation: clearer failure on production deploys; SET LOCAL scopes to the implicit Supabase ExecBatch transaction wrap).
2. NEW §5.5 — `private.organizations_immutable_columns()` BEFORE UPDATE trigger function + `organizations_immutable_columns` trigger on `public.organizations`. Blocks NEW vs OLD mutation of `id`, `slug`, `created_at`. SET search_path locked. (Codex M1)

### 3.2 Test harness changes v2 → v3
1. T13 reordered — DDL+data setup runs FIRST as default postgres/owner role; SET LOCAL ROLE authenticated + SET LOCAL request.jwt.claim.sub applied immediately BEFORE the helper call; PRECHECK assertion on auth.uid() binding. (Codex M2)
2. T13 GUC switched from `request.jwt.claims` JSON to `request.jwt.claim.sub` dot-path. (Codex M2)
3. T15a/b/c/d NEW — verify organizations_immutable_columns trigger blocks slug + created_at + id UPDATE and PERMITS name UPDATE. (Codex M1)
4. T16 NEW — verify organizations_immutable_columns() has SET search_path locked. (Codex M1)

### 3.3 Codex QA on v3 — PARTIAL on v2 M2
| v3 QA item | Verdict | Detail |
|---|---|---|
| v2 M1 (orgs_update immutable columns) | APPLIED | Trigger blocks id+slug+created_at; name remains mutable; covers full Phase A surface. |
| v2 M2 (T13 role context) | **PARTIAL** | Ordering / GUC / PRECHECK are correct. **BUT:** `private.auth_user_organization_id()` is a `LANGUAGE sql` function returning scalar uuid; PostgreSQL SQL functions return the FIRST row on multi-row final query rather than raising `cardinality_violation` (PG docs §38). So even with the corrected T13 path, the helper silently picks one membership instead of fail-louding. The "NO LIMIT 1 = fail-loud" B1 design DOES NOT WORK with this function shape — needs scalar-subquery semantics. |
| v2 minor (.meta line count) | APPLIED | Line counts removed from .meta. |
| Fresh defects in v3 | None | The M2 PARTIAL is a pre-existing helper semantics issue surfaced by the corrected T13 path, not v3 drift. |

**Codex v3 QA recommendation (verbatim):** *"To preserve the intended T13 cardinality_violation, make auth_user_organization_id() return a scalar subquery, e.g. SELECT (SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid())."*

### 3.4 SQL changes v3 → v4 (single-issue fix)

```sql
-- v3 (broken — SQL function returns first row on multi-row, no cardinality_violation):
AS $$
  SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
$$;

-- v4 (correct — scalar subquery raises cardinality_violation on multi-row):
AS $$
  SELECT (
    SELECT organization_id FROM public.organization_members WHERE user_id = auth.uid()
  )
$$;
```

Behavior matrix:
| Inner SELECT rows | v3 (SQL function) | v4 (scalar subquery wrap) |
|---|---|---|
| 0 | NULL | NULL |
| 1 | that row's value | that row's value |
| 2+ | **first row (silent, wrong)** | **cardinality_violation (SQLSTATE 21000) — fail-loud, correct** |

`auth_user_is_owner()` is unchanged — it uses `SELECT EXISTS(...)` which always returns exactly one boolean row, no cardinality concern.

T13 harness unchanged after v3 — same code path now correctly exercises the fail-loud helper.

### 3.5 Empirical findings logged

The S49 MERGE-gate review chain caught 5 distinct issues across 4 SQL revisions through 3 review rounds (Gemini v1 → Codex v2 → Codex v3 QA). The most subtle catch — Codex v3 QA on the SQL-function-vs-scalar-subquery semantics — would have escaped a single-pass reviewer. Empirical support for the Multi-Reviewer Policy Framework v2.1 sequential MERGE-gate rule.

**To be added to [[research_compare_learnings]] at S49 close:**
- `pg_sql_function_vs_scalar_subquery_cardinality` — `LANGUAGE sql` functions returning a scalar do NOT raise cardinality_violation on multi-row final query; they return the first row. Use `SELECT (SELECT ...)` scalar-subquery wrapping to get fail-loud semantics. This is the relevant invariant any time a "single-row helper" relies on a uniqueness constraint and you want the helper to fail loud if the constraint is breached.
- `merge_gate_review_v3_qa_value` — v3 QA pass caught an issue v1 (Gemini), v2 review (Codex), and self-fidelity sweeps all missed. Sequential MERGE-gate review on revisions produces compounding catch rate, not diminishing returns.

---

## 4. Multi-Reviewer Policy Framework alignment (compliance log)

Per `~/CLAUDE.md` Multi-Reviewer Policy Framework v2.1:

- **Event Gate:** MERGE (fresh code).
- **Risk Labels:** SECURITY (RLS, auth context, security-definer helpers), DATA (DDL on production table, FK + constraint additions), AGENT BEHAVIOR (the immutable-org_id trigger affects worker UPDATE paths), INFRA (migration ships via Supabase CLI), ARCHITECTURE (helper signature design impacts all downstream policies).
- **Severity Mode:** NORMAL.
- **Review Topology:** SEQUENTIAL — Gemini (v1) → revise → Codex (v2). Per v2.1 MERGE-gate fresh-code rule.
- **Code-grounded preference:** Codex slot used the read-only repo access; Gemini used paste-only.
- **Disagreement procedure:** none required this round — Gemini found 2 CRITICAL + 2 MAJOR + 1 MINOR; v2 author resolved each with either ACCEPT or documented DEFER/DISMISS; Codex evaluated those resolutions in the sequential second pass.

---

## 5. Decision provenance + cross-memory links

This synthesis applies the following established patterns:
- [[feedback_multi_reviewer_gate_dependent_pattern]] — MERGE-gate fresh code is sequential, not parallel
- [[feedback_self_fidelity_sweep_before_qa]] — author grep sweep run between v1 and v2 (clean)
- [[feedback_supabase_db_push_filename_underscore]] — filename uses `_` separator
- [[feedback_supabase_db_push_no_begin_commit]] — no file-level BEGIN/COMMIT
- [[project_multi_reviewer_policy_framework_v2_shape]] — Event Gate × Risk Label × Severity Mode classification

**Empirical findings logged for [[research_compare_learnings]]:**
- [TBD post-Codex]

---

## 6. Next gate

**Decision: SHIP v4.**

1. `/promote` v4 sandbox files:
   - `sandbox/20260523_phase_b_auth_rls_helpers.sql` → `supabase/migrations/20260523_phase_b_auth_rls_helpers.sql`
   - `sandbox/test-phase-b-rls.sh` → `agent/scripts/test-phase-b-rls.sh`
   - `sandbox/multi-tenancy-phase-b-merge-gate-peer-review.md` → `Documentation/multi-tenancy-phase-b-merge-gate-peer-review.md`
2. `cd "Dynamic Research" && bash agent/scripts/test-phase-b-rls.sh preflight` (read-only, should pass clean: B-1 not yet applied + Phase A present + zero duplicate memberships).
3. `cd "Dynamic Research" && supabase db push --db-url "$DATABASE_URL"` — applies `20260523_phase_b_auth_rls_helpers.sql` to production via Supabase CLI ExecBatch wrap.
4. `bash agent/scripts/test-phase-b-rls.sh postmerge` (full 14-test grid).
5. Archive S49 review artifacts to `sandbox/validated/` with `-s49` suffix.
6. Commit + update handoff + close S49.
