-- Phase 5 §1 — parent-same-org fence on research_queue (Component 1)
--
-- Implements Documentation/phase5-parent-same-org-and-rls-harness-design.md
-- (v3-FINAL §3, DESIGN gate CLOSED S148) + the open-fork decisions in
-- Documentation/phase5-decisions-s150.md.
--   Decision #1 (S150): parent lookup uses `FOR SHARE` (closes the cross-session
--     TOCTOU the FK's implicit FOR KEY SHARE does not — see §1 below).
--   Decision #2 (S150): keep the bare app.allow_org_migration GUC here (parity
--     with research_queue_immutable_org_id, B-1 §4); admin-gated-enabler
--     hardening of BOTH triggers is a tracked B-1-touching fast-follow, not
--     folded in.
--
-- WHAT BAD OUTCOME THIS PREVENTS: a child run (parent_run_id IS NOT NULL) whose
-- parent lives in a DIFFERENT organization — a cross-tenant lineage link. RLS
-- rq_insert only constrains the child's own organization_id; it says NOTHING
-- about parent_run_id, and the worker daemon / every server path uses the
-- service-role key, which BYPASSES RLS entirely. This trigger is the matching
-- DB-level fence for that vector, mirroring research_queue_immutable_org_id
-- (B-1 §4) and organizations_immutable_columns (B-1 §5.5). It is
-- defense-in-depth: the app layer already org-scopes the parent lookup
-- (queue/route.ts, replay/route.ts both `.eq("organization_id", orgId)`), but
-- the trigger backstops the service-role / direct-SQL / future-code paths that
-- never pass through those routes.
--
-- MRPF: MERGE gate, SECURITY (tenant isolation) + DATA + ARCHITECTURE, NORMAL.
-- Full tri-vendor gate (Gemini + Codex + Claude) must clear BEFORE any prod
-- apply (project §11 agent-prod HARD RULE). Companion synthesis:
-- Documentation/phase5-parent-same-org-and-rls-harness-merge-gate-peer-review.md.
-- Validated by agent/scripts/test-ssr-auth-cutover.sh against a NON-PROD target.
--
-- Deployment path: supabase db push --linked
--   - filename uses an UNDERSCORE separator (else `db push` silently skips it).
--   - NO file-level BEGIN/COMMIT (the CLI ExecBatch wraps the file + the
--     schema_migrations history insert in one implicit txn).
--   - NO SET LOCAL; plain SET for the session-scoped timeouts on the dedicated
--     migration connection (SET LOCAL warns 25P01 outside an explicit txn).
--   - Apply ONLY via `supabase db push` — never the Studio SQL Editor (bypasses
--     migration history).
--   - Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS / CREATE.
--
-- Rollback (additive, no data mutation — strictly reversible):
--   DROP TRIGGER IF EXISTS research_queue_parent_same_org ON public.research_queue;
--   DROP FUNCTION IF EXISTS private.research_queue_parent_same_org();
--   (No RLS change, no column change, no backfill.)


SET lock_timeout = '5s';
SET statement_timeout = '15s';


-- =============================================================================
-- §0 — Pre-apply audit (fail-loud BLOCKING preflight). Design §4.2 / G-INFO-1.
-- =============================================================================
-- This trigger is BEFORE INSERT/UPDATE only; it does NOT retroactively validate
-- rows already stored. A latent cross-org lineage link present before apply
-- would survive the migration and silently violate the boundary the trigger
-- asserts. Fail loud instead of trusting an operator to run the manual query.
-- Prod has exactly one org (system-default) → expected count is 0. If this ever
-- returns rows, remediate (re-parent or NULL parent_run_id) BEFORE applying.
-- Runs inside the same CLI-wrapped implicit txn as the DDL, so an abort leaves
-- nothing partially applied.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.research_queue c
  JOIN public.research_queue p ON p.id = c.parent_run_id
  WHERE c.organization_id IS DISTINCT FROM p.organization_id;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Phase 5 precondition violated: % existing cross-org parent link(s) found — remediate before applying the trigger', v_bad;
  END IF;
END $$;


