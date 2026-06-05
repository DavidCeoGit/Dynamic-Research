# Wave B-2 (RLS enforce + DROP DEFAULT + CHECK NOT NULL) — DESIGN-gate v3

> **Status:** DESIGN-gate v3 (post-Codex round 1 integration; sequential MRPF loop closed at v3 per S77/S79 mechanical-fix fidelity-skip precedent). Authored 2026-06-01 UTC (S80).
> **Target migration:** `supabase/migrations/<YYYYMMDD>_phase_b_2_rls_enable.sql` (Phase 2 work).
> **Companion peer-review file:** `Documentation/wave-b-2-rls-enable-design-gate-peer-review.md` (forthcoming).
> **Predecessor:** B-1 — `supabase/migrations/20260523_phase_b_auth_rls_helpers.sql` (S46–S49).
> **Successor:** Phase C — SET NOT NULL on `research_queue.organization_id` (deferred; CHECK constraint here is the bridge).

> ### v1 → v2 changelog (Gemini round 1 — 5 findings, all ACCEPTED)
>
> - **G-MAJ-1 ACCEPT**: adopted **Option B** (CHECK constraint `organization_id IS NOT NULL`) over Option A. Closes the silent-NULL gap immediately for all roles including service-role; still 1 migration / 1 table; cheaper than SET NOT NULL (no table-rewrite semantic). §4.4 + §5 + §8 R1 + executive summary updated.
> - **G-MAJ-2 ACCEPT**: corrected the B2-T11 assertion in §7. PostgreSQL `ALTER COLUMN ... DROP DEFAULT` is natively idempotent (silent success when no default exists; never raises). Original text claimed it raises — wrong.
> - **G-MIN-1 ACCEPT**: added **B2-T7.5** in §7 — explicit service-role INSERT against `audit_storage_writes` to verify `relforcerowsecurity = false` bypass posture.
> - **G-MIN-2 ACCEPT**: §8 R5 now ends with an action item to record the `20260527_plan_review_gate.sql` shadow-state finding in DR memory once B-2 ships.
> - **G-NIT-1 ACCEPT**: §5 `COMMENT ON COLUMN` reworded to remove "DEFAULT dropped" redundancy.

> ### v2 → v3 changelog (Codex round 1 — 4 findings, all ACCEPTED; mechanical fixes)
>
> - **C-MAJ-1 ACCEPT**: replaced `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` with plain `SET …` in both §5 and §6.2. Memory [[feedback_set_local_in_supabase_migration_warns]] is canonical — `SET LOCAL` outside an explicit transaction block warns SQLSTATE 25P01 and has no effect; Supabase CLI's ExecBatch wraps the file in an implicit txn but the txn is closed when the migration completes, so the LOCAL scope evaporates immediately. Plain `SET` applies to the migration connection for its lifetime. Header note in §5 updated.
> - **C-MIN-1 ACCEPT**: §3.2 + §4.3 + §5 migration header now enumerate **both** live INSERT paths: `frontend/app/api/queue/route.ts:120-124` AND `frontend/app/api/runs/[slug]/replay/route.ts:180-184`. Both write `organization_id` explicitly. The original "only live INSERT path" wording was wrong; this is a documentation-correctness fix.
> - **C-MIN-2 ACCEPT**: B2-T7.5 split into two parts: (a) catalog assertion `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_storage_writes'::regclass` expecting `t | f` — directly proves the catalog posture; (b) the original service-role INSERT — proves the privileged write path. Both required for full coverage.
> - **C-MIN-3 ACCEPT**: PG17 has no `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints (verified against PG17 docs). B2-T11 wording updated to: ENABLE RLS and DROP DEFAULT are natively idempotent; ADD CONSTRAINT is intentionally fail-loud on direct psql replay (`duplicate_object` / SQLSTATE 42710 expected); `supabase db push` skips already-applied migrations via history, not via drift detection. Author-note about uncertainty removed.
>
> **Loop closed at v3.** All four findings are mechanical (single-word SET swap, doc-text corrections, test rewording). No new code surface for adversarial critique. Per S77/S79 precedent ("mechanical-fix fidelity-skip"), no Codex round 2 is run. Codex round 1 explicit verifications carried forward as v3 evidence: (a) **CHECK × immutable-org-trigger interaction held up** — non-NULL to non-NULL UPDATE does not synthesize an intermediate NULL state; a two-step `UPDATE … SET org_id = NULL; UPDATE … SET org_id = '<new>'` sequence would be blocked by the CHECK on statement 1, which is the intended behaviour; (b) **R1 (Option B) approach validated** by independent reviewer.

---

## Executive summary

Wave B-2 was originally scoped as **two structural changes**:

1. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on the 4 existing tenant-scoped tables (`research_queue`, `organization_members`, `organization_invitations`, `organizations`).
2. `ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT`.

**Live-DB probe at 2026-06-01 20:35Z reveals item (1) is already done.** `pg_class.relrowsecurity = true` on all 4 target tables — and on `public.audit_storage_writes` (already documented as ENABLED-at-create-time by B-1). The B-1 post-merge test harness (`agent/scripts/test-phase-b-rls.sh:524–531`) documented this pre-existing state at S49: RLS was flipped to `true` on the 4 tenant tables before B-1 applied (suspected origin: Supabase Studio default, an earlier session, or RLS-enabled defaults on Phase A `CREATE TABLE`). With B-1's 14 policies now in place, authenticated traffic is currently gated by them; service-role bypasses; the system has already been operating under "post-B-2" semantics for ~9 days.

**B-2 reduces to three changes plus belt-and-braces idempotency (v2: CHECK added per Gemini G-MAJ-1):**

- **C1** `ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT` — the actual remaining structural change from the original brief.
- **C2** `ALTER TABLE public.research_queue ADD CONSTRAINT research_queue_org_id_not_null CHECK (organization_id IS NOT NULL)` — closes the silent-NULL gap window for ALL roles (including service-role) without the table-rewrite semantics of `SET NOT NULL`. Gemini-driven addition (G-MAJ-1).
- **C3** Idempotent `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on the 4 tables — defense-in-depth no-op against the (low-probability) event that someone DISABLEd RLS between S49 and apply.
- **C4** Pre-flight `DO $$ … RAISE EXCEPTION IF NOT … $$` block that asserts the live state matches expectations before any DDL runs — fail-loud if pre-conditions drift.

