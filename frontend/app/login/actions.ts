"use server";

/**
 * Login Server Actions — passwordless email auth.
 *
 * S181 — OTP-code login fix (replaces the single magic-link send action). Root
 * cause this addresses: Gmail's link-scanner prefetches the one-time PKCE
 * magic-link, consuming the token before the human click → /auth/callback sees
 * no `code` → "missing_code". A typed 6-digit OTP has no link to prefetch and no
 * same-browser code_verifier-cookie dependency, so it is immune to both failure
 * modes. The magic LINK is KEPT (the email carries both link + {{ .Token }} code)
 * as an additive fallback — /auth/callback semantics are unchanged.
 *
 * The OTP code carried by the magic-link-flow email verifies with
 * verifyOtp({type:'email'}) — confirmed by a live test against the production
 * GoTrue instance under BOTH implicit and PKCE flows (S181 MERGE gate; this
 * refuted a reviewer claim that 'magiclink' was required).
 *
 * Two actions, both driven by useActionState (login/login-form.tsx):
 *   sendEmailOtp   — signInWithOtp (emailRedirectTo set → the link still works;
 *                    shouldCreateUser:false → no self-signup). ALWAYS returns a
 *                    success-shaped result for any syntactically valid email,
 *                    regardless of provider outcome, so the front door never
 *                    discloses whether an email is enrolled (account-enumeration
 *                    close-out, preserved from the prior signInWithMagicLink).
 *   verifyEmailOtp — verifyOtp({type:'email'}) → on success routes via the shared
 *                    resolvePostAuthDestination (same as /auth/callback); on
 *                    failure a GENERIC error (no enumeration) for retry.
 *                    BRUTE-FORCE: the PRIMARY control is Supabase-side and
 *                    per-TOKEN (codes are single-use + expire — verified S181),
 *                    NOT per-IP (server-side verify calls egress from Vercel's
 *                    own IPs, so Supabase's per-IP limit would throttle Vercel,
 *                    not an end user). The per-IP token bucket below is a
 *                    SECONDARY speed-bump only. Recommend lowering the dashboard
 *                    OTP expiry to <=10 min to shrink the brute-force window.
 *
 * NEXT_PUBLIC_SITE_URL is the hardcoded production URL (Q8); deriving from
 * VERCEL_URL would require a wildcard *.vercel.app Supabase Redirect allowlist.
 * Static process.env access only (NEXT_PUBLIC_* bundler substitution is static-
 * AST); .trim() defends against `vercel env add` stdin trailing-newline.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";
import { verifyEmailOtpAndResolve, type OtpVerifyOutcome } from "@/lib/post-auth";
import { checkRateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import type { SendState, VerifyState } from "./types";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE_RE = /^\d{6}$/;

/**
 * Step 1 — email the user a 6-digit code (plus a magic-link backup). Advances to
 * the code step for any syntactically valid email regardless of enrollment
 * (enumeration-safe). Format/config errors are pre-Supabase and safe to surface.
 */
export async function sendEmailOtp(
  _prev: SendState,
  formData: FormData,
): Promise<SendState> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!siteUrl) {
    console.error("[sendEmailOtp] NEXT_PUBLIC_SITE_URL is not set");
    return { ok: false, error: "Login is temporarily unavailable. Try again later." };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const redirectRaw = String(formData.get("redirect") ?? "/");
  const safeRedirect = isSafeRedirect(redirectRaw) ? redirectRaw : "/";

  const callbackUrl = new URL("/auth/callback", siteUrl);
  callbackUrl.searchParams.set("redirect", safeRedirect);

  try {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: callbackUrl.toString(),
        shouldCreateUser: false,
      },
    });
    if (error) {
      // Server-side log only — surfacing it would leak whether the email is
      // enrolled (account-enumeration close-out).
      console.error("[sendEmailOtp] Supabase OTP send error:", {
        email,
        status: (error as { status?: number }).status,
        message: error.message,
      });
    }
  } catch (err) {
    // An infra blip must not reveal enrollment either — still success-shaped.
    console.error("[sendEmailOtp] unexpected error:", { email, err: String(err) });
  }

  // Unconditional success-shaped result prevents account enumeration.
  return { ok: true, error: null };
}

/**
 * Step 2 — verify the typed 6-digit code. On success, route EXACTLY as the
 * magic-link callback does (shared resolver, cannot drift). On failure, a
 * generic retryable error (no enumeration).
 */
export async function verifyEmailOtp(
  _prev: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  // Secondary brute-force speed-bump (per-IP). On Vercel the client IP comes
  // from the platform-overwritten x-forwarded-for (not client-spoofable). The
  // PRIMARY control is Supabase per-token (single-use + expiry). Counts ALL
  // attempts incl. malformed.
  const ip = clientIpFromHeaders(await headers());
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    return { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const token = String(formData.get("token") ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!CODE_RE.test(token)) {
    return { error: "Enter the 6-digit code from your email." };
  }

  const redirectRaw = String(formData.get("redirect") ?? "/");
  const safeRedirect = isSafeRedirect(redirectRaw) ? redirectRaw : "/";

  let outcome: OtpVerifyOutcome;
  try {
    const supabase = await createServerSupabase();
    outcome = await verifyEmailOtpAndResolve(supabase, { email, token, safeRedirect });
  } catch (err) {
    console.error("[verifyEmailOtp] unexpected error:", { email, err: String(err) });
    return { error: "Something went wrong. Please try again." };
  }

  if (!outcome.ok) {
    // `detail` is for server-side debugging only; the user sees outcome.message.
    console.error("[verifyEmailOtp] OTP verification failed:", {
      email,
      detail: outcome.detail,
    });
    return { error: outcome.message };
  }

  // Success — redirect() throws NEXT_REDIRECT; it MUST stay outside the
  // try/catch above so the control-flow signal is never swallowed.
  redirect(outcome.destination);
}
