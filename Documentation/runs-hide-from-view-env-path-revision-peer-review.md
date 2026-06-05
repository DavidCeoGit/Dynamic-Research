# Hide-From-View ENV-PATH REVISION (v4) — MERGE-gate Peer Review (verbatim + synthesis)

> Intended path: `Documentation/runs-hide-from-view-env-path-revision-peer-review.md`
> Companion to `runs-hide-from-view-env-path-revision.md` (v4). S92 (2026-06-05). Sequential Gemini→Codex.

## MRPF
MERGE × SECURITY (new unauthenticated write surface) + DATA + ARCHITECTURE × NORMAL. Sequential Gemini→Codex. **Both APPROVE_WITH_CHANGES. No SECURITY-CRITICAL → not blocked.**

## What each reviewer saw
- **Gemini (holistic):** full v4 doc inline + directed at the shipped code (runs/state/hide routes, auth, storage, rate-limit, supabase, hidden-runs, the v3 migration). Fallback model (`gemini-3.1-pro-preview` 429-exhausted), doc-grounded.
- **Codex (grounded, gpt-5.5):** integrated v4 doc inline + read the actual shipped v3 code in read-only sandbox (cited real line numbers).

## Synthesis — findings → resolution
| # | Reviewer | Sev | Finding | Resolution |
|---|---|---|---|---|
| G1 | Gemini | MAJOR | Retaining `user_id` is false forward-compat — org-unique breaks per-user anyway | **Applied** — drop `user_id` column + FK + index + the 3 RLS policies; table = (id, org_id, slug, hidden_at). §2/§3 |
| G2 | Gemini | MINOR | upsert `onConflict` must change to `(organization_id, slug)` | **Applied** §4 |
| G3 | Gemini | NIT | v3 RLS policies become dead code under service-role | **Applied** — policies dropped; RLS stays enabled, zero policies = service-role-only. §3 |
| C1 | Codex | **MAJOR** | Migration name `20260605_hidden_runs_org_scoped` collides/sorts before the applied `20260605_user_hidden_runs` (same version) | **Applied** — renamed `20260606_hidden_runs_org_scoped.sql` (strictly-later version). §3 |
| C2 | Codex | MINOR | Match rate-limit contract: limiter before `request.json()`, 429 with `Retry-After` + `X-RateLimit-Remaining` | **Applied** §4 |
| C3 | Codex | NIT | Stale "user_id retained" sentence in §2 | **Applied** — removed. §2 |

**Reviewer-affirmed (no change):** Q1 org-scoping via service-role + always `.eq(organization_id)` is a secure RLS substitute on the env path (both); Q2 rate-limit 20/180s sizing fine; migration drop-order correct (policies→constraint→index→column→add-unique), FK needs no CASCADE; the only degradation vs v3 (unauthenticated unhide) is bounded/reversible/org-scoped. Codex grounded line-map: hide route `requireOrgContext`@20/`createServerSupabase`@35,69/`user_id`@87,115 → replace; runs gating @60; state gating @133; page.tsx envelope field @46, canHide @109, gates @268/@391.

## Residual / human owner
- Holistic (Gemini) pass on a fallback model (capacity-exhausted preview); corroborated by Codex grounded pass; high confidence. No CRITICAL ⇒ no signed risk-acceptance needed.
- **Accepted residual:** anonymous visitor can hide/unhide the system-default org's runs (rate-limited, reversible, UI-only). Acceptable for single-operator deployment; gate behind SSR-auth login if the app opens to the public.

---
## Verbatim — Gemini v4 (holistic)
> **MAJOR** | §6/§3/Q3 | Retaining `user_id` claims "no data migration needed" later — structurally false; `UNIQUE(org, slug)` forces an org singleton. FIX: drop `user_id` entirely now; rebuild per-user cleanly under SSR auth later.
> **MINOR** | §4 POST | Must update upsert conflict target to `{ onConflict: 'organization_id,slug', ignoreDuplicates: true }` or PostgREST errors.
> **NIT** | §3 | Leaving v3 RLS policies (`user_id = auth.uid()`) is dead code under service-role; drop them or rewrite `... OR user_id IS NULL`.
> Q1: route-level org-scoping via service-role is a completely acceptable, secure RLS substitute on the env path — blast radius confined to toggling UI-visibility within the system-default org. Q2: 20/180s bucket sufficient. Q3: drop user_id. Q4: constraint name verified. Focus#4: only degradation is the unauthenticated DELETE (unhide), rigidly scoped to `.eq(organization_id)` → reversible nuisance, no cross-org exposure.
> **VERDICT: APPROVE_WITH_CHANGES. NO SECURITY-CRITICAL.**

## Verbatim — Codex v4 (grounded, gpt-5.5)
> **MAJOR** | migration:1 | `20260605_hidden_runs_org_scoped.sql` is not "timestamp >" the shipped v3; shares the date and sorts before `20260605_user_hidden_runs.sql` lexically — may be skipped/rejected/out-of-order. FIX: use a version the runner orders after v3; verify with the migration list.
> **MINOR** | rate-limit | v4 says "429 on exceed" but should match the repo contract: `Retry-After` + `X-RateLimit-Remaining`, and apply the limiter before `request.json()` in POST and DELETE.
> **NIT** | doc | Stale "user_id retained" sentence; v4 should consistently say org-scoped only.
> Grounded: drop-order correct (policies @26/32/38 → unique @13 → index @16 → column; FK @8 needs no CASCADE → add new unique). Route rewrite implementable (hide `requireOrgContext`@20, `createServerSupabase`@35/69, `user_id`@87/115 → `getOrgContextDualPath` + service-role `getSupabase`@13, always `.eq(organization_id)`). `/api/runs`@60 + `/api/state`@133 stop session-gating hidden reads. page.tsx: envelope field@46, canHide@109, remove gates@268/@391.
> **VERDICT: APPROVE_WITH_CHANGES. No SECURITY-CRITICAL** — unauthenticated write bounded to reversible org-scoped UI state, assuming every service-role op is explicitly filtered by `organization_id = orgId`.
