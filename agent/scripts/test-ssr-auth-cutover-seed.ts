/**
 * test-ssr-auth-cutover-seed.ts — committed NON-PROD fixture for
 * test-ssr-auth-cutover.sh (Phase 5 Component 2, design §5.1/§5.5).
 *
 * Why a committed seed (C-CRIT-1): the harness's HTTP Tier-1 probe hits the
 * live app over its OWN pooled DB connection + the Storage API, so
 * rollback-wrapped psql fixtures are invisible to it and psql cannot roll back
 * storage objects. So we create a COMMITTED seed (two orgs, two Admin-API
 * users, an owner membership + a run each, and one real storage object per org
 * prefix), shared by both the psql RLS matrix (which SAVEPOINT-isolates its own
 * mutations) and the HTTP Tier-1 probe. Users are created via the Supabase
 * Admin API — NOT a raw auth.users SQL insert (C-MAJ-1) — matching
 * phase-a-bootstrap-primary-user.ts:192.
 *
 * Self-mint (S151 MERGE-gate Gemini G-MAJ-1): the seed ALSO mints an SSR
 * session cookie for user A (admin.generateLink → anon verifyOtp → @supabase/ssr
 * cookie, the reference_localhost_dev_session_mint recipe) so Tier-1 runs
 * automatically whenever a running app (BASE_URL) is supplied — closing the
 * chicken-and-egg where an ephemeral per-run user could never have a pre-set
 * SESSION. The cookie goes into the temp fixture file only (never printed,
 * never committed); mint failure is non-fatal (Tier-1 then skips loudly).
 *
 * Partial-failure safety (S151 G-MIN-1): every fatal exit first writes whatever
 * fixture state exists so teardown can always clean up — no orphaned non-prod
 * resources on a mid-seed failure.
 *
 * HARD prod guard: refuses to run unless DR_TEST_ENV=nonprod AND no env var
 * references the prod ref mfjgoghlpqgxcycxoxio. The seed is COMMITTED, so a prod
 * run would inject phantom orgs/users/objects.
 *
 * Subcommands:
 *   seed                    create fixtures; print "FIXTURE_PATH=<abs path>".
 *   teardown --in <file>    delete everything the fixture references.
 *
 * Usage (from agent/, env mapped to the NON-PROD target):
 *   node --import=tsx scripts/test-ssr-auth-cutover-seed.ts seed
 *
 * Exit codes: 0 ok · 2 env/guard/API error.
 *
 * Phase 5 (S151). Mirrors the createClient/Admin-API/storage conventions of the
 * agent worker; pair-edited semantics with scopedStoragePath().
 */

import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scopedStoragePath } from "../lib/storage-paths.js";

const BUCKET = "research-projects"; // private bucket (conventions.json bucketName)
const PROD_REF = "mfjgoghlpqgxcycxoxio";

interface Fixture {
  suffix: string;
  orgA?: string;
  orgB?: string;
  userA?: string;
  userB?: string;
  runA?: string;
  runB?: string;
  slugA?: string;
  slugB?: string;
  pathA?: string;
  pathB?: string;
  createdUserA?: boolean;
  createdUserB?: boolean;
  cookieName?: string;   // SSR auth cookie name for the running app (self-mint)
  sessionCookie?: string; // "<name>=<value>" for user A; absent if mint failed
}

function info(msg: string): void {
  console.log(`[ssr-seed] ${msg}`);
}

