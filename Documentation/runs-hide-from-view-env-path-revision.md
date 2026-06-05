# Hide-From-View — ENV-PATH REVISION (v4) — DESIGN + SECURITY re-review

> **Status:** DRAFT v4 — S92 (2026-06-05). Revises the shipped v3 after a field finding: the v3 session-gate made the feature **invisible**, because the live dashboard runs on the **env-fallback path with no active session**. Re-review required (SECURITY-labelled — introduces an unauthenticated write surface).
> **Intended path:** `Documentation/runs-hide-from-view-env-path-revision.md`
> **Builds on:** `Documentation/runs-hide-from-view-design-gate.md` (v3, shipped commit abe3969) + `-peer-review.md`.

---

## 0. MRPF classification
**MERGE × SECURITY + DATA + ARCHITECTURE × NORMAL.** The new risk is an **unauthenticated write** (hide/unhide on the env-fallback path). Sequential Gemini→Codex. SECURITY ⇒ blocking on a CRITICAL.

## 1. Why v3 failed in the field
v3 gated hide controls on `auth === true` (a real Supabase session). But the production dashboard serves runs through `getOrgContextDualPath()` → **`source: "env"`** (the `SYSTEM_DEFAULT_ORG_ID` org), unauthenticated — there is no login on the dashboard and the runs the operator sees live under the system-default org. So `auth` is always `false` → controls never render. Worse, "just log in" would switch the dashboard to the user's *own* org (possibly empty), making their runs appear to vanish. **Conclusion: the feature must work on the env-fallback path to be usable at all in the current (pre-SSR-auth) architecture.**

## 2. Revised model — ORG-SCOPED hide on the resolved org context
Hide state is scoped to the **organization the dashboard resolved** (env *or* session), not to a user. One operator, one org (system-default) today. There is **no `user_id`** — the table is org-scoped only (per-user hide is a clean future rebuild under SSR auth, §6).

- **Org resolution:** `getOrgContextDualPath()` — the SAME tenant boundary the dashboard already uses for reads. No new tenant surface; hide can only ever touch the org the caller can already see.
- **DB client:** the **service-role** `getSupabase()` (the env path has no `auth.uid()`, so the RLS/anon client cannot be used). The route enforces tenant scoping by always filtering `.eq("organization_id", orgId)`. This **reverses v3's Codex MAJOR-A** deliberately: in v3 RLS-via-auth.uid() was the backstop; in v4 the backstop is **route-level org-scoping** (because there is no authenticated identity to bind RLS to). RLS stays ENABLED on the table as defense-in-depth, but is not the load-bearing control.
- **Ownership gate (unchanged):** `projectExists(orgId, slug)` — the run must exist in the resolved org's storage prefix. Prevents hiding arbitrary/cross-org slugs and confines existence-inference to the caller's own org.
- **`user_id`: DROPPED entirely (Gemini v4 MAJOR).** Keeping a nullable `user_id` is false forward-compat — the org-scoped `UNIQUE(org, slug)` makes hide an org singleton, so a future per-user rebuild needs a fresh schema+data migration anyway. Table reduces to `(id, organization_id, slug, hidden_at)`. The 3 v3 RLS policies (which reference `user_id = auth.uid()`) are also dropped — they'd be dead code under service-role-only access.

## 3. Migration delta (the table was created today, currently empty)
New migration **`20260606_hidden_runs_org_scoped.sql`** (date +1 so the version sorts strictly AFTER the already-applied `20260605_user_hidden_runs`; a same-`20260605`-prefix name would collide/mis-order the version and could run before the table exists — Codex v4 MAJOR; underscore; NO BEGIN/COMMIT/SET LOCAL). Drop the per-user identity (policies reference `user_id`, so they go first; the column is in a constraint + index, so those go before the column):
```sql
-- v4: org-scoped hide (works on the env-fallback path). Drop per-user identity.
DROP POLICY IF EXISTS uhr_select ON public.user_hidden_runs;
DROP POLICY IF EXISTS uhr_insert ON public.user_hidden_runs;
DROP POLICY IF EXISTS uhr_delete ON public.user_hidden_runs;
ALTER TABLE public.user_hidden_runs
  DROP CONSTRAINT user_hidden_runs_user_id_organization_id_slug_key;  -- verified name (Q4)
DROP INDEX IF EXISTS public.idx_user_hidden_runs_user_org;
ALTER TABLE public.user_hidden_runs DROP COLUMN user_id;
ALTER TABLE public.user_hidden_runs
  ADD CONSTRAINT user_hidden_runs_org_slug_key UNIQUE (organization_id, slug);
-- RLS stays ENABLED with NO policies: all access is via the service-role client
-- (which bypasses RLS); anon/authenticated direct access is denied by default.
```
- New unique `(organization_id, slug)` → a run is hidden once per org; `ON CONFLICT (organization_id, slug) DO NOTHING` makes hide idempotent. Its btree index also serves the `.eq(organization_id)` filter (leftmost-prefix), so the old `idx_user_hidden_runs_user_org` is dropped, not replaced.
- RLS ENABLED + zero policies = locked to service-role (Gemini NIT resolved by dropping the now-dead `auth.uid()` policies).
- Rollback = `DROP TABLE public.user_hidden_runs` (or re-add the column/constraint). Table is empty today, so the ALTERs are instant + safe.

