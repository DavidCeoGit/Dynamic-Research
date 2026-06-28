/**
 * OAuth callback — exchange magic-link code for a session.
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 * S181: the post-exchange routing (getUser → organization_members lookup →
 * redirect taxonomy) was extracted to lib/post-auth.ts:resolvePostAuthDestination
 * so this magic-link path and the new 6-digit OTP verify Server Action route
 * IDENTICALLY and cannot drift. The link path is KEPT as an additive fallback to
 * the OTP code (the email carries both; Gmail-prefetch can consume the link but
 * not the typed code).
 *
 * Flow: user clicks magic-link email → /auth/callback?code=...&redirect=...
 *   1. Re-validate the redirect param server-side (defense-in-depth on top of
 *      the Server Action's pre-validation) — C-M3 open-redirect close-out.
 *   2. Exchange the code for a Supabase session (writes auth cookies).
 *   3. resolvePostAuthDestination() decides the landing path (see that file for
 *      the full no-user / membership-error / no-org / member taxonomy).
 *   4. Code-exchange failures (incl. a missing code) redirect to /login?error=.
 */

import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";
import { resolvePostAuthDestination } from "@/lib/post-auth";

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

  // Shared with the OTP verify path so the two cannot drift (lib/post-auth.ts).
  const destination = await resolvePostAuthDestination(supabase, safeRedirect);
  return NextResponse.redirect(new URL(destination, url));
}
