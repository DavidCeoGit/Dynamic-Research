#!/usr/bin/env bash
#
# test-ssr-auth-cutover.sh — Phase 5 Component 2: executable tenant-isolation
# proof (the RLS-bypass matrix + storage isolation tiers + the Component-1
# parent-same-org trigger cross-link).
#
# Implements Documentation/phase5-parent-same-org-and-rls-harness-design.md §5
# (DESIGN gate CLOSED v3-FINAL, S148) + decisions in
# Documentation/phase5-decisions-s150.md (#4: localhost Tier-1 is required).
#
# WHAT IT PROVES (none of this is asserted by test-phase-b-rls.sh, which only
# snapshots that the policies EXIST):
#   - an authenticated session cannot read/write another org's rows (X1-X9),
#   - anon is default-denied across the whole perimeter (A1-A2),
#   - the Component-1 trigger fences cross-org lineage even for the GENUINE
#     service_role that BYPASSes RLS (P1/P1b), allows same-org lineage (P2),
#     and honours the TWO-FACTOR escape hatch (20260622 GUC-hardening): a
#     tenancy_admin MEMBER overrides (P3) but a NON-member is still blocked even
#     with the GUC set (P3b), and B-1's message no longer leaks the flag (P3c),
#   - storage is private + has no permissive object policy (Tier-2 S1/S2),
#   - [when a session is supplied] the file-serving routes keep orgId
#     session-derived so a foreign-org slug 404s (Tier-1 T1-T4).
#
# NOT side-effect-free: it creates a COMMITTED seed on a NON-PROD target (two
# orgs + Admin-API users + runs + real storage objects) and tears it down in a
# trap. A hard prod-ref guard (DR_TEST_ENV=nonprod + no mfjgoghlpqgxcycxoxio in
# any env) makes a prod run impossible. The psql matrix SAVEPOINT/ROLLBACK-
# isolates its mutations so the seed survives for the HTTP tier.
#
# NOT in the offline `pnpm test` chain — needs a non-prod DB + service-role key
# (+ optionally a running app for Tier-1). Run at the SSR-auth cutover and
# whenever RLS policies or the file-serving routes change.
#
# Usage:
#   DR_TEST_ENV=nonprod \
#   DATABASE_URL=<non-prod psql URL> \
#   SUPERUSER_DATABASE_URL=<non-prod TRUE-superuser URL> \    # supabase_admin on local Supabase; required for Regime 1b (P3/P3b)
#   NEXT_PUBLIC_SUPABASE_URL=<non-prod> SUPABASE_SERVICE_ROLE_KEY=<non-prod> \
#   [BASE_URL=http://127.0.0.1:3000 SESSION='sb-...=...; ...'] \
#   bash agent/scripts/test-ssr-auth-cutover.sh [--http]
#
# SUPERUSER_DATABASE_URL (e.g. postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres)
# is required by the GUC-hardening escape-hatch arm: SET SESSION AUTHORIZATION
# needs a true superuser, and on Supabase `postgres` is NOT one. Absent/non-super
# → P3/P3b FAIL (never skip-as-pass).
#
# Exit codes: 0 all-pass · 1 one+ fail · 2 env/dependency/guard error.
#
# Phase 5 (S151). Sibling of agent/scripts/test-phase-b-rls.sh.

set -u
set -o pipefail

PROD_REF="mfjgoghlpqgxcycxoxio"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

WANT_HTTP=0
for arg in "$@"; do
  case "$arg" in
    --http) WANT_HTTP=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---- guards ---------------------------------------------------------------
for bin in psql node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: required binary not on PATH: $bin" >&2; exit 2; }
done
[[ -n "${DATABASE_URL:-}" ]] || { echo "ERROR: DATABASE_URL not set" >&2; exit 2; }
[[ "${DR_TEST_ENV:-}" == "nonprod" ]] || { echo "ERROR: refusing to run — set DR_TEST_ENV=nonprod (this harness writes a COMMITTED seed; never run against prod)" >&2; exit 2; }
if [[ "$DATABASE_URL" == *"$PROD_REF"* || "${NEXT_PUBLIC_SUPABASE_URL:-}" == *"$PROD_REF"* || "${SUPABASE_SERVICE_ROLE_KEY:-}" == *"$PROD_REF"* ]]; then
  echo "ERROR: prod-ref guard tripped — an env var references the prod project $PROD_REF" >&2
  exit 2
