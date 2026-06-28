/**
 * S181 post-auth routing + OTP-verify resolver tests (SECURITY-labeled).
 *
 * resolvePostAuthDestination + verifyEmailOtpAndResolve are the shared,
 * injectable core that BOTH the magic-link callback and the new OTP verify
 * Server Action route through — a regression here is a tenant-isolation /
 * routing bug on the login critical path. The action wrappers
 * (createServerSupabase + redirect + rate-limit) are thin and framework-bound;
 * the security-relevant decisions live here and are pinned directly with a
 * Supabase stub (cast through unknown — deliberate partial fake, test-only).
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/post-auth.test.ts"
 * (wired into the root `pnpm test` script alongside the other frontend suites)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolvePostAuthDestination,
  verifyEmailOtpAndResolve,
} from "../post-auth";

function stubSupabase(opts: {
  user?: { id: string } | null;
  member?: { organization_id: string } | null;
  memberError?: { message: string } | null;
  verifyError?: { status?: number; message: string } | null;
}): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({ data: { user: opts.user ?? null } }),
      verifyOtp: async () => ({ error: opts.verifyError ?? null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.member ?? null,
            error: opts.memberError ?? null,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

// ── resolvePostAuthDestination ──────────────────────────────────────

test("resolvePostAuthDestination: member present → the safe redirect", async () => {
  const supabase = stubSupabase({ user: { id: "u1" }, member: { organization_id: "org1" } });
  assert.equal(await resolvePostAuthDestination(supabase, "/runs"), "/runs");
});

test("resolvePostAuthDestination: no membership row → /no-org", async () => {
  const supabase = stubSupabase({ user: { id: "u1" }, member: null });
  assert.equal(await resolvePostAuthDestination(supabase, "/runs"), "/no-org");
});

test("resolvePostAuthDestination: membership query error → /login?error=... (NOT /no-org)", async () => {
  const supabase = stubSupabase({ user: { id: "u1" }, memberError: { message: "boom" } });
  const dest = await resolvePostAuthDestination(supabase, "/runs");
  assert.match(dest, /^\/login\?error=/);
  assert.match(decodeURIComponent(dest), /Membership lookup failed: boom/);
  assert.notEqual(dest, "/no-org");
});

test("resolvePostAuthDestination: no user after auth → /login?error=no_user_after_exchange", async () => {
  const supabase = stubSupabase({ user: null });
  assert.equal(
    await resolvePostAuthDestination(supabase, "/runs"),
    "/login?error=no_user_after_exchange",
  );
});

// ── verifyEmailOtpAndResolve ────────────────────────────────────────

test("verifyEmailOtpAndResolve: valid code + member → ok, destination = safe redirect", async () => {
  const supabase = stubSupabase({ user: { id: "u1" }, member: { organization_id: "org1" } });
  const out = await verifyEmailOtpAndResolve(supabase, {
    email: "a@b.com",
    token: "123456",
    safeRedirect: "/runs",
  });
  assert.deepEqual(out, { ok: true, destination: "/runs" });
});

test("verifyEmailOtpAndResolve: valid code + no org → ok, destination = /no-org", async () => {
  const supabase = stubSupabase({ user: { id: "u1" }, member: null });
  const out = await verifyEmailOtpAndResolve(supabase, {
    email: "a@b.com",
    token: "123456",
    safeRedirect: "/runs",
  });
  assert.deepEqual(out, { ok: true, destination: "/no-org" });
});

test("verifyEmailOtpAndResolve: bad/expired code → ok:false, GENERIC message (no enumeration)", async () => {
  const supabase = stubSupabase({
    verifyError: { status: 403, message: "Token has expired or is invalid" },
  });
  const out = await verifyEmailOtpAndResolve(supabase, {
    email: "a@b.com",
    token: "000000",
    safeRedirect: "/runs",
  });
  assert.equal(out.ok, false);
  if (out.ok === false) {
    // The user-facing message must NOT echo the raw provider reason.
    assert.doesNotMatch(out.message, /expired or is invalid/i);
    assert.match(out.message, /invalid or expired code/i);
    // The raw reason is preserved only in detail (server-side logging).
    assert.equal(out.detail?.message, "Token has expired or is invalid");
  }
});

test("verifyEmailOtpAndResolve: a bad code does NOT run the membership lookup (verify gates routing)", async () => {
  let lookupCalled = false;
  const supabase = {
    auth: {
      verifyOtp: async () => ({ error: { message: "bad" } }),
      getUser: async () => {
        lookupCalled = true;
        return { data: { user: null } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            lookupCalled = true;
            return { data: null, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const out = await verifyEmailOtpAndResolve(supabase, {
    email: "a@b.com",
    token: "000000",
    safeRedirect: "/runs",
  });
  assert.equal(out.ok, false);
  assert.equal(lookupCalled, false);
});
