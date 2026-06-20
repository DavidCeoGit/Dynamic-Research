/**
 * Authentication + organization-context helpers (server-side only).
 *
 * Phase 4 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 * The Phase-2 dual-path bridge (getOrgContextDualPath) has been RETIRED: there is
 * no env fallback anymore. Every org-gated route resolves the caller's org from
 * the session via requireOrgContext() (mapped to 401 by requireOrgOr401), and
 * proxy.ts redirects unauthenticated page requests to /login before they render.
 *
 * Throw semantics:
 *   requireUser           → UnauthorizedError (no session)
 *   requireOrgContext     → UnauthorizedError | ForbiddenError | Error
 *                            (query failure surfaces as generic Error so
 *                            requireOrgOr401 does NOT misclassify it as
 *                            "no session yet" — Codex finding C-M1, S56)
 *
 * Route handlers map these to 401 / 403 / 500. Pages map to redirect
 * (proxy.ts + /auth/callback/route.ts).
 *
 * isSafeRedirect now lives in lib/route-protection.ts (pure, Edge-importable) so
 * the proxy + login page + callback share one open-redirect predicate; it is
 * re-exported here for backward compatibility with existing @/lib/auth importers.
 */

import type { User } from "@supabase/supabase-js";
import { createServerSupabase } from "./supabase-server";

export { isSafeRedirect } from "./route-protection";

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
    // Error so requireOrgOr401 does NOT catch + return 401 (it only catches
    // UnauthorizedError | ForbiddenError; everything else propagates as 500).
    // Codex round-2 MAJOR finding C-M1, S56: prior version conflated query
    // failure with !data into ForbiddenError, which (under the old dual-path)
    // allowed env fallback to mask DB outages as successful responses with the
    // wrong org. Phase 4 removed the fallback, but the taxonomy still matters:
    // a transient DB failure must surface as 500, never a silent 401.
    throw new Error(
      `requireOrgContext: organization_members query failed: ${error.message}`,
    );
  }
  if (!data) {
    throw new ForbiddenError("User has no organization membership");
  }
  return { user, orgId: data.organization_id as string };
}

// Phase 4 org-context choke point for API route handlers. Resolves the caller's
// org from their session and, on a missing session OR missing membership,
// returns a ready-to-send 401 JSON Response instead of throwing — so callers
// stay a flat `if (!auth.ok) return auth.res`. Any OTHER error (DB query
// failure, etc.) propagates so Next returns a 500; those are real failures, not
// "no session yet" (enforced by requireOrgContext's error discipline: query
// failures throw generic Error, only no-membership throws ForbiddenError).
//
// 401 for BOTH Unauthorized (no session) and Forbidden (session, no membership)
// matches the established attachments/route.ts precedent and keeps the API a
// uniform "you cannot access this" denial; the no-membership UX redirect to
// /no-org is handled at the page layer by proxy.ts, not here.
export async function requireOrgOr401(
  message = "Authentication required",
): Promise<{ ok: true; orgId: string } | { ok: false; res: Response }> {
  try {
    const { orgId } = await requireOrgContext();
    return { ok: true, orgId };
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return {
        ok: false,
        res: Response.json({ error: message }, { status: 401 }),
      };
    }
    throw err;
  }
}