fi
[[ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || {
  echo "ERROR: seed needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (non-prod)" >&2; exit 2; }
# C-MAJ-1: a BASE_URL run MUST exercise the primary storage boundary. If no
# explicit SESSION is given, the seed self-mints one — which needs the anon key.
# Refuse up front rather than let Tier-1 silently skip.
if [[ -n "${BASE_URL:-}" && -z "${SESSION:-}" && -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]]; then
  echo "ERROR: BASE_URL set without SESSION and without NEXT_PUBLIC_SUPABASE_ANON_KEY — cannot self-mint the Tier-1 session; provide one (else Tier-1 would skip the primary storage proof)." >&2; exit 2
fi

PSQL=(psql "$DATABASE_URL" --no-psqlrc --quiet --tuples-only --no-align --pset=footer=off)

FAILS=0; TOTAL=0; SKIPS=0
pass() { TOTAL=$((TOTAL + 1)); printf '[PASS] %s\n' "$1"; }
fail() { TOTAL=$((TOTAL + 1)); FAILS=$((FAILS + 1)); printf '[FAIL] %s\n  reason: %s\n' "$1" "$2" >&2; }
skip() { SKIPS=$((SKIPS + 1)); printf '[SKIP] %s\n' "$1"; }
scalar() { "${PSQL[@]}" -c "$1" 2>/dev/null | tr -d '[:space:]'; }
# scalar as authenticated user <uid> inside a rolled-back txn (RLS applies).
scalar_authed() {
  "${PSQL[@]}" -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$1'; $2; ROLLBACK;" 2>/dev/null | tr -d '[:space:]'
}
scalar_anon() {
  "${PSQL[@]}" -c "BEGIN; SET LOCAL ROLE anon; $1; ROLLBACK;" 2>/dev/null | tr -d '[:space:]'
}
capture() { "${PSQL[@]}" -c "$1" 2>&1; }

# ---- seed (committed) + teardown trap -------------------------------------
# The seed owns its temp-file path (os.tmpdir(), forward slashes) and prints it
# as a FIXTURE_PATH= line — mktemp's /tmp does NOT round-trip between Git-Bash
# and Windows-native node, so we let node choose the path.
FX=""
cleanup() {
  if [[ -n "$FX" && -f "$FX" ]]; then
    ( cd "$AGENT_DIR" && node --import=tsx scripts/test-ssr-auth-cutover-seed.ts teardown --in "$FX" ) || \
      echo "WARN: teardown reported errors (fixture $FX) — inspect the non-prod target" >&2
    rm -f "$FX"
  fi
}
trap cleanup EXIT

echo "=== Phase 5 SSR-auth cutover harness ==="
echo "--- seeding committed non-prod fixture ---"
seed_out="$( cd "$AGENT_DIR" && node --import=tsx scripts/test-ssr-auth-cutover-seed.ts seed )"; seed_rc=$?
echo "$seed_out"
# Parse FX even on a NON-zero seed rc — the seed writes a partial fixture + emits
# FIXTURE_PATH on failure (G-MIN-1), so the EXIT trap can still tear down.
FX="$(printf '%s\n' "$seed_out" | grep '^FIXTURE_PATH=' | head -1 | cut -d= -f2-)"
if [[ "$seed_rc" -ne 0 ]]; then echo "ERROR: seed failed (rc=$seed_rc)" >&2; exit 2; fi
[[ -n "$FX" && -f "$FX" ]] || { echo "ERROR: seed did not report a usable FIXTURE_PATH (got '$FX')" >&2; exit 2; }

# Parse flat string fields from the fixture JSON without node (avoids the
# Windows require() path quirk).
read_fx() { grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$FX" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }
orgA="$(read_fx orgA)"; orgB="$(read_fx orgB)"
userA="$(read_fx userA)"; userB="$(read_fx userB)"
runA="$(read_fx runA)"; runB="$(read_fx runB)"
slugA="$(read_fx slugA)"; slugB="$(read_fx slugB)"
[[ -n "$orgA" && -n "$orgB" && -n "$userA" && -n "$runB" ]] || { echo "ERROR: fixture JSON incomplete" >&2; exit 2; }

# ---- PRECHECK: identity binding resolves ----------------------------------
echo "--- precheck: identity binding ---"
got_org="$(scalar_authed "$userA" "SELECT private.auth_user_organization_id()")"
if [[ "$got_org" == "$orgA" ]]; then
  pass "PRECHECK: auth_user_organization_id() resolves user A → org A"
else
  fail "PRECHECK: auth context misbound" "expected $orgA got '$got_org' — aborting matrix (results would be meaningless)"
  echo ""; echo "Total: $TOTAL  Pass: $((TOTAL - FAILS))  Fail: $FAILS  Skip: $SKIPS" ; exit 1
fi

# ---- Regime 1: RLS-bypass matrix (§5.2) -----------------------------------
echo "--- Regime 1: RLS-bypass matrix ---"

# X1 — authenticated A sees its own rows (positive control)
gotA="$(scalar_authed "$userA" "SELECT count(*) FROM public.research_queue")"
ownA="$(scalar "SELECT count(*) FROM public.research_queue WHERE organization_id='$orgA'")"
if [[ -n "$gotA" && "$gotA" == "$ownA" && "$gotA" -ge 1 ]]; then
  pass "X1: authenticated A sees exactly its own research_queue rows ($gotA), B invisible"
else
  fail "X1: research_queue visibility wrong for A" "authed=$gotA own=$ownA (expected equal, >=1)"
fi

# X2 — no cross-org read
x2="$(scalar_authed "$userA" "SELECT count(*) FROM public.research_queue WHERE organization_id='$orgB'")"
[[ "$x2" == "0" ]] && pass "X2: A cannot read org B research_queue rows (0)" || fail "X2: cross-org read leaked" "got=$x2 expected=0"

# X3 — cannot forge org B on INSERT (RLS WITH CHECK)
x3="$(capture "
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$userA';
DO \$\$ BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug)
  VALUES ('$orgB','x3','dr-test-x3-'||left(gen_random_uuid()::text,8));
  RAISE NOTICE 'BUG: forged org-B insert succeeded';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'OK: blocked % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
echo "$x3" | grep -q 'OK: blocked' && pass "X3: A cannot INSERT a row stamped org B (RLS WITH CHECK)" || fail "X3: forged-org insert not blocked" "$x3"

# X4 — UPDATE of org B rows affects 0
x4="$(scalar_authed "$userA" "WITH d AS (UPDATE public.research_queue SET status='x' WHERE organization_id='$orgB' RETURNING 1) SELECT count(*) FROM d")"
[[ "$x4" == "0" ]] && pass "X4: A's UPDATE touches 0 org-B rows (rq_update USING hides B)" || fail "X4: cross-org UPDATE affected rows" "got=$x4 expected=0"

# X5 — DELETE of org B rows affects 0
x5="$(scalar_authed "$userA" "WITH d AS (DELETE FROM public.research_queue WHERE organization_id='$orgB' RETURNING 1) SELECT count(*) FROM d")"
[[ "$x5" == "0" ]] && pass "X5: A's DELETE touches 0 org-B rows (rq_delete USING hides B)" || fail "X5: cross-org DELETE affected rows" "got=$x5 expected=0"

# X6-X9 — other perimeter tables: A cannot read org B
declare -A perim=(
  ["X6:organization_members"]="organization_id='$orgB'"
  ["X7:organizations"]="id='$orgB'"
  ["X8:organization_invitations"]="organization_id='$orgB'"
  ["X9:audit_storage_writes"]="organization_id='$orgB'"
)
for key in X6:organization_members X7:organizations X8:organization_invitations X9:audit_storage_writes; do
  tbl="${key#*:}"; lbl="${key%%:*}"; pred="${perim[$key]}"
  n="$(scalar_authed "$userA" "SELECT count(*) FROM public.$tbl WHERE $pred")"
  [[ "$n" == "0" ]] && pass "$lbl: A cannot read org B $tbl (0)" || fail "$lbl: cross-org read on $tbl" "got=$n expected=0"
done

# A1/A2 — anon default-deny across the perimeter
for tbl in research_queue organization_members organization_invitations organizations audit_storage_writes; do
  n="$(scalar_anon "SELECT count(*) FROM public.$tbl")"
  [[ "$n" == "0" ]] && pass "A(anon): anon sees 0 rows in $tbl (default-deny)" || fail "A(anon): anon read $tbl" "got=$n expected=0"
done

# P1 — authenticated A: cross-org lineage child INSERT blocked by the trigger
p1="$(capture "
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$userA';
DO \$\$ BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug, parent_run_id)
  VALUES ('$orgA','p1','dr-test-p1-'||left(gen_random_uuid()::text,8),'$runB');
  RAISE NOTICE 'BUG: cross-org child insert succeeded';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK: trigger blocked (check_violation)';
  WHEN OTHERS THEN RAISE NOTICE 'OTHER: % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
echo "$p1" | grep -q 'OK: trigger blocked' && pass "P1: authenticated cross-org child insert blocked by parent-same-org trigger" || fail "P1: cross-org lineage not blocked (authenticated)" "$p1"

# P1b — GENUINE service_role (BYPASSRLS): trigger STILL fires (the core claim)
p1b="$(capture "
BEGIN; SET LOCAL ROLE service_role;
DO \$\$ BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug, parent_run_id)
  VALUES ('$orgA','p1b','dr-test-p1b-'||left(gen_random_uuid()::text,8),'$runB');
  RAISE NOTICE 'BUG: service_role cross-org child insert succeeded';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK: trigger blocked service_role (check_violation)';
  WHEN OTHERS THEN RAISE NOTICE 'OTHER: % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
