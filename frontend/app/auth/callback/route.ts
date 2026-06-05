/**
 * OAuth callback — exchange magic-link code for a session.
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * Flow: user clicks magic-link email → /auth/callback?code=...&redirect=...
 *   1. Re-validate the redirect param server-side (defense-in-depth on top of
 *      the Server Action's pre-validation) — C-M3 open-redirect close-out.
 *   2. Exchange the code for a Supabase session (writes auth cookies).
 *   3. Look up the user's organization_members row.
 *      - DB/RLS error (memberError) → /login?error=<msg> (NOT /no-org —
 *        Codex round-2 MINOR finding C-m1: a transport-layer error must not
 *        be collapsed with a legitimate-zero-row response).
 *      - missing (data=null, no error) → /no-org
 *      - present → safeRedirect (defaults to /)
 *   4. Code-exchange failures redirect to /login?error=<reason>.
 */

import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const redirectParam = url.searchParams.get("redirect");

  const safeRedirect = isSafeRedirect(redirectParam) ? redirectParam : "/";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url));
  }

  const supabase = await createServerSupabase();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(exchangeError.message)}`, url),
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL("/login?error=no_user_after_exchange", url),
    );
  }

  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (memberError) {
    // Distinguish transport/RLS errors from legitimate zero-membership users.
    // Collapsing both into /no-org would mask DB/policy failures (Codex C-m1).
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent("Membership lookup failed: " + memberError.message)}`,
        url,
      ),
    );
  }
  if (!member) {
    return NextResponse.redirect(new URL("/no-org", url));
  }

  // isSafeRedirect already enforced same-origin relative; new URL(safe, url)
  // with a path starting with "/" resolves to the request's origin and cannot
  // escape.
  return NextResponse.redirect(new URL(safeRedirect, url));
}
