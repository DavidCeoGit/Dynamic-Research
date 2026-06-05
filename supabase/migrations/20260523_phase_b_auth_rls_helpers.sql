-- Multi-Tenancy Phase B-1 — auth helpers + RLS policy DEFINITIONS + constraints + audit table
--
-- Implements Documentation/multi-tenancy-phase-b-plan.md v3 §2.2 + §2.3 + §2.5.5 + §3.
-- DESIGN-gate ratified S48 via parallel Gemini Deep Think + Codex GPT-5.5 xhigh
-- (code-grounded) + 2 sequential QA cycles (v2 BLOCK → v3 APPROVE).
-- MERGE-gate sequential review S49: v1 → Gemini (REQUEST CHANGES) → v2 (M1+M2+m1
-- ACCEPT, C1 DEFER, C2 DISMISS) → Codex on v2 (REQUEST CHANGES, 2 MAJOR + 1 minor)
-- → v3 (Codex M1 = orgs immutable-columns trigger; Codex M2 = test harness reorder
-- + dot-path JWT claim; lock_timeout added per Codex recommendation) → Codex v3
-- QA (REQUEST CHANGES, PARTIAL on M2) → v4 (scalar-subquery wrap on
-- auth_user_organization_id() to enable actual cardinality_violation per PG
-- SQL-function semantics; T13 now exercises real fail-loud path).
-- See Documentation/multi-tenancy-phase-b-merge-gate-peer-review.md for full audit trail.
--
-- Scope (IN):
--   §1  CREATE SCHEMA private + REVOKE/GRANT pattern (CG7 S48)
--   §2  ALTER TABLE organization_members ADD CONSTRAINT om_one_org_per_user UNIQUE (user_id)
--       FIRST mutating statement (B1 S48). C1 (S49 Gemini) flagged the ACCESS EXCLUSIVE
--       lock as a concern; deferred with documented rationale below — current state is
--       1 row, lock duration is sub-millisecond, no live auth flow yet.
--   §3  private.auth_user_organization_id() — STABLE SECURITY DEFINER, NO LIMIT 1 (B1)
--       private.auth_user_is_owner() — PARAMETERLESS, STABLE SECURITY DEFINER (M1 S49)
--   §4  private.research_queue_immutable_org_id() trigger function + BEFORE UPDATE trigger
--       (CG9 S48). v2 adds SET search_path = private, public, pg_temp (m1 S49).
--   §5  RLS policy CREATEs on the 4 tenant-scoped existing tables. v2 refactors every
--       policy body to the InitPlan-safe `auth_user_is_owner() AND <col> =
--       auth_user_organization_id()` pattern (M1 S49), eliminating the per-row SubPlan
--       evaluation of the previous v1 `auth_user_is_org_owner(<row_col>)` form.
--       Policies are CREATED but RLS is NOT ENABLED on these existing tables — that's B-2.
--   §6  audit_storage_writes table + indexes + RLS ENABLED at create-time (Q3 / W7).
--       v2 changes FK ON DELETE policies from SET NULL → RESTRICT (M2 S49) to preserve
--       forensic immutability. asw_select policy refactored to InitPlan-safe form (M1).
--   §7  REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO authenticated on the 2 helpers
--       (m3 S48). v2 updates the signature on the parameterless helper.
--
-- Scope (OUT — Phase B-2):
--   - ALTER TABLE ... ENABLE ROW LEVEL SECURITY on the 4 existing tenant-scoped tables
--   - ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT
--   - The post-frontend-cutover preflight assertion (plan §2.8 step 7)
--
-- Deployment path (S46 C1/C2 hard rules):
--   - Apply via `supabase db push` ONLY. DO NOT use Supabase Studio SQL Editor.
--   - Filename uses UNDERSCORE separator (S46 C1).
--   - NO file-level BEGIN/COMMIT (S46 C2: ExecBatch wraps file + history insert atomically).
--
-- Pre-apply tests:  bash agent/scripts/test-phase-b-rls.sh preflight  (read-only)
-- Post-apply tests: bash agent/scripts/test-phase-b-rls.sh postmerge
--
-- Rollback: additive migration — no DROPs, no DATA mutation, no RLS ENABLE on existing
-- tables. See plan §5 for the production rollback strategy.


-- =============================================================================
-- §0 — Session-level lock timeout (Codex S49 recommendation)
-- =============================================================================
-- Cap lock-wait time on the ALTER TABLE in §2. If a long-running query holds a
-- conflicting lock, fail fast (≤5s) with a clear error rather than queuing
-- indefinitely behind it. SET LOCAL scopes to the implicit transaction Supabase
-- CLI ExecBatch wraps around this file.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';


