/**
 * phase-a-rollback-primary-user.ts — Multi-Tenancy Phase A bootstrap rollback.
 *
 * Implements Documentation/multi-tenancy-phase-a-plan.md v3 §6.
 *
 * Run AFTER the migration rollback SQL has been applied (which CASCADEs the
 * organization_members row when organizations is dropped). This script only
 * needs to clean up the auth.users row that the bootstrap script may have
 * created — and ONLY if the bootstrap actually created it.
 *
 * State-file-aware: reads agent/scripts/.phase-a-bootstrap-state.json (written
 * monotonically by the bootstrap script) and uses the `created_user` flag to
 * decide whether deleting the auth.users row is safe.
 *
 *   - created_user=true  -> Phase A created the user; safe to delete.
 *   - created_user=false -> The user pre-existed; leave it alone.
 *   - no state file      -> Bootstrap never ran successfully; nothing to do.
 *
 * On success, removes the state file so the next bootstrap run starts clean.
 *
 * Usage:
 *   cd "Dynamic Research/agent"
 *   node --env-file=.env --import=tsx scripts/phase-a-rollback-primary-user.ts
 *
 * Exit codes:
 *   0 — rollback completed (user deleted, or no action needed)
 *   2 — environment/Supabase API error
 *
 * Shipped S46 (2026-05-22) per Codex M4 (rollback script claimed by plan but
 * not present in repo).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, ".phase-a-bootstrap-state.json");

interface BootstrapState {
  created_user: boolean;
  user_id: string;
  applied_at: string;
}

function fail(code: number, msg: string): never {
  console.error(`[phase-a-rollback] ${msg}`);
  process.exit(code);
}

function info(msg: string): void {
  console.log(`[phase-a-rollback] ${msg}`);
}

if (!existsSync(STATE_FILE)) {
  info(`No bootstrap state file at ${STATE_FILE}; bootstrap may not have run. No action.`);
  process.exit(0);
}

let state: BootstrapState;
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as BootstrapState;
} catch (e) {
  fail(2, `failed to parse state file ${STATE_FILE}: ${(e as Error).message}`);
}

info(`Loaded state: created_user=${state.created_user} user_id=${state.user_id} applied_at=${state.applied_at}`);

if (!state.created_user) {
  info(`Bootstrap did not create user_id=${state.user_id}; leaving auth.users untouched.`);
  unlinkSync(STATE_FILE);
  info(`Removed state file ${STATE_FILE}`);
  process.exit(0);
}

// Bootstrap created the user; safe to delete on rollback.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  fail(2, "missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { error } = await sb.auth.admin.deleteUser(state.user_id);
if (error) {
  // If the user is already gone (e.g. operator deleted via dashboard), that's
  // an acceptable terminal state for a rollback — log and continue.
  const isMissing = /not\s*found|does\s*not\s*exist/i.test(error.message);
  if (isMissing) {
    info(`auth.users user_id=${state.user_id} already absent; rollback effectively complete`);
  } else {
    fail(2, `auth.admin.deleteUser(${state.user_id}) failed: ${error.message}`);
  }
} else {
  info(`Deleted auth.users user_id=${state.user_id}`);
}

unlinkSync(STATE_FILE);
info(`Removed state file ${STATE_FILE}; rollback complete`);
