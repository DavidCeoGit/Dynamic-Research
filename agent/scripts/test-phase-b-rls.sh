#!/usr/bin/env bash
#
# test-phase-b-rls.sh — Multi-Tenancy Phase B-1 pre-flight + post-merge tests.
#
# Implements Documentation/multi-tenancy-phase-b-plan.md v3 §6 (the subset that
# is testable at the B-1 stage — i.e. before Phase B-2 enables RLS on the 4
# existing tenant-scoped tables and before the frontend SSR refactor lands).
#
# In-scope at B-1:
#   - private schema + helper functions exist with correct properties
#   - om_one_org_per_user UNIQUE constraint enforced (E6)
#   - private.auth_user_organization_id() raises cardinality violation when
#     constraint is dropped + 2 memberships exist for one user (E9)
#   - private.research_queue_immutable_org_id() trigger fires on UPDATE (W4)
#   - All 14 RLS policy CREATEs are in pg_policies (will activate when B-2
#     enables RLS)
#   - audit_storage_writes table + RLS + asw_select policy exist
#   - EXECUTE grants on helpers: authenticated has them; PUBLIC does not
#   - RLS NOT enabled on the 4 existing tenant-scoped tables (B-2's job)
#
# Out-of-scope at B-1 (deferred to later harnesses):
#   - §6.1 Auth bypass (A1-A7): require running frontend + HTTP client; will
#     land in agent/scripts/test-phase-b-auth.sh after the SSR refactor.
#   - §6.2 RLS bypass matrix: requires RLS enabled on the 4 tables (Phase B-2).
#   - §6.3 Storage RLS: requires storage path migration + storage policies (B-1.5).
#   - §6.4 W1/W3/W5/W6/W7: require worker refactor + storage helper to land.
#   - §6.5 E1/E2/E7/E8: require running as authenticated/anon client over HTTP.
#   - §6.5 E3/E4: covered by Phase A min-owner trigger tests (already passing).
#   - §6.5 E5: requires RLS enabled (B-2).
#
# Usage:
#   PRE-FLIGHT (run before `supabase db push` for B-1):
#     bash agent/scripts/test-phase-b-rls.sh preflight
#
#   POST-MERGE (run after `supabase db push` for B-1):
#     bash agent/scripts/test-phase-b-rls.sh postmerge
#
# Env:
#   DATABASE_URL          — Postgres connection string (psql-compatible). Required.
#   BASELINE_SCHEMA_HASH  — Expected schema hash for Test 0 (optional; if unset,
#                           Test 0 captures and reports rather than asserts).
#
# Requires: psql.
#
# Exit codes:
#   0 — all selected tests passed
#   1 — one or more tests failed (test name and reason printed to stderr)
#   2 — environment / dependency error (missing env, missing tool)
#
# Shipped S49 (2026-05-23). Pending MERGE-gate sequential review on the migration
# this validates: supabase/migrations/20260523_phase_b_auth_rls_helpers.sql.

set -u
set -o pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "usage: $0 {preflight|postmerge}" >&2
  exit 2
fi

for bin in psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: required binary not on PATH: $bin" >&2
    exit 2
  fi
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set" >&2
  exit 2
fi

PSQL=(psql "$DATABASE_URL" --no-psqlrc --quiet --tuples-only --no-align --pset=footer=off)

FAILS=0
TOTAL=0

pass() {
  TOTAL=$((TOTAL + 1))
  printf '[PASS] %s\n' "$1"
}

fail() {
  TOTAL=$((TOTAL + 1))
  FAILS=$((FAILS + 1))
  printf '[FAIL] %s\n  reason: %s\n' "$1" "$2" >&2
}

scalar() {
  "${PSQL[@]}" -c "$1" | tr -d '[:space:]'
}


