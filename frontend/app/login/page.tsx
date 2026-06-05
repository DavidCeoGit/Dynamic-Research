/**
 * Magic-link login page (Server Component).
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * Hidden `redirect` field round-trips the originating path through the magic-
 * link click so /auth/callback can land the user where they started.
 * isSafeRedirect() narrows the input to same-origin relative paths
 * (C-M3 open-redirect close-out).
 *
 * Phase 1 UX: two-state page. Form view (default) + sent-confirmation view
 * after the Server Action redirects with ?sent=1. Errors surface via ?error=.
 */

import { isSafeRedirect } from "@/lib/auth";
import { signInWithMagicLink } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string; sent?: string }>;
}) {
  const params = await searchParams;
  const safeRedirect = isSafeRedirect(params.redirect) ? params.redirect : "/";

  if (params.sent === "1") {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-2xl font-semibold mb-4">Check your email</h1>
        <p className="text-gray-700">
          We sent a magic link to your inbox — valid for 1 hour.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <form action={signInWithMagicLink} className="space-y-4">
        <label className="block">
          <span className="block text-sm font-medium mb-1">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="w-full rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <input type="hidden" name="redirect" value={safeRedirect} />
        <button
          type="submit"
          className="w-full rounded bg-black px-4 py-2 text-white"
        >
          Send magic link
        </button>
      </form>
      {params.error ? (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {params.error}
        </p>
      ) : null}
    </main>
  );
}