// ---- hard non-prod guard --------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
function guardFail(msg: string): never {
  console.error(`[ssr-seed] ${msg}`);
  process.exit(2);
}
if (!url || !key) guardFail("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
if (process.env.DR_TEST_ENV !== "nonprod") {
  guardFail("refusing to run: DR_TEST_ENV must equal 'nonprod' (this seed is COMMITTED — never run against prod)");
}
if (url.includes(PROD_REF) || key.includes(PROD_REF) || (anonKey ?? "").includes(PROD_REF)) {
  guardFail(`refusing to run: SUPABASE env references the prod ref ${PROD_REF}`);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cmd = process.argv[2];

// ---------------------------------------------------------------------------
async function seed(): Promise<void> {
  // The seed owns the fixture path so both Git-Bash (-f/rm) and Windows-native
  // node (writeFileSync/read) agree on it. Forward slashes work on both OSes.
  const out = join(tmpdir(), `dr-ssr-fx-${process.pid}-${randomBytes(4).toString("hex")}.json`).replace(/\\/g, "/");
  const suffix = randomBytes(4).toString("hex");
  const fx: Fixture = { suffix };

  // Persist whatever fixture state exists, then exit. Guarantees teardown can
  // always clean up partial seeds (G-MIN-1). Still prints FIXTURE_PATH so the
  // orchestrator's trap fires.
  const seedFail = (msg: string): never => {
    try { writeFileSync(out, JSON.stringify(fx, null, 2) + "\n"); } catch { /* best effort */ }
    console.error(`[ssr-seed] ${msg}`);
    console.log(`FIXTURE_PATH=${out}`);
    process.exit(2);
  };

  const slugA = `dr-test-${suffix}-a`;
  const slugB = `dr-test-${suffix}-b`;
  const emailA = `dr-test-${suffix}-a@dynamic-research.invalid`;
  const emailB = `dr-test-${suffix}-b@dynamic-research.invalid`;
  fx.slugA = slugA; fx.slugB = slugB;

  // 1) Admin-API users (committed; matches phase-a-bootstrap-primary-user.ts:192)
  const mkUser = async (email: string): Promise<string> => {
    const { data, error } = await sb.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data?.user) seedFail(`auth.admin.createUser(${email}) failed: ${error?.message ?? "no user"}`);
    return data.user.id;
  };
  fx.userA = await mkUser(emailA); fx.createdUserA = true;
  fx.userB = await mkUser(emailB); fx.createdUserB = true;
  info(`users: A=${fx.userA} B=${fx.userB}`);

  // 2) Orgs (org-before-member order satisfies the min-owner trigger)
  const mkOrg = async (name: string, slug: string): Promise<string> => {
    const { data, error } = await sb.from("organizations").insert({ name, slug }).select("id").single();
    if (error || !data) seedFail(`insert org ${slug} failed: ${error?.message ?? "no row"}`);
    return data.id as string;
  };
  fx.orgA = await mkOrg(`DR Test ${suffix} A`, slugA);
  fx.orgB = await mkOrg(`DR Test ${suffix} B`, slugB);

  // 3) Owner memberships (one org per user → om_one_org_per_user holds)
  const mkMember = async (orgId: string, userId: string): Promise<void> => {
    const { error } = await sb.from("organization_members").insert({
      organization_id: orgId, user_id: userId, role: "owner",
    });
    if (error) seedFail(`insert member ${userId}@${orgId} failed: ${error.message}`);
  };
  await mkMember(fx.orgA, fx.userA);
  await mkMember(fx.orgB, fx.userB);

  // 4) One run per org (parent_run_id NULL → parent-same-org trigger passes)
  const mkRun = async (orgId: string, slug: string): Promise<string> => {
    const { data, error } = await sb
      .from("research_queue")
      .insert({ organization_id: orgId, topic: `Phase 5 harness ${slug}`, topic_slug: slug })
      .select("id").single();
    if (error || !data) seedFail(`insert run ${slug} failed: ${error?.message ?? "no row"}`);
    return data.id as string;
  };
  fx.runA = await mkRun(fx.orgA, slugA);
  fx.runB = await mkRun(fx.orgB, slugB);

  // 5) One real storage object under each org prefix (session-derived-prefix
  //    invariant target for the HTTP Tier-1 probe). Path via scopedStoragePath.
  fx.pathA = scopedStoragePath(fx.orgA, slugA, "probe.txt");
  fx.pathB = scopedStoragePath(fx.orgB, slugB, "probe.txt");
  const body = Buffer.from(`dr-test ${suffix} probe object\n`, "utf-8");
  for (const p of [fx.pathA, fx.pathB]) {
    const { error } = await sb.storage.from(BUCKET).upload(p, body, { contentType: "text/plain", upsert: true });
    if (error) seedFail(`storage upload ${p} failed: ${error.message}`);
  }

  // 6) Self-mint an SSR session cookie for user A (G-MAJ-1). Non-fatal: a mint
  //    failure leaves Tier-1 to skip loudly rather than failing the whole run.
  if (anonKey) {
    try {
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email: emailA });
      const hashed = linkData?.properties?.hashed_token;
      if (linkErr || !hashed) throw new Error(linkErr?.message ?? "no hashed_token");
      const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const { data: vData, error: vErr } = await anon.auth.verifyOtp({ type: "email", token_hash: hashed });
      if (vErr || !vData?.session) throw new Error(vErr?.message ?? "no session");
      // @supabase/ssr default cookie: name sb-<ref>-auth-token (ref = URL host's
      // first label); value "base64-" + base64url(JSON.stringify(session)).
      const ref = new URL(url).hostname.split(".")[0];
      const cookieName = `sb-${ref}-auth-token`;
      const value = "base64-" + Buffer.from(JSON.stringify(vData.session), "utf-8").toString("base64url");
      // @supabase/ssr chunks a long cookie into name.0/name.1/... at ~3180 chars
      // (C-MAJ-1 prefers emitting chunks over skipping). Build the full Cookie
      // header so the harness passes it verbatim; @supabase/ssr reassembles
      // name.N in order. A single chunk uses the unsuffixed name (Codex-validated).
      const CHUNK = 3180;
      let cookieHeader: string;
      if (value.length <= CHUNK) {
        cookieHeader = `${cookieName}=${value}`;
      } else {
        const parts: string[] = [];
        for (let i = 0, n = 0; i < value.length; i += CHUNK, n++) {
          parts.push(`${cookieName}.${n}=${value.slice(i, i + CHUNK)}`);
        }
        cookieHeader = parts.join("; ");
        info(`session cookie chunked into ${parts.length} parts (@supabase/ssr name.N)`);
      }
      fx.cookieName = cookieName;
      fx.sessionCookie = cookieHeader;
      info(`self-minted Tier-1 session cookie for user A (${cookieName})`);
    } catch (e) {
      info(`WARN: session self-mint failed (${(e as Error).message}) — Tier-1 will skip unless SESSION provided`);
    }
  } else {
    info("NEXT_PUBLIC_SUPABASE_ANON_KEY not set — skipping Tier-1 session self-mint");
  }

  writeFileSync(out, JSON.stringify(fx, null, 2) + "\n");
  info(`seed complete → ${out}`);
  console.log(`FIXTURE_PATH=${out}`); // LAST line, machine-readable
}

