/**
 * Shared post-authentication routing (server-side only).
 *
 * S181 — OTP-code login fix. Two entry paths now establish a Supabase session:
 *   1. the magic-link callback (/auth/callback/route.ts) — exchangeCodeForSession
 *   2. the 6-digit OTP verify Server Action (login/actions.ts:verifyEmailOtp)
 * BOTH must then route the user IDENTICALLY: no membership → /no-org,
 * membership-query failure → /login?error=..., member → the safe redirect.
 * Factoring that routing here is the load-bearing reason this file exists: the
 * two paths CANNOT DRIFT. (A drift where one path skipped the membership check
 * would let a user with no organization reach tenant-scoped pages — a security
 * regression, not a cosmetic one.)
 *
 * resolvePostAuthDestination takes the request-scoped Supabase client as a
 * PARAMETER (not constructed internally) so it (a) inherits the caller's
 * cookie-bound session and (b) is unit-testable with a stub. It returns a
 * SAME-ORIGIN RELATIVE path so each consumer applies it with its own redirect
 * mechanism:
 *   - route handler:  NextResponse.redirect(new URL(dest, requestUrl))
 *   - server action:  redirect(dest)               // next/navigation
 *
 * The caller MUST pass an already-isSafeRedirect-validated `safeRedirect` (both
 * call sites compute it via isSafeRedirect first); this function echoes it
 * verbatim on the success path and never widens it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * After a session is established, decide where to send the user. This mirrors
 * the EXACT taxonomy /auth/callback used before the logic was extracted here:
 *   no user after auth        → /login?error=no_user_after_exchange
 *   membership query failed   → /login?error=Membership lookup failed: <msg>
 *   no membership row         → /no-org
 *   member                    → safeRedirect (caller-validated)
 */
export async function resolvePostAuthDestination(
  supabase: SupabaseClient,
  safeRedirect: string,
): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return "/login?error=no_user_after_exchange";
  }

  const { data: member, error: memberError } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (memberError) {
    // Transport/RLS failure is NOT "no membership" — surface it distinctly so a
    // DB outage is never silently collapsed into /no-org (Codex C-m1, preserved
    // verbatim from the original callback semantics).
    return `/login?error=${encodeURIComponent(
      "Membership lookup failed: " + memberError.message,
    )}`;
  }
  if (!member) {
    return "/no-org";
  }
  return safeRedirect;
}

export type OtpVerifyOutcome =
  | { ok: false; message: string; detail?: { status?: number; message: string } }
  | { ok: true; destination: string };

/**
 * Verify a 6-digit email OTP and, on success, resolve the post-auth destination.
 * Injectable (supabase passed in) for unit testing. The caller (the Server
 * Action) owns: input validation, rate limiting, session/cookie construction
 * (createServerSupabase), server-side logging of `detail`, and turning the
 * outcome into a redirect (success) or an inline error (failure → retry).
 *
 * On failure this returns a GENERIC message — never "wrong code" vs "expired"
 * vs "unknown email" — so the verify step leaks no account-enrollment signal
 * (it matches the send step's enumeration-safe posture). The raw provider error
 * is returned only in `detail` for server-side logging, never for display.
 */
export async function verifyEmailOtpAndResolve(
  supabase: SupabaseClient,
  args: { email: string; token: string; safeRedirect: string },
): Promise<OtpVerifyOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    email: args.email,
    token: args.token,
    type: "email",
  });
  if (error) {
    return {
      ok: false,
      message: "Invalid or expired code. Request a new code and try again.",
      detail: { status: (error as { status?: number }).status, message: error.message },
    };
  }
  const destination = await resolvePostAuthDestination(supabase, args.safeRedirect);
  return { ok: true, destination };
}
