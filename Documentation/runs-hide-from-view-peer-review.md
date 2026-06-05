# Per-User "Hide From My View" — MERGE-gate Peer Review (verbatim + synthesis)

> **Intended path:** `Documentation/runs-hide-from-view-peer-review.md`
> Companion to `Documentation/runs-hide-from-view-design-gate.md` (v3).
> Session: S92 (2026-06-05). Topology: **sequential Gemini → integrate → Codex** (DR CLAUDE.md §11).

---

## MRPF classification
**MERGE gate × SECURITY + DATA + PRIVACY + ARCHITECTURE × NORMAL** → mandatory sequential Gemini→Codex; SECURITY label ⇒ blocking gate (a SECURITY-CRITICAL finding blocks merge until resolved-in-code or signed risk-acceptance).

## What each reviewer saw
- **Gemini (holistic, reviewer 1):** the **full v1 design doc embedded inline** in the prompt + directed to read the tracked code files (`runs/route.ts`, `auth.ts`, `storage.ts`, `storage-paths.ts`, `page.tsx`, the two RLS migrations). **Ran on a FALLBACK model** — `gemini-3.1-pro-preview` returned HTTP 429 `RESOURCE_EXHAUSTED` (capacity) on all 3 attempts; the CLI degraded to a lighter model. A *first* attempt also failed to read the doc (sandbox is gitignored; Gemini's file tool honors ignore patterns) and reviewed a strawman — **discarded**; the inline-doc re-run is the one captured here.
- **Codex (grounded, reviewer 2):** the **integrated v2 doc inline** + read the ACTUAL repo files in its read-only sandbox (cited real line numbers throughout). Model **gpt-5.5, xhigh reasoning**, sandbox=read-only.

## Outcome
Both reviewers: **APPROVE_WITH_CHANGES. No SECURITY-CRITICAL finding.** → merge is **not blocked**, conditional on the integrated changes (all applied in doc v3). Gemini's 2 MAJORs + Codex's 3 MAJORs are functional/correctness + implementation-fidelity, not RLS/tenant-boundary breaches.

---

## Synthesis — findings → resolution

| # | Reviewer | Sev | Finding | Resolution (doc section) |
|---|---|---|---|---|
| G1 | Gemini | MAJOR | Ownership gate via `resolveOrgForSlug` queries `research_queue` → blocks hiding storage-only legacy runs the gallery shows | **Applied** — gate switched to `projectExists(orgId, slug)` (storage existence). §5.1/§5.2/§7 |
| G2 | Gemini | MAJOR | `UNIQUE(user_id, slug)` lets a cross-org slug collision resurface a hidden run | **Applied** — `UNIQUE(user_id, organization_id, slug)` + matching `ON CONFLICT`. §4 |
| G3 | Gemini | MINOR | No-slug `GET /api/state` "latest" summary not filtered → hidden latest run leaks to dashboard | **Applied** — §5.4 filters that path too |
| G4 | Gemini | NIT | `listProjects` 100-row cap interacts with hiding (short gallery) | **Applied** — §5.5 documents + offers paginate/raise-cap at build |
| G5 | Gemini | NIT | RLS policies lack `TO authenticated` | **Applied** — added to all 3 policies. §4 |
| C1 | Codex | **MAJOR** | `getSupabase()` is **service-role → bypasses RLS**; the RLS backstop is inert if the route uses it | **Applied** — §5.0 mandates `createServerSupabase()` for `user_hidden_runs`; service-role only for Storage. §7 + test §8.1 |
| C2 | Codex | MAJOR | `getOrgContextDualPath()` falls back to `source:"env"` on `ForbiddenError` → membership-less user writes under bootstrap org | **Applied** — §5.0/§5.1: hide writes use `requireOrgContext()` directly |
| C3 | Codex | MAJOR | SWR consumer assumes bare `RunSummary[]`; empty-state shows "No Research Found" instead of "N hidden" | **Applied** — §5.3 envelope `{runs, hiddenCount, auth}`; §6 empty-state checks `hiddenCount` |
| C4 | Codex | MINOR | Auth source only in `X-Org-Source` header (fetcher discards) → UI can't auth-gate | **Applied** — `auth` flag in envelope body. §5.3/§6 |
| C5 | Codex | MINOR | Malformed slug → 500 (storage-path guard throws) | **Applied** — shared zod body schema → 400/skip. §5.1 |

**Codex verified (no change needed):** `projectExists` is the correct gate; no-slug `/api/state` does need filtering; `private.auth_user_organization_id()` (SECURITY DEFINER, granted to `authenticated`) composes correctly with the proposed policies and Phase B-2 RLS; `gen_random_uuid()` already supported (`pgcrypto` created in Phase A migration).

---

## Residual / for the human owner
1. **Model-degradation caveat:** the holistic (Gemini) pass ran on a fallback model due to `gemini-3.1-pro-preview` capacity exhaustion. Findings are doc-grounded + code-verified and corroborated by Codex's independent grounded pass, so confidence is high — but if any decision below is contentious, a strong-model Gemini re-read is cheap insurance before merge.
2. **Open user decisions (design §10):** Q1 per-user (both reviewers concur) · Q2 session-gated (concur) · Q4 bulk cap 500 (Gemini ok; user may tighten).
3. No SECURITY-CRITICAL ⇒ no signed risk-acceptance line required.

---

## Verbatim — Gemini (holistic, reviewer 1; fallback model)

> ### Findings
>
> | SEVERITY | LOCATION | PROBLEM | CONCRETE FIX |
> | :--- | :--- | :--- | :--- |
> | **MAJOR** | Section 5.1 (POST /api/runs/hide) | **Gate Mismatch.** The ownership gate uses `resolveOrgForSlug(slug)`, which only queries the `research_queue` table. This will return `null` and block the "hide" action for "legacy" runs that exist only in Storage (whose queue rows were deleted or never existed), even though the gallery displays them. | Use `projectExists(orgId, slug)` from `lib/storage.ts` to verify ownership via storage existence, aligning with the gallery's discovery logic. |
> | **MAJOR** | Section 4 (Data Model) | **Constraint Conflict.** `UNIQUE (user_id, slug)` prevents a user from hiding the same slug name in a different organization (e.g., if a user moves orgs or if slugs collide across tenants). The `ON CONFLICT DO NOTHING` logic will keep the old `organization_id`, causing the RLS policy to filter the row out in the new org, rendering the run visible. | Change the constraint to `UNIQUE (user_id, organization_id, slug)` to allow per-tenant hidden states for the same user. |
> | **MINOR** | Section 5.3 & Section 10 Q5 | **Dashboard Inconsistency.** `GET /api/state` (without a slug) returns the "Latest Research" summary for the dashboard. If a user hides their most recent run, it will still appear in this dashboard summary, violating the "remove from screen" intent. | Apply the hidden-slug filter in `GET /api/state` when calculating the "Latest across all projects" summary. |
> | **NIT** | Section 5.3 (GET /api/runs) | **Paging Limitation.** `listProjects` is capped at 100 slugs. If a user hides 100 runs, the gallery will appear empty even if more runs exist in storage. This is a pre-existing limitation but is exacerbated by the "Hide" feature. | Document this limitation or consider increasing the `listProjects` limit to 200-500. |
> | **NIT** | Section 4 (Migration) | **Policy Specificity.** RLS policies lack the `TO authenticated` clause found in existing tenant-perimeter migrations. | Add `TO authenticated` to `uhr_select`, `uhr_insert`, and `uhr_delete`. |
>
> ### Responses to Open Questions
> - **Q1:** Per-user is correct (personal cleanup; org-wide archive is a separate feature).
> - **Q2:** Session-gated is correct (avoid new env-fallback stopgaps; aligns with S53+ retiring that path).
> - **Q3:** Round-trip worth it for defense-in-depth + junk-row prevention, but switch to `projectExists` (Storage) to support legacy runs.
> - **Q4:** 500 is appropriate.
> - **Q5:** Only `GET /api/state` (latest path) requires filtering. `runs/[slug]/...` direct-link routes should NOT be filtered.
>
> ### OVERALL VERDICT: APPROVE_WITH_CHANGES
> **Any security-critical finding? NO.** (MAJORs are functional/logic bugs — they block utility for legacy runs / cause incorrect state during org-migration — but do not expose data or bypass RLS.)

---

## Verbatim — Codex (grounded, reviewer 2; gpt-5.5 xhigh, read-only sandbox)

> **Findings**
>
> MAJOR | frontend/lib/supabase.ts:25 | `getSupabase()` is service-role and bypasses RLS. The v2 design repeatedly relies on `user_hidden_runs` RLS as a backstop, but current repo patterns use service-role for route DB writes. If hide/unhide routes use this client, the proposed RLS policies will not enforce `auth.uid()` at runtime. | Use `createServerSupabase()` for all `user_hidden_runs` SELECT/INSERT/DELETE operations, and reserve `getSupabase()` for Storage/project existence. Alternatively, if service-role is used, the route must use `requireOrgContext()` and hard-code `user_id = user.id` plus `organization_id = orgId` in every write/delete, but that loses RLS defense-in-depth.
>
> MAJOR | frontend/lib/auth.ts:98 | `getOrgContextDualPath()` falls back to env on `ForbiddenError` as well as no session. That is correct for existing read/list routes, but wrong for per-user hide writes if used after `requireUser()`: a signed-in user with no membership can reach `source: "env"` unless the route explicitly rejects it. | Hide/unhide should use `requireOrgContext()` directly. For `GET /api/runs` and no-slug `GET /api/state`, keep dual-path only for backward-compatible listing, with hidden filtering enabled only when `source === "session"`.
>
> MAJOR | frontend/app/page.tsx:81 | The dashboard SWR consumer assumes `/api/runs` returns a bare `RunSummary[]`; `isEmpty` also treats `runs.length === 0` as "No Research Found" at lines 89-93 and renders that copy at 117-130. If all runs are hidden, this will violate the design's "N runs hidden - Show hidden" requirement unless the API/UI response shape changes. | Return an envelope such as `{ runs, hiddenCount, auth }` or add a separate hidden-count fetch, update the SWR type/fetcher, and make the SWR key include `?show_hidden=1` when archived view is active.
>
> MINOR | frontend/app/api/runs/route.ts:84 | Current `/api/runs` returns only JSON body; `X-Org-Source` is in a header. The page fetcher at page.tsx:38 discards headers, so the UI cannot auth-gate hide controls from the existing response. | Put `auth: source === "session"` or `source` in the JSON envelope, not only the header.
>
> MINOR | frontend/lib/storage-paths.ts:36 | The storage slug guard is sufficient for traversal (`/`, `\`, `..`) and `projectExists()` will enforce it via `listFiles()`, but it throws. A malformed hide body could become a 500 if the new route only calls `projectExists()` and does not pre-validate/catch. | Add a shared body schema for hide/unhide slugs: string, non-empty, max length, no `/`, `\`, `..`; cap arrays at 500; return 400/skipped for invalid entries.
>
> **Verified Points**
> - `projectExists(orgId, slug)` is the right ownership gate: storage.ts:248 calls `listFiles(orgId, slug)` under `scopedStoragePath(orgId, slug)` (storage.ts:153). `resolveOrgForSlug()` is not equivalent — it queries `research_queue.topic_slug` (storage.ts:73).
> - The no-slug `/api/state` path does need the hidden filter: lists all projects at state/route.ts:136 and selects newest across them at 155-168.
> - The RLS helper composes correctly: `private.auth_user_organization_id()` uses `auth.uid()` under `SECURITY DEFINER` (20260523…sql:157), execution granted to `authenticated` (lines 521-525); Phase B-2 enables RLS at 20260602…sql:121.
> - `gen_random_uuid()` is already supported: Phase A creates `pgcrypto` (20260522…sql:70).
>
> **Overall Verdict:** APPROVE_WITH_CHANGES. No SECURITY-CRITICAL finding exists.
