/**
 * Phase 4 SSR-auth route classification + redirect-safety (pure — no next/server
 * imports, so it is unit-testable AND safe to import into the Edge proxy).
 * proxy.ts uses it to decide which PAGE routes receive the unauthenticated→/login
 * and authenticated-no-membership→/no-org redirects, and to sanitize the
 * ?redirect= value it emits.
 *
 * Kept dependency-free on purpose: the public-vs-protected boundary and the
 * open-redirect predicate are security-critical (a route wrongly marked public
 * would leak; an unsafe redirect would enable phishing), so they are asserted
 * directly in route-protection.test.ts rather than only through the Edge proxy.
 *
 * See Documentation/ssr-auth-refactor-design.md §2.5 (Phase 4 protection) + §3.1
 * (open-redirect close-out).
 */

// Public PAGE routes — never redirected by the Phase 4 protection block. EXACT
// match only (S146 Gemini MAJOR): /login + /no-org are the redirect destinations
// themselves (loop guard); /auth/callback exchanges the magic-link code with no
// session yet. None of the three has a legitimate child route, so prefix
// matching is dropped to avoid a latent over-match (e.g. a future public
// "/foo" must NOT silently expose "/foo/secret"). The public /api routes
// (extract-context, generate-questions, claim) are covered by the isApiPath()
// skip, not this list — /api self-protects in each handler.
export const PUBLIC_PAGE_ROUTES = ["/login", "/no-org", "/auth/callback"] as const;

/** True for any /api route (matched by proxy for cookie refresh, but never
 *  page-redirected — each /api handler returns its own 401 JSON). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** True for the EXACT public PAGE routes exempt from redirects. */
export function isPublicPage(pathname: string): boolean {
  return (PUBLIC_PAGE_ROUTES as readonly string[]).includes(pathname);
}

/** True when the Phase 4 page-protection block must evaluate auth for this
 *  path: a navigable page that is neither an /api route nor a public page. */
export function isProtectedPage(pathname: string): boolean {
  return !isApiPath(pathname) && !isPublicPage(pathname);
}

// Reject open-redirect vectors: only same-origin relative paths pass. Must start
// with "/" and not "//" (protocol-relative) and contain no backslash anywhere
// (browsers may normalize "/\" → "//"). Rejects schemes, whitespace, and control
// chars. Used by proxy.ts (to sanitize the ?redirect= it emits), the /login page,
// and /auth/callback — single source of truth so the three cannot drift.
// Moved here from lib/auth.ts (S146) so the Edge proxy can import it without
// pulling next/headers (a server-only module) into the Edge bundle; lib/auth.ts
// re-exports it for its existing consumers.
export function isSafeRedirect(path: string | undefined | null): path is string {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (/[\s\x00-\x1f]/.test(path)) return false;
  return true;
}