-- =============================================================================
-- §1 — private schema (security-definer helpers live here, not in public)
-- =============================================================================
-- CG7 (S48): Supabase recommends security-definer helpers in private/app_private
-- to minimize exposed-schema surface area. PostgREST does not expose `private`.

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;


-- =============================================================================
-- §2 — UNIQUE (user_id) on organization_members  (FIRST MUTATING STATEMENT)
-- =============================================================================
-- B1 (S48): Phase A schema has composite PK on (organization_id, user_id), which
-- permits a user in N orgs. v1 "one membership per user" was a convention only.
-- This constraint asserts the invariant in the DB so the helper in §3 can rely
-- on it; if the constraint is ever dropped and a user gains a second membership,
-- the helper raises a cardinality violation (fail-loud).
--
-- Must be the FIRST mutating statement so subsequent statements execute against
-- a schema where the constraint holds.
--
-- -----------------------------------------------------------------------------
-- C1 (S49 Gemini): ACCESS EXCLUSIVE lock concern — DEFERRED with rationale
-- -----------------------------------------------------------------------------
-- Gemini's S49 MERGE-gate review flagged this ALTER TABLE as CRITICAL because
-- ADD CONSTRAINT ... UNIQUE acquires ACCESS EXCLUSIVE and blocks all reads/writes
-- while Postgres scans the table and builds the index. The recommended fix is a
-- two-stage CREATE UNIQUE INDEX CONCURRENTLY + ALTER TABLE ... USING INDEX.
--
-- We DEFER this refactor for two reasons:
--
-- 1. Production-state safety (CURRENT): organization_members has 1 row (the
--    primary owner from S47 bootstrap). ACCESS EXCLUSIVE on a 1-row table
--    completes in microseconds. There is no live user-auth flow against this
--    table — Phase B-2 has not enabled RLS and the frontend SSR refactor has
--    not landed, so worker traffic is the only consumer and it goes via
--    service-role + direct user_id key access, not via the membership join.
--    The downtime risk Gemini warns about does not materialize at this scale.
--
-- 2. Supabase-CLI architectural constraint: CREATE INDEX CONCURRENTLY CANNOT
--    run inside a transaction. Supabase CLI ExecBatch wraps the migration file
--    + the supabase_migrations.schema_migrations history insert in ONE implicit
--    transaction (S46 C2 hard rule). So the CONCURRENTLY path is incompatible
--    with the supabase db push deployment path. To use CONCURRENTLY we would
--    have to (a) apply via direct psql outside the CLI wrap and manually insert
--    the history row, or (b) apply via Supabase Studio SQL Editor and bypass
--    history altogether. Both options introduce more operational risk than the
--    sub-millisecond lock on a 1-row table.
--
-- FUTURE SCALING PATH (when organization_members > ~10K rows): drop the
-- constraint in an in-tx migration, apply CREATE UNIQUE INDEX CONCURRENTLY via
-- direct psql (manually inserting a history row), then re-attach the constraint
-- via ALTER TABLE ... ADD CONSTRAINT ... USING INDEX in a follow-up in-tx
-- migration. Tracked in [[project_multi_reviewer_policy_framework_v2_shape]]
-- backlog for re-evaluation post-beta.

ALTER TABLE public.organization_members
  ADD CONSTRAINT om_one_org_per_user UNIQUE (user_id);

COMMENT ON CONSTRAINT om_one_org_per_user ON public.organization_members IS
  'Phase B-1: DB-level "one membership per user" invariant. private.auth_user_organization_id() relies on this for fail-loud cardinality-violation semantics under any future breach. C1-deferred (S49 Gemini) — re-evaluate CONCURRENTLY refactor when row count >~10K.';


-- =============================================================================
-- §3 — Security-definer helpers (in private schema)
-- =============================================================================
-- Both helpers:
--   - STABLE so Postgres caches the result; combined with the `(select ...)`
--     wrap in policy bodies AND the parameterless signature (M1 S49), the
--     helper executes EXACTLY ONCE per query as an InitPlan, not per-row as a
--     SubPlan.
--   - SECURITY DEFINER + SET search_path = private, public, pg_temp prevents
--     search-path hijacking via a malicious public-schema function shadow.
--   - Live in `private`, not `public`, so PostgREST does not expose them.
--
-- M1 (S49 Gemini): v1 had `auth_user_is_org_owner(target_org_id uuid)` which
-- took the per-row org_id as an argument — forcing the optimizer into a
-- correlated SubPlan (O(N) per query). v2 replaces with PARAMETERLESS
-- `auth_user_is_owner()` (returns true iff current user is owner of their one
-- org). All policies refactored to `auth_user_is_owner() AND <col> =
-- auth_user_organization_id()` — semantically equivalent under the UNIQUE
-- (user_id) constraint, but resolves to a single InitPlan eval per query.