echo "$p1b" | grep -q 'OK: trigger blocked' && pass "P1b: trigger fences GENUINE service_role (BYPASSRLS) cross-org lineage — the load-bearing case" || fail "P1b: service_role cross-org lineage NOT blocked" "$p1b"

# P2 — same-org lineage allowed
p2="$(capture "
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$userA';
DO \$\$ BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug, parent_run_id)
  VALUES ('$orgA','p2','dr-test-p2-'||left(gen_random_uuid()::text,8),'$runA');
  RAISE NOTICE 'OK: same-org child insert succeeded';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'BUG: same-org insert rejected % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
echo "$p2" | grep -q 'OK: same-org' && pass "P2: same-org child insert succeeds (trigger does not over-block)" || fail "P2: same-org lineage wrongly rejected" "$p2"

# ---- Regime 1b: GUC-hardening two-factor escape hatch (P3/P3b/P3c) ----------
# After 20260622, the escape hatch is private.org_migration_enabled() =
#   app.allow_org_migration='true' AND pg_has_role(session_user,'tenancy_admin','MEMBER').
# It keys on SESSION_USER, which `SET LOCAL ROLE` does NOT change — so the bare
# GUC is no longer sufficient. To faithfully exercise the role factor we must
# change session_user via SET SESSION AUTHORIZATION, which requires a TRUE
# superuser connection. On local Supabase `postgres` is NOT a superuser
# (supabase_admin is), so the escape-hatch arm runs over SUPERUSER_DATABASE_URL.
# A missing / non-superuser / prod-pointing connection FAILS this arm (never a
# silent skip — it is the load-bearing hardening proof, per C-MAJ-1 discipline).
echo "--- Regime 1b: GUC-hardening escape hatch (two-factor: GUC + tenancy_admin) ---"
SU_URL="${SUPERUSER_DATABASE_URL:-}"
PSQL_SU=(psql "$SU_URL" --no-psqlrc --quiet --tuples-only --no-align --pset=footer=off)
capture_su() { "${PSQL_SU[@]}" -c "$1" 2>&1; }

