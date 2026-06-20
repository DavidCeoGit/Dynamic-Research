/**
 * Phase 4 SSR-auth route-classification + redirect-safety tests (S146).
 *
 * Guards the security-critical public-vs-protected boundary that proxy.ts uses
 * for the unauth→/login + no-membership→/no-org redirects, AND the open-redirect
 * predicate the proxy/login/callback share. A regression in the former is either
 * a lockout (a public page wrongly protected) or a leak (a protected page wrongly
 * public); a regression in the latter is a phishing vector. Both are pinned.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/route-protection.test.ts"
 * (wired into the root `pnpm test` script alongside the other frontend suites)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_PAGE_ROUTES,
  isApiPath,
  isPublicPage,
  isProtectedPage,
  isSafeRedirect,
} from "../route-protection";

// ── isApiPath ───────────────────────────────────────────────────────

test("isApiPath: /api and any /api/* are API paths", () => {
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/api/runs"), true);
  assert.equal(isApiPath("/api/runs/abc/file/chart.png"), true);
  assert.equal(isApiPath("/api/queue/claim"), true);
});

test("isApiPath: page routes are not API paths", () => {
  assert.equal(isApiPath("/"), false);
  assert.equal(isApiPath("/runs"), false);
  // A page route that merely starts with the letters "api" is NOT /api.
  assert.equal(isApiPath("/apiary"), false);
});

// ── isPublicPage (EXACT match only — S146 Gemini MAJOR) ──────────────

test("isPublicPage: the three public routes (exact) are public", () => {
  assert.equal(isPublicPage("/login"), true);
  assert.equal(isPublicPage("/no-org"), true);
  assert.equal(isPublicPage("/auth/callback"), true);
});

test("isPublicPage: subpaths under a public route are NOT public (no over-match)", () => {
  // Exact-match: a nested segment under a public path must not inherit public
  // status, so a future public "/foo" can never silently expose "/foo/secret".
  assert.equal(isPublicPage("/auth/callback/extra"), false);
  assert.equal(isPublicPage("/login/anything"), false);
  assert.equal(isPublicPage("/no-org/x"), false);
});

test("isPublicPage: prefix look-alikes are NOT public", () => {
  assert.equal(isPublicPage("/login-help"), false);
  assert.equal(isPublicPage("/no-org-admin"), false);
  assert.equal(isPublicPage("/"), false);
  assert.equal(isPublicPage("/runs"), false);
});

// ── isProtectedPage ─────────────────────────────────────────────────

test("isProtectedPage: real page routes require auth", () => {
  for (const p of ["/", "/runs", "/runs/my-slug", "/runs/my-slug/gallery", "/new", "/new/some-id"]) {
    assert.equal(isProtectedPage(p), true, `${p} should be protected`);
  }
});

test("isProtectedPage: /api routes are NOT page-protected (they self-protect)", () => {
  assert.equal(isProtectedPage("/api/runs"), false);
  assert.equal(isProtectedPage("/api/queue/claim"), false);
});

test("isProtectedPage: public pages are not protected", () => {
  for (const p of PUBLIC_PAGE_ROUTES) {
    assert.equal(isProtectedPage(p), false, `${p} should be public`);
  }
});

test("PUBLIC_PAGE_ROUTES is pinned exactly (change = security review)", () => {
  assert.deepEqual([...PUBLIC_PAGE_ROUTES], ["/login", "/no-org", "/auth/callback"]);
});

// ── isSafeRedirect (open-redirect predicate — S146 Gemini CRITICAL) ──

test("isSafeRedirect: same-origin relative paths pass", () => {
  assert.equal(isSafeRedirect("/"), true);
  assert.equal(isSafeRedirect("/runs"), true);
  assert.equal(isSafeRedirect("/runs/my-slug/gallery"), true);
});

test("isSafeRedirect: protocol-relative + absolute + backslash vectors are rejected", () => {
  assert.equal(isSafeRedirect("//evil.com"), false);
  assert.equal(isSafeRedirect("/\\evil.com"), false);
  assert.equal(isSafeRedirect("https://evil.com"), false);
  assert.equal(isSafeRedirect("http://evil.com"), false);
  assert.equal(isSafeRedirect("javascript:alert(1)"), false);
  assert.equal(isSafeRedirect("evil.com"), false); // no leading slash
});

test("isSafeRedirect: empty / nullish / whitespace / control chars rejected", () => {
  assert.equal(isSafeRedirect(""), false);
  assert.equal(isSafeRedirect(undefined), false);
  assert.equal(isSafeRedirect(null), false);
  assert.equal(isSafeRedirect("/has space"), false);
  assert.equal(isSafeRedirect("/has\ttab"), false);
  assert.equal(isSafeRedirect("/has\nnewline"), false);
});
