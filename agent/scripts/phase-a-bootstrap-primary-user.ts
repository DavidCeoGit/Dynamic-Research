/**
 * phase-a-bootstrap-primary-user.ts — Multi-Tenancy Phase A post-deploy bootstrap.
 *
 * Implements Documentation/multi-tenancy-phase-a-plan.md v3 §4.2.
 *
 * Run AFTER `supabase db push` has applied 20260522-phase-a-multi-tenancy.sql.
 * Inserts the primary owner (ceo@thewcoachinggroup.com) into auth.users
 * (idempotent) and adds the owner row in organization_members for the
 * system-default org. Closes Gemini's "empty-org window" concern (Option 1.5).
 *
 * Idempotent. Re-running is a no-op if the bootstrap row already exists.
 *
 * Pre-check (matches Phase B callback contract): if system-default already has
 * an owner whose email != EXPECTED_EMAIL, abort with diagnostic — no mutation.
 * Operator must investigate before proceeding.
 *
 * State file at agent/scripts/.phase-a-bootstrap-state.json records whether
 * THIS run created the auth.users row. The rollback script reads this to
 * decide whether to delete the auth.users row safely on rollback.
 *
 * Usage:
 *   cd "Dynamic Research/agent"
 *   node --env-file=.env --import=tsx scripts/phase-a-bootstrap-primary-user.ts
 *
 * Exit codes:
 *   0 — bootstrap complete (created or verified existing)
 *   1 — pre-check failed (unexpected owner present); no mutation performed
 *   2 — environment/Supabase API error (missing key, network, schema not migrated)
 *
 * Shipped S46 (2026-05-22).
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, ".phase-a-bootstrap-state.json");
const EXPECTED_EMAIL = "ceo@thewcoachinggroup.com";
const DEFAULT_ORG_SLUG = "system-default";

interface BootstrapState {
  created_user: boolean;
  user_id: string;
  applied_at: string;
}

// v3 (Codex C3): state file is MONOTONIC on created_user. If a prior run
// recorded created_user=true for the same user_id, we MUST preserve that
// on later no-op reruns — otherwise rollback loses the provenance that
// Phase A actually created the auth.users row.
function readExistingState(): BootstrapState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as BootstrapState;
  } catch {
    return null;
  }
}

function writeStateMonotonic(next: BootstrapState): BootstrapState {
  const prior = readExistingState();
  let merged = next;
  if (prior && prior.user_id === next.user_id && prior.created_user === true) {
    merged = { ...next, created_user: true };
  }
  writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

function fail(code: number, msg: string): never {
  console.error(`[phase-a-bootstrap] ${msg}`);
  process.exit(code);
}

function info(msg: string): void {
  console.log(`[phase-a-bootstrap] ${msg}`);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  fail(2, "missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// -----------------------------------------------------------------------------
// 1. Resolve system-default org_id (must already exist from migration backfill)
// -----------------------------------------------------------------------------
const { data: org, error: orgErr } = await sb
  .from("organizations")
  .select("id")
  .eq("slug", DEFAULT_ORG_SLUG)
  .single();

if (orgErr || !org) {
  fail(
    2,
    `system-default org not found (slug=${DEFAULT_ORG_SLUG}); migration must run first. Detail: ${orgErr?.message ?? "no row"}`
  );
}
info(`Resolved system-default org_id=${org.id}`);

// -----------------------------------------------------------------------------
// 2. PRE-CHECK — any existing owners on system-default?
//    If so, all must have email === EXPECTED_EMAIL or we abort.
// -----------------------------------------------------------------------------
const { data: existingOwners, error: ownerErr } = await sb
  .from("organization_members")
  .select("user_id, role")
  .eq("organization_id", org.id)
  .eq("role", "owner");

if (ownerErr) {
  fail(2, `pre-check: failed to query organization_members: ${ownerErr.message}`);
}

if (existingOwners && existingOwners.length > 0) {
  for (const ownerRow of existingOwners) {
    const { data: u, error: userErr } = await sb.auth.admin.getUserById(
      ownerRow.user_id
    );
    if (userErr) {
      fail(
        2,
        `pre-check: failed to resolve auth.users for owner ${ownerRow.user_id}: ${userErr.message}`
      );
    }
    if (u?.user?.email !== EXPECTED_EMAIL) {
      fail(
        1,
        `PRE-CHECK FAILED: system-default org has unexpected owner. user_id=${ownerRow.user_id} email=${u?.user?.email ?? "(unknown)"} expected=${EXPECTED_EMAIL}. ABORTING — operator must investigate. No mutation performed.`
      );
    }
  }
  // All existing owners match EXPECTED_EMAIL.
  const expectedOwner = existingOwners[0];
  info(
    `system-default already has expected owner(s); no mutation needed. user_id=${expectedOwner.user_id}`
  );
  // v3 (Codex C3): write monotonically — if prior state recorded
  // created_user=true for THIS user_id, preserve it on no-op reruns.
  const finalState = writeStateMonotonic({
    created_user: false,
    user_id: expectedOwner.user_id,
    applied_at: new Date().toISOString(),
  });
  info(`State file written: ${STATE_FILE} (created_user=${finalState.created_user})`);
  process.exit(0);
}

// -----------------------------------------------------------------------------
// 3. createUser idempotently
//    v2 (Gemini Major-1): paginate listUsers to handle any project size.
//    Default Supabase page size is 50; we use perPage=100 and iterate until
//    we find the expected user or exhaust pages.
//    v3 (Codex M1): added race recovery — if two bootstrap processes both
//    miss the user in listUsers, both call createUser. The losing process
//    sees `user_already_exists` and falls through to re-lookup instead of
//    failing the script.
// -----------------------------------------------------------------------------
async function findExpectedUser(): Promise<{ id: string } | undefined> {
  for (let page = 1; ; page++) {
    const { data: listed, error: listErr } = await sb.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (listErr) {
      fail(2, `auth.admin.listUsers (page ${page}) failed: ${listErr.message}`);
    }
    if (!listed?.users || listed.users.length === 0) {
      return undefined;
    }
    const hit = listed.users.find((u) => u.email === EXPECTED_EMAIL);
    if (hit) return hit;
    if (listed.users.length < 100) return undefined;
  }
}

let userId: string;
let createdUser = false;
let found = await findExpectedUser();

if (found) {
  userId = found.id;
  info(`Found existing auth.users row for ${EXPECTED_EMAIL}; user_id=${userId}`);
} else {
  const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
    email: EXPECTED_EMAIL,
    email_confirm: true,
  });
  if (createErr) {
    // v3 (Codex M1): race-recovery. Two concurrent runs both miss the user
    // in listUsers; one wins createUser, the other sees user_already_exists.
    // The loser should re-lookup and continue as if the user pre-existed.
    const isAlreadyExists =
      (createErr as { code?: string }).code === "user_already_exists" ||
      /already.*registered|already.*exists/i.test(createErr.message);
    if (isAlreadyExists) {
      info(`createUser hit user_already_exists (race); re-fetching via listUsers`);
      found = await findExpectedUser();
      if (!found) {
        fail(2, `race-recovery failed: createUser reported user_already_exists but listUsers does not see ${EXPECTED_EMAIL}`);
      }
      userId = found.id;
      createdUser = false;
      info(`Race-recovered: user_id=${userId} (createdUser=false)`);
    } else {
      fail(2, `auth.admin.createUser failed: ${createErr.message}`);
    }
  } else if (!newUser?.user) {
    fail(2, `auth.admin.createUser returned no user`);
  } else {
    userId = newUser.user.id;
    createdUser = true;
    info(`Created auth.users row for ${EXPECTED_EMAIL}; user_id=${userId}`);
  }
}

// -----------------------------------------------------------------------------
// 4. Insert owner membership (idempotent via PK conflict)
// -----------------------------------------------------------------------------
const { error: memberErr } = await sb.from("organization_members").insert({
  organization_id: org.id,
  user_id: userId,
  role: "owner",
});

if (memberErr) {
  // v2 (Gemini Minor-2): rely only on PostgreSQL state code for
  // unique_violation (23505). Driver error messages drift; codes do not.
  const isDupKey = (memberErr as { code?: string }).code === "23505";
  if (!isDupKey) {
    fail(2, `organization_members.insert failed: ${memberErr.message}`);
  }
  info(`organization_members row already exists for (${org.id}, ${userId}); idempotent skip`);
}

// -----------------------------------------------------------------------------
// 5. POST-STATE invariant: exactly 1 owner on system-default, matching userId
// -----------------------------------------------------------------------------
const { data: postOwners, error: postErr } = await sb
  .from("organization_members")
  .select("user_id")
  .eq("organization_id", org.id)
  .eq("role", "owner");

if (postErr) {
  fail(2, `post-state query failed: ${postErr.message}`);
}
if (!postOwners || postOwners.length !== 1 || postOwners[0].user_id !== userId) {
  fail(
    2,
    `POST-STATE invariant failed: expected exactly 1 owner=${userId} on system-default, got ${JSON.stringify(postOwners)}`
  );
}

// -----------------------------------------------------------------------------
// 6. Write state file for rollback (v3: monotonic write — see Codex C3)
// -----------------------------------------------------------------------------
const finalState = writeStateMonotonic({
  created_user: createdUser,
  user_id: userId,
  applied_at: new Date().toISOString(),
});
info(`State file written: ${STATE_FILE} (created_user=${finalState.created_user})`);
info(`Bootstrap complete: created_user=${finalState.created_user}, user_id=${userId}`);
