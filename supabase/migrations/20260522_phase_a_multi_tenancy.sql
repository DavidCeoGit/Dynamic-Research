-- Multi-Tenancy Phase A — schema migration
--
-- Implements `Documentation/multi-tenancy-phase-a-plan.md` v3 (FINAL).
-- DESIGN-gate peer-reviewed (Gemini 3.5 Flash + Deep Think; Codex GPT-5.5 + xhigh
-- sequential QA). Pending MERGE-gate sequential review on this SQL before apply.
--
-- Scope (IN):
--   1. CREATE EXTENSION pgcrypto INTO extensions schema.
--   2. Three new tables: organizations, organization_members, organization_invitations.
--      RLS DISABLED for Phase A (Phase C enables RLS and policies).
--   3. CHECK constraints on role, slug format, name non-empty.
--   4. email_normalized GENERATED STORED column on invitations.
--   5. token_digest (plain SHA-256, indexable) + token_hash (bcrypt cost=12, verify-only)
--      on invitations; revoked_at lifecycle column.
--   6. Indexes: members(user_id), queue(organization_id) partial,
--      invitation active partial unique on (org, email_normalized), invitation(organization_id).
--      Plus implicit token_digest UNIQUE index.
--   7. >=1-owner invariant as AFTER DEFERRABLE constraint trigger evaluating final
--      state with per-org FOR UPDATE lock. Permits zero-member orgs.
--   8. ALTER research_queue ADD organization_id UUID NULL FK ON DELETE RESTRICT.
--   9. Temporary DB DEFAULT on research_queue.organization_id (Option 1+ — keeps
--      new inserts safe during the A->B frontend-deploy gap). Phase B drops it.
--  10. Idempotent topic_slug UNIQUE creation, guarded by a pg_index structural
--      check (creates only if no existing single-column unique index covers it).
--  11. Backfill: insert system-default org; UPDATE existing research_queue rows.
--
-- Scope (OUT — deferred to later phases):
--   - RLS policies (Phase C)
--   - Immutable org_id trigger on research_queue (Phase C)
--   - SET NOT NULL on research_queue.organization_id (Phase C)
--   - Storage paths + Storage RLS (Phase D)
--   - Worker code awareness of org_id (Phase E)
--   - Frontend auth + magic-link callback (Phase B)
--   - Invite CLI / acceptance flow (Phase F)
--
-- Deployment path (Codex S45 M6 + S46 C1/C2 findings, hard rules):
--   - Apply via `supabase db push` ONLY. DO NOT use Supabase Studio SQL Editor —
--     Studio bypasses migration history and has no plan-level atomicity. This
--     reverses the convention used by 20260511 / 20260514, which we accept.
--   - The filename MUST use underscore separator (this file is named
--     20260522_phase_a_multi_tenancy.sql). Supabase CLI's ListLocalMigrations
--     skips dash-separated filenames; the prior two migrations were applied via
--     Studio and so dodged the regex — this is the first migration that goes
--     through `supabase db push`, so the filename pattern matters.
--   - NO file-level BEGIN/COMMIT. Supabase CLI's ExecBatch wraps the migration
--     file's statements AND the supabase_migrations.schema_migrations history
--     insert in ONE implicit transaction. Our own BEGIN/COMMIT would close
--     early and let the history insert run separately — silent desync risk.
--
-- Bootstrap:
--   - After migration applies, run agent/scripts/phase-a-bootstrap-primary-user.ts
--     to insert the primary owner into auth.users (idempotent) and add the owner
--     row in organization_members. The script writes a state file recording
--     whether it created the user, used by phase-a-rollback-primary-user.ts.
--
-- Pre-flight (run from agent/scripts/test-phase-a-migration.sh BEFORE apply):
--   - Test 0:   staging clone at expected baseline schema hash
--   - Test 0.5: zero topic_slug duplicates (abort if non-zero)
--   - Test 0.6: read-only inventory of any existing topic_slug unique index
--
-- Post-apply tests 1-11: see agent/scripts/test-phase-a-migration.sh.
--
-- Rollback: see Documentation/multi-tenancy-phase-a-plan.md §6.


-- =============================================================================
-- §2.0 — Extension (FIRST statement; required by gen_random_uuid + bcrypt salt)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- =============================================================================
-- §2.1 — organizations
-- =============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (btrim(name) <> ''),
  slug        TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE organizations IS
  'Phase A multi-tenancy: top-level workspace. Phase C enables RLS.';