-- =============================================================================
-- §1 — Trigger function: private.research_queue_parent_same_org()
-- =============================================================================
-- SECURITY DEFINER: the internal parent lookup must see the TRUE parent row
-- regardless of the caller's RLS visibility. An `authenticated` caller cannot
-- SELECT a foreign-org parent (rq_select hides it); without DEFINER the lookup
-- would return NULL and we could not distinguish "foreign org" (must BLOCK)
-- from "nonexistent" (let the FK reject it). Owned by the migration role
-- (postgres), which bypasses RLS, so the lookup always observes the real org.
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

  -- Admin tenancy-migration escape hatch — aligned with
  -- research_queue_immutable_org_id (B-1 §4) so a parent+child set can be moved
  -- atomically under one session flag without a transient cross-org window.
  -- NEVER set in worker code or user-facing routes. (Decision #2: kept bare in
  -- Phase 5; admin-gated-enabler hardening of both triggers is a tracked
  -- fast-follow. Any session that sets this flag MUST run the §4.2 cross-org-
  -- link audit as a post-condition — see design §3.3/§3.4.)
  IF COALESCE(current_setting('app.allow_org_migration', true), 'false') = 'true' THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE (decision #1): a shared, single-row, PK-indexed lock on the
  -- parent. Inserting a child already takes an implicit FOR KEY SHARE via
  -- referential integrity, but FOR KEY SHARE only blocks key-column changes +
  -- DELETEs — it PERMITS a concurrent plain UPDATE of the non-key
  -- organization_id (the break-glass org-move). FOR SHARE blocks that too,
  -- closing the read-vs-commit TOCTOU. Shared locks are mutually compatible, so
  -- N concurrent children of one parent do NOT serialize against each other;
  -- the only thing it blocks is an exclusive UPDATE/DELETE of the parent — i.e.
  -- the rare admin org-move, which is exactly the contention we want to
  -- serialize. Does NOT cover the inverse parent-move-strands-children case
  -- (C-MAJ-3) — that stays mitigated by the mandatory post-GUC §4.2 audit.
  SELECT organization_id INTO v_parent_org
  FROM public.research_queue
  WHERE id = NEW.parent_run_id
  FOR SHARE;

  -- organization_id is NOT NULL on every row (research_queue_org_id_not_null
  -- CHECK, B-2 §4). So v_parent_org IS NULL <=> parent row not found — leave
  -- nonexistence to the FK constraint (which fires AFTER BEFORE-triggers); do
  -- not mask it here.
  IF v_parent_org IS NOT NULL
     AND v_parent_org IS DISTINCT FROM NEW.organization_id THEN
    -- Generic message (G-MIN-1): do NOT echo v_parent_org. Echoing the parent's
    -- organization_id turns the trigger into an oracle — a user with only
    -- INSERT rights in their own org could guess parent_run_id UUIDs and read
    -- back which org each belongs to without any SELECT visibility. The
    -- non-tenant detail (the offending parent_run_id, caller-supplied) is safe.
    RAISE EXCEPTION
      'parent_run_id % references a run in a different organization or does not exist',
      NEW.parent_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.research_queue_parent_same_org() IS
  'Phase 5: BEFORE INSERT/UPDATE on public.research_queue. Rejects a child whose parent_run_id references a run in a different organization. SECURITY DEFINER so the lookup bypasses RLS and sees the true parent org; FOR SHARE locks the parent against a concurrent org-move. Honours app.allow_org_migration. Catches the service-role / direct-SQL cross-tenant-lineage vector RLS cannot.';

REVOKE ALL ON FUNCTION private.research_queue_parent_same_org() FROM PUBLIC;


-- =============================================================================
-- §2 — Trigger binding
-- =============================================================================
-- OF parent_run_id, organization_id (G-MIN-2): fire only when a lineage-relevant
-- column changes (or on any INSERT). organization_id is immutable
-- (research_queue_immutable_org_id), so in practice this fires on INSERT and on
-- the rare parent_run_id mutation — NOT on the high-frequency status/updated_at
-- UPDATE path. The OF list constrains only the UPDATE event; INSERT always
-- fires the trigger regardless (correct — a fresh row's lineage must be
-- validated). Standard PostgreSQL CREATE TRIGGER semantics.
DROP TRIGGER IF EXISTS research_queue_parent_same_org ON public.research_queue;

CREATE TRIGGER research_queue_parent_same_org
  BEFORE INSERT OR UPDATE OF parent_run_id, organization_id ON public.research_queue
  FOR EACH ROW
  EXECUTE FUNCTION private.research_queue_parent_same_org();