-- Codex S49 v3 QA (PARTIAL on M2): SQL functions return the first row on a
-- multi-row final query — they do NOT raise cardinality_violation. The
-- "NO LIMIT 1 = fail-loud" guarantee only holds with scalar-subquery
-- semantics, which DO raise cardinality_violation on multi-row results.
-- v4 wraps the inner SELECT in a scalar subquery to get the intended
-- fail-loud behavior. PG docs: https://www.postgresql.org/docs/15/xfunc-sql.html
CREATE OR REPLACE FUNCTION private.auth_user_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
  SELECT (
    SELECT organization_id
    FROM public.organization_members
    WHERE user_id = auth.uid()
  )
$$;

COMMENT ON FUNCTION private.auth_user_organization_id() IS
  'Phase B-1: resolves the current authenticated user to their single organization. Inner SELECT is a SCALAR SUBQUERY (Codex S49 v3 QA fix) — under UNIQUE(user_id) returns 0/1 rows normally; if the constraint is ever dropped and a user has 2+ memberships, the scalar subquery raises cardinality_violation (PostgreSQL SQLSTATE 21000) — fail-loud, not silent. SQL functions alone do NOT raise this — they return the first row on multi-row final query.';


-- M1 (S49 Gemini): parameterless. Returns true iff the current authenticated
-- user is an owner of their single org (the one given by
-- auth_user_organization_id()). Under UNIQUE(user_id), this is unambiguous.
-- If v2 ever relaxes the single-org rule, a parameterized variant can be
-- re-added; today it would only enable per-row SubPlan execution with no
-- security benefit.

CREATE OR REPLACE FUNCTION private.auth_user_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id = auth.uid()
      AND role = 'owner'
  )
$$;

COMMENT ON FUNCTION private.auth_user_is_owner() IS
  'Phase B-1: returns true iff the current authenticated user is an owner of their single organization. Parameterless for InitPlan-friendly RLS policy bodies (M1 S49 Gemini). Combine with `<col> = auth_user_organization_id()` in WITH CHECK / USING clauses to scope to the user''s specific org.';


-- =============================================================================
-- §4 — Immutable organization_id trigger on research_queue (CG9 S48)
-- =============================================================================
-- DB-level fence: service-role code (worker daemon + Next API routes) bypasses
-- RLS, so even after Phase B-2 enables RLS, service-role can still mutate the
-- organization_id of a queued row and migrate ownership across tenants. This
-- trigger blocks that bypass vector by default.
--
-- Escape hatch: `current_setting('app.allow_org_migration', true) = 'true'`
-- is a session-scoped variable reserved for an explicit admin tenancy-migration
-- tool that does not yet exist. NEVER set in worker code, NEVER set in
-- user-facing API routes.
--
-- m1 (S49 Gemini): v2 adds SET search_path = private, public, pg_temp. While
-- the function body does not currently query any tables, the search_path lock
-- is defense-in-depth against future modifications that reference unqualified
-- structures.

CREATE OR REPLACE FUNCTION private.research_queue_immutable_org_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = private, public, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND OLD.organization_id IS DISTINCT FROM NEW.organization_id
     AND COALESCE(current_setting('app.allow_org_migration', true), 'false') <> 'true' THEN
    RAISE EXCEPTION
      'research_queue.organization_id is immutable (set app.allow_org_migration=true to override)';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.research_queue_immutable_org_id() IS
  'Phase B-1: BEFORE UPDATE trigger function on public.research_queue. Blocks org_id mutation unless app.allow_org_migration=true is set in the session. Catches the service-role-bypass-of-RLS vector for tenancy migration.';

DROP TRIGGER IF EXISTS research_queue_immutable_org_id ON public.research_queue;

CREATE TRIGGER research_queue_immutable_org_id
  BEFORE UPDATE ON public.research_queue
  FOR EACH ROW
  EXECUTE FUNCTION private.research_queue_immutable_org_id();


-- =============================================================================
-- §5 — RLS POLICY DEFINITIONS (RLS not yet ENABLED on the 4 existing tables)
-- =============================================================================
-- Phase B-1 defines the policies; Phase B-2 enables RLS on each table via
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
--
-- All policies wrap helper calls as `(select private.helper())` (m1 S48) and
-- use the PARAMETERLESS helper signatures (M1 S49) so Postgres compiles each
-- subquery as an InitPlan (evaluated once per query) instead of a SubPlan
-- (per-row). All policies explicitly target the `authenticated` role (m2 S48)
-- — service-role bypasses RLS.

