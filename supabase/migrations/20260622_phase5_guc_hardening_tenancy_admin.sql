-- =============================================================================
-- 20260622_phase5_guc_hardening_tenancy_admin.sql
-- Phase 5 GUC-hardening fast-follow (decision #2, S150) — admin-gated escape hatch
-- =============================================================================
-- Replaces the BARE `app.allow_org_migration` GUC check in BOTH tenant-boundary
-- triggers with a TWO-FACTOR gate: the GUC must be set AND the session must be a
-- member of a dedicated, NOLOGIN `tenancy_admin` role. This decouples "can set a
-- session-level GUC" (reachable from any server-side raw-SQL path) from "is
-- authorized to migrate a tenant boundary" (must be a tenancy_admin).
--
-- WHY both triggers in one migration (decision #2, rationale #2): the flag
-- disables BOTH tenant-boundary triggers — B-1's organization_id immutability AND
-- Phase 5's parent-same-org. Hardening only one would leave two DIFFERENT bypass
-- mechanisms; the weaker one would set the effective security level. So the swap
-- must be all-or-nothing across both, and that touches B-1's shipped surface —
-- which is why this is a tracked, separately-gated fast-follow, not folded into
-- the Phase 5 migration.
--
-- ORDERING / VERSION (deliberate 2026-06-22, one day after the 20260621 Phase 5
-- trigger): a same-date `20260621_*` sibling would (a) COLLIDE on the supabase
-- migration version token `20260621` and be SILENTLY skipped
-- (feedback_supabase_migration_version_collision_silent_skip), and (b) sort
-- BEFORE `20260621_phase5_parent_same_org_trigger.sql` on a fresh rebuild:
-- digits (0x30-0x39) sort BEFORE '_' (0x5f), so a longer same-date name
-- (e.g. 20260621120000_guc...) has a digit where the Phase 5 file has '_' and
-- thus sorts FIRST — letting that file's later CREATE OR REPLACE overwrite this
-- hardening back to the bare GUC. A strictly-greater date is the only filename
-- that yields BOTH a distinct token AND correct after-Phase-5 ordering under
-- this YYYYMMDD_ scheme.
--
-- IDEMPOTENT: CREATE ROLE guarded by a pg_roles existence check; CREATE OR
-- REPLACE for the helper + both trigger functions. No data writes.
--
-- RISK: SECURITY + DATA + AGENT BEHAVIOR + ARCHITECTURE (touches the B-1 tenant
-- boundary). Apply LOCAL first (re-run test-ssr-auth-cutover.sh 24/24 + the new
-- P3/P3b escape-hatch arm), then prod via `supabase db push --linked` with
-- explicit human confirm.
--
-- ROLLBACK:
--   CREATE OR REPLACE ... (re-apply the bare-GUC bodies of both trigger fns);
--   DROP FUNCTION IF EXISTS private.org_migration_enabled();
--   DROP ROLE IF EXISTS tenancy_admin;   -- only if no grants depend on it
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §1 — Dedicated break-glass admin role + membership.
-- -----------------------------------------------------------------------------
-- NOLOGIN: cannot authenticate directly; it is a pure marker. The gate's second
-- factor is pg_has_role(session_user, 'tenancy_admin', 'MEMBER').
--
-- GRANT tenancy_admin TO postgres (v3, Codex C-MAJ-2): on Supabase the `postgres`
-- role is NOT a superuser (only `supabase_admin` is), so postgres does NOT
-- implicitly pass pg_has_role(...). Yet `postgres` is the canonical break-glass
-- identity (dashboard SQL editor / direct admin connection). So it MUST be an
-- explicit member or break-glass would be impossible. The app roles
-- (anon/authenticated/service_role/authenticator) are deliberately NOT members:
-- the app reaches the DB as `authenticator` → `SET ROLE service_role`, leaving
-- session_user = authenticator, which is not a member → the app can never satisfy
-- the gate even if it set the GUC. That non-membership IS the security win.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_admin') THEN
    CREATE ROLE tenancy_admin NOLOGIN;
  END IF;
END
$$;

GRANT tenancy_admin TO postgres;

COMMENT ON ROLE tenancy_admin IS
  'Phase 5 GUC-hardening: NOLOGIN marker role. Membership (pg_has_role(session_user, ...)) is the SECOND factor — alongside app.allow_org_migration=true — that private.org_migration_enabled() requires to permit a tenant-boundary override. Member: postgres (canonical break-glass; not a superuser on Supabase so the grant is required). NEVER grant to anon/authenticated/service_role/authenticator.';

-- -----------------------------------------------------------------------------
-- §2 — Two-factor gate helper.
-- -----------------------------------------------------------------------------
-- Anchored on session_user, NOT current_user. The Phase 5 trigger is SECURITY
-- DEFINER, so INSIDE it current_user is the function OWNER (postgres), not the
-- caller — current_user would be wrong (trivially "satisfied" by the definer).
-- session_user is the original authenticated LOGIN role and is immutable across
-- SECURITY DEFINER boundaries, so it faithfully identifies the break-glass
-- operator regardless of how many SET ROLE / SECURITY DEFINER frames are stacked.
--
-- SECURITY INVOKER (default): both checks are argument-driven (current_setting on
-- a custom GUC, pg_has_role on an explicit role) and need no elevated privilege.
-- STABLE: depends only on session state within a statement. search_path pinned to
-- pg_catalog so the bare function names resolve to the catalog regardless of
-- caller search_path.
CREATE OR REPLACE FUNCTION private.org_migration_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(current_setting('app.allow_org_migration', true), 'false') = 'true'
         AND pg_has_role(session_user, 'tenancy_admin', 'MEMBER');
$$;

COMMENT ON FUNCTION private.org_migration_enabled() IS
  'Phase 5 GUC-hardening: TRUE only when app.allow_org_migration=true AND session_user is a member of tenancy_admin. The role-membership second factor decouples "can set the GUC" from "authorized to migrate a tenant boundary". Anchored on session_user so a SECURITY DEFINER caller cannot satisfy it via the definer identity.';

-- GRANTS — PUBLIC EXECUTE (the default for a function), set EXPLICITLY here.
--
-- The helper is a NON-SENSITIVE boolean predicate: it returns
--   (GUC='true' AND pg_has_role(session_user,'tenancy_admin','MEMBER'))
-- and grants NO capability. The enforcement point is the two SECURITY DEFINER
-- triggers, which call it internally as their OWNER; a direct call by any app
-- role just yields `false` (non-members) and lets them DO nothing. So leaving it
-- world-executable is security-neutral, and the gate's boundary is unchanged.
--
-- WHY NOT `REVOKE ALL FROM PUBLIC` (the v3 design's posture, REVERSED at the S154
-- MERGE gate, Gemini CRITICAL + MAJOR):
--   1. DoS landmine (CRITICAL). On PostgreSQL 17.x a DIRECT call to a non-inlinable
--      SQL function in `private` by a role that LACKS EXECUTE does not raise a clean
--      "permission denied" — it SEGFAULTS the backend (signal 11). Reproduced and
--      root-caused at S154 to a GENERIC platform behavior (even a trivial
--      `SELECT true` with a SET clause crashes on the EXECUTE-denied path), NOT to
--      this function's body. With REVOKE-FROM-PUBLIC, any future reuse of this helper
--      — e.g. a new RLS policy `USING (... OR private.org_migration_enabled())`
--      evaluated as service_role — would crash the DB instead of erroring. (Verified
--      S154: making the helper SECURITY DEFINER does NOT prevent it — the EXECUTE
--      check is on the CALLER regardless of DEFINER/INVOKER; only GRANTING execute
--      removes the crashing permission-denied path.) PUBLIC EXECUTE eliminates that
--      path for every caller. Roles without `private` schema USAGE (anon/authenticated
--      after the ntfy hardening) still get a CLEAN schema-permission error, not a crash
--      (verified S154) — so this does NOT re-grant them private USAGE and does NOT undo
--      the ntfy hardening.
--   2. Owner-agnostic (MAJOR). The trigger->helper call must succeed whatever role
--      OWNS the triggers in prod. A `GRANT EXECUTE TO postgres` only works if the owner
--      is exactly postgres; if a platform change / restore / future migration made the
--      owner supabase_admin (or anything else), EVERY research_queue INSERT/UPDATE would
--      fail permission-denied -> total outage. PUBLIC includes any owner, so the call
--      works regardless. (The owner question therefore no longer needs an IMPL-VERIFY
--      gate; it is mooted by PUBLIC EXECUTE.)
GRANT EXECUTE ON FUNCTION private.org_migration_enabled() TO PUBLIC;

-- -----------------------------------------------------------------------------
-- §3 — Swap B-1's immutable-org trigger onto the two-factor gate.
-- -----------------------------------------------------------------------------
-- TWO changes vs the shipped B-1 fn:
--  (1) SECURITY DEFINER added (v3, Codex C-CRIT-1/C-CRIT-2). The shipped B-1 fn is
--      SECURITY INVOKER; if it stayed INVOKER, its call to private.org_migration_enabled()
--      would execute as the invoker (e.g. `authenticated`, who LOST `private` USAGE in
--      the ntfy migration) and fail with "permission denied for schema private" the
--      moment a caller attempts an org_id change. As DEFINER the call runs as the owner
--      (postgres, who holds `private` USAGE), so no app-role grant is needed and the ntfy
--      hardening is preserved. B-1's body reads only OLD/NEW + RAISEs (no table access),
--      so DEFINER introduces no privilege-escalation surface; the gate still keys on
--      session_user (immutable across DEFINER), so the boundary is unchanged.
--  (2) Generic error message (drops the GUC-name oracle the shipped text leaked:
--      "set app.allow_org_migration=true to override"), aligning with the Phase 5 trigger.
-- SET search_path is retained (already present on the shipped fn).
CREATE OR REPLACE FUNCTION private.research_queue_immutable_org_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND OLD.organization_id IS DISTINCT FROM NEW.organization_id
     AND NOT private.org_migration_enabled() THEN
    RAISE EXCEPTION 'research_queue.organization_id is immutable';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.research_queue_immutable_org_id() IS
  'Phase B-1 (Phase 5-hardened): BEFORE UPDATE on public.research_queue. SECURITY DEFINER so its call to private.org_migration_enabled() runs as owner (postgres) and does not require app roles to hold private USAGE. Blocks org_id mutation unless private.org_migration_enabled() (GUC + tenancy_admin membership). Generic message — does not leak the bypass-flag name.';

-- -----------------------------------------------------------------------------
-- §4 — Swap the Phase 5 parent-same-org trigger onto the same gate.
-- -----------------------------------------------------------------------------
-- SQL SEMANTICS identical to 20260621_phase5_parent_same_org_trigger.sql — the
-- only behavioral change is the escape-hatch predicate (bare current_setting →
-- the helper). SECURITY DEFINER, FOR SHARE (decision #1), the generic oracle-safe
-- message + ERRCODE, the NOT-NULL-aware nonexistence handling, and the REVOKE are
-- all preserved. (v3, Codex C-MIN-1: the inline comments are updated to describe
-- the helper, so this is NOT a byte-for-byte copy of the shipped comments — only
-- the executable SQL is semantically identical bar the predicate.)
CREATE OR REPLACE FUNCTION private.research_queue_parent_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
DECLARE
  v_parent_org uuid;
BEGIN
  IF NEW.parent_run_id IS NULL THEN
    RETURN NEW;  -- fresh submission, no lineage to validate
  END IF;

  -- Admin tenancy-migration escape hatch — now two-factor (GUC + tenancy_admin)
  -- via private.org_migration_enabled(), aligned with research_queue_immutable_org_id
  -- (B-1 §3) so a parent+child set can be moved atomically under one session
  -- without a transient cross-org window. Any session that trips this MUST run
  -- the §4.2 cross-org-link audit as a post-condition.
  IF private.org_migration_enabled() THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE (decision #1): shared, single-row, PK-indexed lock on the parent.
  -- The implicit FOR KEY SHARE a child INSERT takes blocks only key changes +
  -- DELETEs and PERMITS a concurrent plain UPDATE of the non-key organization_id
  -- (the break-glass org-move); FOR SHARE blocks that too, closing the
  -- read-vs-commit TOCTOU. Shared locks are mutually compatible, so N concurrent
  -- children of one parent do NOT serialize. Does NOT cover the inverse
  -- parent-move-strands-children case — that stays mitigated by the §4.2 audit.
  SELECT organization_id INTO v_parent_org
  FROM public.research_queue
  WHERE id = NEW.parent_run_id
  FOR SHARE;

  -- organization_id is NOT NULL on every row (research_queue_org_id_not_null
  -- CHECK, B-2 §4), so v_parent_org IS NULL <=> parent not found — leave
  -- nonexistence to the FK (fires AFTER BEFORE-triggers); do not mask it here.
  IF v_parent_org IS NOT NULL
     AND v_parent_org IS DISTINCT FROM NEW.organization_id THEN
    -- Generic message: do NOT echo v_parent_org (would turn the trigger into a
    -- cross-org oracle). The caller-supplied parent_run_id is safe to echo.
    RAISE EXCEPTION
      'parent_run_id % references a run in a different organization or does not exist',
      NEW.parent_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.research_queue_parent_same_org() IS
  'Phase 5 (GUC-hardened): BEFORE INSERT/UPDATE on public.research_queue. Rejects a child whose parent_run_id references a run in a different organization. SECURITY DEFINER so the lookup bypasses RLS and sees the true parent org; FOR SHARE locks the parent against a concurrent org-move. Escape hatch is private.org_migration_enabled() (GUC + tenancy_admin). Catches the service-role / direct-SQL cross-tenant-lineage vector RLS cannot.';

REVOKE ALL ON FUNCTION private.research_queue_parent_same_org() FROM PUBLIC;