The risk asymmetry is favourable: B-2 turns out to be smaller and safer than the original DESIGN brief assumed, the CHECK constraint adds cheap defense-in-depth, and the migration is structurally additive (DROP DEFAULT is reversible by re-applying `SET DEFAULT '<system-default-org-uuid>'::uuid`; CHECK is reversible by `DROP CONSTRAINT`).

**Scope-boundary note for the user re-affirmation at the Phase 1 → 2 gate:** v1 originally scoped DROP DEFAULT alone (Option A in v1 §4.4) per the S79 pre-auth wording. v2 integrates Gemini's Option B (add CHECK) into the migration. Either choice fits within "1 migration file + 1 target table" so neither is a pre-auth STOP-trigger, but the user should explicitly confirm Option B at the Phase 1 → 2 gate before Phase 2 begins.

---

## 1. Live-state inventory (truth at 2026-06-01 20:35Z)

All values captured against the production Supabase instance (project ref `mfjgoghlpqgxcycxoxio`) via `psql $DATABASE_URL`. Re-run before Phase 2 apply to confirm no drift.

### 1.1 `pg_class.relrowsecurity` on the 5 tables

| Table | `relrowsecurity` | `relforcerowsecurity` | Source of enable |
|---|---|---|---|
| `public.research_queue` | **`true`** | `false` | Pre-existing (S49 finding) |
| `public.organization_members` | **`true`** | `false` | Pre-existing (S49 finding) |
| `public.organization_invitations` | **`true`** | `false` | Pre-existing (S49 finding) |
| `public.organizations` | **`true`** | `false` | Pre-existing (S49 finding) |
| `public.audit_storage_writes` | **`true`** | `false` | B-1 §6 (ENABLE at create-time) |

`relforcerowsecurity = false` on all 5 means **table owners are not subject to RLS** — this is the standard configuration and is intentional. Service-role bypasses RLS via the standard `BYPASSRLS` attribute on the `service_role` role; `relforcerowsecurity` is a different mechanism (forces RLS to apply even to the table owner).

### 1.2 Policies installed (14 total) — pg_policies snapshot

| Table | Policy | Cmd | Role | USING | WITH CHECK |
|---|---|---|---|---|---|
| `research_queue` | `rq_select` | SELECT | `authenticated` | `organization_id = auth_user_organization_id()` | — |
| `research_queue` | `rq_insert` | INSERT | `authenticated` | — | `organization_id = auth_user_organization_id()` |
| `research_queue` | `rq_update` | UPDATE | `authenticated` | `organization_id = auth_user_organization_id()` | `organization_id = auth_user_organization_id()` |
| `research_queue` | `rq_delete` | DELETE | `authenticated` | `organization_id = auth_user_organization_id()` | — |
| `organization_members` | `om_select` | SELECT | `authenticated` | `user_id = auth.uid() OR (auth_user_is_owner() AND organization_id = auth_user_organization_id())` | — |
| `organization_members` | `om_insert` | INSERT | `authenticated` | — | `organization_id = auth_user_organization_id() AND auth_user_is_owner()` |
| `organization_members` | `om_update` | UPDATE | `authenticated` | `auth_user_is_owner() AND organization_id = auth_user_organization_id()` | (same) |
| `organization_members` | `om_delete` | DELETE | `authenticated` | `auth_user_is_owner() AND organization_id = auth_user_organization_id()` | — |
| `organization_invitations` | `oi_select` | SELECT | `authenticated` | `auth_user_is_owner() AND organization_id = auth_user_organization_id()` | — |
| `organization_invitations` | `oi_insert` | INSERT | `authenticated` | — | `organization_id = auth_user_organization_id() AND auth_user_is_owner()` |
| `organization_invitations` | `oi_delete` | DELETE | `authenticated` | `auth_user_is_owner() AND organization_id = auth_user_organization_id()` | — |
| `organizations` | `orgs_select` | SELECT | `authenticated` | `id = auth_user_organization_id()` | — |
| `organizations` | `orgs_update` | UPDATE | `authenticated` | `auth_user_is_owner() AND id = auth_user_organization_id()` | (same) |
| `audit_storage_writes` | `asw_select` | SELECT | `authenticated` | `auth_user_is_owner() AND organization_id = auth_user_organization_id()` | — |

Default-deny by absence of policy applies for:

- `organization_invitations.oi_update` (invitations immutable; accept-flow uses DELETE + INSERT)
- `organizations.orgs_insert`, `organizations.orgs_delete` (service-role only for tenancy provisioning)
- `audit_storage_writes.asw_insert/update/delete` (service-role only; authenticated cannot mutate audit log)

All policy predicates wrap helpers as `(select private.<helper>())` per B-1 §5 — InitPlan-safe (evaluated once per query, not per row). Helpers are `STABLE SECURITY DEFINER` with `SET search_path = private, public, pg_temp` (B-1 §3).

### 1.3 `research_queue.organization_id` current state

```
column_name     | is_nullable | column_default                                  | data_type
----------------+-------------+-------------------------------------------------+----------
organization_id | YES         | '4ece2f20-f2fc-4f8f-afce-59806d92a11b'::uuid    | uuid
```

The DEFAULT UUID is the `system-default` organization (Phase A `§4.1` backfill — `David's Workspace`, `created_at = 2026-05-23 21:34:50Z`). Column is nullable; Phase C will `SET NOT NULL`.

