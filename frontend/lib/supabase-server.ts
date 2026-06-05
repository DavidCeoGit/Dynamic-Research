/**
 * Request-scoped Supabase server client (anon-key + JWT cookies).
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * Constructs a NEW client per request — cookies are per-request via next/headers,
 * and sharing the client across requests would leak sessions across users.
 * Service-role singleton in ./supabase.ts is unchanged and continues to serve
 * storage + admin paths; this anon-key client owns auth + RLS-enforced reads.
 *
 * Cookie options enforced per design §2.2: HttpOnly + Secure + SameSite=Lax +
 * Path=/. Secure is gated on NODE_ENV=production (Codex round-2 MINOR finding —
 * @supabase/ssr does NOT auto-disable Secure on localhost, contrary to the
 * design's §2.2 assumption; local dev over HTTP would otherwise drop cookies).
 *
 * setAll(xs, headers) — the headers arg is the second positional parameter of
 * @supabase/ssr.SetAllCookies. The library passes Cache-Control: no-store +
 * Expires: 0 + Pragma: no-cache to prevent CDN/proxy caching of Set-Cookie
 * responses cross-user. In Server Component / Server Action contexts the
 * cookie store has no response-headers sink; cache headers are moot when the
 * response is a redirect (login/actions, auth/callback). The proxy.ts
 * setAll DOES apply headers to res.headers — that is the load-bearing site.
 * (Codex round-2 MAJOR/SECURITY/DEPENDENCY finding C-M1.)
 *
 * Static process.env access (NOT dynamic process.env[name]) — Gemini round-1
 * MAJOR finding: Next.js bundler performs static AST substitution for
 * NEXT_PUBLIC_* vars only on STATIC property access. .trim() defends against
 * `vercel env add` stdin trailing-newline.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for SSR auth",
    );
  }
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (xs, _headers) => {
        try {
          xs.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS }),
          );
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes on the
          // next request. Read-only from a Server Component is the expected
          // pattern; the throw here is the framework signal, not an error.
          // _headers is intentionally unused here — see file header.
        }
      },
    },
  });
}