-- =============================================================================
-- §2.2 — organization_members
-- =============================================================================

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

COMMENT ON TABLE organization_members IS
  'Phase A multi-tenancy: membership join table. >=1-owner invariant enforced by trg_organization_members_min_owner.';


-- =============================================================================
-- §2.3 — organization_invitations
-- =============================================================================
-- token_digest: plain SHA-256 of the raw 32-byte CSPRNG token. Indexable for
-- O(1) lookup at acceptance time.
-- token_hash: bcrypt(gen_salt('bf', 12)) of the same raw token. Random salt
-- makes it impossible to look up by hash; verify-only after digest lookup.
-- Both written by the invite-issuance code path; never recoverable from DB.

CREATE TABLE IF NOT EXISTS organization_invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  email_normalized  TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  token_digest      TEXT NOT NULL UNIQUE,
  token_hash        TEXT NOT NULL,
  invited_by        UUID NOT NULL REFERENCES auth.users(id),
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE organization_invitations IS
  'Phase A multi-tenancy: invite-issued (Phase F flow). token_digest=SHA-256 lookup key; token_hash=bcrypt verify-only.';


-- Partial unique index: one active (non-accepted, non-revoked) invitation per
-- (org, normalized-email) pair. Permits re-inviting after acceptance/revoke.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_invitation_per_org_email
  ON organization_invitations (organization_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;


-- =============================================================================
-- §2.4 — Modify research_queue + idempotent topic_slug UNIQUE
-- =============================================================================
-- ON DELETE RESTRICT: deleting an org while it still has queue rows must
-- fail loudly. Caller must reassign/delete child rows first.

ALTER TABLE research_queue
  ADD COLUMN IF NOT EXISTS organization_id UUID NULL
    REFERENCES organizations(id) ON DELETE RESTRICT;


-- Idempotent topic_slug UNIQUE: create only if no existing single-column
-- unique index already covers topic_slug. We check structurally via pg_index,
-- NOT by name (a manually-created index could use any name and our IF NOT EXISTS
-- on a fixed name would falsely fire CREATE).
--
-- v2 (Gemini Major-2): use `attnum = ANY(i.indkey)` instead of `i.indkey[0]`.
-- int2vector's array indexing is 0-based in some Postgres internal contexts;
-- the ANY() form is portable across versions, and combined with the
-- `array_length(i.indkey, 1) = 1` filter we still guarantee single-column.
DO $$
DECLARE
  existing_idx_name TEXT;
BEGIN
  SELECT c.relname INTO existing_idx_name
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
  WHERE t.relname = 'research_queue'
    AND i.indisunique = TRUE
    AND array_length(i.indkey, 1) = 1
    AND a.attname = 'topic_slug'
  LIMIT 1;

  IF existing_idx_name IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX uniq_research_queue_topic_slug ON research_queue (topic_slug)';
    RAISE NOTICE 'Created uniq_research_queue_topic_slug index';
  ELSE
    RAISE NOTICE 'Existing unique index % already covers topic_slug; skipping creation', existing_idx_name;
  END IF;
END $$;


-- =============================================================================
-- §2.5 — Indexes
-- =============================================================================
-- Note: token_digest UNIQUE constraint on the column implicitly creates a unique
-- index; no separate CREATE INDEX needed.
-- Note: uniq_active_invitation_per_org_email is defined inline with the table above.

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id
  ON organization_members (user_id);

CREATE INDEX IF NOT EXISTS idx_research_queue_organization_id
  ON research_queue (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organization_invitations_organization_id
  ON organization_invitations (organization_id);


-- =============================================================================
-- §3 — >=1-owner invariant (AFTER DEFERRABLE CONSTRAINT trigger)
-- =============================================================================
-- Evaluates the FINAL state of organization_members after each row event.
-- Covers all bypass vectors that a BEFORE trigger would miss:
--   - DELETE the sole owner
--   - UPDATE sole owner role -> member
--   - UPDATE sole owner organization_id (move to another org)
--   - UPDATE sole owner user_id (re-attribution)
--   - INSERT first member as 'member' (no owner ever existed)
--   - Concurrent INSERT/DELETE in two transactions (FOR UPDATE on organizations
--     row serializes via the per-org lock)
-- Permits: zero-member orgs (a newly created org has zero rows in members).
--
-- DEFERRABLE INITIALLY IMMEDIATE: fires at end of each statement by default.
-- A caller can opt into commit-time firing for atomic multi-statement
-- membership rebalances via `SET CONSTRAINTS trg_organization_members_min_owner DEFERRED`.

-- v2 (Gemini Critical-1 defensive restructure): explicit IF TG_OP branching
-- ensures NEW is never *referenced in source* during DELETE and OLD is never
-- referenced during INSERT. The v1 form used CASE-in-array-expression which
-- PostgreSQL short-circuits correctly, but the explicit form is easier to
-- reason about and safer against future modifications.

CREATE OR REPLACE FUNCTION enforce_min_one_owner() RETURNS TRIGGER AS $$
DECLARE
  old_org_id UUID;
  new_org_id UUID;
  check_org_id UUID;
  member_count INT;
  owner_count INT;
BEGIN
  -- Branch by TG_OP. Only assign from records that are guaranteed to exist.
  IF TG_OP = 'INSERT' THEN
    new_org_id := NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    old_org_id := OLD.organization_id;
  ELSE  -- UPDATE
    old_org_id := OLD.organization_id;
    new_org_id := NEW.organization_id;
  END IF;

  -- Distinct list of orgs to evaluate (may include both old and new on an
  -- UPDATE that changes organization_id — the cross-org bypass vector).
  FOR check_org_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[old_org_id, new_org_id]) AS t(x)
    WHERE x IS NOT NULL
  LOOP
    -- Per-org FOR UPDATE lock serializes concurrent transactions touching
    -- the same org. If the org row is gone (cascade delete in flight), skip.
    PERFORM 1 FROM organizations WHERE id = check_org_id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT count(*), count(*) FILTER (WHERE role = 'owner')
      INTO member_count, owner_count
    FROM organization_members
    WHERE organization_id = check_org_id;

    IF member_count > 0 AND owner_count = 0 THEN
      RAISE EXCEPTION 'organization % must have at least one owner while it has members', check_org_id;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;


-- Idempotent redefinition: drop-and-create avoids the lack of
-- CREATE TRIGGER IF NOT EXISTS on PostgreSQL.
--
-- INITIALLY IMMEDIATE (DELIBERATE — per v3 plan §3 note; Gemini Critical-2
-- recommended INITIALLY DEFERRED, REJECTED with rationale):
--   Statement-end firing gives operators fast feedback at the offending
--   statement, not at COMMIT after additional work. For the rare
--   multi-statement rebalance (swap-owner in one transaction), the caller
--   opts into commit-time firing via `SET CONSTRAINTS
--   trg_organization_members_min_owner DEFERRED;` for that transaction.
DROP TRIGGER IF EXISTS trg_organization_members_min_owner ON organization_members;
CREATE CONSTRAINT TRIGGER trg_organization_members_min_owner
  AFTER INSERT OR UPDATE OR DELETE ON organization_members
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_min_one_owner();


-- =============================================================================
-- §4.1 — Backfill: insert default org, update existing queue rows, set DEFAULT
-- =============================================================================

-- Default org. The 'name' field is mutable display text; 'slug' is the immutable
-- identity used by infrastructure (URL routing, audit lineage, this migration).
INSERT INTO organizations (name, slug)
  VALUES ('David''s Workspace', 'system-default')
  ON CONFLICT (slug) DO NOTHING;


-- Backfill every existing research_queue row to system-default.
UPDATE research_queue
  SET organization_id = (SELECT id FROM organizations WHERE slug = 'system-default')
  WHERE organization_id IS NULL;


-- Temporary DB DEFAULT on organization_id (Option 1+).
-- Any insert that omits organization_id between Phase A merge and Phase B's
-- org-aware frontend deploy gets the system-default org. Phase B drops this
-- DEFAULT after frontend always writes an explicit org_id.
--
-- PostgreSQL column DEFAULTs cannot contain subqueries, so we resolve the
-- system-default org_id into a variable, then ALTER ... SET DEFAULT with a
-- format()'d literal UUID. The 'L' format specifier quotes safely.
DO $$
DECLARE
  v_default_org_id UUID;
BEGIN
  SELECT id INTO v_default_org_id
  FROM organizations WHERE slug = 'system-default';

  IF v_default_org_id IS NULL THEN
    RAISE EXCEPTION 'system-default org not found — backfill must have failed';
  END IF;

  EXECUTE format(
    'ALTER TABLE research_queue ALTER COLUMN organization_id SET DEFAULT %L::uuid',
    v_default_org_id
  );

  RAISE NOTICE 'Set research_queue.organization_id DEFAULT to %', v_default_org_id;
END $$;