## 4. Route changes
- **`POST/DELETE /api/runs/hide`** — auth: `getOrgContextDualPath()` (env or session), NOT `requireOrgContext()`. Client: service-role `getSupabase()`. Writes/deletes scoped `(organization_id = orgId, slug)` — **no `user_id`**. POST `.upsert({ organization_id, slug }, { onConflict: "organization_id,slug", ignoreDuplicates: true })` (Gemini MINOR — onConflict MUST match the new constraint). **Rate-limited FIRST** (before `request.json()`) via `clientIp()` + `checkRateLimit()` (the existing per-IP token bucket); on deny return **429 with `Retry-After: <retryAfterSec>` + `X-RateLimit-Remaining: 0`** headers to match the existing unauth-route contract (Codex v4 MINOR). Then body validated by the existing `parseHideBody` zod schema (400 on malformed). `projectExists` gate on POST (not DELETE).
- **`GET /api/runs`** — fetch the hidden set ALWAYS (not only on session), via service-role scoped `.eq("organization_id", orgId)`. Envelope field `auth` → renamed **`canHide`** (always `true` now — the dashboard can always hide within its resolved org). `?show_hidden=1` unchanged.
- **`GET /api/state`** (no-slug latest) — same: filter hidden via service-role scoped to `orgId`, always.

## 5. UI changes (`page.tsx`)
Ungate the controls: render per-card hide/unhide, "Hide all", and "Show hidden (N)" whenever the runs section is shown (drop the `auth` gate; `canHide` is effectively always true). Everything else (dimming, "Hidden" badge, non-blank empty-state, bulk confirm) unchanged from v3.

## 6. Security analysis — the unauthenticated write surface (the crux)
**What bad outcome are we preventing?** An anonymous visitor mutating hide state.
- **Blast radius is small + reversible:** hide state is **UI-only** — it hides nothing destructive, deletes no DB/storage data, and is fully reversible (`Show hidden` → `Unhide`). The worst an attacker can do is hide the system-default org's runs from the listing (annoying, instantly restorable).
- **Tenant scope is unchanged:** hide can only touch the org the dashboard already resolves and already exposes read-only. We are NOT widening which org a caller can reach — only adding a (reversible, view-only) write to an org whose contents the caller can already list.
- **Consistent with current posture:** the dashboard is already unauthenticated-readable (env fallback), and the app already has unauthenticated *write* routes (`/api/queue/extract-context`, `/api/queue/generate-questions`) protected by the same rate-limiter we apply here.
- **Bounds:** per-IP rate limit (20-token bucket) + `projectExists` ownership gate + zod body validation + array cap 500.
- **Forward path:** when SSR auth lands (S53+) and the dashboard requires login, per-user hide is re-introduced cleanly via a NEW migration (drop the org-unique, add `user_id` + a per-user unique, re-engage `auth.uid()` RLS). This is a fresh build, not an in-place upgrade — keeping a vestigial `user_id` now would not avoid that migration (Gemini v4 MAJOR).
- **Residual risk accepted:** on a public deployment, an anon visitor could hide/unhide the system org's runs (rate-limited, reversible). Acceptable for a private single-operator deployment; if the app later opens to the public, gate behind the SSR-auth login then.

## 7. Tests
- `parseHideBody` unit test — unchanged, still green (body validation is identical).
- Manual/integration (post-deploy): hide a run (no login) → disappears; Show hidden → reappears dimmed; Unhide → returns; bulk Hide all; refresh persists; a second org's runs unaffected (org-scoping).

## 8. Open questions for reviewers
- **Q1:** Is route-level org-scoping (service-role + always `.eq(organization_id)`) an acceptable substitute for RLS here, given there is no `auth.uid()` on the env path? (I argue yes — same boundary as dashboard reads.)
- **Q2:** Rate-limit bucket sizing — is 20/refill-180s right for a hide endpoint, or should hide get its own looser/tighter bucket? (Bulk hide is one request.)
- **Q3 — RESOLVED (Gemini): DROP `user_id` entirely.** The org-scoped unique breaks per-user hide anyway; retaining it is false forward-compat. Applied in v4.
- **Q4 — RESOLVED: constraint name verified** against the live DB (`user_hidden_runs_user_id_organization_id_slug_key`).

## 9. Gemini v4 integration (holistic pass — APPROVE_WITH_CHANGES, no SECURITY-CRITICAL)
- MAJOR: drop `user_id` (column + FK + index) + the 3 RLS policies → done (§2/§3). MINOR: upsert `onConflict: "organization_id,slug"` → done (§4). NIT: RLS dead-policy → resolved by dropping the policies (§3). Gemini affirmed Q1 (org-scoping is a secure RLS substitute on the env path), Q2 (rate-limit sizing fine), and that the only degradation vs v3 — the unauthenticated unhide — is a bounded, reversible nuisance scoped to the system-default org.
