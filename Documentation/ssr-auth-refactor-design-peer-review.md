# SSR Auth Refactor — Peer Review Audit Trail

> Companion to `Documentation/ssr-auth-refactor-design.md`. Records the full Gemini → Codex sequential review chain at each revision. Per `~/CLAUDE.md` Multi-Reviewer Policy Framework §Workflow + Operationalization.

---

## Round 1 — Gemini 3.1 Pro Deep Think (on v1)

**Invocation:** `cat sandbox/working/gemini_review_ssr_auth_refactor_PROMPT.md | gemini -p "" -m gemini-3.1-pro-preview --output-format json --approval-mode plan` (S54, 2026-05-26)

**Stat-line:** exit 0; 777s wall-clock (rate-limit retries — 20 errors out of 51 requests); 12,374 thinking tokens (confirms Deep Think signature); 30 code-grounded tool calls (12 grep + 10 read_file + 6 list_directory). Verdict: **REQUEST CHANGES** (1 CRITICAL + 1 MAJOR + 2 MINOR).

**Raw response:** `sandbox/working/gemini_response_ssr_auth_refactor.json`.

### Findings

#### CRITICAL — must resolve before MERGE

**G-C1. Phase 5 preflight `count(*) WHERE org_id='<system-default>'` is logically broken — SECURITY/DEPLOYMENT.**
The check at §5 row 5 (`SELECT count(*) FROM research_queue WHERE created_at > '<phase-4-deploy>' AND organization_id = '<system-default>' = 0`) is impossible to satisfy. Since the owner's organization *is* the `system-default` org today, every explicit valid insert during Phase 4 soak populates `organization_id` with that exact UUID. `COUNT(*)` cannot distinguish an explicit insert from an implicit `DEFAULT` fallback when both write the identical value. The gate would falsely block deployment of every Phase 5 cutover that follows real user traffic.
**Resolution (v2):** Drop the SQL preflight. Rely on the 3-day soak + a static grep that no remaining code path uses the DEFAULT (i.e. every `insert(...)` site passes `organization_id` explicitly). Updated `Documentation/multi-tenancy-phase-b-plan.md` §2.8 step 7 reference accordingly in v2.
**Author disposition:** ACCEPT. Acknowledged that the inherited B-plan check was wrong; the SSR refactor inherits it but does not re-justify it.

#### MAJOR — should resolve