// ---------------------------------------------------------------------------
async function teardown(): Promise<void> {
  const flag = process.argv[3];
  const inFile = process.argv[4];
  if (flag !== "--in" || !inFile) guardFail("expected 'teardown --in <file>'");
  let fx: Fixture;
  try {
    fx = JSON.parse(readFileSync(inFile, "utf-8")) as Fixture;
  } catch (e) {
    guardFail(`cannot read fixture ${inFile}: ${(e as Error).message}`);
  }
  // Explicit dependency order (research_queue org FK is ON DELETE RESTRICT, so
  // org delete would NOT cascade runs — delete children-of-the-seed first).
  // Each step is best-effort + idempotent so a partial seed still cleans up.
  const warn = (label: string, error: { message: string } | null): void => {
    if (error) console.error(`[ssr-seed] teardown WARN ${label}: ${error.message}`);
  };
  for (const p of [fx.pathA, fx.pathB]) {
    if (!p) continue;
    const { error } = await sb.storage.from(BUCKET).remove([p]);
    warn(`storage ${p}`, error as { message: string } | null);
  }
  for (const id of [fx.runA, fx.runB]) {
    if (!id) continue;
    const { error } = await sb.from("research_queue").delete().eq("id", id);
    warn(`run ${id}`, error);
  }
  for (const id of [fx.orgA, fx.orgB]) {
    if (!id) continue;
    const { error: mErr } = await sb.from("organization_members").delete().eq("organization_id", id);
    warn(`members of ${id}`, mErr);
    const { error: oErr } = await sb.from("organizations").delete().eq("id", id);
    warn(`org ${id}`, oErr);
  }
  for (const [id, created] of [[fx.userA, fx.createdUserA], [fx.userB, fx.createdUserB]] as const) {
    if (!id || !created) continue;
    const { error } = await sb.auth.admin.deleteUser(id);
    warn(`user ${id}`, error as { message: string } | null);
  }
  info(`teardown complete (fixture ${fx.suffix})`);
}

// ---------------------------------------------------------------------------
if (cmd === "seed") {
  await seed();
} else if (cmd === "teardown") {
  await teardown();
} else {
  guardFail("usage: <seed | teardown --in FILE>");
}