su_ok=0
if [[ -z "$SU_URL" ]]; then
  fail "P3/P3b: SUPERUSER_DATABASE_URL not set" "the two-factor escape-hatch arm needs a TRUE superuser connection (supabase_admin on local Supabase) for SET SESSION AUTHORIZATION; refusing to skip a load-bearing hardening assertion"
elif [[ "$SU_URL" == *"$PROD_REF"* ]]; then
  fail "P3/P3b: SUPERUSER_DATABASE_URL references prod" "prod-ref guard tripped on the superuser connection ($PROD_REF)"
else
  is_su="$(printf '%s' "$(capture_su "SHOW is_superuser")" | tr -d '[:space:]')"
  if [[ "$is_su" == "on" ]]; then
    su_ok=1
  else
    fail "P3/P3b: SUPERUSER_DATABASE_URL is not a superuser connection" "SHOW is_superuser='$is_su' (expected 'on') — SET SESSION AUTHORIZATION would error; use the supabase_admin URL"
  fi
fi

if [[ "$su_ok" == "1" ]]; then
  # P3 (RETARGET, positive) — a tenancy_admin MEMBER (postgres) + GUC → cross-org
  # lineage PERMITTED (break-glass works for a member). The old P3 used SET LOCAL
  # ROLE service_role, which left session_user=postgres (a member) and so passed
  # for the WRONG reason — it never exercised the new role factor.
  p3="$(capture_su "
