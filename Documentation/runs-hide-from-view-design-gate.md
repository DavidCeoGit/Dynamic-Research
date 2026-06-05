# Per-User "Hide From My View" for Completed Runs — DESIGN GATE

> **Status:** DRAFT **v3** — authored S92 (2026-06-05). v2 integrated Gemini (holistic); **v3 integrates Codex (code-grounded).** Both reviewers APPROVE_WITH_CHANGES, no SECURITY-CRITICAL. Ready for user review + implementation.
>
> **v3 changelog (Codex integration — all findings code-verified before applying):**
> - **MAJOR-A (the load-bearing one):** `getSupabase()` is the **service-role** client and **bypasses RLS** — so the `user_hidden_runs` RLS backstop is *inert* if the hide routes use it. v3 mandates the **RLS-respecting `createServerSupabase()`** (anon+cookie) for all `user_hidden_runs` reads/writes; service-role is reserved for Storage/`projectExists`. §5.0/§7.
> - **MAJOR-B:** hide/unhide **writes** must use `requireOrgContext()` directly — `getOrgContextDualPath()` falls back to `source:"env"` on `ForbiddenError` (a signed-in user with no membership), which must not silently write under the bootstrap org. §5.0/§5.1.
> - **MAJOR-C + MINOR-D:** `GET /api/runs` returns a **bare array** with auth source only in a header the fetcher discards → switch to an envelope `{ runs, hiddenCount, auth }` so (a) the empty-state shows "N hidden — Show hidden" not "No Research Found", and (b) the UI can auth-gate hide controls. §5.3/§6.
> - **MINOR-E:** add a shared zod body schema (slug: non-empty, max-len, no `/`\\`..`; array cap 500) so a malformed slug returns **400/skip**, not a 500 from the storage-path guard throw. §5.1.
> **Intended path:** `Documentation/runs-hide-from-view-design-gate.md`
> **Companion:** `Documentation/runs-hide-from-view-peer-review.md` (review verbatim).
>
> **v2 changelog (Gemini integration — all 5 findings verified against code before applying):**
> - **MAJOR-1:** ownership gate switched from `resolveOrgForSlug` (queries `research_queue` → misses storage-only legacy runs) to `projectExists(orgId, slug)` (storage existence under caller's org prefix). §5.1/§5.2/§7.
> - **MAJOR-2:** unique key `(user_id, slug)` → `(user_id, organization_id, slug)` so a cross-org slug collision can't resurface a hidden run. §4.
> - **MINOR:** the no-slug `GET /api/state` "latest across all projects" summary must also apply the hidden filter (else a hidden latest-run leaks into the dashboard). §5.3.
> - **NIT:** RLS policies given `TO authenticated`; **NIT:** documented the `listProjects` 100-row cap interaction. §4/§5.3.
> - *Gemini ran on a fallback model (`gemini-3.1-pro-preview` was capacity-exhausted, HTTP 429). Findings are doc-grounded + code-verified, but a strong-model re-read is offered before final merge — see peer-review artifact.*

---

## 0. MRPF classification (HARD RULE — see `~/CLAUDE.md` §Multi-Reviewer Policy)

| Axis | Value | Why |
|---|---|---|
| **Event Gate** | **MERGE** (new feature) + DESIGN-gate doc for the subsystem | Adds a new table, 2 API routes, UI surface — a small new subsystem. |
| **Risk Labels** | **SECURITY**, **DATA**, **PRIVACY**, **ARCHITECTURE** | SECURITY = ownership/authz seam (who may hide what); DATA = new table + migration (but **additive, non-destructive**); PRIVACY = per-user view state; ARCHITECTURE = new storage-discovery↔DB-preference bridge. |
| **Severity Mode** | **NORMAL** | No production incident; no time pressure. |
| **Topology** | **Sequential Gemini → integrate → Codex** | Per DR CLAUDE.md §11. SECURITY label ⇒ **blocking gate**: a SECURITY-CRITICAL finding blocks merge until resolved-in-code OR signed risk-acceptance. |

**Mandatory test question (SECURITY/DATA/PRIVACY):** *Is this change covered by automated tests, and if not, why?* → **Yes** — see §8. RLS isolation, cross-org rejection, and filter correctness are all specified as tests before merge.

---

## 1. Problem statement & user intent

The user (org owner) wants to **remove completed/successful research runs from their on-screen gallery** — declutter the "Completed Runs" view — **without deleting anything from the database or storage**. Verbatim intent: *"actually remove from the screen all of the successful [runs]… if they own it. I do not want them deleted from the database. I just want the user to be able to control the user interface on what they see."*

**Restated as requirements:**
- **R1** — A user can hide a completed run from their gallery (per-item).
- **R2** — A user can hide *all* completed runs in one action (bulk).
- **R3** — Hiding is **soft**: DB rows, Storage objects, and `state.json` are untouched.
- **R4** — Hiding is **per-user view state** (controls only what *they* see), gated to runs they **own**.
- **R5** — Hiding is **reversible**: the user can view hidden runs and restore them.

---

## 2. Key finding that shapes the design — the gallery is STORAGE-driven

The "Completed Runs" list is **not** read from the `research_queue` table. [`frontend/app/api/runs/route.ts`](../frontend/app/api/runs/route.ts) lists project slugs out of **Supabase Storage** (`<org_id>/<slug>/`) via `listProjects(orgId)`, then reads each newest `state.json`. `research_queue` only feeds the **Active Pipelines** (pending/running) section.

**Consequences:**
1. Hide-state **cannot** be a column on `research_queue` — completed runs aren't queried from there. It must be a **separate per-user table keyed by `slug`** (the stable identifier shared by storage + queue).
2. The filter is **storage-list minus hidden-slug-set**, applied in `GET /api/runs`.
3. This *guarantees* R3: the hide subsystem touches neither Storage, `state.json`, nor `research_queue`. It is purely additive.

**Current ownership model (from code):** runs are owned by `organization_id`; a user belongs to exactly one org (`organization_members`, unique `user_id`). The runs route resolves org via `getOrgContextDualPath()` → `{ orgId, source: "session" | "env" }`. Storage tenant boundary is **path-based** (`scopedStoragePath(orgId, slug, file)`); Supabase Storage has no RLS. Service-role client (`frontend/lib/supabase.ts`) is used for storage/queue; anon+cookie client (`frontend/lib/supabase-server.ts`) is used for auth identity.

---

## 3. Design decisions (with rationale + alternatives)

### D1 — Per-user hide, NOT per-org *(recommended)*
Key the hidden table on `user_id`. A hide is a personal view preference; my hidden list ≠ a future teammate's. **Alternative (per-org):** one user hiding a run blanks it for the whole org — wrong for "what *they* see." Only correct if shared org views are explicitly wanted (they are not, per intent R4). Today, one-user-one-org makes the two nearly equivalent, but per-user is future-proof at zero extra cost.

### D2 — Separate `user_hidden_runs` table, keyed by `slug` *(recommended)*
Additive, non-destructive (satisfies R3 by construction), decoupled from the storage-driven gallery. **Alternative (column on `research_queue`):** rejected — gallery doesn't read that table; would also be global, violating D1.

### D3 — Server-side filtering in `GET /api/runs` *(recommended)*
Subtract the caller's hidden-slug set **before** returning. A hidden run never ships to the browser — cleaner, and privacy-respecting (no hidden data leaking into client state). **Alternative (client-side hide):** rejected — leaks hidden runs to the browser and breaks on refresh.

### D4 — Hide UI gated on a real session *(recommended)*
A per-user hide needs an authenticated `user_id`. The app is still dual-path (`source: "session" | "env"`); SSR-auth refactor is deferred (S53+). When `source === "env"` (no real user), **show no hide controls** (or disabled with a "sign in to manage your view" hint). No migration debt; matches "if they own it." **Alternative (org-level hide during env era, migrate later):** rejected — adds migration debt and a behavior change mid-feature.

### D5 — Reversibility is first-class (R5)
"Hide" pairs with a **"Show hidden / Archived" view** + **"Unhide."** Empty gallery after hiding all must read *"N runs hidden — Show hidden,"* never a blank screen. Language is reassuring ("Hidden, still saved — restore anytime"). This is the line between a *dismiss* and a *delete*; users won't trust the feature without it.

---

## 4. Data model — new migration

**File:** `supabase/migrations/20260605_user_hidden_runs.sql`
(underscore convention per CLAUDE.md §8; **no `BEGIN`/`COMMIT`, no `SET LOCAL`**; RLS enabled immediately.)

```sql
-- Per-user, per-run "hidden from my gallery view" markers.
-- Soft, non-destructive: never touches research_queue, Storage, or state.json.
CREATE TABLE public.user_hidden_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  hidden_at       timestamptz NOT NULL DEFAULT now(),
  -- org-scoped unique: a cross-org slug collision cannot resurface a hidden run (Gemini MAJOR-2).
  UNIQUE (user_id, organization_id, slug)
);

CREATE INDEX idx_user_hidden_runs_user_org
  ON public.user_hidden_runs (user_id, organization_id);

ALTER TABLE public.user_hidden_runs ENABLE ROW LEVEL SECURITY;

-- A user may only read/insert/delete their OWN hide rows, scoped to their org.
-- `TO authenticated` mirrors the existing tenant-perimeter policies in
-- 20260523_phase_b_auth_rls_helpers.sql (Gemini NIT).
CREATE POLICY uhr_select ON public.user_hidden_runs
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );
CREATE POLICY uhr_insert ON public.user_hidden_runs
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );
CREATE POLICY uhr_delete ON public.user_hidden_runs
  FOR DELETE TO authenticated USING (
    user_id = auth.uid()
    AND organization_id = (SELECT private.auth_user_organization_id())
  );
-- No UPDATE policy: hide rows are immutable (insert to hide, delete to unhide).
```

**Notes:**
- `slug` is `text`, not a FK to `research_queue.id` — the gallery is slug-keyed off storage, and a completed run may exist in storage without a live queue row.
- `UNIQUE (user_id, organization_id, slug)` makes `POST /hide` idempotent (upsert / on-conflict-do-nothing) and is org-scoped (MAJOR-2).
- `ON DELETE CASCADE` from `auth.users` and `organizations` keeps the table self-cleaning if a user or org is removed.
- RLS uses the existing `private.auth_user_organization_id()` helper (`20260523_phase_b_auth_rls_helpers.sql`).
- **Worker impact: none.** The worker daemon uses the service-role client (bypasses RLS) and never reads this table. No `conventions.json`/`conventions.ts` change ⇒ **no daemon restart required** (CLAUDE.md §7).

---

## 5. API surface

### 5.0 Client & auth selection (Codex MAJOR-A/B — foundational)
- **DB client for `user_hidden_runs`: MUST be the RLS-respecting `createServerSupabase()`** (anon key + auth cookie, `frontend/lib/supabase-server.ts`). The service-role `getSupabase()` (`frontend/lib/supabase.ts:25`) **bypasses RLS**, which would render the entire RLS backstop in §4 inert. Service-role is used **only** for Storage / `projectExists` (which has no RLS and is path-scoped). *(If a future constraint forces service-role on the table, every write/delete must hard-code `user_id = user.id AND organization_id = orgId` — but that forfeits defense-in-depth; not recommended.)*
- **Auth for hide/unhide WRITES: `requireOrgContext()` directly** (throws `ForbiddenError` on no-membership). Do **not** use `getOrgContextDualPath()` here — it falls back to `source:"env"` (the bootstrap org) on `ForbiddenError`, so a signed-in but membership-less user could write hide rows under the wrong org. Dual-path stays only on the backward-compatible **read/list** routes (`/api/runs`, no-slug `/api/state`), where hidden-filtering activates only when `source === "session"`.

### 5.1 `POST /api/runs/hide`
- **Body:** `{ "slug": "<slug>" }` **or** `{ "slugs": ["<s1>", "<s2>", ...] }` (bulk, R2).
- **Auth (per §5.0):** `requireOrgContext()` → 401 if no session, **403** if signed-in but no membership (never the env fallback). DB ops via `createServerSupabase()`.
- **Ownership gate (SECURITY) — storage existence, NOT the queue table:** each slug must exist in the caller's storage prefix. Use **`projectExists(orgId, slug)`** (`frontend/lib/storage.ts:248` — checks `listFiles(orgId, slug).length > 0` under `<orgId>/<slug>/`); reject absent slugs with **404** (skip them in bulk, returning a per-slug result). **Do NOT use `resolveOrgForSlug`** — it queries `research_queue`, which has no row for completed/legacy runs that live only in storage, so it would wrongly block hiding exactly the runs the gallery shows (Gemini MAJOR-1). Because `listFiles` is org-prefix-scoped, this gate *also* prevents cross-tenant slug-existence inference (a caller can only probe their own org). Belt-and-suspenders: RLS already pins `user_id = auth.uid()` so a user can *only ever* write their own rows.
- **Effect:** upsert `(user_id, organization_id, slug)` — `ON CONFLICT (user_id, organization_id, slug) DO NOTHING`.
- **Returns:** `200 { hidden: [...slugs], skipped: [{slug, reason}] }`.
- **Input validation (Codex MINOR-E):** a **shared zod body schema** validates slugs *before* any storage call — `string, min 1, max ~120, no `/` `\` `..``; array length capped ≤ 500. Invalid entries → **400** (single) or skipped-with-reason (bulk). Without this, a malformed slug reaching `projectExists`→`scopedStoragePath` would **throw a 500** (the guard throws, `storage-paths.ts:36`).

### 5.2 `DELETE /api/runs/hide`  *(unhide — R5)*
- **Body:** `{ "slug" }` or `{ "slugs": [...] }`.
- **Auth:** requires a real session (`requireUser()`); 401 on `source === "env"`.
- **Ownership:** RLS already restricts the DELETE to the caller's own rows (`user_id = auth.uid()`), so **no `projectExists` check is needed** here — and omitting it lets a user clean up a hidden row even if the underlying run was later removed from storage (avoids orphaned hidden rows).
- **Effect:** `DELETE ... WHERE user_id = auth.uid() AND organization_id = (current org) AND slug = ANY($slugs)`.
- **Returns:** `200 { unhidden: [...] }`.

### 5.3 `GET /api/runs` — modified (response is now an ENVELOPE — Codex MAJOR-C/MINOR-D)
- **Breaking shape change:** returns `{ runs: RunSummary[], hiddenCount: number, auth: boolean }` instead of a bare `RunSummary[]`. `auth = (source === "session")` moves into the **body** (today it's only in the `X-Org-Source` header, which the page fetcher discards). The SWR type + fetcher in `frontend/app/page.tsx` update accordingly.
- Default: after `listProjects(orgId)`, fetch the caller's hidden-slug set and **exclude** those slugs before building summaries; `hiddenCount` = how many were excluded (drives the "Show hidden (N)" affordance + the non-blank empty-state).
- **`?show_hidden=1`:** include hidden runs, each annotated `hidden: true` for the "Unhide" affordance / "Archived" section. SWR key includes the param so the two views cache separately.
- When `source === "env"` (no user): `hiddenCount: 0, auth: false`, no filtering → behaves exactly as today. Fully backward-compatible at the data level (only the envelope wrapper changes; update the one consumer).

**Efficiency:** the hidden-slug set is one indexed query (`WHERE user_id = $uid`) returning `slug[]`; filtering is an in-memory `Set.has()` over the already-listed slugs. No N+1.

### 5.4 `GET /api/state` (no-slug "latest" path) — also filtered (Gemini MINOR)
`GET /api/state` without a slug returns "the most recent state.json across all projects" (`frontend/app/api/state/route.ts:5`, loop at :155). If a user hides their newest run, it must **not** still surface in that dashboard summary. Apply the same hidden-slug filter to the slug list before computing the newest. Same env-fallback no-op + session gating as `/api/runs`. (The *with-slug* `GET /api/state?slug=` and `runs/[slug]/...` direct-link routes are **NOT** filtered — a hidden run is still directly reachable by URL; hiding controls the *listing*, not access.)

### 5.5 Known interaction — `listProjects` 100-row cap (Gemini NIT)
`listProjects(orgId)` (`frontend/lib/storage.ts:107`) returns at most one Supabase Storage `.list()` page (default 100). Subtracting hidden slugs from a capped page means a user who hides many runs could see a short/empty gallery while more un-hidden runs exist beyond the cap. Pre-existing limitation, mildly exacerbated. **Resolution for implementation:** either (a) page `listProjects` to fetch the full set before filtering, or (b) raise the cap to ~500 with a documented ceiling. Decide at build time; not a blocker for the design.

---

## 6. UI changes — `frontend/app/page.tsx` (+ small components)

- **Per-card hide (R1):** an unobtrusive control on each Completed-Run card (hover-revealed `×` or a `⋯` menu with "Hide from my view"). Optimistic `SWR mutate` → `POST /api/runs/hide`.
- **Bulk hide (R2):** a "Hide all completed" action in the Completed-Runs section header. **Confirm dialog** ("Hide all N completed runs? They stay saved and can be restored from *Show hidden*.") — bulk only; single hides are unconfirmed (reversible, low-cost).
- **Archived view (R5):** a "Show hidden (N)" toggle → refetch `?show_hidden=1`, render hidden runs in a visually-distinct "Hidden" section, each with **"Unhide."**
- **Empty-state guard (D5):** the `runs.length === 0` "No Research Found" branch (`page.tsx:89-93,117-130`) must check `hiddenCount` first — if `hiddenCount > 0`, show *"N runs hidden — Show hidden,"* never the blank "No Research Found" (Codex MAJOR-C).
- **Auth-gating (D4):** hide controls render only when `envelope.auth === true` (from the body, per §5.3) — not the discarded header; otherwise hidden / disabled with a hint.
- **Accessibility:** controls are real `<button>`s with `aria-label`s; confirm dialog is focus-trapped; reassuring, non-destructive copy throughout ("Hide," never "Delete").

---

## 7. Security & privacy analysis

**Threat model — what bad outcome are we preventing?**
- **Cross-tenant hide / slug enumeration:** a user crafting `POST /hide` with another org's slug. *Mitigation (v2):* RLS pins writes to `user_id = auth.uid()` + `organization_id = caller's org`; the API ownership gate is now **`projectExists(orgId, slug)`** — a storage-existence check scoped to the caller's own `<orgId>/` prefix, so a cross-org slug simply 404s and the caller learns nothing about whether it exists in another tenant. Blast radius even without the gate is low (a user can only ever affect their *own* view). Note the v1 `resolveOrgForSlug` gate was **rejected** (MAJOR-1): it queries `research_queue` and would block hiding legitimate storage-only runs.
- **Hidden data leakage to the browser:** server-side filtering (D3) means hidden runs never reach the client. No client-side hidden cache.
- **RLS-backstop actually engaged (Codex MAJOR-A):** the table-level RLS in §4 only enforces at runtime if the route uses the **anon+cookie `createServerSupabase()`** client. Using the service-role `getSupabase()` would silently bypass every policy. §5.0 mandates the RLS-respecting client for `user_hidden_runs`; service-role is confined to Storage/`projectExists`. This is the single most important implementation invariant — a test asserts cross-user isolation under the real client (§8.1).
- **No new destructive surface:** the feature has **no DELETE against `research_queue`, Storage, or `state.json`**. `DELETE /api/runs/hide` deletes only the caller's own marker rows. This is the strongest argument that the DATA label is low-severity.
- **Input validation:** slugs sanitized (path-traversal guard reused) and bulk arrays length-capped.
- **Auth dependency:** the feature requires the session path; it does **not** extend the 6 SSR-auth stopgaps — it only *reads* identity through the existing `requireUser()`/`requireOrgContext()`. Document this as an explicit dependency, not a new stopgap.

**Privacy:** the table stores `(user_id, org_id, slug, hidden_at)` — view preferences, no PII beyond the user UUID already in `auth.users`. RLS-isolated per user. Cascade-deletes on user/org removal. No analytics emission.

---

## 8. Testing plan (answers the mandatory SECURITY/DATA/PRIVACY test question)

`node --test` (NOT vitest), per CLAUDE.md §2. New tests:
1. **RLS isolation under the real client (Codex MAJOR-A)** — using `createServerSupabase()` (anon+cookie), user A cannot `SELECT`/`DELETE` user B's hide rows; assert the route does NOT use service-role for these ops (a service-role query would see all rows — the test pins the correct client).
2. **Cross-org / no-membership rejection** — `POST /api/runs/hide` with a slug not in the caller's storage prefix → 404, no row written; signed-in-but-no-membership → 403 (never an env-fallback write — Codex MAJOR-B).
2b. **Envelope shape (Codex MAJOR-C)** — `GET /api/runs` returns `{ runs, hiddenCount, auth }`; when all runs hidden, `runs:[]` + `hiddenCount>0` so the UI shows "N hidden" not "No Research Found"; malformed slug body → 400 not 500 (MINOR-E).
3. **Filter correctness** — a hidden slug is absent from `GET /api/runs`; present (annotated `hidden:true`) under `?show_hidden=1`.
4. **Idempotency** — double `POST /hide` of the same slug → single row, 200 both times.
5. **Unhide round-trip** — hide → absent; unhide → reappears.
6. **Env-fallback no-op** — with `source === "env"`, `GET /api/runs` is unfiltered and hide endpoints 401.
7. **Migration hygiene** — filename underscore; no `BEGIN`/`COMMIT`/`SET LOCAL`; RLS enabled; applies cleanly via `supabase db push` on a scratch branch.
8. **Storage-path guard unaffected** — existing `test-phase-b-storage-paths.sh` still PASS; both tsc clean.

---

## 9. Rollout / phasing

1. **Migration** — author + `supabase db push` (RLS-enabled at creation; additive, non-destructive; instantly reversible by `DROP TABLE` since no data depends on it).
2. **API** — `hide`/`unhide` routes + `GET /api/runs` filter (sandbox → /promote).
3. **UI** — per-card + bulk + archived view (sandbox → /promote).
4. **Tests** — land with the code; `pnpm test` GREEN gate.
5. **No daemon restart** (no `conventions` change). **No env vars.** Vercel auto-deploys `frontend/` on push.

**Reversibility of the whole feature:** `DROP TABLE public.user_hidden_runs` + revert the route/UI commits. Because nothing else references the table and no real data lives in it, rollback is clean.

---

## 10. Open questions for the reviewers

- **Q1 (D1):** Confirm per-**user** hide (vs per-org). Recommendation: per-user. Reviewers: any reason an org-owner would want a *shared* hidden view?
- **Q2 (D4):** Confirm gating hide UI on a real session (env-fallback shows no controls) vs a stopgap org-level hide. Recommendation: session-gated.
- **Q3 (ownership gate)** — *Gemini-resolved:* keep the gate for defense-in-depth + inference-prevention, but switch it from `resolveOrgForSlug` to **`projectExists`** (storage existence) so legacy storage-only runs remain hideable (MAJOR-1). Applied in v2.
- **Q4:** Should bulk-hide be capped lower than 500, or paginated? *Gemini: 500 is appropriate* — bounds the request, covers all realistic gallery sizes. Still open for the user if they prefer tighter.
- **Q5 (other consumers)** — *Gemini-resolved:* the only other consumer needing the filter is the no-slug `GET /api/state` "latest" summary (added §5.4). Direct-link `GET /api/state?slug=` and `runs/[slug]/...` must **not** be filtered (hiding controls listing, not access). **Codex to verify** no SWR key / prefetch path assumes an unfiltered `/api/runs`.

---

## 11. Out of scope (explicit)

- **Hard delete** of runs (DB/storage purge) — the user explicitly does NOT want this.
- **Archiving Active Pipelines** (pending/running queue rows) — this feature targets *completed* runs only.
- **The SSR-auth refactor** — this feature depends on the existing auth path but does not advance or extend it.
- **Org-shared / team views** — per-user only for v1.
