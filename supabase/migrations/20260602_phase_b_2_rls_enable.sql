-- Multi-Tenancy Phase B-2 — RLS-enforce assertion + DROP DEFAULT + CHECK NOT NULL
--
-- Implements Documentation/wave-b-2-rls-enable-design-gate.md v3 (S80, 2026-06-01).
-- DESIGN-gate ratified S80 via sequential Gemini round 1 → Codex round 1 MRPF (9
-- findings, all ACCEPTED, 0 CRITICAL). User confirmed Option B (DROP DEFAULT +
-- CHECK NOT NULL) at the Phase 1 → 2 gate.
-- See Documentation/wave-b-2-rls-enable-design-gate-peer-review.md for the audit
-- trail.
-- MERGE-gate sequential review on THIS SQL pending (Phase 2.2-2.3 of S80).
--
-- Scope (IN):
--   §1  Pre-flight assertion: relrowsecurity = true on the 4 tenant tables +
--       zero NULL organization_id rows in research_queue.
--   §2  Idempotent ALTER TABLE … ENABLE ROW LEVEL SECURITY (defense-in-depth
--       no-op against the unlikely event that someone DISABLEd RLS between
--       the S80 probe and apply).
--   §3  ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT
--   §4  ALTER TABLE public.research_queue ADD CONSTRAINT
--         research_queue_org_id_not_null CHECK (organization_id IS NOT NULL)
--       (Gemini G-MAJ-1: closes the silent-NULL gap window for ALL roles
--        including service-role.)
--   §5  COMMENT ON COLUMN documentation.
--
-- Scope (OUT — deferred to Phase C):
--   - ALTER TABLE public.research_queue ALTER COLUMN organization_id SET NOT NULL
--     (the CHECK constraint in §4 is the bridge; SET NOT NULL canonicalises it
--     when Phase C lands)
--
-- Deployment path: supabase db push --linked
--   - filename uses UNDERSCORE separator (S46 C1)
--   - NO file-level BEGIN/COMMIT (S46 C2: Supabase CLI's ExecBatch wraps the
--     migration + the schema_migrations history insert in one implicit txn)
--   - NO SET LOCAL; use plain SET for session-scoped timeouts on the dedicated
--     migration connection (S47 finding + Codex C-MAJ-1 verification S80)
--
-- Pre-apply tests:  bash agent/scripts/test-phase-b-rls.sh postmerge   (B-1 harness; must NOT regress)
-- Post-apply tests: inline psql per design §7 (B2-T1 .. B2-T11 captured manually
--                   this phase; a dedicated b2-postmerge harness mode is a
--                   follow-up task — MERGE-gate Codex C-MIN-2 acknowledges the
--                   gap and accepts inline-execution for B-2 to keep diff
--                   within the pre-auth 1-migration / 2-doc bound)
--
-- Rollback (design doc §6.2):
--   ALTER TABLE public.research_queue DROP CONSTRAINT IF EXISTS research_queue_org_id_not_null;
--   ALTER TABLE public.research_queue
--     ALTER COLUMN organization_id SET DEFAULT '4ece2f20-f2fc-4f8f-afce-59806d92a11b'::uuid;
--   -- (DISABLE RLS only if RLS-breaks-app, not for DROP-DEFAULT or CHECK alone)


SET lock_timeout = '5s';
SET statement_timeout = '15s';


-- =============================================================================
-- §1 — Pre-flight assertions
-- =============================================================================
-- Fail-loud before any DDL if (a) RLS got DISABLEd on a tenant table between the
-- S80 probe and apply, or (b) any NULL organization_id rows snuck in
-- (CHECK NOT NULL in §4 would fail validation; surface that here with a clearer
-- message).