BEGIN;
SET SESSION AUTHORIZATION postgres;
SET LOCAL app.allow_org_migration='true';
DO \$\$ BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'PRECOND-FAIL: session_user=% (expected postgres)', session_user;
  END IF;
  INSERT INTO public.research_queue (organization_id, topic, topic_slug, parent_run_id)
  VALUES ('$orgA','p3','dr-test-p3-'||left(gen_random_uuid()::text,8),'$runB');
  RAISE NOTICE 'OK: member escape hatch permitted cross-org lineage';
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'RESULT: % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
  if echo "$p3" | grep -q 'PRECOND-FAIL'; then
    fail "P3: precondition failed (session_user not postgres under SET SESSION AUTHORIZATION)" "$p3"
  elif echo "$p3" | grep -q 'OK: member escape hatch'; then
    pass "P3: tenancy_admin member (postgres) + GUC permits cross-org lineage (member break-glass works)"
  else
    fail "P3: member (postgres) + GUC did NOT permit cross-org lineage (break-glass broken)" "$p3"
  fi

  # P3b-i (NEW, negative — THE load-bearing hardening assertion) — a non-member
  # session (service_role: the app's real session identity after authenticator →
  # SET ROLE) WITH the GUC set is STILL blocked from cross-org lineage. This is
  # exactly what the bare-GUC predicate used to permit; membership is now required.
  p3bi="$(capture_su "
BEGIN;
SET SESSION AUTHORIZATION service_role;
SET LOCAL app.allow_org_migration='true';
DO \$\$ BEGIN
  IF session_user <> 'service_role' THEN
    RAISE EXCEPTION 'PRECOND-FAIL: session_user=% (expected service_role)', session_user;
  END IF;
  INSERT INTO public.research_queue (organization_id, topic, topic_slug, parent_run_id)
  VALUES ('$orgA','p3b','dr-test-p3b-'||left(gen_random_uuid()::text,8),'$runB');
  RAISE NOTICE 'BUG: service_role escape hatch permitted cross-org lineage despite non-membership';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'OK: trigger blocked service_role despite GUC (check_violation)';
  WHEN OTHERS THEN RAISE NOTICE 'OTHER: % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
  if echo "$p3bi" | grep -q 'PRECOND-FAIL'; then
    fail "P3b(INSERT): precondition failed (session_user not service_role)" "$p3bi"
  elif echo "$p3bi" | grep -q 'OK: trigger blocked service_role'; then
    pass "P3b(INSERT): service_role + GUC STILL blocked from cross-org lineage (membership is the necessary 2nd factor — the hardening win)"
  else
    fail "P3b(INSERT): service_role escaped the gate with only the GUC (HARDENING REGRESSION)" "$p3bi"
  fi

  # P3b-ii (NEW, negative — B-1 UPDATE arm) — the same non-member + GUC cannot
  # mutate organization_id either; B-1's two-factor gate holds symmetrically.
  # Mutates to a REAL org (orgB) so a regression surfaces as a clear success, not
  # an ambiguous FK error.
  p3bii="$(capture_su "