**G-M1. Middleware matcher misses static assets in `frontend/public/` — ARCHITECTURE.**
The matcher at §2.5 `"/((?!_next/static|_next/image|favicon.ico).*)"` and `PUBLIC_PREFIXES` array do not exclude top-level static assets served by Next from `frontend/public/`. The directory contains `file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`. The middleware would intercept these GETs as unauthenticated and 302 them to `/login`, breaking UI icons across the app post-Phase 1 deploy.
**Resolution (v2):** Replace matcher with `"/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$).*)"`. Broadens the file-extension exclusion to all static asset types Next might serve from `public/`. (Author added woff/woff2/ttf/ico beyond Gemini's minimum set as defense-in-depth for future static fonts/icons.)
**Author disposition:** ACCEPT.

#### MINOR

**G-m1. Doc text says "8 STOPGAP(SSR-auth)-tagged handler bodies" but queue routes lack the physical tag — DOC QUALITY.**
§0.1 and §1.3 text imply all 8 handler bodies bear the `STOPGAP(SSR-auth)` comment, but `app/api/queue/route.ts` (POST + GET) and `app/api/queue/[id]/route.ts` (GET) are not tagged. A grep-driven implementation would miss them.
**Resolution (v2):** Replace "8 `STOPGAP(SSR-auth)`-tagged" with "8 handler bodies (5 carrying explicit `STOPGAP(SSR-auth)` comments; 3 in queue routes implicitly relying on the Phase A DEFAULT)". Mirror clarification in §1.3.
**Author disposition:** ACCEPT.

**G-m2. SameSite=Strict would break PKCE magic-link flow — SECURITY/UX.**
§2.2 open question on `SameSite=Strict` vs `Lax`. Gemini observation: `@supabase/ssr` uses PKCE; the code-verifier cookie must ride the cross-site GET when the user clicks the magic link from an external email client (e.g. Gmail web). `SameSite=Strict` blocks the cookie on cross-site navigation → `exchangeCodeForSession` fails with PKCE mismatch. Lax is mandatory, not preferential.
**Resolution (v2):** Replace §2.2's open question with a stated decision: "`SameSite=Lax` is mandatory — PKCE code-verifier cookie must ride the cross-site GET from email-client link click. `Strict` would break login. Keep the `@supabase/ssr` default."
**Author disposition:** ACCEPT.

#### Open question resolutions (§9 Q1-Q8)

| Q | Author position v1 | Gemini verdict |
|---|---|---|
| Q1 — `@supabase/ssr` | Recommended | CONFIRMED — correct supported choice for Next 16 App Router; no known showstopper bugs |
| Q2 — service-role + manual `.eq()` post-Phase 5 | Keep service-role | CONFIRMED — minimizes diff, preserves audit_storage_writes pattern uniformly, defers cascading `lib/storage.ts` refactor to post-beta |
| Q3 — SameSite | Lax (default) | CONFIRMED — promoted to mandate (see G-m2 above) |
| Q4 — extract-context + generate-questions unauth | No auth | CONFIRMED — no DB state to scope |
| Q5 — soak window minimum | 3 days | (Not addressed; carry forward as v1 position) |
| Q6 — Phase 5 rollback strategy | Follow-up DISABLE migration | CONFIRMED — `supabase db reset` would wipe schema; follow-up migration is only acceptable rollback |
| Q7 — Phase 5 timing | Separate session +24h | CONFIRMED — ensures Phase 4 hasn't caused lockouts before flipping RLS switch |
| Q8 — `NEXT_PUBLIC_SITE_URL` | Hardcode `dynamic-research.vercel.app` | CONFIRMED — `NEXT_PUBLIC_VERCEL_URL` would require wildcard allowlist in Supabase Auth Redirect URLs setting |

### Findings NOT raised (worth noting for Codex round 2)

- No issues raised against §2.4 helper API surface (`requireUser`, `requireOrgContext`, `getOrgContextDualPath`).
- No issues raised against §3 magic-link flow.
- No issues raised against §4 per-route refactor diffs.
- No issues raised against §6 RLS bypass test grid.
- No issues raised against §7 risk register.
- Codex should pay extra attention to: (a) typing of `requireOrgContext` against actual `@supabase/ssr` v0.x API + Next 16's `cookies()` Promise return, (b) Server Action vs Route Handler subtleties for the magic-link send path, (c) whether `exchangeCodeForSession` actually handles the `redirect=` query param the way §3.3 assumes, (d) any TypeScript narrowing issues in the dual-path helper.

---

## Round 2 — Codex CLI (on integrated v2)

**Invocation:** `cat sandbox/working/codex_review_ssr_auth_refactor_PROMPT.md | codex exec -s read-only -C "<project root>" -` (S54, 2026-05-26)

**Stat-line:** exit 0; 318s wall-clock; 216,724 tokens consumed; code-grounded read of actual project files (frontend/, agent/, supabase/, Documentation/). Verdict: **REQUEST CHANGES (1 BLOCKING)**.

**Raw response:** `sandbox/working/codex_response_ssr_auth_refactor.txt`.

### Findings

#### CRITICAL — BLOCKING (per `~/CLAUDE.md` §Disagreement Procedure, SECURITY-labeled)

**C-C1. `POST /api/queue` `parentSlug → parent_run_id` lookup is cross-tenant — SECURITY/DATA.**
The v2 design at §4.4 adds `organization_id: orgId` to the new queue row but leaves the parent lookup at `frontend/app/api/queue/route.ts` lines 48-53 unscoped. A user can craft a clone/studio-only POST containing another org's `parentSlug`. The route writes an org-A job with `parent_run_id` pointing at an org-B row. The worker resolves the parent by ID and reads parent-org storage/notebook data at `agent/scripts/regenerate-studio-products.ts:349-401` — cross-tenant data leak.
**Resolution (v3):** Phase 2 must (a) derive `orgId` BEFORE the parent lookup, (b) add `.eq('organization_id', orgId)` to the `parent_run_id` query, AND (c) recommend a DB-level guard (composite FK or BEFORE-INSERT/UPDATE trigger on `research_queue` asserting `parent_run_id` references a row with the same `organization_id`). The DB-level guard is defense-in-depth in case future code paths regress the route-level check. Track the DB guard as a Phase 5+ deliverable so it co-exists with the RLS enable.
**Author disposition:** ACCEPT (CRITICAL/BLOCKING). Resolved in v3 §4.4 + new §4.5; DB guard tracked as a v3 recommendation appended to the Phase B-2 migration scope.

#### MAJOR

**C-M1. Middleware design contradicts Phase 1+2 deploy plan — DEPLOYMENT/AGENT BEHAVIOR.**
v2 §2.5 middleware pseudocode redirects every non-public unauthenticated request to `/login` immediately. But §5 row 1 says "existing routes unaffected" for Phase 1, and §5 row 2 specifies the Phase 2 smoke test as "hit logged-out env path + logged-in session path; both 200". With the v2 middleware live, the logged-out env path is unreachable — middleware would 302 before the route ever ran the dual-path helper.
**Resolution (v3):** Phase 1 middleware refreshes cookies only — no route protection. Phase 2 middleware adds the 8-route dual-path tolerance (route handlers themselves choose env vs session). Phase 4 promotes middleware to full protection. Track via a `PHASE` env var or a hardcoded `PROTECTED_ROUTES` constant that grows across phases. Updated §2.5 + §5 row table accordingly.
**Author disposition:** ACCEPT.

**C-M2. Broadened middleware matcher regresses dynamic API file URLs — AGENT BEHAVIOR/SECURITY.**
The Gemini G-M1 fix (broadened matcher to exclude `.svg/.png/...`) regresses `/api/runs/<slug>/file/<filename>/route.ts` — dynamic tenant file routes serve `chart.png`, `report.pdf`, etc. The matcher would skip these as static assets even though they are functional tenant-scoped data routes.
**Resolution (v3):** Two-matcher pattern. `matcher[0] = "/api/:path*"` ALWAYS runs through proxy (auth-aware). `matcher[1] = "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|...)$).*)"` excludes static assets only outside `/api`. Updated §2.5.
**Author disposition:** ACCEPT.

**C-M3. Login `redirect` doesn't propagate; `new URL(redirectTo, url)` accepts external URLs — SECURITY (open-redirect).**
v2 §3.2 Server Action calls `signInWithOtp({ emailRedirectTo: '/auth/callback' })` — but the login page's `?redirect=<x>` query param is not passed through. Supabase magic-link emails only preserve the `?code=<otp>` param; arbitrary login-page query params are dropped. Worse, v2 §3.3 callback does `new URL(redirectTo, url)` — that accepts absolute external URLs (e.g., `?redirect=https://evil.example/`), creating an open-redirect vector.
**Resolution (v3):** (a) login page hidden form field for `redirect` (same-origin relative path); (b) Server Action validates `redirect` starts with `/` but NOT `//` (which would be protocol-relative external), then passes it as `/auth/callback?redirect=<x>` via `emailRedirectTo`; (c) callback re-validates `redirect` before navigation. Updated §3.1, §3.2, §3.3.
**Author disposition:** ACCEPT.

**C-M4. §2.2 cookie strategy overstates `@supabase/ssr` defaults — DOC QUALITY/SECURITY.**
v2 §2.2 claims `HttpOnly` is among the `@supabase/ssr` defaults. Current Supabase docs do not actually default to `HttpOnly: true` for SSR auth cookies — the browser side may need token access for the browser-client subscription pattern. Stating it as a default is misleading and would mislead the implementer.
**Resolution (v3):** Revise §2.2 to enumerate the cookies we DO want with explicit options (`HttpOnly: true` if we are confident; `Secure: true` always; `SameSite: 'lax'` always — see G-m2 rationale; `Path: '/'`). Add a checkpoint to Phase 1 to manually verify the actual cookie shape via DevTools post-deploy.
**Author disposition:** ACCEPT.

**C-M5. Static-grep preflight regex is single-line; doesn't catch multi-line inserts — DEPLOYMENT GATE.**
v2 §5 row 5 replaces the SQL preflight (G-C1) with a regex: `git grep -nE "(\\.insert\\(\\{[^}]*organization_id|from\\([\"']research_queue[\"']\\)\\.insert)"`. The real insert in `frontend/app/api/queue/route.ts` lines 80-95 has `.from("research_queue")` and `.insert({` on separate lines, with `organization_id` several lines later. The single-line `git grep -E` would miss it; the preflight would falsely pass even if the route still relied on DEFAULT.
**Resolution (v3):** Replace with multiline `ripgrep -U` (multi-line mode): `rg -U 'from\("research_queue"\)\s*\.insert\(\{[^}]*organization_id'` — OR an AST-based grep via a small Node script using `@typescript-eslint/parser`. Pick the multiline rg variant for the v3 spec; AST is overkill for one preflight check.
**Author disposition:** ACCEPT.

**C-M6. `test-phase-b-rls.sh` is insufficient as the Phase 5 acceptance harness — TEST COVERAGE.**
v2 §8.3 mentions `agent/scripts/test-ssr-auth-cutover.sh` (does not yet exist) but `agent/scripts/test-phase-b-rls.sh` lines 21-29 explicitly say HTTP auth + RLS bypass matrix are OUT of scope for that script (it's a B-1 helper/policy harness only).
**Resolution (v3):** Keep `test-phase-b-rls.sh` for what it covers. Specify the minimum spec for `test-ssr-auth-cutover.sh`: (1) unauth redirects to `/login`, (2) owner authenticated access succeeds, (3) no-membership user redirects to `/no-org`, (4) other-org slug access returns 404, (5) worker `POST /api/queue/claim` + `PATCH /api/queue/[id]` bypass via X-Agent-Key, (6) anon-key direct SQL denied by RLS, (7) owner JWT direct SQL returns only owner-scoped rows, (8) RLS enabled on the 4 tenant tables (`SELECT relrowsecurity FROM pg_class WHERE relname IN ('research_queue', 'organization_members', 'organization_invitations', 'organizations')`), (9) `research_queue.organization_id` DEFAULT dropped (`SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef ...` returns no row), (10) queue POST parent lookup is same-org scoped (negative test: cross-org parentSlug returns 400). Updated §8.3.
**Author disposition:** ACCEPT.

#### MINOR

**C-m1. T14 SQLSTATE 21000 expectation won't fire from `.single()` — TEST CORRECTNESS.**
v2 §6 T14 expects PostgreSQL `cardinality_violation` (21000) when the `om_one_org_per_user` UNIQUE constraint is dropped + a 2nd membership row is inserted + `requireOrgContext()` is called. But `requireOrgContext()` uses PostgREST `.single()`, which raises an app-level error (PostgREST 406), NOT the DB-level cardinality_violation. The fail-loud guarantee only holds inside the `private.auth_user_organization_id()` SQL function's scalar-subquery wrap (B-1 §3).
**Resolution (v3):** Split T14 into T14a (call `.single()` from app code — expect PostgREST 406 / "multiple rows returned") and T14b (call `private.auth_user_organization_id()` via psql — expect SQLSTATE 21000). Updated §6.
**Author disposition:** ACCEPT.

**C-m2. Naming — `middleware.ts` vs `proxy.ts` in Next 16 — DOC ACCURACY.**
Codex stated Next 16 has "renamed `middleware.ts` to `proxy.ts`". Author verified via Perplexity Sonar (2026-05-26): Next 16 itself did NOT deprecate `middleware.ts` — it still works at the framework level. HOWEVER, the ecosystem has standardized on `proxy.ts` for Next 16 integrations (Clerk, Auth0, Prismic), and **Supabase's `@supabase/ssr` migration guide for Next 16 specifically uses `proxy.ts`**. Since this design uses `@supabase/ssr` against Next 16, alignment with Supabase's docs dictates `proxy.ts` + `export async function proxy(...)`.
**Resolution (v3):** Globally rename `middleware.ts` → `proxy.ts` and `function middleware` → `function proxy` throughout the doc, with a documented rationale block in §2.5 explaining the ecosystem alignment (not a Next 16 deprecation). Updated §1.3 file inventory + §2.5 + every cross-reference.
**Author disposition:** ACCEPT WITH AMENDED RATIONALE (Codex was directionally right but stated rationale was wrong).

### Verdict line

`VERDICT: REQUEST CHANGES (1 blocking)` — C-C1 is blocking SECURITY. Resolved in v3.

### Findings NOT raised (worth carrying into v3 QA pass)

- Codex did not re-raise the Gemini G-* findings (correct — they were already integrated).
- Codex's "Checked / Not Found" notes: no real `SYSTEM_DEFAULT_ORG_ID` reads outside the 2 known frontend handler constants; no hidden direct Supabase service-role usage in Server Components; `C:/tmp/Dynamic-Research/frontend` not reachable from Codex's read-only sandbox (Codex couldn't validate the push-clone). The push-clone reconcile must be a manual pre-deploy step per `feedback_pushclone_divergence_reconcile`.
- v3 QA pass (per `~/CLAUDE.md` §Review Topology DESIGN-revision rule) is Codex (caught more this round = does QA). Pre-submission self-fidelity sweep (`feedback_self_fidelity_sweep_before_qa`) must verify: (a) all `middleware` literals replaced with `proxy`, (b) no leftover `count(*) WHERE org_id` references, (c) all new file/line refs introduced in v3 exist in the codebase.

---

## Round 3 — Codex Sequential QA (on integrated v3)

**Invocation:** `cat sandbox/working/codex_qa_v3_ssr_auth_refactor_PROMPT.md | codex exec -s read-only -C "<project root>" -` (S54, 2026-05-26). Charter: fidelity (verify v3 applied round-2 findings correctly), not novel critique.

**Stat-line:** exit 0; 370s wall-clock; 108,357 tokens consumed; code-grounded read of v3 doc + peer-review companion + project codebase. Verdict: **REQUEST CHANGES (0 blocking, 5 major + 2 minor fidelity gaps)**.

**Raw response:** `sandbox/working/codex_qa_v3_response.txt`.

### Findings (all resolved in v3 post-QA fidelity pass)

#### MAJOR fidelity gaps

**Q-M1. §1.3 file inventory row for `frontend/proxy.ts` contradicted §2.5 phase-gating.** v3 §1.3 said `frontend/proxy.ts` is edited in Phase 2 to "extend route-protection map", but §2.5 says Phase 1-3 are cookie-refresh-only and Phase 4 adds protection. The two sections disagreed.
**Resolution:** Updated row to `NEW (cookie-refresh only; no route protection — see §2.5 phase-gating)` for Phase 1, `—` for Phase 2, `edit (populate PROTECTED_PHASE_4 array; enable redirect block)` for Phase 4.

**Q-M2. §2.2 explicit cookie options vs §2.3/§2.5 setAll handlers passing options through verbatim.** v3 §2.2 lists explicit `httpOnly: true`, `secure: true`, etc., but both setAll pseudocode blocks (in `lib/supabase-server.ts` and `proxy.ts`) passed `options` through unchanged from library, re-introducing reliance on library defaults.
**Resolution:** Both setAll handlers now spread `options` first, then override with security-critical fields explicitly: `{ ...options, httpOnly: true, secure: true, sameSite: 'lax', path: '/' }`. Comment cites Q-M2.

**Q-M3. §4.5 PL/pgSQL trigger function missing block terminator semicolon.** Function body ended with `END` not `END;`. Would not compile in PostgreSQL.
**Resolution:** Added the missing `END;`.

**Q-M4. §6 contradicted §8.3 on which test script implements the RLS bypass grid.** §6 said "lives in `agent/scripts/test-phase-b-rls.sh postmerge`" but §8.3 correctly specifies the new `test-ssr-auth-cutover.sh` (because the existing script scopes out HTTP auth + RLS bypass per its own lines 21-29).
**Resolution:** §6 intro rewritten — "conceptual grid here; executable implementation lives in `agent/scripts/test-ssr-auth-cutover.sh` (NEW); `test-phase-b-rls.sh` remains scoped to B-1 helpers + RLS policy structural checks."

**Q-M5. §7 risk register stale mitigation referenced the rejected SQL preflight.** "Phase 5 preflight in §5 row 5 must pass — explicit assertion against `created_at`+`organization_id`" was a leftover from v1 that Gemini G-C1 retired and Codex C-M5 replaced with multiline `rg -U`.
**Resolution:** Mitigation rewritten to cite the multiline grep + soak/log observational verification. Notes that the v1 SQL preflight is permanently retired.

#### MINOR fidelity gaps

**Q-m1. §1.3 didn't enumerate the 5 STOPGAP-tagged vs 3 DEFAULT-reliant handlers (only §0.1 did).** §0.1 says "see §1.3 for full inventory" but the §1.3 table didn't break the 8 handlers into the two grep-discovery categories.
**Resolution:** Added a sub-note under §1.3 explicitly listing the 5 tagged file paths and the 3 untagged queue-route handlers.

**Q-m2. Leftover lowercase `middleware` references at lines 232, 620, 756.** Self-fidelity sweep before QA missed three lowercase prose hits + one code comment.
**Resolution:** Fixed all four. Remaining `middleware` literals are intentional prose (in the rename rationale block + v3 changelog explaining what was renamed).

### Verified passes (round-2 findings correctly integrated)

| Round-2 finding | Verification |
|---|---|
| C-C1 — parent_run_id same-org scoping | Route-level `.eq()` present at v3 §4.4 lines 629-640; insert follows lines 655-663; T15 covers both layers (route 400 + DB trigger) at line 746 |
| C-M2 — two-matcher pattern | Correct at v3 §2.5 lines 301-310 |
| C-M3 — redirect open-redirect closed | `isSafeRedirect()` helper + Server Action propagation + callback re-validation all present at v3 §3.1-§3.3 lines 373-403, 425-440, 464-498 |
| C-M5 — multiline static grep | Uses `rg -U` at v3 §5 row 5 line 721 |
| C-m1 — T14 split | T14a (app-level 406) + T14b (DB-level 21000) at v3 §6 lines 744-745 |
| `isSafeRedirect()` helper | Rejects `//evil/path`, `https://evil`, whitespace, control chars; accepts `/`, `/runs/foo`, `/runs/foo?bar=baz` at v3 §3.1 lines 394-402 |
| §9 Q1-Q8 resolutions preserved | All 8 still present at v3 §9 lines 817-826 |

### Verdict line

`VERDICT: REQUEST CHANGES (0 blocking, 5 major)` — followed by author fidelity pass that resolved all 7 (5 MAJOR + 2 MINOR). No further reviewer round needed; all findings have ACCEPT dispositions and v3-post-QA reflects them.

---

## Final disposition (v3 FINAL — ready for /promote)

**Status: SHIP-READY.** All reviewer findings across 3 rounds resolved.

- **Round 1 Gemini Deep Think:** 1 CRITICAL + 1 MAJOR + 2 MINOR; all ACCEPT, all resolved in v2.
- **Round 2 Codex code-grounded:** 1 BLOCKING + 6 MAJOR + 2 MINOR; all ACCEPT, all resolved in v3.
- **Round 3 Codex Sequential QA:** 0 BLOCKING + 5 MAJOR + 2 MINOR fidelity gaps; all ACCEPT, all resolved in v3-post-QA fidelity pass.

**Recommendation:** `/promote` `sandbox/ssr-auth-refactor-design.md` → `Documentation/ssr-auth-refactor-design.md` AND `sandbox/ssr-auth-refactor-design-peer-review.md` → `Documentation/ssr-auth-refactor-design-peer-review.md`.

**Phase 1 implementation can begin in a follow-on session.** This DESIGN gate is closed.

### Dogfood notes for the multi-reviewer policy framework

- Sequential Gemini → Codex topology earned its keep: Codex round 2's C-C1 (cross-tenant `parent_run_id` leak) was code-grounded — Gemini round 1's whole-doc read did NOT catch it because the second tenant-sensitive path was in a different region of the route than the obvious insert. Codex caught it by reading the actual route file.
- v2 → v3 integration introduced REGRESSIONS that Sequential QA caught (Q-M1 §1.3 contradicted §2.5; Q-M2 setAll inconsistency; Q-M3 missing semicolon). Author's own self-fidelity sweep before QA missed 2 of the 7 (Q-m2 prose leftovers, Q-M3 SQL semicolon). Sequential QA pass therefore saved one more revision cycle — empirically validates the topology rule.
- CLI invocation latency: Gemini ~13min (rate-limit retries); Codex round 2 ~5min; Codex QA round 3 ~6min. Total reviewer wall-clock for a 12h-effort-estimate DESIGN gate: ~24 minutes. Reasonable cost.
- Cross-link: Update `feedback_multi_reviewer_gate_dependent_pattern.md` with this S54 data point.
