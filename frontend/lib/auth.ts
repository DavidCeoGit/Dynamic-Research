/**
 * Authentication + organization-context helpers (server-side only).
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 * Phase 2 adds getOrgContextDualPath() as the env→session migration bridge
 * (design §4.1). Phase 4 will delete it once env fallback is retired.
 *
 * Throw semantics:
 *   requireUser           → UnauthorizedError (no session)
 *   requireOrgContext     → UnauthorizedError | ForbiddenError | Error
 *                            (query failure surfaces as generic Error so
 *                            getOrgContextDualPath does NOT misclassify it
 *                            as "no session yet" — Codex round-2 MAJOR
 *                            finding C-M1, S56)
 *
 * Route handlers map these to 401 / 403 / 500. Pages map to redirect
 * (see /auth/callback/route.ts).
 *
 * Helper return shapes match design §2.4 (Codex round-2 NIT): requireUser
 * returns the full Supabase User; requireOrgContext returns { user, orgId }.
 */

import type { User } from "@supabase/supabase-js";
import { createServerSupabase } from "./supabase-server";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface OrgContext {
  user: User;
  orgId: string;
}

export async function requireUser(): Promise<User> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError("No session");
  return user;
}

export async function requireOrgContext(): Promise<OrgContext> {
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    // DB query failure (network, RLS denial, postgrest fetch failure with
    // status: 0, etc.) is NOT a "no membership" state. Throw a generic
    // Error so getOrgContextDualPath does NOT catch + fall back to env
    // (it only catches UnauthorizedError | ForbiddenError; everything
    // else propagates as 500). Codex round-2 MAJOR finding C-M1, S56:
    // prior version conflated query failure with !data into
    // ForbiddenError, allowing dual-path fallback to mask DB outages as
    // successful env-fallback responses (with the wrong org).
    throw new Error(
      `requireOrgContext: organization_members query failed: ${error.message}`,
    );
  }
  if (!data) {
    throw new ForbiddenError("User has no organization membership");
  }
  return { user, orgId: data.organization_id as string };
}

// Phase 2 dual-path bridge (design §4.1). Deleted in Phase 4 once env
// fallback is retired and routes use requireOrgContext() directly.
//
// Returns the session-derived orgId when an authenticated request carries
// a valid Supabase cookie session + a membership row; falls back to
// process.env.SYSTEM_DEFAULT_ORG_ID otherwise. The `source` field is the
// diagnostic signal for X-Org-Source headers during the Phase 3 soak.
//
// Only Unauthorized/Forbidden errors trigger fallback. Any other error
// (DB query failure, env crash, etc.) propagates as 500 — those represent
// real failures, not "no session yet". This contract is enforced by
// requireOrgContext()'s error discipline: query failures throw generic
// Error, only no-membership throws ForbiddenError.
//
// .trim() defends against vercel env add stdin trailing newline
// (feedback_vercel_env_add_stdin_trailing_newline.md, S50).
export async function getOrgContextDualPath(): Promise<{
  orgId: string;
  source: "session" | "env";
}> {
  try {
    const { orgId } = await requireOrgContext();
    return { orgId, source: "session" };
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      const envOrgId = process.env.SYSTEM_DEFAULT_ORG_ID?.trim();
      if (!envOrgId) {
        throw new Error(
          "getOrgContextDualPath: no session AND no SYSTEM_DEFAULT_ORG_ID env var. " +
            "Phase 2 dual-path requires at least one path to resolve.",
        );
      }
      return { orgId: envOrgId, source: "env" };
    }
    throw err;
  }
}

// Reject open-redirect vectors: only same-origin relative paths pass.
// Must start with "/" and not "//" (protocol-relative) and contain no
// backslash anywhere (browsers may normalize "/\" → "//" — Gemini round-1
// MINOR finding). Rejects schemes, whitespace, and control chars.
export function isSafeRedirect(path: string | undefined | null): path is string {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (/[\s\x00-\x1f]/.test(path)) return false;
  return true;
}