BEGIN;
SET SESSION AUTHORIZATION service_role;
SET LOCAL app.allow_org_migration='true';
DO \$\$ DECLARE rid uuid; BEGIN
  IF session_user <> 'service_role' THEN
    RAISE EXCEPTION 'PRECOND-FAIL: session_user=% (expected service_role)', session_user;
  END IF;
  SELECT id INTO rid FROM public.research_queue WHERE organization_id='$orgA' LIMIT 1;
  IF rid IS NULL THEN RAISE EXCEPTION 'PRECOND-FAIL: no org-A row to mutate'; END IF;
  UPDATE public.research_queue SET organization_id='$orgB' WHERE id=rid;
  RAISE NOTICE 'BUG: service_role org_id mutation permitted despite non-membership';
EXCEPTION
  WHEN OTHERS THEN RAISE NOTICE 'RESULT: % %', SQLSTATE, SQLERRM;
END \$\$;
ROLLBACK;")"
  if echo "$p3bii" | grep -q 'PRECOND-FAIL'; then
    fail "P3b(UPDATE/B-1): precondition failed" "$p3bii"
  elif echo "$p3bii" | grep -q 'BUG: service_role org_id mutation permitted'; then
    fail "P3b(UPDATE/B-1): service_role mutated org_id with only the GUC (B-1 HARDENING REGRESSION)" "$p3bii"
  elif echo "$p3bii" | grep -qi 'immutable'; then
    pass "P3b(UPDATE/B-1): service_role + GUC STILL blocked from org_id mutation (B-1 two-factor holds)"
  else
    fail "P3b(UPDATE/B-1): unexpected outcome (expected B-1 'immutable' block)" "$p3bii"
  fi
fi

# P3c (NEW, negative — B-1 message de-oracle). Runs over the regular (non-super)
# connection: fire B-1 with NO GUC at all and assert the exception (a) blocks and
# (b) no longer leaks the bypass-flag name (the shipped B-1 text leaked
# 'set app.allow_org_migration=true to override').
p3c="$(capture "
BEGIN; SET LOCAL ROLE service_role;
DO \$\$ DECLARE rid uuid; BEGIN
  SELECT id INTO rid FROM public.research_queue WHERE organization_id='$orgA' LIMIT 1;
  IF rid IS NULL THEN RAISE EXCEPTION 'PRECOND-FAIL: no org-A row'; END IF;
  UPDATE public.research_queue SET organization_id='$orgB' WHERE id=rid;
  RAISE NOTICE 'BUG: org_id mutation succeeded without escape hatch';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'B1MSG: %', SQLERRM;
END \$\$;
ROLLBACK;")"
if echo "$p3c" | grep -q 'PRECOND-FAIL'; then
  fail "P3c: precondition failed (no org-A row)" "$p3c"
elif echo "$p3c" | grep -qi 'allow_org_migration'; then
  fail "P3c: B-1 exception STILL leaks the bypass-flag name (oracle not removed)" "$p3c"
elif echo "$p3c" | grep -q 'B1MSG:' && echo "$p3c" | grep -qi 'immutable'; then
  pass "P3c: B-1 blocks org_id mutation with a generic message — no allow_org_migration oracle leaked"
else
  fail "P3c: B-1 did not block as expected, or message unexpected" "$p3c"
fi