### 1.4 Row-distribution sanity (drives DROP DEFAULT safety)

| Cohort | Rows |
|---|---|
| `research_queue` total | 44 |
| `research_queue` with `organization_id IS NULL` | **0** |
| `research_queue` with `organization_id = '4ece2f20-…-a11b'` (system-default) | **44** |
| `research_queue` with `organization_id` in any other org | 0 |
| `organizations` total | 1 (system-default only) |
| `organization_members` total | 1 (primary owner) |
| `organization_invitations` total | 0 |
| `audit_storage_writes` total | 43 |

Last 7 days of inserts (2026-05-26 → 2026-06-01): 20 rows, **100 % to system-default**. Confirms only one org exists; every insert today already routes there explicitly via the frontend code path (§3.2).

### 1.5 Triggers installed

| Table | Trigger | Status |
|---|---|---|
| `research_queue` | `research_queue_immutable_org_id` (B-1 §4) | enabled |
| `research_queue` | `trg_queue_updated` (Phase A `updated_at`) | enabled |
| `organizations` | `organizations_immutable_columns` (B-1 §5.5) | enabled |
| `organization_members` | `trg_organization_members_min_owner` (Phase A §3) | enabled |

### 1.6 Migration history

```
version  | name
---------+--------------------------
20260522 | phase_a_multi_tenancy
20260523 | phase_b_auth_rls_helpers
20260525 | research_usage_telemetry
```

`20260527_plan_review_gate.sql` exists on disk but is **not** in `supabase_migrations.schema_migrations` — out of scope for B-2 but noted here for retrospective triage. (Probably applied via Supabase Studio; B-2 must not double-apply it.)

---

## 2. The 14 B-1 policies — semantic map

The 14 policies define the tenant boundary in terms of two helpers (B-1 §3):

- `private.auth_user_organization_id() returns uuid` — scalar-subquery resolution of `organization_members.organization_id WHERE user_id = auth.uid()`. Raises `cardinality_violation` (SQLSTATE 21000) if `om_one_org_per_user` UNIQUE constraint were ever dropped + a user had 2+ memberships (fail-loud).
- `private.auth_user_is_owner() returns boolean` — `EXISTS (… WHERE role = 'owner' AND user_id = auth.uid())`.

Combined, they enforce:

| Privilege | Required tenant condition |
|---|---|
| Member SELECT on `research_queue` | row's `organization_id` matches caller's org |
| Member INSERT to `research_queue` | new row's `organization_id` matches caller's org |
| Member UPDATE / DELETE on `research_queue` | row's `organization_id` matches caller's org (both USING and WITH CHECK) |
| Member SELECT on `organization_members` | row is caller's own OR caller is owner of its org |
| Owner-only INSERT/UPDATE/DELETE on `organization_members` | within caller's org |
| Owner-only manage on `organization_invitations` | within caller's org (no UPDATE policy — immutable) |
| Member SELECT on `organizations` | row is caller's own org |
| Owner-only UPDATE on `organizations.name` | `organizations_immutable_columns` trigger blocks id/slug/created_at mutation |
| Member SELECT on `audit_storage_writes` | owner of the row's org; no mutating policies |

**Service-role (worker daemon + frontend SSR API routes via the `STOPGAP(SSR-auth)` shim) bypasses all of these.** The `BYPASSRLS` attribute on the `service_role` Postgres role is the bypass mechanism (not `relforcerowsecurity = true`, which is `false` everywhere — see §1.1).

---

## 3. Caller path map — per role, per table

For each consumer of the 5 tables, this section enumerates the role and predicts the post-B-2 RLS behavior. Since RLS is already enabled (§1.1), most "post-B-2" behavior is **already in effect today**; the only B-2 behavior change is on the DEFAULT column.

### 3.1 Worker daemon (`agent/`)

**Role:** `service_role` via `SUPABASE_SERVICE_ROLE_KEY` injected through `@supabase/supabase-js` server client (`agent/lib/supabase.ts`).
**RLS posture:** Bypasses RLS by `BYPASSRLS` attribute. **No behavior change post-B-2.**
**Insert paths:** None on `research_queue` (worker SELECTs/UPDATEs only). Worker `audit_storage_writes` inserts are governed by the absence of an asw_insert policy + service-role bypass — unaffected.
**Update paths:** `executor.ts` claim flow + status transitions (`research_queue.status`, `current_phase`, `phase_status`, `progress_pct`, …). Trigger `research_queue_immutable_org_id` blocks any UPDATE that changes `organization_id` (B-1 §4 — defends against service-role-bypass-of-RLS tenancy migration).

Specific files referencing these tables:

- `agent/executor.ts` — main job pipeline; SELECT/UPDATE/INSERT (the INSERTs are into `audit_storage_writes`, not `research_queue`).
- `agent/lib/storage-paths.ts` — `uploadWithAudit()` appends one row to `audit_storage_writes` per Supabase Storage upload.
- `agent/lib/usage-tracking.ts` — telemetry.
- `agent/scripts/phase-b-cleanup-legacy-storage-paths.ts` — admin cleanup; reads `research_queue.organization_id` to scope work.
- `agent/scripts/finalize-recovered-run.ts`, `regenerate-studio-products.ts`, `cancel-job.ts` — admin tools.
- `agent/scripts/phase-a-bootstrap-primary-user.ts`, `phase-a-rollback-primary-user.ts` — bootstrap tooling.
- `agent/scripts/test-phase-a-migration.sh`, `test-phase-b-rls.sh` — test harnesses (use `psql` directly, not the JS client; psql connects as the `postgres` superuser via `DATABASE_URL` — `BYPASSRLS` does not apply but the postgres role typically has table-owner exemption + `relforcerowsecurity = false` means no force-RLS apply).

### 3.2 Frontend SSR API routes (`frontend/app/api/`)