-- Schema-qualified via to_regclass per MERGE-gate Codex C-MIN-1: avoids the
-- pg_class.relname ambiguity (e.g. a same-named table in another schema would
-- false-fail/pass otherwise). Includes audit_storage_writes per MERGE-gate
-- Gemini G-MIN-2: the entire tenant-boundary perimeter is 5 tables, not just
-- the 4 Phase-A tables. Missing table → to_regclass returns NULL → fail-loud.
DO $$
DECLARE
  v_table text;
  v_oid oid;
  v_missing text := '';
  v_disabled text := '';
  v_rowsec boolean;
  v_null_count bigint;
  v_perimeter constant text[] := ARRAY[
    'public.research_queue',
    'public.organization_members',
    'public.organization_invitations',
    'public.organizations',
    'public.audit_storage_writes'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_perimeter LOOP
    v_oid := to_regclass(v_table);
    IF v_oid IS NULL THEN
      v_missing := v_missing || v_table || ',';
      CONTINUE;
    END IF;
    SELECT relrowsecurity INTO v_rowsec FROM pg_class WHERE oid = v_oid;
    IF v_rowsec IS NOT TRUE THEN
      v_disabled := v_disabled || v_table || ',';
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'Phase B-2 precondition violated: tenant-perimeter table(s) missing: %', rtrim(v_missing, ',');
  END IF;

  IF v_disabled <> '' THEN
    RAISE EXCEPTION 'Phase B-2 precondition violated: RLS DISABLED on: %', rtrim(v_disabled, ',');
  END IF;

  SELECT COUNT(*) INTO v_null_count
  FROM public.research_queue
  WHERE organization_id IS NULL;

  IF v_null_count > 0 THEN
    RAISE EXCEPTION 'Phase B-2 precondition violated: % NULL organization_id rows found in research_queue (CHECK NOT NULL in §4 would fail validation)', v_null_count;
  END IF;
END $$;


-- =============================================================================
-- §2 — Idempotent ENABLE ROW LEVEL SECURITY (defense-in-depth no-op).
-- =============================================================================
-- Live state at the S80 probe (2026-06-01 20:35Z): relrowsecurity = true on all
-- 4 tables. These statements are no-ops in the current state but assert intent
-- declaratively and recover the table to ENABLED if §1 somehow let a DISABLED
-- state slip through (it shouldn't — §1 fails first).

ALTER TABLE public.research_queue           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations            ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- §3 — DROP DEFAULT on research_queue.organization_id.
-- =============================================================================
-- Phase A's transitional DEFAULT (system-default org UUID '4ece2f20-…-a11b')
-- is no longer needed: both live INSERT paths write organization_id explicitly
-- via getOrgContextDualPath() —
--   - frontend/app/api/queue/route.ts:120-124
--   - frontend/app/api/runs/[slug]/replay/route.ts:180-184
-- Worker daemon does NOT INSERT into research_queue (claim/update only;
-- Codex C-MIN-1 verified exhaustive grep across agent/+frontend/+supabase/).
--
-- Dropping the DEFAULT makes "INSERT without organization_id" a constraint
-- violation (§4 enforces NOT NULL) rather than a silent misroute to
-- system-default.
--
-- ALTER COLUMN … DROP DEFAULT is natively idempotent in PostgreSQL — succeeds
-- silently whether or not a default exists on the column.

ALTER TABLE public.research_queue ALTER COLUMN organization_id DROP DEFAULT;


-- =============================================================================
-- §4 — CHECK constraint: organization_id IS NOT NULL (Gemini G-MAJ-1).
-- =============================================================================
-- Closes the silent-NULL gap window for ALL callers — service-role,
-- authenticated, and anon alike. RLS policies hide NULL rows from authenticated
-- readers (the predicate `organization_id = auth_user_organization_id()`
-- evaluates to UNKNOWN against NULL → effectively false) but do NOT prevent
-- a service-role INSERT from writing a NULL row — that's the gap. A CHECK
-- constraint is enforced at the relation level by all roles, closing the gap.
--
-- Existing 44 rows in research_queue all have non-NULL organization_id
-- (verified via §1 preflight + S80 design-doc §1.4); the constraint validation
-- in this DDL completes in microseconds.
--
-- Idempotency posture: PG17 does NOT support `ADD CONSTRAINT IF NOT EXISTS`
-- for CHECK constraints (verified against PG17 ALTER TABLE docs per Codex
-- C-MIN-3). Direct psql replay would raise SQLSTATE 42710 (duplicate_object) —
-- intentionally fail-loud. supabase db push skips already-applied migrations
-- via supabase_migrations.schema_migrations history; it is NOT a drift
-- detector.
--
-- Phase C will add SET NOT NULL alongside; CHECK + NOT NULL is over-determined
-- but not erroneous. If Phase C ever drops the CHECK in favour of NOT NULL,
-- semantics are preserved.

ALTER TABLE public.research_queue
  ADD CONSTRAINT research_queue_org_id_not_null CHECK (organization_id IS NOT NULL);


-- =============================================================================
-- §5 — Column documentation.
-- =============================================================================
COMMENT ON COLUMN public.research_queue.organization_id IS
  'Phase B-2 (2026-06-02): transitional DEFAULT removed; CHECK NOT NULL constraint added (research_queue_org_id_not_null). Every INSERT must specify organization_id explicitly. Phase C will canonicalise via SET NOT NULL.';