# P4/P4b/P5 — UPDATE arm of the trigger (G-CRIT-1: the trigger fires on
# BEFORE INSERT OR UPDATE OF parent_run_id; the INSERT path alone is insufficient).
# Pattern: insert a same-org child with parent_run_id NULL, then UPDATE its
# parent_run_id and assert the trigger verdict.

# P4 — authenticated A reparents own child to a cross-org parent → blocked
p4="$(capture "
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$userA';
DO \$\$ DECLARE cid uuid; BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug)
  VALUES ('$orgA','p4','dr-test-p4-'||left(gen_random_uuid()::text,8)) RETURNING id INTO cid;
  BEGIN
    UPDATE public.research_queue SET parent_run_id='$runB' WHERE id=cid;
    RAISE NOTICE 'BUG: cross-org reparent (UPDATE) succeeded';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK: trigger blocked reparent (check_violation)';
    WHEN OTHERS THEN RAISE NOTICE 'OTHER: % %', SQLSTATE, SQLERRM; END;
END \$\$;
ROLLBACK;")"
echo "$p4" | grep -q 'OK: trigger blocked' && pass "P4: authenticated cross-org reparent via UPDATE blocked by trigger" || fail "P4: cross-org reparent (UPDATE) not blocked (authenticated)" "$p4"

# P4b — GENUINE service_role reparents to a cross-org parent via UPDATE → blocked
p4b="$(capture "
BEGIN; SET LOCAL ROLE service_role;
DO \$\$ DECLARE cid uuid; BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug)
  VALUES ('$orgA','p4b','dr-test-p4b-'||left(gen_random_uuid()::text,8)) RETURNING id INTO cid;
  BEGIN
    UPDATE public.research_queue SET parent_run_id='$runB' WHERE id=cid;
    RAISE NOTICE 'BUG: service_role cross-org reparent (UPDATE) succeeded';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK: trigger blocked service_role reparent (check_violation)';
    WHEN OTHERS THEN RAISE NOTICE 'OTHER: % %', SQLSTATE, SQLERRM; END;
END \$\$;
ROLLBACK;")"
echo "$p4b" | grep -q 'OK: trigger blocked' && pass "P4b: service_role (BYPASSRLS) cross-org reparent via UPDATE blocked by trigger" || fail "P4b: service_role cross-org reparent (UPDATE) NOT blocked" "$p4b"

# P5 — authenticated A reparents own child to a SAME-org parent via UPDATE → allowed (control)
p5="$(capture "
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$userA';
DO \$\$ DECLARE cid uuid; BEGIN
  INSERT INTO public.research_queue (organization_id, topic, topic_slug)
  VALUES ('$orgA','p5','dr-test-p5-'||left(gen_random_uuid()::text,8)) RETURNING id INTO cid;
  BEGIN
    UPDATE public.research_queue SET parent_run_id='$runA' WHERE id=cid;
    RAISE NOTICE 'OK: same-org reparent (UPDATE) permitted';
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'BUG: same-org reparent rejected % %', SQLSTATE, SQLERRM; END;
END \$\$;
ROLLBACK;")"
echo "$p5" | grep -q 'OK: same-org reparent' && pass "P5: same-org reparent via UPDATE permitted (trigger does not over-block the UPDATE arm)" || fail "P5: same-org reparent (UPDATE) wrongly rejected" "$p5"

# ---- Tier 2: storage catalog backstop (§5.3) ------------------------------
echo "--- Tier 2: storage catalog backstop ---"
s1="$(scalar "SELECT public FROM storage.buckets WHERE id='research-projects'")"
[[ "$s1" == "f" ]] && pass "S1: research-projects bucket is private (public=false)" || fail "S1: bucket not private" "public=$s1 expected=f"

s2="$(scalar "
SELECT count(*) FROM pg_policies
WHERE schemaname='storage' AND tablename='objects'
  AND cmd IN ('SELECT','ALL') AND permissive='PERMISSIVE'
  AND (roles && ARRAY['anon','authenticated','public']::name[] OR roles = '{public}')")"
