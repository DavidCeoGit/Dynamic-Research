/**
 * Next.js 16 proxy — Supabase SSR cookie refresh.
 *
 * Phase 1 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * File is named proxy.ts (not middleware.ts) per the Next 16 convention and the
 * @supabase/ssr Next-16 migration guide. Next.js 16's runtime picks up proxy.ts
 * as the request interceptor.
 *
 * Phase 1 behavior: ALWAYS call supabase.auth.getUser() to trigger cookie
 * rotation on token refresh. NEVER redirects. Existing STOPGAP routes continue
 * to serve via env fallback — Phase 2 wires them to dual-path, Phase 4
 * removes the env fallback AND populates the Phase-4 protection block.
 *
 * /api/queue/[id] PATCH is the worker-auth path (X-Agent-Key, not session) —
 * short-circuit BEFORE creating the supabase client so worker requests don't
 * fire a Supabase Auth round-trip on every claim/PATCH.
 *
 * EDGE-RUNTIME CRITICAL CONSTRAINTS (S55 MERGE-gate findings):
 *   - process.env access MUST be static (Gemini G-M1). Bundler substitutes
 *     NEXT_PUBLIC_* literals; dynamic `process.env[name]` evaluates undefined
 *     at Edge runtime.
 *   - The setAll cookie adapter MUST mutate BOTH req.cookies AND res.cookies
 *     and reconstruct the response from the updated request — downstream
 *     Server Components otherwise see the stale JWT and 401 on refresh
 *     (Gemini G-C1).
 *   - setAll's second argument is the `headers` map (@supabase/ssr type
 *     contract): Cache-Control: no-store + Expires: 0 + Pragma: no-cache.
 *     MUST be copied onto the response so CDNs / reverse proxies cannot
 *     cache a Set-Cookie response and serve it to a different user
 *     (Codex C-M1).
 *   - Secure cookie attribute is gated on NODE_ENV=production — @supabase/ssr
 *     does NOT auto-disable Secure on localhost (Codex C-m2).
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

// Phase 4 will populate these and enable the redirect block. Commented out
// in Phase 1 to keep the live file diff-minimal and avoid dead branches.
//
// const PROTECTED_PHASE_4: string[] = [];
// const PUBLIC_ROUTES = [
//   "/login",
//   "/auth/callback",
//   "/no-org",
//   "/api/queue/extract-context",
//   "/api/queue/generate-questions",
//   "/api/queue/claim",
//   "/api/healthz",
// ];

export async function proxy(req: NextRequest) {
  let res = NextResponse.next();

  // /api/queue/[id] PATCH = worker-only (X-Agent-Key). Skip session refresh.
  if (
    req.method === "PATCH" &&
    /^\/api\/queue\/[^/]+$/.test(req.nextUrl.pathname)
  ) {
    return res;
  }

  // Static env access for Edge-runtime bundler substitution; .trim() defends
  // against `vercel env add` stdin trailing-newline.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required for SSR auth",
    );
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (xs, headers) => {
        // Canonical @supabase/ssr Next-16 middleware cookie-sync pattern:
        //   1. Update req.cookies so downstream Server Components on this
        //      same request see the refreshed JWT (no spurious 401 on token
        //      rotation).
        //   2. Reconstruct the response so it carries the updated request
        //      headers.
        //   3. Write to res.cookies for the browser, enforcing
        //      AUTH_COOKIE_OPTIONS as the security-critical overrides.
        //   4. Copy library-supplied headers (Cache-Control no-store, etc.)
        //      onto the response so CDNs/proxies cannot cache the
        //      Set-Cookie response cross-user.
        xs.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        xs.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS }),
        );
        Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
      },
    },
  });

  // CRITICAL: getUser() triggers token-refresh cookie rotation when needed.
  // getUser() (not getSession()) — the former revalidates against Supabase
  // Auth; the latter reads cookies without server contact and can return an
  // expired JWT that hasn't been detected yet.
  await supabase.auth.getUser();

  // PHASE 4 promotes proxy.ts to full route protection — block re-added then.
  // Phase 1-3: existing routes continue handling auth themselves (env fallback
  // until Phase 4); proxy is cookie-refresh only.

  return res;
}

export const config = {
  matcher: [
    // Matcher 0: /api/* ALWAYS through proxy — dynamic API file routes like
    // /api/runs/<slug>/file/chart.png are tenant data, not static assets.
    // Skipping them by extension would create a cross-tenant access bypass.
    "/api/:path*",
    // Matcher 1: page routes + non-/api requests, excluding Next internals
    // and frontend/public/ static assets (svg/png/...).
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$).*)",
  ],
};
