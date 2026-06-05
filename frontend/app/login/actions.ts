"use server";

/**
 * Server Action: send magic-link email.
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * Account-enumeration close-out (Codex round-2 MAJOR/SECURITY): For all
 * syntactically valid email submissions, return the SAME `/login?sent=1`
 * confirmation regardless of whether the email is known to Supabase. Provider
 * errors (including `shouldCreateUser: false` rejections, rate limits, and
 * transport failures) are logged server-side ONLY — never surfaced to the UI
 * because doing so leaks the "this email is enrolled" signal to attackers.
 *
 * shouldCreateUser=false remains the safety gate that prevents unknown emails
 * from creating accounts; combined with the unconditional ?sent=1 redirect,
 * the front door does not disclose membership.
 *
 * NEXT_PUBLIC_SITE_URL is hardcoded production URL (Q8 resolution); deriving
 * from VERCEL_URL would require a wildcard *.vercel.app allowlist in the
 * Supabase Auth Redirect URLs setting (would accept any preview deployment
 * as a valid callback origin).
 *
 * Static process.env access (Gemini round-1 MAJOR): NEXT_PUBLIC_* bundler
 * substitution is static-AST only. .trim() defends against `vercel env add`
 * stdin trailing-newline.
 */

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";
import { isSafeRedirect } from "@/lib/auth";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function signInWithMagicLink(formData: FormData): Promise<never> {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!siteUrl) {
    throw new Error("NEXT_PUBLIC_SITE_URL is required for SSR auth");
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  // Format errors are pre-Supabase and safe to surface (no enumeration risk).
  if (!EMAIL_RE.test(email)) {
    redirect(`/login?error=${encodeURIComponent("Invalid email format")}`);
  }

  const redirectRaw = String(formData.get("redirect") ?? "/");
  const safeRedirect = isSafeRedirect(redirectRaw) ? redirectRaw : "/";

  const callbackUrl = new URL("/auth/callback", siteUrl);
  callbackUrl.searchParams.set("redirect", safeRedirect);

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callbackUrl.toString(),
      shouldCreateUser: false,
    },
  });

  if (error) {
    // Server-side log only — surfacing this would leak whether the email is
    // enrolled (Codex round-2 C-M2 account-enumeration close-out).
    console.error("[signInWithMagicLink] Supabase OTP error:", {
      email,
      status: (error as { status?: number }).status,
      message: error.message,
    });
  }

  // Unconditional success-shaped response prevents account enumeration.
  redirect("/login?sent=1");
}