[[ "$s2" == "0" ]] && pass "S2: no permissive read policy opens storage.objects to client roles (incl. public)" || fail "S2: permissive storage.objects read policy present" "count=$s2 expected=0"

# ---- Tier 1: authenticated cross-org route probe (§5.3, the PRIMARY storage boundary) -
# Session source (G-MAJ-1): the env var SESSION wins; otherwise the seed
# SELF-MINTS a cookie for user A and stores it in the fixture, so Tier-1 runs
# automatically given only a running app at BASE_URL (no manual session juggling,
# closing the ephemeral-user chicken-and-egg). Tier-1 is skipped ONLY when there
# is no app to probe (no BASE_URL) — never silently.
echo "--- Tier 1: authenticated cross-org route probe ---"
sess="${SESSION:-$(read_fx sessionCookie)}"
if [[ -n "${BASE_URL:-}" && -n "$sess" ]]; then
  command -v curl >/dev/null 2>&1 || { echo "ERROR: Tier-1 needs curl" >&2; exit 2; }
  probe() { curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $sess" "$BASE_URL$1"; }
  # T1-T3: session A reaching org B's slug must NOT succeed
  for t in "T1:/api/runs/$slugB/files" "T2:/api/runs/$slugB/manifest" "T3:/api/runs/$slugB/file/probe.txt"; do
    lbl="${t%%:*}"; path="${t#*:}"
    code="$(probe "$path")"
    if [[ "$code" == "403" || "$code" == "404" ]]; then
      pass "$lbl: session A → org B $path returns $code (foreign-org path refused)"
    else
      fail "$lbl: session A reached org B path" "GET $path returned $code (expected 403/404)"
    fi
  done
  # T4: positive control — own org succeeds
  t4="$(probe "/api/runs/$slugA/files")"
  [[ "$t4" == "200" ]] && pass "T4: session A → own org $slugA/files returns 200 (probe wired correctly)" || fail "T4: own-org positive control failed" "got=$t4 expected=200"
elif [[ -n "${BASE_URL:-}" ]]; then
  # C-MAJ-1: BASE_URL means the operator intends to probe the primary storage
  # boundary. A missing session here is a FAILURE, never a silent skip-as-pass.
  fail "Tier 1 storage route probe — BASE_URL set but NO session (self-mint failed AND no SESSION env)" "a BASE_URL run must exercise the primary storage boundary; provide SESSION or a working NEXT_PUBLIC_SUPABASE_ANON_KEY for self-mint"
else
  skip "Tier 1 storage route probe — no BASE_URL (no running app to probe). Start 'next dev' against the non-prod target and pass BASE_URL to exercise the PRIMARY storage boundary (decision #4)."
fi

# ---- Tier 3: optional anon HTTP probes (--http) ---------------------------
if [[ "$WANT_HTTP" == "1" ]]; then
  echo "--- Tier 3: anon HTTP probes (--http) ---"
  command -v curl >/dev/null 2>&1 || { echo "ERROR: --http needs curl" >&2; exit 2; }
  PROD="https://dynamic-research.vercel.app"
  h1="$(curl -s -o /dev/null -w '%{http_code}' "$PROD/api/runs")"
  [[ "$h1" == "401" ]] && pass "H1: anon GET $PROD/api/runs → 401" || fail "H1: anon API not denied" "got=$h1 expected=401"
  h2="$(curl -s -o /dev/null -w '%{http_code}' "$PROD/")"
  [[ "$h2" == "307" ]] && pass "H2: anon GET $PROD/ → 307 (login redirect)" || fail "H2: root not redirected" "got=$h2 expected=307"
else
  skip "Tier 3 anon HTTP probes — pass --http to enable (network-coupled, hits prod URL)"
fi

# ---- summary --------------------------------------------------------------
echo ""
echo "Total: $TOTAL  Pass: $((TOTAL - FAILS))  Fail: $FAILS  Skip: $SKIPS"
[[ "$FAILS" -gt 0 ]] && exit 1
exit 0