These routes are **currently** service-role via the 6 `STOPGAP(SSR-auth)` sites tagged for grep at `frontend/app/api/runs/route.ts`, `state/route.ts`, `runs/[slug]/files/route.ts`, `manifest/route.ts`, `file/[filename]/route.ts`, `runs/[slug]/replay/route.ts` (+ `runs/[slug]/plan-review/route.ts`). The SSR-auth refactor (S53+ work, separate initiative `ssr-auth-refactor-design.md`) will replace these with cookie-bound authenticated Supabase clients — **out of scope for B-2**.

**Role today:** `service_role`. **RLS posture:** Bypassed. **No behavior change post-B-2.**

**Live `research_queue` INSERT paths** (per Codex C-MIN-1, exhaustive grep across `agent/` + `frontend/` + `supabase/`):

1. `frontend/app/api/queue/route.ts:120-124` — new-job submission via `POST /api/queue`. Writes `organization_id: orgId` from `getOrgContextDualPath()`. Preamble at lines 15–16 explicitly anticipates B-2.
2. `frontend/app/api/runs/[slug]/replay/route.ts:180-184` — replay flow via `POST /api/runs/[slug]/replay`; UI entry at `frontend/app/runs/[slug]/page.tsx:89`. Also writes `organization_id: orgId` from `getOrgContextDualPath()` at line 44.

**No INSERT into `research_queue` in `agent/`.** Worker paths claim/update queue rows and INSERT only into `plan_reviews`, `research_usage`, and `audit_storage_writes`.

Both live INSERT paths are pre-B-2-compatible (explicit org_id). The shared route preamble at `queue/route.ts:15–16`:

> Insert adds explicit `organization_id: orgId` — replaces reliance on
> the Phase A schema DEFAULT (which Phase 5 will DROP).