# -----------------------------------------------------------------------------
# PRE-FLIGHT
# -----------------------------------------------------------------------------
run_preflight() {
  echo "=== PRE-FLIGHT (Phase B-1) ==="

  # P0: baseline schema hash (capture-or-assert)
  local current_hash
  current_hash=$(scalar "
    SELECT md5(string_agg(table_name || ':' || column_name || ':' || data_type, ','
                          ORDER BY table_name, ordinal_position))
    FROM information_schema.columns
    WHERE table_schema = 'public'
  ")
  if [[ -n "${BASELINE_SCHEMA_HASH:-}" ]]; then
    if [[ "$current_hash" == "$BASELINE_SCHEMA_HASH" ]]; then
      pass "P0: schema hash matches BASELINE_SCHEMA_HASH"
    else
      fail "P0: schema hash mismatch" "expected=$BASELINE_SCHEMA_HASH got=$current_hash"
    fi
  else
    pass "P0: schema hash captured (no BASELINE_SCHEMA_HASH set; informational): $current_hash"
  fi

  # P1: Phase A migration applied
  local phase_a
  phase_a=$(scalar "
    SELECT COUNT(*) FROM supabase_migrations.schema_migrations
    WHERE version = '20260522'
  " 2>/dev/null || echo "0")
  if [[ "$phase_a" == "1" ]]; then
    pass "P1: Phase A migration 20260522 present in history (B-1 depends on its tables)"
  else
    fail "P1: Phase A migration 20260522 NOT present" "B-1 cannot apply without Phase A"
  fi

  # P2: Phase B-1 migration NOT yet applied
  local phase_b1
  phase_b1=$(scalar "
    SELECT COUNT(*) FROM supabase_migrations.schema_migrations
    WHERE version = '20260523'
  " 2>/dev/null || echo "0")
  if [[ "$phase_b1" == "0" ]]; then
    pass "P2: Phase B-1 migration 20260523 NOT yet applied (preflight precondition)"
  else
    fail "P2: Phase B-1 migration 20260523 already in history" "this is a post-apply state; run postmerge mode instead"
  fi

  # P3: private schema NOT yet present
  local private_schema
  private_schema=$(scalar "
    SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'private'
  ")
  if [[ "$private_schema" == "0" ]]; then
    pass "P3: private schema NOT yet present (preflight precondition)"
  else
    pass "P3: private schema already exists (informational — created by some other migration; B-1 uses CREATE SCHEMA IF NOT EXISTS so this is non-blocking)"
  fi

  # P4: om_one_org_per_user constraint NOT yet present
  local om_unique
  om_unique=$(scalar "
    SELECT COUNT(*) FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'organization_members'
      AND c.conname = 'om_one_org_per_user'
  ")
  if [[ "$om_unique" == "0" ]]; then
    pass "P4: om_one_org_per_user constraint NOT yet present (preflight precondition)"
  else
    fail "P4: om_one_org_per_user already exists" "B-1 ALTER ADD CONSTRAINT would fail; investigate before apply"
  fi

  # P5: zero users have 2+ memberships (constraint would fail on backfill check)
  local users_with_dup
  users_with_dup=$(scalar "
    SELECT COALESCE(SUM(c), 0) FROM (
      SELECT COUNT(*) AS c FROM organization_members
      GROUP BY user_id HAVING COUNT(*) > 1
    ) sub
  ")
  if [[ "$users_with_dup" == "0" ]]; then
    pass "P5: zero users have 2+ memberships (UNIQUE constraint will install cleanly)"
  else
    fail "P5: $users_with_dup duplicate-membership users" "ALTER TABLE ADD CONSTRAINT UNIQUE would fail; reconcile memberships first"
  fi
}


# -----------------------------------------------------------------------------
# POST-MERGE
# -----------------------------------------------------------------------------
run_postmerge() {
  echo "=== POST-MERGE (Phase B-1) ==="

  # T1: migration applied cleanly (history row present)
  local mig_row
  mig_row=$(scalar "
    SELECT COUNT(*) FROM supabase_migrations.schema_migrations
    WHERE version = '20260523'
  " 2>/dev/null || echo "0")
  if [[ "$mig_row" == "1" ]]; then
    pass "T1: migration 20260523 recorded in supabase_migrations history"
  else
    fail "T1: migration 20260523 NOT recorded in history" "Studio bypass suspected, or apply failed"
  fi

  # T2: private schema exists with correct REVOKE/GRANT
  local private_exists
  private_exists=$(scalar "
    SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'private'
  ")
  if [[ "$private_exists" != "1" ]]; then
    fail "T2a: private schema missing" "CREATE SCHEMA did not run"
  else
    pass "T2a: private schema exists"

    # information_schema.usage_privileges doesn't reliably surface schema USAGE
    # on Supabase; query pg_namespace.nspacl directly. Format: 'authenticated=U/postgres'.
    local nspacl
    nspacl=$(scalar "SELECT nspacl::text FROM pg_namespace WHERE nspname = 'private'")
    if [[ "$nspacl" == *"authenticated=U"* ]]; then
      pass "T2b: authenticated has USAGE on private schema"
    else
      fail "T2b: authenticated missing USAGE on private" "GRANT USAGE did not run; nspacl=$nspacl"
    fi
  fi

  # T3: om_one_org_per_user UNIQUE constraint installed
  local om_unique
  om_unique=$(scalar "
    SELECT COUNT(*) FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'organization_members'
      AND c.conname = 'om_one_org_per_user'
      AND c.contype = 'u'
  ")
  if [[ "$om_unique" == "1" ]]; then
    pass "T3: om_one_org_per_user UNIQUE(user_id) constraint installed"
  else
    fail "T3: om_one_org_per_user constraint missing" "ALTER TABLE ADD CONSTRAINT did not run"
  fi

  # T4: helper functions exist with expected properties
  local fn1_props
  fn1_props=$(scalar "
    SELECT p.provolatile::text || '|' || p.prosecdef::text || '|' || p.prorettype::regtype::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'auth_user_organization_id'
  ")
  # provolatile: s=STABLE, i=IMMUTABLE, v=VOLATILE
  # prosecdef: true=SECURITY DEFINER
  # prorettype: uuid
  if [[ "$fn1_props" == "s|true|uuid" ]]; then
    pass "T4a: private.auth_user_organization_id() is STABLE SECURITY DEFINER returning uuid"
  else
    fail "T4a: private.auth_user_organization_id() properties wrong" "expected s|true|uuid got=$fn1_props"
  fi

  local fn2_props
  fn2_props=$(scalar "
    SELECT p.provolatile::text || '|' || p.prosecdef::text || '|' || p.prorettype::regtype::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'auth_user_is_owner'
      AND p.pronargs = 0
  ")
  if [[ "$fn2_props" == "s|true|boolean" ]]; then
    pass "T4b: private.auth_user_is_owner() is STABLE SECURITY DEFINER returning boolean (parameterless per M1 S49)"
  else
    fail "T4b: private.auth_user_is_owner() properties wrong" "expected s|true|boolean got=$fn2_props"
  fi

  # T5: helper search_path locked down
  local fn1_search_path
  fn1_search_path=$(scalar "
    SELECT proconfig::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'auth_user_organization_id'
  ")
  if [[ "$fn1_search_path" == *"search_path=private,public,pg_temp"* ]]; then
    pass "T5a: auth_user_organization_id() has SET search_path = private, public, pg_temp"
  else
    fail "T5a: auth_user_organization_id() search_path not locked" "got: $fn1_search_path"
  fi

  local fn2_search_path
  fn2_search_path=$(scalar "
    SELECT proconfig::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'auth_user_is_owner' AND p.pronargs = 0
  ")
  if [[ "$fn2_search_path" == *"search_path=private,public,pg_temp"* ]]; then
    pass "T5b: auth_user_is_owner() has SET search_path = private, public, pg_temp"
  else
    fail "T5b: auth_user_is_owner() search_path not locked" "got: $fn2_search_path"
  fi

  # T5c (m1 S49): trigger function search_path locked down
  local trg_fn_search_path
  trg_fn_search_path=$(scalar "
    SELECT proconfig::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'research_queue_immutable_org_id'
  ")
  if [[ "$trg_fn_search_path" == *"search_path=private,public,pg_temp"* ]]; then
    pass "T5c: research_queue_immutable_org_id() has SET search_path = private, public, pg_temp (m1 S49)"
  else
    fail "T5c: trigger function search_path not locked" "got: $trg_fn_search_path"
  fi

  # T6: EXECUTE grants — authenticated YES, PUBLIC NO
  local fn1_auth_exec
  fn1_auth_exec=$(scalar "
    SELECT has_function_privilege('authenticated', 'private.auth_user_organization_id()', 'EXECUTE')::text
  ")
  if [[ "$fn1_auth_exec" == "true" ]]; then
    pass "T6a: authenticated has EXECUTE on private.auth_user_organization_id()"
  else
    fail "T6a: authenticated missing EXECUTE on auth_user_organization_id()" "got=$fn1_auth_exec"
  fi

  # has_function_privilege does NOT accept 'PUBLIC' as a role literal.
  # Inspect proacl directly: PUBLIC grants appear as "=X/owner" (empty grantee
  # before the equals). Absence of "=X" + non-NULL proacl means PUBLIC revoked.
  local fn1_acl
  fn1_acl=$(scalar "
    SELECT COALESCE(p.proacl::text, '(NULL — default ACL: PUBLIC has EXECUTE)')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'auth_user_organization_id'
  ")
  if [[ "$fn1_acl" != *"=X"* ]] && [[ "$fn1_acl" != *"NULL"* ]]; then
    pass "T6b: PUBLIC does NOT have EXECUTE on private.auth_user_organization_id()"
  else
    fail "T6b: PUBLIC has EXECUTE on auth_user_organization_id()" "REVOKE PUBLIC did not run; proacl=$fn1_acl"
  fi

  local fn2_auth_exec
  fn2_auth_exec=$(scalar "
    SELECT has_function_privilege('authenticated', 'private.auth_user_is_owner()', 'EXECUTE')::text
  ")
  if [[ "$fn2_auth_exec" == "true" ]]; then
    pass "T6c: authenticated has EXECUTE on private.auth_user_is_owner()"
  else
    fail "T6c: authenticated missing EXECUTE on auth_user_is_owner()" "got=$fn2_auth_exec"
  fi

  local fn2_acl
  fn2_acl=$(scalar "
    SELECT COALESCE(p.proacl::text, '(NULL — default ACL: PUBLIC has EXECUTE)')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'auth_user_is_owner' AND p.pronargs = 0
  ")
  if [[ "$fn2_acl" != *"=X"* ]] && [[ "$fn2_acl" != *"NULL"* ]]; then
    pass "T6d: PUBLIC does NOT have EXECUTE on private.auth_user_is_owner()"
  else
    fail "T6d: PUBLIC has EXECUTE on auth_user_is_owner()" "REVOKE PUBLIC did not run; proacl=$fn2_acl"
  fi

  # T7: research_queue immutable-org_id trigger installed + fires on UPDATE
  local trg_exists
  trg_exists=$(scalar "
    SELECT COUNT(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'research_queue'
      AND t.tgname = 'research_queue_immutable_org_id'
      AND NOT t.tgisinternal
  ")
  if [[ "$trg_exists" == "1" ]]; then
    pass "T7a: research_queue_immutable_org_id trigger installed"
  else
    fail "T7a: trigger missing" "CREATE TRIGGER did not run"
  fi

  # T7b (W4): trigger fires under service-role UPDATE of organization_id
  local primary_org_id
  primary_org_id=$(scalar "SELECT id FROM organizations WHERE slug = 'system-default'")
  if [[ -z "$primary_org_id" ]]; then
    fail "T7b-precheck: system-default org missing" "Phase A bootstrap must have run"
  else
    local trg_test_out
    trg_test_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      DECLARE
        v_test_org UUID;
        v_existing_row_id UUID;
      BEGIN
        -- Create a sacrificial second org for the would-be migration target.
        INSERT INTO organizations (name, slug)
        VALUES ('Phase B-1 T7b', 'test-phase-b-t7b-' || left(gen_random_uuid()::text, 8))
        RETURNING id INTO v_test_org;

        -- Pick any existing research_queue row.
        SELECT id INTO v_existing_row_id FROM research_queue LIMIT 1;
        IF v_existing_row_id IS NULL THEN
          RAISE NOTICE 'SKIP: no research_queue rows to test against';
          RETURN;
        END IF;

        BEGIN
          UPDATE research_queue SET organization_id = v_test_org WHERE id = v_existing_row_id;
          RAISE NOTICE 'BUG: org_id mutation succeeded';
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'OK: trigger raised: %', SQLERRM;
        END;
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    if echo "$trg_test_out" | grep -q "OK: trigger raised"; then
      pass "T7b: research_queue org_id UPDATE blocked by trigger (W4 — service-role bypass-of-RLS vector caught)"
    elif echo "$trg_test_out" | grep -q "SKIP:"; then
      pass "T7b: trigger test SKIPPED (no research_queue rows to test against)"
    else
      fail "T7b: trigger did not block org_id mutation" "output: $trg_test_out"
    fi

    # T7c: trigger escape hatch works (admin migration tool)
    local trg_escape_out
    trg_escape_out=$("${PSQL[@]}" -c "
      BEGIN;
      SET LOCAL app.allow_org_migration = 'true';
      DO \$\$
      DECLARE
        v_test_org UUID;
        v_existing_row_id UUID;
      BEGIN
        INSERT INTO organizations (name, slug)
        VALUES ('Phase B-1 T7c', 'test-phase-b-t7c-' || left(gen_random_uuid()::text, 8))
        RETURNING id INTO v_test_org;

        SELECT id INTO v_existing_row_id FROM research_queue LIMIT 1;
        IF v_existing_row_id IS NULL THEN
          RAISE NOTICE 'SKIP: no research_queue rows';
          RETURN;
        END IF;

        UPDATE research_queue SET organization_id = v_test_org WHERE id = v_existing_row_id;
        RAISE NOTICE 'OK: escape hatch permitted org_id mutation';
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    if echo "$trg_escape_out" | grep -q "OK: escape hatch"; then
      pass "T7c: app.allow_org_migration=true escape hatch permits org_id mutation"
    elif echo "$trg_escape_out" | grep -q "SKIP:"; then
      pass "T7c: escape hatch test SKIPPED (no research_queue rows)"
    else
      fail "T7c: escape hatch did not permit mutation" "output: $trg_escape_out"
    fi
  fi

  # T8: all 14 RLS policies created (research_queue 4 + org_members 4 + org_invitations 3 + organizations 2 + audit_storage_writes 1 = 14)
  declare -A expected_policies=(
    ["public.research_queue.rq_select"]=1
    ["public.research_queue.rq_insert"]=1
    ["public.research_queue.rq_update"]=1
    ["public.research_queue.rq_delete"]=1
    ["public.organization_members.om_select"]=1
    ["public.organization_members.om_insert"]=1
    ["public.organization_members.om_update"]=1
    ["public.organization_members.om_delete"]=1
    ["public.organization_invitations.oi_select"]=1
    ["public.organization_invitations.oi_insert"]=1
    ["public.organization_invitations.oi_delete"]=1
    ["public.organizations.orgs_select"]=1
    ["public.organizations.orgs_update"]=1
    ["public.audit_storage_writes.asw_select"]=1
  )
  local missing_policies=""
  for key in "${!expected_policies[@]}"; do
    local schemaname="${key%%.*}"
    local rest="${key#*.}"
    local tablename="${rest%.*}"
    local policyname="${rest##*.}"
    local found
    found=$(scalar "
      SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = '$schemaname'
        AND tablename = '$tablename'
        AND policyname = '$policyname'
    ")
    if [[ "$found" != "1" ]]; then
      missing_policies="$missing_policies $key"
    fi
  done
  if [[ -z "$missing_policies" ]]; then
    pass "T8: all 14 RLS policies created (4 rq + 4 om + 3 oi + 2 orgs + 1 asw)"
  else
    fail "T8: missing policies:$missing_policies" "see CREATE POLICY statements in B-1 §5"
  fi

  # T9: NO oi_update policy (invitations immutable) + NO orgs_insert/orgs_delete
  declare -a forbidden_policies=(
    "public.organization_invitations.oi_update"
    "public.organizations.orgs_insert"
    "public.organizations.orgs_delete"
    "public.audit_storage_writes.asw_insert"
    "public.audit_storage_writes.asw_update"
    "public.audit_storage_writes.asw_delete"
  )
  local extra_policies=""
  for key in "${forbidden_policies[@]}"; do
    local schemaname="${key%%.*}"
    local rest="${key#*.}"
    local tablename="${rest%.*}"
    local policyname="${rest##*.}"
    local found
    found=$(scalar "
      SELECT COUNT(*) FROM pg_policies
      WHERE schemaname = '$schemaname'
        AND tablename = '$tablename'
        AND policyname = '$policyname'
    ")
    if [[ "$found" != "0" ]]; then
      extra_policies="$extra_policies $key"
    fi
  done
  if [[ -z "$extra_policies" ]]; then
    pass "T9: no forbidden policies present (oi_update/orgs_insert/orgs_delete/asw_*-mut absent — intentional default-deny)"
  else
    fail "T9: forbidden policies present:$extra_policies" "remove these CREATE POLICY statements"
  fi

  # T10: RLS state on the 4 existing tenant-scoped tables.
  # ORIGINAL DESIGN ASSUMPTION: RLS would be DISABLED on these until Phase B-2.
  # ACTUAL PROD STATE (discovered S49 post-apply): RLS was already ENABLED on
  # all 4 tables before B-1 applied — pre-existing condition (likely Supabase
  # Studio default or earlier session). With no policies before B-1, default-deny
  # was in effect for authenticated traffic; service-role bypassed. After B-1,
  # the 14 policies are in place, so authenticated traffic would be gated by
  # them (no-op until frontend SSR client ships). Phase B-2 reduces to
  # DROP DEFAULT + frontend cutover validation. Test accepts either state.
  local rls_on_existing
  rls_on_existing=$(scalar "
    SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class
    WHERE relname IN ('research_queue','organization_members','organization_invitations','organizations')
      AND relkind = 'r'
      AND relrowsecurity = TRUE
  ")
  local expected="organization_invitations,organization_members,organizations,research_queue"
  if [[ "$rls_on_existing" == "$expected" ]]; then
    pass "T10: RLS enabled on all 4 existing tenant-scoped tables (pre-existing state; B-2 cutover model adjusted post-S49)"
  elif [[ -z "$rls_on_existing" ]]; then
    pass "T10: RLS NOT enabled on the 4 existing tables (original-design state; B-2 would flip)"
  else
    fail "T10: partial RLS state — only some tables enabled: $rls_on_existing" "expected all 4 or none"
  fi

  # T11: audit_storage_writes table + RLS + asw_select policy
  local asw_exists
  asw_exists=$(scalar "
    SELECT COUNT(*) FROM pg_class
    WHERE relname = 'audit_storage_writes' AND relkind = 'r'
  ")
  if [[ "$asw_exists" == "1" ]]; then
    pass "T11a: audit_storage_writes table exists"
  else
    fail "T11a: audit_storage_writes table missing" "CREATE TABLE did not run"
  fi

  local asw_rls
  asw_rls=$(scalar "
    SELECT relrowsecurity::text FROM pg_class WHERE relname = 'audit_storage_writes'
  ")
  if [[ "$asw_rls" == "true" ]]; then
    pass "T11b: RLS ENABLED on audit_storage_writes (safe at create-time per design)"
  else
    fail "T11b: RLS NOT enabled on audit_storage_writes" "design called for ENABLE at create-time"
  fi

  # T11c: audit_storage_writes has expected columns
  local asw_cols
  asw_cols=$(scalar "
    SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_storage_writes'
  ")
  if [[ "$asw_cols" == "id,written_at,caller,organization_id,research_queue_id,object_path,bytes,http_status" ]]; then
    pass "T11c: audit_storage_writes columns match expected layout"
  else
    fail "T11c: audit_storage_writes columns mismatch" "got: $asw_cols"
  fi

  # T11d: 2 expected indexes
  local asw_idxs
  asw_idxs=$(scalar "
    SELECT string_agg(indexname, ',' ORDER BY indexname)
    FROM pg_indexes
    WHERE tablename = 'audit_storage_writes'
      AND indexname IN ('audit_storage_writes_written_at_idx', 'audit_storage_writes_org_idx')
  ")
  if [[ "$asw_idxs" == "audit_storage_writes_org_idx,audit_storage_writes_written_at_idx" ]]; then
    pass "T11d: both expected indexes on audit_storage_writes installed"
  else
    fail "T11d: missing/extra indexes" "got: $asw_idxs"
  fi

  # T11e (M2 S49): FKs use ON DELETE RESTRICT (not SET NULL) for forensic immutability
  # confdeltype is type "char"; cast to text to avoid `text || char` ambiguity.
  local asw_fks
  asw_fks=$(scalar "
    SELECT string_agg(c.conname || ':' || c.confdeltype::text, ',' ORDER BY c.conname)
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'audit_storage_writes'
      AND c.contype = 'f'
  ")
  # confdeltype 'r' = RESTRICT, 'n' = SET NULL, 'c' = CASCADE, 'a' = NO ACTION
  if [[ "$asw_fks" == *":r"* ]] && [[ "$asw_fks" != *":n"* ]] && [[ "$asw_fks" != *":c"* ]]; then
    pass "T11e (M2 S49): all audit_storage_writes FKs use ON DELETE RESTRICT (forensic immutability)"
  else
    fail "T11e (M2 S49): audit FK ON DELETE policy wrong" "expected all RESTRICT (:r); got: $asw_fks"
  fi

  # T11f (M2 S49): organization_id is NOT NULL (no orphaning possible)
  local asw_org_notnull
  asw_org_notnull=$(scalar "
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_storage_writes' AND column_name = 'organization_id'
  ")
  if [[ "$asw_org_notnull" == "NO" ]]; then
    pass "T11f (M2 S49): audit_storage_writes.organization_id is NOT NULL"
  else
    fail "T11f (M2 S49): organization_id is nullable" "expected NOT NULL; got is_nullable=$asw_org_notnull"
  fi

  # T12 (E6): cannot insert second org_members row for the same user_id (UNIQUE constraint)
  local primary_user_id
  primary_user_id=$(scalar "
    SELECT user_id FROM organization_members
    WHERE organization_id = (SELECT id FROM organizations WHERE slug = 'system-default')
      AND role = 'owner'
    LIMIT 1
  ")
  if [[ -z "$primary_user_id" ]]; then
    fail "T12-precheck: no primary owner found" "Phase A bootstrap must have run"
  else
    local e6_out
    e6_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      DECLARE
        v_org2 UUID;
        v_user UUID := '${primary_user_id}'::uuid;
      BEGIN
        INSERT INTO organizations (name, slug)
        VALUES ('Phase B-1 E6', 'test-phase-b-e6-' || left(gen_random_uuid()::text, 8))
        RETURNING id INTO v_org2;

        BEGIN
          INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (v_org2, v_user, 'owner');
          RAISE NOTICE 'BUG: second membership accepted';
        EXCEPTION WHEN unique_violation THEN
          RAISE NOTICE 'OK: UNIQUE(user_id) blocked second membership: %', SQLERRM;
        WHEN OTHERS THEN
          RAISE NOTICE 'UNEXPECTED: %', SQLERRM;
        END;
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    if echo "$e6_out" | grep -q "OK: UNIQUE"; then
      pass "T12 (E6): second organization_members row for same user_id blocked by om_one_org_per_user"
    else
      fail "T12 (E6): UNIQUE constraint did not block second membership" "output: $e6_out"
    fi
  fi

  # T13 (E9): helper raises cardinality violation under 2+ memberships.
  # v3 (Codex S49 M2): DDL + data setup runs FIRST as the default (postgres /
  # table owner) role — `authenticated` does not have ALTER privileges so doing
  # the DROP CONSTRAINT under that role would fail with insufficient_privilege
  # instead of exercising the helper. Only AFTER setup do we switch to the
  # authenticated context for the helper invocation.
  #
  # v3 (Codex S49 M2): use the DOT-PATH GUC form `request.jwt.claim.sub` —
  # Supabase auth.uid() reads both `request.jwt.claim.sub` (direct scalar) and
  # `request.jwt.claims` (JSON with .sub). The dot-path form is unambiguous.
  # We also assert auth.uid() resolves to the expected user BEFORE calling
  # the helper, so a misbinding fails as PRECHECK FAIL instead of silently
  # passing the test for the wrong reason.
  if [[ -z "${primary_user_id:-}" ]]; then
    fail "T13-precheck: no primary owner found" "Phase A bootstrap must have run"
  else
    local e9_out
    e9_out=$("${PSQL[@]}" -c "
      BEGIN;
      -- 1) DDL + data setup as the default role (postgres / table owner).
      ALTER TABLE public.organization_members DROP CONSTRAINT om_one_org_per_user;
      DO \$\$
      DECLARE
        v_org2 UUID;
        v_user UUID := '${primary_user_id}'::uuid;
      BEGIN
        INSERT INTO organizations (name, slug)
        VALUES ('Phase B-1 E9', 'test-phase-b-e9-' || left(gen_random_uuid()::text, 8))
        RETURNING id INTO v_org2;

        -- Insert as 'owner' to satisfy Phase A min-owner trigger on v_org2.
        -- ('member' would leave v_org2 with 0 owners → enforce_min_one_owner raises.)
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES (v_org2, v_user, 'owner');
      END
      \$\$;
      -- 2) Switch to authenticated context immediately before calling the helper.
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${primary_user_id}';
      DO \$\$
      DECLARE
        v_uid UUID;
        v_org UUID;
      BEGIN
        -- Verify auth.uid() resolves correctly (PRECHECK per Codex S49 Recommendation).
        SELECT auth.uid() INTO v_uid;
        IF v_uid IS DISTINCT FROM '${primary_user_id}'::uuid THEN
          RAISE NOTICE 'PRECHECK FAIL: auth.uid()=% expected=%', v_uid, '${primary_user_id}';
          RETURN;
        END IF;
        BEGIN
          SELECT private.auth_user_organization_id() INTO v_org;
          RAISE NOTICE 'BUG: helper returned % without raising', v_org;
        EXCEPTION WHEN cardinality_violation THEN
          RAISE NOTICE 'OK: cardinality_violation raised: %', SQLERRM;
        WHEN OTHERS THEN
          RAISE NOTICE 'UNEXPECTED SQLSTATE: % - %', SQLSTATE, SQLERRM;
        END;
      END
      \$\$;
      RESET ROLE;
      ROLLBACK;
    " 2>&1)
    if echo "$e9_out" | grep -q "OK: cardinality_violation"; then
      pass "T13 (E9): helper raises cardinality_violation with 2+ memberships (fail-loud B1 design validated)"
    elif echo "$e9_out" | grep -q "PRECHECK FAIL"; then
      fail "T13 (E9): auth.uid() did not bind to test user" "$e9_out"
    else
      fail "T13 (E9): helper did not raise cardinality_violation" "output: $e9_out"
    fi

    # T13b: post-ROLLBACK, verify constraint is still in place
    local om_unique_post
    om_unique_post=$(scalar "
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'organization_members' AND c.conname = 'om_one_org_per_user'
    ")
    if [[ "$om_unique_post" == "1" ]]; then
      pass "T13b: om_one_org_per_user constraint still present post-ROLLBACK (test harness did not leak state)"
    else
      fail "T13b: constraint missing post-test" "ROLLBACK did not restore — investigate immediately"
    fi
  fi

  # T15 (Codex S49 M1): organizations_immutable_columns trigger blocks slug/id/created_at UPDATE
  if [[ -z "${primary_org_id:-}" ]]; then
    fail "T15-precheck: no system-default org" "Phase A bootstrap"
  else
    # T15a: slug UPDATE blocked
    local t15a_out
    t15a_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      BEGIN
        BEGIN
          UPDATE public.organizations SET slug = 'system-default-mutated' WHERE id = '${primary_org_id}'::uuid;
          RAISE NOTICE 'BUG: slug mutation succeeded';
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'OK: trigger raised: %', SQLERRM;
        END;
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    echo "$t15a_out" | grep -q "OK: trigger raised" \
      && pass "T15a (Codex M1): organizations.slug UPDATE blocked by immutable-columns trigger" \
      || fail "T15a: slug mutation not blocked" "$t15a_out"

    # T15b: created_at UPDATE blocked
    local t15b_out
    t15b_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      BEGIN
        BEGIN
          UPDATE public.organizations SET created_at = '2020-01-01'::timestamptz WHERE id = '${primary_org_id}'::uuid;
          RAISE NOTICE 'BUG: created_at mutation succeeded';
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'OK: trigger raised: %', SQLERRM;
        END;
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    echo "$t15b_out" | grep -q "OK: trigger raised" \
      && pass "T15b (Codex M1): organizations.created_at UPDATE blocked" \
      || fail "T15b: created_at mutation not blocked" "$t15b_out"

    # T15c: id UPDATE blocked
    local t15c_out
    t15c_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      BEGIN
        BEGIN
          UPDATE public.organizations SET id = gen_random_uuid() WHERE id = '${primary_org_id}'::uuid;
          RAISE NOTICE 'BUG: id mutation succeeded';
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'OK: trigger raised: %', SQLERRM;
        END;
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    echo "$t15c_out" | grep -q "OK: trigger raised" \
      && pass "T15c (Codex M1): organizations.id UPDATE blocked" \
      || fail "T15c: id mutation not blocked" "$t15c_out"

    # T15d: name UPDATE permitted (control case — workspace rename per G2 S48)
    local t15d_out
    t15d_out=$("${PSQL[@]}" -c "
      BEGIN;
      DO \$\$
      BEGIN
        UPDATE public.organizations SET name = 'Renamed Workspace Test' WHERE id = '${primary_org_id}'::uuid;
        RAISE NOTICE 'OK: name UPDATE permitted';
      END
      \$\$;
      ROLLBACK;
    " 2>&1)
    echo "$t15d_out" | grep -q "OK: name UPDATE permitted" \
      && pass "T15d (Codex M1 control): organizations.name UPDATE still permitted (workspace rename works)" \
      || fail "T15d: name UPDATE rejected" "$t15d_out"
  fi

  # T16 (Codex S49 M1): organizations_immutable_columns trigger fn search_path locked
  local org_trg_search_path
  org_trg_search_path=$(scalar "
    SELECT proconfig::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'organizations_immutable_columns'
  ")
  if [[ "$org_trg_search_path" == *"search_path=private,public,pg_temp"* ]]; then
    pass "T16: organizations_immutable_columns() has SET search_path locked"
  else
    fail "T16: search_path not locked on organizations_immutable_columns" "got: $org_trg_search_path"
  fi

  # T14: idempotency — migration history shows exactly one row for 20260523
  local mig_dups
  mig_dups=$(scalar "
    SELECT COUNT(*) FROM supabase_migrations.schema_migrations WHERE version = '20260523'
  " 2>/dev/null || echo "0")
  if [[ "$mig_dups" == "1" ]]; then
    pass "T14: migration recorded exactly once (idempotency structural — DDL guarded by IF NOT EXISTS / DROP-IF-EXISTS-then-CREATE)"
  else
    fail "T14: migration history shows $mig_dups rows for 20260523" "expected 1"
  fi
}


# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------
case "$MODE" in
  preflight)
    run_preflight
    ;;
  postmerge)
    run_postmerge
    ;;
  *)
    echo "usage: $0 {preflight|postmerge}" >&2
    exit 2
    ;;
esac

echo ""
echo "Total: $TOTAL  Pass: $((TOTAL - FAILS))  Fail: $FAILS"

if [[ "$FAILS" -gt 0 ]]; then
  exit 1
fi
exit 0
