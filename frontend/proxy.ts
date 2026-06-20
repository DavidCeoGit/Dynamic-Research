/**
 * Next.js 16 proxy — Supabase SSR cookie refresh + Phase 4 page-route protection.
 *
 * Phase 4 of the SSR auth refactor — see Documentation/ssr-auth-refactor-design.md.
 *
 * File is named proxy.ts (not middleware.ts) per the Next 16 convention and the
 * @supabase/ssr Next-16 migration guide. Next.js 16's runtime picks up proxy.ts
 * as the request interceptor.
 *
 * Behavior:
 *   1. ALWAYS call supabase.auth.getUser() to trigger cookie rotation on token
 *      refresh (the canonical @supabase/ssr proxy side effect).
 *   2. PAGE-route protection (Phase 4): unauthenticated requests to any
 *      non-public, non-/api path redirect to /login?redirect=<path+query>;
 *      authenticated-but-no-org-membership requests redirect to /no-org.
 *
 * /api/* routes are deliberately NOT redirected here — each handler resolves the
 * caller's org via requireOrgOr401() and returns a 401 JSON itself (a 302 to an
 * HTML login page would be wrong for a fetch/SWR client). The proxy still RUNS
 * on /api/* (matcher 0) for cookie refresh, but the protection block below skips
 * them. Closing the env-fallback at lib/auth.ts is what actually denies anon
 * API access; this block is the page-layer UX/defense companion.
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
 *   - isProtectedPage / isSafeRedirect are imported from lib/route-protection
 *     (PURE — no next/headers) so the Edge bundle stays clean.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isProtectedPage, isSafeRedirect } from "@/lib/route-protection";

const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Phase 4 PAGE-route protection ──────────────────────────────────
  // /api/* self-protects (requireOrgOr401 → 401 JSON); only navigable page
  // routes are redirected here. _next internals + static assets are excluded
  // by the matcher, so this only fires on real page navigations.
  const { pathname } = req.nextUrl;

  if (isProtectedPage(pathname)) {
    // No session → bounce to /login, round-tripping the originating
    // path + query so /auth/callback can land the user back EXACTLY where they
    // started — including deep links like /new?clone=<slug> whose query drives
    // the clone prefill (S146 Codex MAJOR: dropping the query broke Clone&Edit
    // through the login bounce).
    if (!user) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      // Defense-in-depth (S146 Gemini CRITICAL): only round-trip a SAFE
      // same-origin target. The login page + /auth/callback already re-validate
      // via isSafeRedirect (and the whole chain encodes via searchParams), but
      // the proxy must not emit an unsafe value in the first place; an unsafe
      // target falls back to "/".
      const target = `${pathname}${req.nextUrl.search}`;
      loginUrl.searchParams.set(
        "redirect",
        isSafeRedirect(target) ? target : "/",
      );
      return NextResponse.redirect(loginUrl);
    }

    // Authenticated but no org membership → /no-org. Fail OPEN on a query
    // error so a transient DB blip can never lock the owner out of the app;
    // the per-route requireOrgOr401 remains the hard tenant boundary regardless
    // of what this best-effort page-layer check decides. maybeSingle() returns
    // error:null + data:null for a legitimate zero-membership user (the only
    // case that should redirect), and a populated error for transport/RLS
    // failures (fail open).
    const { data: member, error: memberErr } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!memberErr && !member) {
      const noOrgUrl = req.nextUrl.clone();
      noOrgUrl.pathname = "/no-org";
      noOrgUrl.search = "";
      return NextResponse.redirect(noOrgUrl);
    }
  }

  return res;
}

export const config = {
  matcher: [
    // Matcher 0: /api/* ALWAYS through proxy — dynamic API file routes like
    // /api/runs/<slug>/file/chart.png are tenant data, not static assets.
    // Skipping them by extension would create a cross-tenant access bypass.
    // (Protection block above skips /api; this matcher is for cookie refresh.)
    "/api/:path*",
    // Matcher 1: page routes + non-/api requests, excluding Next internals
    // and frontend/public/ static assets (svg/png/...). The api exclusion is
    // `api(?:/|$)` — EXACTLY /api or /api/* (already covered by matcher 0), NOT
    // a look-alike page like /apiary, which must still be protected (S146 Codex
    // MAJOR: a bare `api` lookahead skipped the proxy for any /api*-prefixed
    // page, a latent protection-boundary gap).
    "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$).*)",
  ],
};