-- -----------------------------------------------------------------------------
-- §5.1 — research_queue policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS rq_select ON public.research_queue;
DROP POLICY IF EXISTS rq_insert ON public.research_queue;
DROP POLICY IF EXISTS rq_update ON public.research_queue;
DROP POLICY IF EXISTS rq_delete ON public.research_queue;

CREATE POLICY rq_select ON public.research_queue
  FOR SELECT
  TO authenticated
  USING (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_insert ON public.research_queue
  FOR INSERT
  TO authenticated
  WITH CHECK (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_update ON public.research_queue
  FOR UPDATE
  TO authenticated
  USING      (organization_id = (select private.auth_user_organization_id()))
  WITH CHECK (organization_id = (select private.auth_user_organization_id()));

CREATE POLICY rq_delete ON public.research_queue
  FOR DELETE
  TO authenticated
  USING (organization_id = (select private.auth_user_organization_id()));


-- -----------------------------------------------------------------------------
-- §5.2 — organization_members policies
-- -----------------------------------------------------------------------------
-- Q7 (S48, Codex stricter default): members see THEIR OWN row only; owners see
-- ALL members of their org. Easier to loosen later than tighten.
--
-- M1 refactor: USING and WITH CHECK clauses use parameterless helpers to
-- enable InitPlan evaluation. Semantically equivalent to v1's
-- auth_user_is_org_owner(organization_id) under UNIQUE(user_id).

DROP POLICY IF EXISTS om_select ON public.organization_members;
DROP POLICY IF EXISTS om_insert ON public.organization_members;
DROP POLICY IF EXISTS om_update ON public.organization_members;
DROP POLICY IF EXISTS om_delete ON public.organization_members;

CREATE POLICY om_select ON public.organization_members
  FOR SELECT
  TO authenticated
  USING (
    user_id = (select auth.uid())
    OR (
      (select private.auth_user_is_owner())
      AND organization_id = (select private.auth_user_organization_id())
    )
  );

CREATE POLICY om_insert ON public.organization_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (select private.auth_user_organization_id())
    AND (select private.auth_user_is_owner())
  );

CREATE POLICY om_update ON public.organization_members
  FOR UPDATE
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  )
  WITH CHECK (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

CREATE POLICY om_delete ON public.organization_members
  FOR DELETE
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );


-- -----------------------------------------------------------------------------
-- §5.3 — organization_invitations policies (owner-only SELECT/INSERT/DELETE; NO UPDATE)
-- -----------------------------------------------------------------------------
-- CG1 (S48): correct table name is `organization_invitations` (plural).

DROP POLICY IF EXISTS oi_select ON public.organization_invitations;
DROP POLICY IF EXISTS oi_insert ON public.organization_invitations;
DROP POLICY IF EXISTS oi_delete ON public.organization_invitations;

CREATE POLICY oi_select ON public.organization_invitations
  FOR SELECT
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

CREATE POLICY oi_insert ON public.organization_invitations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (select private.auth_user_organization_id())
    AND (select private.auth_user_is_owner())
  );

CREATE POLICY oi_delete ON public.organization_invitations
  FOR DELETE
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

-- Intentionally NO oi_update policy: invitations are immutable once issued.
-- Accept flow rotates by DELETE + INSERT, never UPDATE.


-- -----------------------------------------------------------------------------
-- §5.4 — organizations policies (SELECT for members; UPDATE for owners)
-- -----------------------------------------------------------------------------
-- Q8 (S48): no authenticated INSERT/DELETE on organizations; service-role only
-- via admin provisioning script.
-- G2 (S48): owners UPDATE org name (workspace rename forward-compat).

DROP POLICY IF EXISTS orgs_select ON public.organizations;
DROP POLICY IF EXISTS orgs_update ON public.organizations;

CREATE POLICY orgs_select ON public.organizations
  FOR SELECT
  TO authenticated
  USING (id = (select private.auth_user_organization_id()));

CREATE POLICY orgs_update ON public.organizations
  FOR UPDATE
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND id = (select private.auth_user_organization_id())
  )
  WITH CHECK (
    (select private.auth_user_is_owner())
    AND id = (select private.auth_user_organization_id())
  );

-- Intentionally NO authenticated INSERT/DELETE policy on organizations.