(The route's "Phase 5" refers to the SSR-auth-refactor phase numbering, which coincides with B-2 here.)

The same `.eq("organization_id", orgId)` guard appears in `frontend/app/api/queue/[id]/route.ts:33`, `frontend/app/api/runs/[slug]/plan-review/route.ts`, and `frontend/lib/auth.ts` (`getOrgContextDualPath`).

### 3.3 Frontend client (browser, anon + authenticated)

**Role:** `authenticated` (via cookie-bound JWT) once the user has clicked the magic-link callback, or `anon` while logged out.
**RLS posture:** **Already subject to the 14 B-1 policies as of S49** (since RLS was already enabled at B-1 apply). Authenticated users in the system-default org see their own org's rows; `anon` sees nothing. **No behavior change post-B-2.**

Specific files:

- `frontend/hooks/useNewResearchForm.ts` — client-side form submission; calls `POST /api/queue` (not a direct DB call).
- `frontend/lib/storage.ts`, `frontend/lib/validate.ts` — utility libraries that take an `orgId` arg.
- `frontend/app/no-org/page.tsx` — fallback page when `getOrgContextDualPath()` returns no org.
- `frontend/app/auth/callback/route.ts` — magic-link callback; touches `organization_members` to associate the user with their org.

### 3.4 Direct psql / admin access (DBA + migrations)

**Role:** `postgres` (superuser) via `DATABASE_URL`. **RLS posture:** Bypassed (table-owner exemption + `relforcerowsecurity = false`). **No behavior change post-B-2.**

---

## 4. DROP DEFAULT — rationale, safety, risk

### 4.1 What the DEFAULT is and why it exists

Phase A `§4.1` set `research_queue.organization_id DEFAULT '4ece2f20-…-a11b'::uuid` as a **transitional measure** — Phase A added the column NULLABLE because pre-existing rows would otherwise fail; the DEFAULT then ensured that any newly inserted row that *omitted* `organization_id` would still get a non-NULL value (routed to system-default). This was the explicit Phase A "Option 1+" Pattern (Phase A migration line 305–330): keep new inserts safe during the A → B frontend-deploy gap.

### 4.2 Why DROP it now

Three reasons:

1. **All current INSERT paths write `organization_id` explicitly** (frontend `POST /api/queue/route.ts:124`). Live-traffic grep shows zero callers omit it. The DEFAULT has been dead-code-protective since the SSR-cutover work in S56.
2. **Reliance on the DEFAULT is a silent failure mode if it ever fires.** A row inserted without an explicit `organization_id` ends up in system-default — currently the *only* org — which masks the bug. Future bug surface: if multi-org support ever lands and an INSERT path is missed in refactor, those rows go to system-default rather than the intended org. DROP DEFAULT converts that silent misroute into a NULL row that fails policy (`organization_id = auth_user_organization_id()` is false against NULL); the bug becomes loud (queries return empty for the intended tenant).
3. **B-1 ratchet: trigger + policies already assume explicit org_id.** The immutable-org_id trigger blocks any UPDATE that would change `organization_id` (B-1 §4), and the rq_insert WITH CHECK requires `organization_id = auth_user_organization_id()` for authenticated callers. The DEFAULT only saves service-role omissions — and service-role callers are auditable via `audit_storage_writes`. Dropping it tightens the contract without changing live behaviour today.

### 4.3 Safety analysis

| Concern | Evidence | Verdict |
|---|---|---|
| Existing rows orphaned | 44 / 44 rows have non-NULL org_id (§1.4) | **safe** |
| Live INSERT paths rely on DEFAULT | Both paths (`queue/route.ts:120-124` AND `replay/route.ts:180-184`) write `organization_id: orgId` explicitly; preamble at `queue/route.ts:15–16` confirms intent (Codex C-MIN-1) | **safe** |
| Worker daemon INSERTs queue rows without org_id | Worker SELECTs/UPDATEs only; no `.from('research_queue').insert(` in agent code (Codex-confirmed grep) | **safe** |
| `audit_storage_writes` affected | No FK between DEFAULT and audit log | **n/a** |
| Trigger interaction | `research_queue_immutable_org_id` fires only on UPDATE; CHECK × trigger interaction verified non-pathological by Codex round 1 | **safe** |
| Rollback complexity | `ALTER TABLE … SET DEFAULT '4ece2f20-…-a11b'::uuid` one-liner + `DROP CONSTRAINT IF EXISTS …` | **trivial** |

### 4.4 Closed risk — "silent NULL" gap window (Option B adopted per Gemini G-MAJ-1)

**Risk (as v1 framed it):** Post-DROP-DEFAULT and pre-Phase-C (SET NOT NULL), any *future* INSERT path that omits `organization_id` silently inserts a row with `organization_id = NULL`. Such a row is:

- Invisible to authenticated SELECT (policy predicate against NULL is unknown → false).
- Still visible to service-role (worker daemon).
- Caught by the `research_queue_immutable_org_id` trigger on UPDATE only when the OLD value also exists in a comparable state (NULL → real-uuid via UPDATE is `OLD IS DISTINCT FROM NEW = true`, so the trigger would fire).

**v2 resolution — Option B adopted:** the B-2 migration now includes `ALTER TABLE public.research_queue ADD CONSTRAINT research_queue_org_id_not_null CHECK (organization_id IS NOT NULL)`. This:

1. **Closes the gap for all roles**, including service-role — `SET NOT NULL` is enforced by the relation itself (not by RLS), and so is a CHECK constraint with an `IS NOT NULL` predicate. The worker daemon, the frontend SSR routes, and any future service-role INSERT path all hit the same wall.
2. **Avoids the SET NOT NULL table-rewrite path** — `ALTER COLUMN … SET NOT NULL` in PostgreSQL ≥ 12 does NOT rewrite the table (it validates the existing rows and updates `pg_attribute.attnotnull`); but a CHECK constraint is structurally identical in intent and slightly easier to roll back (DROP CONSTRAINT vs. DROP NOT NULL). At 44 rows the cost difference is rounding-error, but the rollback clarity argues for CHECK.
3. **Composes with Phase C cleanly** — when Phase C lands SET NOT NULL, the CHECK constraint becomes redundant and can be DROPPED in the same migration (or left in place as defense-in-depth; CHECK + NOT NULL is over-determined but not erroneous).

**v1 deliberation preserved for context (the three options considered):**

- **Option A (v1 default):** DROP DEFAULT alone; defer SET NOT NULL to Phase C. Risk window bounded by Phase C's timeline.
- **Option B (v2 adopted):** add a CHECK constraint in the same B-2 migration.
- **Option C (rejected):** combine with SET NOT NULL. Out of pre-auth scope ("DROP DEFAULT" only).

**Author position (v2):** Option B is the right balance — closes the actual safety gap that motivated the DEFAULT, costs $0 to add, costs $0 to roll back, and keeps B-2 narrowly scoped vs. Phase C's broader SET NOT NULL work. **The user is asked to confirm Option B explicitly at the Phase 1 → 2 gate.**

---

## 5. Migration SQL skeleton (Phase 2 deliverable)

```sql
-- Multi-Tenancy Phase B-2 — RLS-enforce assertion + DROP DEFAULT + CHECK NOT NULL
--
-- Implements Documentation/wave-b-2-rls-enable-design-gate.md v<final>.
-- DESIGN-gate ratified S80 via sequential Gemini → Codex MRPF.
-- Pending MERGE-gate sequential review on this SQL before apply.
--
-- Scope (IN):
--   §1  Pre-flight assertion: relrowsecurity = true on the 4 tenant tables
--       (RLS was pre-existing as of S49; assert before any DDL)
--   §2  Idempotent ALTER TABLE … ENABLE ROW LEVEL SECURITY (no-op if already on)
--   §3  ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT
--   §4  ALTER TABLE public.research_queue ADD CONSTRAINT
--         research_queue_org_id_not_null CHECK (organization_id IS NOT NULL)
--       (Gemini G-MAJ-1: closes the silent-NULL gap window for ALL roles
--        including service-role; bridges to Phase C SET NOT NULL.)
--
-- Scope (OUT — deferred to Phase C):
--   - ALTER TABLE public.research_queue ALTER COLUMN organization_id SET NOT NULL
--     (the CHECK constraint in §4 is the bridge; SET NOT NULL canonicalises it
--     when Phase C lands; both can coexist — over-determined but not erroneous)
--
-- Deployment path: supabase db push --linked
--   - filename uses UNDERSCORE separator (S46 C1)
--   - NO file-level BEGIN/COMMIT (S46 C2)
--   - NO SET LOCAL; use plain SET for session-scoped timeouts on the dedicated
--     migration connection (S47 finding + Codex C-MAJ-1 verification S80)
--
-- Pre-apply tests:  bash agent/scripts/test-phase-b-rls.sh postmerge   (B-1 harness; B-2 must NOT regress)
-- Post-apply tests: bash agent/scripts/test-phase-b-2.sh postmerge     (new harness, see §7)
--
-- Rollback (§6):
--   ALTER TABLE public.research_queue DROP CONSTRAINT research_queue_org_id_not_null;
--   ALTER TABLE public.research_queue
--     ALTER COLUMN organization_id SET DEFAULT '4ece2f20-f2fc-4f8f-afce-59806d92a11b'::uuid;
--   (Optional, only if RLS-breaks-app, NOT for DROP-DEFAULT or CHECK rollback alone:)
--   ALTER TABLE public.research_queue           DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.organization_members     DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.organization_invitations DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.organizations            DISABLE ROW LEVEL SECURITY;


SET lock_timeout = '5s';
SET statement_timeout = '15s';


-- =============================================================================
-- §1 — Pre-flight assertion: confirm RLS is enabled on the 4 tenant tables
--      and there are zero NULL organization_id rows in research_queue.
-- =============================================================================
-- If RLS ever got DISABLEd between S49 and apply, this fails loud and aborts
-- the migration before any DDL runs.
-- If any NULL org_id rows exist, §4 (CHECK constraint validation) would fail
-- — surface that here rather than mid-DDL.

DO $$
DECLARE
  v_disabled text;
  v_null_count bigint;
BEGIN
  SELECT string_agg(relname, ',' ORDER BY relname)
    INTO v_disabled
  FROM pg_class
  WHERE relname IN ('research_queue','organization_members','organization_invitations','organizations')
    AND relkind = 'r'
    AND relrowsecurity = FALSE;

  IF v_disabled IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B-2 precondition violated: RLS DISABLED on: %', v_disabled;
  END IF;

  -- Cross-check: zero NULL org_id rows. If any exist, the CHECK constraint
  -- in §4 would fail validation — fail-loud here with a clearer message.
  SELECT COUNT(*) INTO v_null_count FROM public.research_queue WHERE organization_id IS NULL;
  IF v_null_count > 0 THEN
    RAISE EXCEPTION 'Phase B-2 precondition violated: % NULL organization_id rows found in research_queue (CHECK NOT NULL in §4 would fail)', v_null_count;
  END IF;
END $$;


-- =============================================================================
-- §2 — Idempotent ENABLE ROW LEVEL SECURITY (defense-in-depth no-op).
-- =============================================================================
-- Live state (S80 probe): relrowsecurity = true on all 4 tables. These
-- statements are no-ops in the current state but assert intent declaratively
-- and recover the table to ENABLED if §1 somehow let a DISABLED state slip
-- through (it shouldn't — §1 fails first).

ALTER TABLE public.research_queue           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations            ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- §3 — DROP DEFAULT on research_queue.organization_id.
-- =============================================================================
-- Phase A's transitional DEFAULT (system-default org UUID) is no longer needed:
-- both live INSERT paths write organization_id explicitly
--   - frontend/app/api/queue/route.ts:120-124
--   - frontend/app/api/runs/[slug]/replay/route.ts:180-184
-- Worker daemon does NOT INSERT into research_queue (claim/update only).
-- Dropping the DEFAULT makes "INSERT without organization_id" a constraint
-- violation (§4 enforces NOT NULL) rather than a silent misroute to
-- system-default. (Codex C-MIN-1: exhaustive INSERT inventory.)
--
-- DROP DEFAULT is natively idempotent in PostgreSQL — succeeds silently
-- whether or not a default exists on the column.

ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT;


-- =============================================================================
-- §4 — CHECK constraint: organization_id IS NOT NULL (Gemini G-MAJ-1).
-- =============================================================================
-- Closes the silent-NULL gap window for ALL callers — service-role, authenticated,
-- and anon alike. RLS policies hide NULL rows from authenticated readers (the
-- predicate `organization_id = auth_user_organization_id()` evaluates to UNKNOWN
-- against NULL → effectively false) but do NOT prevent a service-role INSERT
-- from writing a NULL — that's the gap. A CHECK constraint is enforced at the
-- relation level by all roles, closing the gap.
--
-- Existing 44 rows in research_queue all have non-NULL organization_id (verified
-- via §1.4 of the design doc + §1 preflight); the constraint validation in this
-- DDL will succeed in microseconds.
--
-- Phase C will likely add SET NOT NULL alongside; over-determined (CHECK + NOT
-- NULL) but not erroneous. If Phase C drops the CHECK in favor of NOT NULL,
-- semantics are preserved.

ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_org_id_not_null CHECK (organization_id IS NOT NULL);


-- =============================================================================
-- §5 — Column documentation.
-- =============================================================================
COMMENT ON COLUMN public.research_queue.organization_id IS
  'Phase B-2 (2026-06-01): transitional DEFAULT removed; CHECK NOT NULL constraint added. Every INSERT must specify organization_id explicitly. Phase C will canonicalise via SET NOT NULL.';
```

**File path (final):** `supabase/migrations/<YYYYMMDD>_phase_b_2_rls_enable.sql` — `YYYYMMDD` chosen at Phase 2 start time, underscore separator per [[feedback_supabase_db_push_filename_underscore]].

---

## 6. Rollback plan

### 6.1 Rollback decision criteria

Roll back **only** if any of the following fire within 1 hour of apply:

1. Worker daemon `claim` cycle starts failing (cron-task `LastTaskResult ≠ 0` repeatedly, OR worker log shows `claimJob()` returning errors).
2. Frontend POST `/api/queue` starts returning 500s for explicit-org-id inserts (would indicate a Postgres-level regression, not the design — investigate before rolling back).
3. Smoke-test failure on either the positive or negative case (see §7).
4. Any policy-bypass observed via the post-apply audit query.

**Do not roll back for:**
- Authenticated client reads returning fewer rows than before (that's the *intent* — they were always intended to be tenant-scoped; if pre-B-2 behavior leaked rows, that was the pre-existing bug).

### 6.2 Rollback SQL (one-shot)

```sql
-- ONLY EXECUTE if §6.1 criteria fire AND user explicitly authorizes.
-- Plain SET (not SET LOCAL) per C-MAJ-1 / MERGE-gate Gemini G-MIN-1.
SET lock_timeout = '5s';

-- Drop the CHECK constraint added in §4
ALTER TABLE public.research_queue
  DROP CONSTRAINT IF EXISTS research_queue_org_id_not_null;

-- Restore the DEFAULT removed in §3
ALTER TABLE public.research_queue
  ALTER COLUMN organization_id SET DEFAULT '4ece2f20-f2fc-4f8f-afce-59806d92a11b'::uuid;

-- Only DISABLE if rollback is triggered by RLS-breaks-app, NOT by DROP DEFAULT
-- or CHECK alone (DISABLE removes the tenant boundary; do this only if leaving
-- it on would break production traffic and a fix is not available within minutes)
ALTER TABLE public.research_queue           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations            DISABLE ROW LEVEL SECURITY;
```

### 6.3 Post-rollback action

- Record incident in `feedback_phase_b_2_rollback_<date>.md` memory.
- Re-classify the issue: if it was a DROP DEFAULT issue, Phase C work has to be revisited too. If it was an RLS-policy issue, B-1 needs revisiting.
- Restore the migration history row (`DELETE FROM supabase_migrations.schema_migrations WHERE version = '<B-2-version>'`) so a corrected version can re-apply.

---

## 7. Post-apply smoke-test plan

Extend `agent/scripts/test-phase-b-rls.sh` with a new mode `b2-postmerge` (or create `agent/scripts/test-phase-b-2.sh`). Tests run as `psql $DATABASE_URL` (postgres role, RLS-exempt — but the tests use `SET LOCAL ROLE authenticated` + `SET LOCAL request.jwt.claim.sub` to simulate authenticated context, mirroring the B-1 T13 pattern).

### Test matrix

| ID | Asserts | Method |
|---|---|---|
| **B2-T1** | Migration `<version>` recorded in `supabase_migrations.schema_migrations` | `SELECT COUNT(*) FROM supabase_migrations.schema_migrations WHERE version = '<B-2-version>'` |
| **B2-T2** | DEFAULT dropped on `research_queue.organization_id` | `SELECT column_default FROM information_schema.columns WHERE table_name = 'research_queue' AND column_name = 'organization_id'` → NULL |
| **B2-T2.5** | CHECK constraint `research_queue_org_id_not_null` installed and VALID | `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'public.research_queue'::regclass AND contype = 'c' AND conname = 'research_queue_org_id_not_null'` → 1 row, `convalidated = t` |
| **B2-T3** | `relrowsecurity = true` on all 4 tenant tables + audit | same query as §1.1 → all 5 rows show `t` |
| **B2-T4** | (positive) authenticated user sees their org's rows | Set role + JWT sub; SELECT from research_queue, expect 44 rows |
| **B2-T5** | (negative) anon sees zero rows | `SET LOCAL ROLE anon`; SELECT from research_queue, expect 0 rows |
| **B2-T6** | (negative) authenticated foreign user sees zero rows | Create sacrificial 2nd user + 2nd org via service-role; SET ROLE authenticated with the 2nd user's JWT sub; SELECT, expect 0 rows |
| **B2-T7** | Service-role (worker) still sees all rows | Use the postgres role / service-role context; SELECT, expect 44 rows |
| **B2-T7.5a (Gemini G-MIN-1)** | Service-role can INSERT into `audit_storage_writes` (load-bearing: worker upload audit hook depends on this) | `BEGIN; INSERT INTO audit_storage_writes (caller, organization_id, object_path, http_status) VALUES ('B2-T7.5', '<system-default-uuid>', 'B2-T7.5-test', 200); SELECT 1 FROM audit_storage_writes WHERE caller = 'B2-T7.5'; ROLLBACK;` — expect INSERT to succeed; verifies the privileged audit-write path |
| **B2-T7.5b (Codex C-MIN-2)** | Catalog posture: `relforcerowsecurity = false` on `audit_storage_writes` (proves service-role bypass condition directly, not by inference from the INSERT test) | `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_storage_writes'::regclass;` — expect `t | f`. Regression catch: if `relforcerowsecurity` ever flipped to `true`, worker upload audit writes would break silently — this test fails-loud first |
| **B2-T8** | Worker daemon polling unaffected | Tail `agent/worker.log` for 90s post-apply; assert "Polling for pending jobs" continues every 30s + no errors |
| **B2-T9** | INSERT without org_id now blocked by CHECK constraint (replaces the v1 "silent NULL" test) | Service-role INSERT omitting organization_id; expect `check_violation` (SQLSTATE 23514). Run in `BEGIN; … ROLLBACK;`. **Reverses v1 expected behaviour**: pre-CHECK the test asserted a NULL row was inserted; post-CHECK the test asserts the INSERT raises. |
| **B2-T10** | Preflight assertion guards: re-running the migration with simulated DISABLED state would fail-fast | Synthesized test in a `BEGIN; ALTER TABLE … DISABLE; <run §1 block>; ROLLBACK;` block; expect the RAISE EXCEPTION |
| **B2-T11 (Gemini G-MAJ-2 + Codex C-MIN-3 resolved)** | Idempotency posture: `ENABLE RLS` on already-enabled is no-op; `DROP DEFAULT` on a column without a default is **natively idempotent** in PostgreSQL (succeeds silently, never raises — G-MAJ-2). `ADD CONSTRAINT … CHECK (…)` is intentionally **fail-loud** on direct psql replay: PostgreSQL 17 does NOT support `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints (verified against PG17 docs per Codex C-MIN-3), so `duplicate_object` (SQLSTATE 42710) is the expected behaviour. `supabase db push` skips already-applied migrations via `supabase_migrations.schema_migrations` history; it is NOT a drift-detector. | Inspect DDL behaviour on a swap-and-revert harness; this test asserts the expected SQLSTATE per statement, not "all statements should be silently idempotent" |

**Pass criteria:** all 12 tests green. Negative tests (B2-T5, B2-T6, B2-T9) are the load-bearing assertions — they prove the tenant boundary + NOT-NULL guarantee are real, not just present.

**Failure response:** abort apply, do not commit migration, restore worker if affected, file incident memory.

---

## 8. Recognized risks and open questions for reviewers

### R1. Silent-NULL gap window — RESOLVED (Option B adopted per Gemini G-MAJ-1)

**Question (v1):** Should B-2 ship DROP DEFAULT alone (Option A), add a CHECK constraint (Option B), or combine with SET NOT NULL (Option C)?

**v2 resolution:** Option B adopted. The B-2 migration now includes `ALTER TABLE … ADD CONSTRAINT … CHECK (organization_id IS NOT NULL)` (§5). This closes the gap for all roles at relation level. Open: user explicit confirmation at the Phase 1 → 2 gate (the pre-auth nominally authorized Option A; the user should re-affirm Option B before Phase 2 commits the migration).

**Codex round 1 task:** verify the CHECK-constraint approach has no edge-case interaction with the `research_queue_immutable_org_id` trigger (B-1 §4) — specifically the trigger evaluates `OLD.organization_id IS DISTINCT FROM NEW.organization_id` and uses an escape-hatch GUC. Confirm the CHECK does not affect those semantics.

### R2. Idempotent ENABLE statements — paperweight or assertion?

**Question:** §2 of the migration issues `ENABLE ROW LEVEL SECURITY` on tables that are already ENABLED. Is this useful or noise?

**Author position:** useful. Three reasons: (a) declarative intent — anyone reading the migration sees "B-2 enables RLS" without grepping S49 history, (b) recovery — if `relrowsecurity` ever got toggled OFF between S80 and apply, §1 catches it and §2 cleans up after rollback, (c) self-documenting cost — the statements are `O(1)` no-ops.

### R3. Preflight assertion stringency

**Question:** §1 fails the migration if *any* NULL org_id rows exist in `research_queue`. Should it also assert on `organization_members.user_id` having only one membership per user (B-1's UNIQUE constraint)?

**Author position:** out of scope for B-2 — that's a B-1 invariant. The B-1 post-merge tests already verify this. Adding it to B-2 preflight would couple the two migrations.

### R4. Worker daemon recycle after apply — required?

**Question:** Does the worker need a recycle after B-2 applies?

**Author position:** No. The worker uses service-role, bypasses RLS, and only UPDATEs `research_queue`. The DEFAULT change does not affect any read path; the policies were already in force at S49. **However**, post-apply preflight (`Get-ScheduledTask` + worker log tail) is mandatory to confirm — both as smoke test B2-T8 evidence and as risk-acceptance signal.

### R5. `20260527_plan_review_gate.sql` history gap (Gemini G-MIN-2)

**Question:** This file exists on disk but is not in `supabase_migrations.schema_migrations` (§1.6). Is this a concern for B-2?

**Author position:** out of scope for B-2 but worth a retrospective triage. Probably applied via Studio (which bypasses `schema_migrations`). B-2 does not touch the plan_review feature; the gap is observational, not blocking.

**v2 action item (Gemini G-MIN-2):** when B-2 ships, write a memory file `feedback_studio_applied_migration_not_in_history.md` capturing the pattern + the specific 20260527 instance. Avoids future "supabase db push behaves unexpectedly on fresh clone" surprises.

### R6. SSR-auth refactor coupling

**Question:** The frontend `STOPGAP(SSR-auth)` sites all use service-role. Post-B-2 they continue to work. But when the SSR-auth refactor lands, those routes will switch to authenticated cookie-bound Supabase clients — does B-2 need to land *before* or *after* that?

**Author position:** Either order is safe. B-2 doesn't depend on the refactor (current frontend writes are already org-aware on the INSERT side). The SSR-auth refactor depends on B-2 being applied (so the rq_* policies bite for authenticated clients). Today's B-2 makes the refactor's Phase 5 a no-op for RLS enforcement.

---

## 9. MRPF classification

Per `~/CLAUDE.md` Multi-Reviewer Policy Framework (HARD RULE):

- **Event Gate:** DESIGN (this doc) → MERGE (Phase 2 migration).
- **Risk Labels:** SECURITY (tenant-isolation boundary) + DATA (schema migration; DROP DEFAULT semantics; irreversibility-without-restore is bounded by §6.2 rollback being a 5-line SQL).
- **Severity Mode:** NORMAL (no incident pressure, no production-down).
- **Review Topology:** Sequential. Gemini round 1 (long-context whole-codebase holistic read on v1) → integrate to v2 → Codex round 1 (code-grounded grep against caller paths + policy predicates on v2) → integrate to v3.
- **Synthesis artifact:** `Documentation/wave-b-2-rls-enable-design-gate-peer-review.md`.
- **Spend ceiling for the DESIGN-gate alone:** ~$0.20–0.40 expected (Gemini ~$0.10 + Codex ~$0.05–0.10).
- **Disagreement procedure:** standard MRPF; SECURITY-labeled CRITICAL findings are blocking.

---

## 10. Phase 2 entry criteria (HARD PAUSE)

Phase 2 begins **only** when:

1. This DESIGN-gate has v3 with both Gemini and Codex findings integrated (or DEFERred with explicit rationale).
2. The companion `peer-review.md` synthesis is written.
3. The user has explicitly answered "yes" to "DESIGN-gate v3 APPROVED — proceed to MERGE-gate (Phase 2) Y/N?" — pre-auth at S79 end does **not** lift this pause; Phase 2 needs fresh user signoff.

If any STOP trigger fires during MRPF (SECURITY CRITICAL finding, DATA CRITICAL finding, reviewer disagreement requiring tiebreaker, spend > $2.00 early-warning, refactor creep beyond 1 migration + 2 docs), halt and write the trigger to `dryrun_handoff.md`.

---

## Appendix A — provenance + verification

- All §1 data captured via `psql $DATABASE_URL` on 2026-06-01 20:35Z against project `mfjgoghlpqgxcycxoxio`.
- All §3 caller-path attribution captured via `Grep` against `agent/` + `frontend/` workdirs on 2026-06-01 20:40Z.
- §4.4 grep evidence: `frontend/app/api/queue/route.ts` lines 12–22 + 117–134 — confirms explicit `organization_id: orgId` write.
- S49 pre-existing-ENABLED finding sourced from `agent/scripts/test-phase-b-rls.sh:523–546` (T10 comment block).

Re-verify §1 immediately before Phase 2 apply (no expected drift, but a fresh probe is a $0 cost).