-- -----------------------------------------------------------------------------
-- §5.5 — organizations immutable-columns trigger (Codex S49 M1)
-- -----------------------------------------------------------------------------
-- orgs_update permits owners to UPDATE org rows for workspace rename (G2 S48).
-- Without this trigger, owners could also mutate `id`, `slug`, and `created_at`
-- once Phase B-2 enables RLS — `slug` is treated as immutable infrastructure
-- identity by Phase A migration line 80 + downstream URL routing / audit
-- lineage. RLS WITH CHECK can't compare NEW to OLD, so a trigger is the right
-- enforcement point. Fires for both service-role and authenticated callers —
-- defense-in-depth for both surfaces.

CREATE OR REPLACE FUNCTION private.organizations_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = private, public, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'organizations.id is immutable';
    END IF;
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN
      RAISE EXCEPTION 'organizations.slug is immutable (it is infrastructure identity used by URL routing + audit lineage)';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'organizations.created_at is immutable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.organizations_immutable_columns() IS
  'Phase B-1: BEFORE UPDATE trigger on public.organizations. Blocks mutation of id, slug, and created_at — only `name` can change via the orgs_update RLS policy. Catches the column-level mutation surface RLS WITH CHECK cannot constrain.';

DROP TRIGGER IF EXISTS organizations_immutable_columns ON public.organizations;

CREATE TRIGGER organizations_immutable_columns
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION private.organizations_immutable_columns();


-- =============================================================================
-- §6 — audit_storage_writes (NEW; RLS ENABLED at create-time)
-- =============================================================================
-- Q3 (S48): concretized compensating control for keeping the worker on
-- service-role. Every storage upload site (refactored post-merge to use
-- agent/lib/storage-paths.ts) appends one row here immediately after the
-- Supabase upload completes. Best-effort write — failure logged but does NOT
-- block the upload (audit must not be a single-point-of-failure choke).
-- W7 in plan §6.4 verifies the hook fires exactly once per upload.
--
-- Safe to ENABLE RLS at create-time: the table is brand new (zero existing
-- rows + zero existing traffic), so the cutover-risk argument that motivates
-- the B-1/B-2 split doesn't apply here.
--
-- M2 (S49 Gemini): v1 used ON DELETE SET NULL on both FK columns, which would
-- silently orphan audit rows when an org or queue row was purged AND make
-- those orphaned rows invisible to authenticated owners (asw_select policy
-- requires org_id to be non-NULL). v2 uses ON DELETE RESTRICT — forensic
-- immutability is the primary purpose of an audit log, and forcing the admin
-- tooling to handle audit-log cleanup explicitly before deleting an org or
-- queue row is the right operational posture. Org deletion is service-role
-- only and rare; research_queue rows are not deleted in normal operation
-- (status changes instead).

CREATE TABLE IF NOT EXISTS public.audit_storage_writes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  written_at         timestamptz NOT NULL DEFAULT now(),
  caller             text NOT NULL,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id)  ON DELETE RESTRICT,
  research_queue_id  uuid          REFERENCES public.research_queue(id) ON DELETE RESTRICT,
  object_path        text NOT NULL,
  bytes              bigint,
  http_status        int NOT NULL
);

COMMENT ON TABLE public.audit_storage_writes IS
  'Phase B-1: append-only audit log for service-role storage writes (compensating control for the worker-on-service-role posture). ON DELETE RESTRICT on both FKs preserves forensic immutability (M2 S49 Gemini) — admin tooling must explicitly handle audit data before deleting an org or queue row.';

CREATE INDEX IF NOT EXISTS audit_storage_writes_written_at_idx
  ON public.audit_storage_writes (written_at DESC);

CREATE INDEX IF NOT EXISTS audit_storage_writes_org_idx
  ON public.audit_storage_writes (organization_id, written_at DESC);

ALTER TABLE public.audit_storage_writes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asw_select ON public.audit_storage_writes;

CREATE POLICY asw_select ON public.audit_storage_writes
  FOR SELECT
  TO authenticated
  USING (
    (select private.auth_user_is_owner())
    AND organization_id = (select private.auth_user_organization_id())
  );

-- Intentionally NO INSERT/UPDATE/DELETE policy on audit_storage_writes:
-- authenticated clients cannot mutate the audit log. Service-role bypasses RLS
-- for INSERT.


-- =============================================================================
-- §7 — EXECUTE grants on helper functions (m3 S48)
-- =============================================================================
-- Explicit REVOKE PUBLIC + GRANT authenticated, not implicit. anon does NOT get
-- EXECUTE (anon should not resolve helpers); service_role bypasses RLS anyway.

REVOKE ALL ON FUNCTION private.auth_user_organization_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.auth_user_is_owner()        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION private.auth_user_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_user_is_owner()        TO authenticated;
