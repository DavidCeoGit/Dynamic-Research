# Phase B Implementation Plan — Peer Review Synthesis (S48)

**Date:** 2026-05-23
**Trigger:** Multi-Reviewer Policy Framework HARD RULE in `~/CLAUDE.md` — DESIGN gate, parallel topology (Gemini + Codex independent reads).
**Reviewers:**
- **Gemini 3.5 Flash + Deep Think** (web app, manual paste) — see `sandbox/gemini-review-phase-b-plan.md`
- **Codex GPT-5.5 + xhigh reasoning** (`codex exec`, detached headless, CODE-GROUNDED slot) — see `sandbox/codex-review-phase-b-plan.md` + raw output at `-raw.md`
- **Claude Opus 4.7 (1M)** — plan author, v1 in `Documentation/multi-tenancy-phase-b-plan.md`

**Status:** SYNTHESIS COMPLETE. Resolved direction below. v2 of the plan to be drafted from this synthesis, then submitted to Codex (sequential QA) per v2.1 framework rule for revision-state DESIGN review.

**What each reviewer saw:**
- **Gemini:** the Phase B plan (v1) only, with cover-note context briefing. No repo access.
- **Codex:** the Phase B plan (v1) + read live repo files (`supabase/migrations/20260522_phase_a_multi_tenancy.sql`, `frontend/lib/supabase.ts`, `frontend/app/api/queue/route.ts`, `agent/executor.ts`, `agent/types.ts`, `frontend/package.json`) + Supabase platform docs + PostgreSQL docs + Next.js 16 docs. **Codex independently grounded its critique against the actual checked-in code, which surfaced several CRITICAL findings — wrong table name, stale route paths, nonexistent files — that Gemini structurally cannot catch from the paste alone.**

**Counts:** Codex emitted 4 Critical + 8 Major + 6 Minor + 6 code-grounded findings + 5 within-artifact-blindspot occurrences. Gemini emitted 2 Critical + 2 Major + 2 Minor + 3 within-artifact-blindspot occurrences. Per v2.1 rule, the more findings-heavy reviewer (Codex) holds the v2 sequential QA slot.

---

## 1. Agreement Matrix (sorted by weight)

### 1.1 High weight — both reviewers raised (CRITICAL or MAJOR)

| Decision | Concern | Gemini | Codex | Resolution |
|---|---|---|---|---|
| **B1 — `LIMIT 1` in `auth_user_organization_id()` is unsafe** | If single-org invariant breaks (2 memberships exist), helper returns a non-deterministic row, silently picking one org. Gemini: drop LIMIT 1 entirely to force cardinality violation. Codex: add `UNIQUE (user_id)` constraint to org_members AND make helper fail closed unless exactly one membership. | CRITICAL §2.2.1 | MAJOR M1 | **ACCEPT Codex's stronger fix (both layers).** Phase A schema does NOT have `UNIQUE(user_id)` on `organization_members` (verified: migration line 92 shows composite PK on `(organization_id, user_id)`, not `(user_id)` alone — a user can be in N orgs per the schema). v2 must: (1) ALTER TABLE to add `UNIQUE (user_id)` on org_members as the FIRST step of Phase B-1 (DB invariant), (2) keep the helper without `LIMIT 1` so cardinality violation fires if the constraint is ever dropped, (3) test it explicitly. **Defense-in-depth: schema + helper semantics + test, not just one.** |
| **B2 — `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` rollback is not safe under traffic** | Statement takes ACCESS EXCLUSIVE lock; queues behind long-running queries; cannot promise "within seconds." | MAJOR §5 (proposes permissive USING(true) alternative) | MAJOR M6 (proposes lock_timeout + blocker detection + app kill switch) | **ACCEPT both, layered.** v2 rollback plan: (1) deploy a permissive-policy migration (`USING (true) WITH CHECK (true)`) as the FAST path — `ShareUpdateExclusiveLock` only, doesn't queue behind selects; (2) keep the literal `DISABLE` variant as the SLOW fallback for use only after app-kill-switch shuts off user traffic; (3) wrap rollback migration with `SET lock_timeout = '5s'` and `SET statement_timeout = '15s'` so a failure is fast and noisy, not a silent hang; (4) document an explicit blocker-detection runbook: `SELECT pg_blocking_pids(...), age(...) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`. |
| **B3 — Test grid is incomplete across tables × verbs** | Tracking tables (org_members, org_invitations, organizations) only tested for SELECT; INSERT/UPDATE/DELETE bypass vectors not covered. Within-artifact-blindspot recurrence. | Within-artifact-blindspot sweep §6.2 R5/R6/orgs | MAJOR M7 + within-artifact-blindspot sweep | **ACCEPT.** v2 §6 must expand the test grid to a full matrix: every tenant-scoped table (4 of them) × every RLS-relevant verb (SELECT/INSERT/UPDATE/DELETE) × every bypass vector (direct REST, Next API, service-role grep, signed URL, agent X-Agent-Key, old-path). Codex's M7 expanded list is the v2 test surface. |
| **B4 — Default value `research_queue.organization_id` should be dropped, but TIMING matters** | Gemini: drop in Phase B-2. Codex: drop in B-2 only AFTER all user-facing inserts explicitly set org_id AND a preflight proves zero rows would default. | Q2 (drop in B-2) | Q2 (drop in B-2 after preflight + explicit inserts everywhere) | **ACCEPT Codex's stricter sequencing.** v2: drop the DEFAULT in B-2 migration as a separate, last statement, preceded by an assertion that no user-facing insert path elides `organization_id`. Preflight test: `SELECT count(*) FROM research_queue WHERE organization_id = '<default-org>' AND created_at > '<phase-b-frontend-deploy-time>'` should return 0. |

### 1.2 Codex-only CRITICAL findings (code-grounded — Gemini structurally could not catch these)

| # | Concern | Codex finding | Resolution |
|---|---|---|---|
| **CG1** | **Wrong table name.** Plan uses `organization_invites`; Phase A migration creates `organization_invitations` (plural, full word). SQL would fail on first apply. | CRITICAL C1, cited migration line 105 | **ACCEPT — global find/replace.** v2 uses `organization_invitations` everywhere. Verified: `grep "CREATE TABLE.*organization" supabase/migrations/20260522_phase_a_multi_tenancy.sql` returns `organization_invitations`. |
| **CG2** | **Stale frontend route.** §2.7 references `/research-compare` form; actual route is `frontend/app/new/`. No such route as `research-compare` exists. | CRITICAL C2 + code-grounded #1 | **ACCEPT — replace route names throughout.** v2 §2.7 uses `/new` as the form route, `/api/queue/route.ts` for the insert endpoint. Verified: `frontend/app/new` exists; `frontend/app/research-compare` does not. |
| **CG3** | **Worker storage invariant references nonexistent file.** Plan asserts a single `agent/lib/upload-to-supabase.ts` helper; that file does not exist. Actual storage writes happen in `agent/executor.ts:835`, `agent/scripts/finalize-recovered-run.ts:135`, `agent/scripts/regenerate-studio-products.ts:555`. | CRITICAL C3 + code-grounded #3 | **ACCEPT — rewrite §2.5 to enumerate the REAL call sites.** v2 §2.5: (1) create NEW `agent/lib/storage-paths.ts` exporting `scopedStoragePath(orgId, ...)` as the single source of truth; (2) refactor the THREE actual storage-write call sites (`executor.ts`, `finalize-recovered-run.ts`, `regenerate-studio-products.ts`) to use the helper; (3) add a build-time grep test in `agent/scripts/test-phase-b-storage-paths.sh` that fails CI if any storage write call site bypasses the helper. Verified: `ls agent/lib/` shows `__pycache__/`, `conventions.{json,py,ts}`, `notify.ts`, `workflow-conventions.ts` — no upload helper exists yet. |
| **CG4** | **Signed-URL test model is wrong.** Plan asserts "leaked signed URL returns 403"; signed URLs are time-limited bearer tokens — once created, RLS does NOT gate them. Service-role keys bypass Storage RLS entirely. | CRITICAL C4 | **ACCEPT.** v2 §6.3 reframes the storage RLS tests: (1) test that a cross-tenant user cannot CREATE a signed URL for another org's object via the authenticated client (RLS on create); (2) keep signed-URL expiries short (default ≤5 min); (3) explicit test: any service-role user-facing route that signs old flat paths is a security defect; grep for these in v2 §6.4. |
| **CG5** | **Plan assumes `middleware.ts` + `anon key + JWT cookie` posture, but Next.js 16.2.3 + actual codebase cannot support this without adding deps.** Next 16 renames `middleware.ts` → `proxy.ts`; project does not have `@supabase/ssr` installed. | MAJOR M4 | **ACCEPT.** v2 §2.7 + §2.1: (1) install `@supabase/ssr` as Phase B prereq; (2) all file-conventions references to `middleware.ts` updated to `proxy.ts`; (3) define the SSR-cookie-aware Supabase client pattern explicitly with code template. Verified: `package.json` shows `"next": "16.2.3"`, no `@supabase/ssr` dep. |
| **CG6** | **`om_*` self-referential subqueries should be a SECURITY DEFINER helper.** Plan inlines `EXISTS (SELECT 1 FROM organization_members om WHERE …)` in policy bodies. Recursion risk is low (Postgres skips RLS on the recursing call site by default) but the pattern is fragile and policy-order-dependent. | MAJOR M2 | **ACCEPT.** v2 §2.3.2: replace inline EXISTS subqueries with a new SECURITY DEFINER helper `private.auth_user_is_org_owner(target_org_id uuid) RETURNS bool` (in `private` schema per CG7 below). All `om_insert/update/delete` policies call this helper. |
| **CG7** | **SECURITY DEFINER helper should live in `private`, not `public`.** Supabase recommends security-definer helpers in `private`/`app_private` to minimize exposed-schema surface area. | MAJOR M3 | **ACCEPT.** v2 §2.2.1: move `auth_user_organization_id()` to `private` schema. Create `CREATE SCHEMA IF NOT EXISTS private` as a Phase B-1 first statement. REVOKE ALL ON SCHEMA private FROM PUBLIC; GRANT USAGE ON SCHEMA private TO authenticated. Helper grants execute explicitly. RLS policies call `(select private.auth_user_organization_id())` (with the parens-and-select wrap per Supabase's documented performance optimization — see Codex m1 below). |
| **CG8** | **Storage migration COPY-by-slug is ambiguous if `topic_slug` is org-scoped.** Phase A made `topic_slug` UNIQUE WITHIN ORG; copying from `<topic_slug>/...` to `<org_uuid>/<topic_slug>/...` cannot resolve duplicates across orgs from slug alone. | MAJOR M5 | **ACCEPT.** v2 §2.4.3: storage migration COPY mapping is driven by `research_queue.id` → resolves to `(organization_id, topic_slug)` tuple → drives source-path discovery + target-path construction. Never copy by slug alone. Write the migration as a query-and-copy script, not a path-walk script. |
| **CG9** | **No DB-level fence for immutable `research_queue.organization_id`.** Service-role code (worker, API routes) can still mutate tenant ownership after RLS is enabled. RLS doesn't catch service-role writes. | MAJOR M8 | **ACCEPT.** v2 adds a Phase B-1 trigger: `BEFORE UPDATE ON research_queue` for `OLD.organization_id IS DISTINCT FROM NEW.organization_id` → RAISE EXCEPTION unless `current_setting('app.allow_org_migration', true) = 'true'` (a session-scoped escape hatch reserved for explicit admin tenancy migration tooling, never set in worker or user-facing routes). |
| **CG10** | **`agent/worker.ts` doesn't directly hold service-role key; it calls Next API routes via `X-Agent-Key`.** Plan's topology description is wrong; worker is an HTTP client of the Next backend, not a direct Supabase service-role consumer. | Code-grounded #6 | **ACCEPT — rewrite §2.5 topology section.** v2 §2.5 describes the actual architecture: worker uses an `X-Agent-Key` shared-secret to call Next API routes (`/api/queue`, `/api/state/*`, etc.); the API routes use service-role server-side. The Phase B fence must be on the **API routes**, not the worker process. Specifically: every Next API route under `/api/` that takes `organization_id` from the request must validate against the JWT session's resolved org_id (or, for the worker's X-Agent-Key calls, accept and pass through the org_id from the queue payload). |

### 1.3 Gemini-only findings (Codex covered some via different framing)

| # | Concern | Gemini finding | Resolution |
|---|---|---|---|
| **G1** | **Storage path fallback creates data-resurrection vulnerability during 30-day window.** If an object is "deleted" by the user but still exists at the legacy flat path, reactive fallback reads resurrect it. | CRITICAL §2.8 step 3 + §2.4.3 | **ACCEPT.** v2 §2.4.3: storage migration is one-way COPY only; readers MUST NOT fall back to legacy paths after cutover. Sequence: (1) COPY all objects to org-prefixed paths; (2) verify checksums; (3) update DB references to point at new paths atomically per project; (4) reader code reads ONLY new paths after cutover (no fallback); (5) after 30-day soak, delete old flat-path objects via a separate cleanup script. NO reactive fallback at any point. |
| **G2** | **`organizations` SELECT-only policy locks out future org rename UI.** Owner UPDATE not provided; future "rename my workspace" UI cannot work via authenticated client. | MAJOR §2.3.4 | **ACCEPT.** v2 §2.3.4 adds `orgs_update` policy for owners (using the new `private.auth_user_is_org_owner()` helper from CG6). DELETE remains service-role-only per Codex Q8. |
| **G3** | **Middleware in-memory org_id cache lacks mid-session revocation.** If user's membership is revoked while their JWT cookie is still valid, the cached resolution leaks access until expiry. | MINOR §2.1 | **ACCEPT (graduate to MAJOR).** v2 §2.7 + §2.1: the per-request org_id resolution does NOT cache across requests. Resolved fresh from `private.auth_user_organization_id()` on each authenticated request (the helper is `STABLE`, so within-request it's free; across requests it must re-evaluate). Cached membership lookups are a footgun. Drop the cache language from v1; document explicitly that the resolution is per-request. |
| **G4 (synthesis-level)** | **Defense-in-depth: SET LOCAL session var + worker trigger pattern.** Even with service-role bypass, DB engine could enforce org-context via a session variable + per-table trigger that checks `current_setting('app.current_worker_org_id', true)` matches the row being written. | Synthesis-level concern | **PARTIAL ACCEPT — adopt for storage writes via X-Agent-Key route fences instead.** Codex CG9 (immutable org_id trigger) covers UPDATE of org_id directly. Gemini's broader pattern (SET LOCAL session var on every worker request) is heavier and not needed in v1 — the Next API routes are the actual choke point (per Codex CG10), and they can validate JWT or X-Agent-Key + payload org_id before reaching Supabase. Defer Gemini's SET LOCAL pattern to v2-of-v2 / Phase C if route-level validation proves insufficient in the beta soak. Document the deferral. |

### 1.4 Codex-only MINOR + operational findings (no Gemini coverage)

| # | Codex finding | Resolution |
|---|---|---|
| **m1** | Wrap helper calls in policy bodies as `(select private.auth_user_organization_id())` per Supabase RLS perf guidance | **ACCEPT.** v2 §2.3 policies all use `(select private.…)` wrapping. |
| **m2** | Storage policies should include `TO authenticated` explicit role target | **ACCEPT.** v2 §2.4.2 policies add `TO authenticated` |
| **m3** | §3 comment "anon/service_role get execute implicitly via public" is wrong security posture | **ACCEPT.** v2 §3 explicitly REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated. |
| **m4** | §2.8 step 5 should say "verify existing primary owner," not "provision" — S47 bootstrap already created the primary owner | **ACCEPT.** v2 §2.8 step 5 reworded. Optional re-run is idempotent per v1; just clarifying intent. |
| **m5** | `.phase-b-provisioned-users.json` must be gitignored and not store magic-link secrets | **ACCEPT.** v2 §2.6 adds explicit `.gitignore` entry; state file stores `(email, org_id, user_id, provisioned_at)` only — NEVER the magic link itself. |
| **m6** | Migration SQL snippets in plan should be labeled "illustrative, not merge-ready" per S46 C2 (no BEGIN/COMMIT in actual migrations) | **ACCEPT.** v2 adds a banner above each SQL block: "Illustrative; merge-ready SQL ships in `supabase/migrations/<TIMESTAMP>_phase_b_*.sql` with NO BEGIN/COMMIT per S46 Codex C2." |

### 1.5 Within-artifact-blindspot sweep (combined)

Both reviewers caught the SAME pattern: tracking tables under-tested vs research_queue. Combined sweep:

| Pattern | Occurrences | v2 fix |
|---|---|---|
| **"RLS will transparently handle it"** — false because the current app uses service-role server routes and flat storage paths; RLS is bypassed at actual call sites. | Codex sweep #1: §2.2, §2.7, §2.8, §6 | v2 explicitly enumerates per-route required code change. No section asserts "no code change." |
| **Test grid asymmetry** — research_queue covered for SELECT/INSERT/UPDATE/DELETE; tracking tables only for SELECT. | Gemini §6.2 R5/R6/orgs + Codex sweep #2 | v2 §6 expands to full matrix (see B3 above). |
| **Storage RLS treated as universal gate** — but service-role and signed URLs bypass it. | Codex sweep #3 | v2 §6.3 reframes per CG4. |
| **B-1/B-2 split lacks gates** — policies inert between steps 1 and 7, but worker/frontend changes schedule without preflight greps or live insert assertions. | Codex sweep #4 | v2 §2.8 adds preflight assertion BETWEEN each step: "STEP N PREFLIGHT: assertion <X> must hold; abort if not." |
| **Single-org invariant asserted in comments but not enforced in DB** | Codex sweep #5 | v2 adds `UNIQUE (user_id) ON organization_members` as a Phase B-1 first-step constraint (B1 above). |
| **Invitation handling under-specified** — wrong table name, policy text omitted, SELECT-only tests | Codex sweep #2 + #5 | v2 §2.3.3 writes full SQL for `organization_invitations` policies (right name); v2 §6.2 adds the full test grid. |

---

## 2. Open Question Answers — Resolved for v2

Reviewers' answers + my resolution:

| Q | v1 question | Gemini | Codex | v2 resolution |
|---|---|---|---|---|
| Q1 | Magic-link-only auth | KEEP | KEEP + add domain allowlist + operator runbook | **KEEP magic-link-only.** Add a `email_domain_allowlist` env var checked at the provisioning script + at `/api/auth/callback`. Add operator runbook section in v2 §11. |
| Q2 | Drop `research_queue.organization_id` DEFAULT in Phase B | YES, in B-2 | YES, in B-2 after preflight | **DROP in B-2 with preflight assertion.** See B4 above. |
| Q3 | Service-role bypass in worker for v1 | OK | OK + immutable org_id trigger + audit every service-role write | **KEEP service-role for worker.** Add CG9 immutable-org_id trigger. Add audit-logging hook on every service-role storage write (logs to a `audit_storage_writes` table; rotated). |
| Q4 | Storage path migration: COPY-then-delete vs MOVE | COPY-then-delete | COPY-then-delete + verify + disable old-path signing + delete on fixed date | **COPY-then-delete with strict gating (no fallback).** See G1 above. |
| Q5 | research_queue → org DELETE cascade | RESTRICT | RESTRICT | **ON DELETE RESTRICT.** Verified: Phase A migration already declares `research_queue.organization_id REFERENCES organizations(id) ON DELETE RESTRICT` (line 145ish of `20260522_phase_a_multi_tenancy.sql`) — no change needed in Phase B. |
| Q6 | Each beta user gets own org | OWN | OWN + UNIQUE(user_id) constraint | **OWN org per user with UNIQUE constraint.** See B1 above. |
| Q7 | Org name + member list visibility | All members SEE | Org name = members SEE; member list = OWNER-ONLY | **ACCEPT Codex's stricter default.** v2 §2.3.2: members can SELECT their own row only; owners can SELECT all members of their org. Future product can loosen this — easier to loosen than tighten. |
| Q8 | Min-owner trigger interaction with org DELETE cascade | Add BEFORE DELETE ON organizations | No authenticated DELETE policy on organizations in v1 | **ACCEPT Codex.** v2 §2.3.4: no authenticated DELETE policy on `organizations`. Org deletion is service-role-only via admin script. The min-owner trigger's documented "skips on cascade" behavior is fine because cascade is unreachable from the user surface. |
| Q9 | Worker daemon scoped JWT | v1: no | v1: no | **No.** Service-role for worker. Phase C may revisit. |
| Q10 | CSRF protection | Supabase JWT cookie sufficient | ADD CSRF: Origin/Referer check OR double-submit token | **ACCEPT Codex's stricter posture.** v2 §2.7 adds explicit CSRF protection on POST/PATCH/DELETE routes (`/api/queue` and friends). Implementation: validate `Origin` header matches a configured allowlist (production app URL + localhost dev URL). Reject mismatches with 403. |

---

## 3. Scope Disputes — none material

Both reviewers accepted the locked constraints. Codex's only scope correction: "Phase B cannot be 'mostly RLS plus no frontend change'; it necessarily includes frontend auth client replacement, route authorization, storage path reads, and worker job contract changes." **ACCEPT — v1's §2.7 'no code change needed' line is replaced.** v2 §2.7 enumerates the actual frontend work needed (full table of file changes).

---

## 4. v2 Plan Outline — Structural Changes vs v1

The v2 plan keeps the same gross structure (§1 Goals/Non-goals, §2 Architecture, §3 SQL, §4 Phase B-2, §5 Rollback, §6 Tests, §7 Open questions, §8 Multi-reviewer alignment, §9 Estimates, §10 Deferred, §11 NEW operator runbook), but with these substantive revisions:

**Naming + repo-grounding fixes (CG1, CG2, CG3, CG5, CG10):**
- Global rename `organization_invites` → `organization_invitations`
- Global rename `/research-compare` → `/new`
- §2.5 enumerates real storage-write call sites: `executor.ts`, `finalize-recovered-run.ts`, `regenerate-studio-products.ts`
- §2.5 describes worker as HTTP client of Next API (X-Agent-Key auth)
- §2.7 documents `proxy.ts` (Next 16) and `@supabase/ssr` install

**Architectural strengthening (B1, CG6, CG7, CG9):**
- Phase B-1 FIRST statement: `CREATE SCHEMA private; REVOKE/GRANT pattern`
- New helper: `private.auth_user_organization_id()` (moved out of public)
- New helper: `private.auth_user_is_org_owner(target_org uuid)` for owner checks
- New constraint: `ALTER TABLE organization_members ADD CONSTRAINT om_one_org_per_user UNIQUE (user_id)` (v1 single-org invariant as DB invariant)
- New trigger: `BEFORE UPDATE ON research_queue` blocks `organization_id` mutation unless session var explicitly allows
- All RLS policies wrap helper calls as `(select private.helper())` per Supabase perf guidance

**Rollback hardening (B2):**
- Permissive `USING(true)` migration as FAST rollback path (ShareUpdateExclusiveLock)
- `DISABLE RLS` as SLOW fallback, behind app kill switch
- `lock_timeout 5s` + `statement_timeout 15s` on rollback migrations
- Blocker-detection runbook

**Test grid expansion (B3, CG3, CG4):**
- Full matrix: 4 tables × 4 verbs × N bypass vectors (Codex M7's expanded list)
- Storage tests reframed: cross-tenant signed-URL CREATION attempts, not "leaked URL access"
- Build-time grep test for `agent/lib/storage-paths.ts` usage compliance
- Preflight assertions BETWEEN each migration step

**Storage migration tightening (G1, CG8):**
- COPY-by-research_queue.id, not COPY-by-slug
- One-way migration; readers do NOT fall back to legacy paths after cutover
- 30-day soak + scheduled cleanup

**Operational additions (m4, m5, Q1, Q10):**
- §2.6 step 5 → "verify existing primary owner"
- `.phase-b-provisioned-users.json` gitignored, no secrets stored
- Email-domain allowlist
- CSRF Origin-header validation on POST/PATCH/DELETE routes
- §11 NEW operator runbook (provisioning, rollback, blocker resolution)

---

## 5. Next Multi-Reviewer Gate

Per Multi-Reviewer Policy Framework v2.1 Review Topology table:

| Situation | Topology | Pattern |
|---|---|---|
| DESIGN gate, **revision (v2+)** | Sequential QA | One reviewer (the one who caught more last round) verifies v2 applied v1's findings correctly — fidelity, not novel critique. |

**Codex caught the dominant share (4 Critical + 8 Major + 6 code-grounded vs Gemini's 2 Critical + 2 Major).** Codex gets the v2 QA slot.

**v2 QA scope (sequential, Codex-only):**
- Verify every Critical (B1-B4, CG1-CG10, G1-G2) has been addressed in v2 text.
- Verify every Major (m1-m6) has been addressed.
- Verify Open Question answers (Q1-Q10) match the resolutions in this synthesis.
- Verify the within-artifact-blindspot sweep findings have been swept across v2 (not just patched in one place).
- NEW critique only on whether v2 INTRODUCES new findings — not a fresh full review.

Gemini does NOT review v2. Their findings have been recorded and applied; re-review would be duplicative cost without complementary-blindspot value at the v2 stage (per v2.1 sequential-QA reasoning in `~/CLAUDE.md`).

If Codex's QA on v2 raises a new CRITICAL or MAJOR, address it in v3 (sequential, Gemini optional). Otherwise v2 ships to MERGE gate.

---

## 6. Decision Provenance + Cross-Memory Links

This synthesis applies the following established patterns:
- [[feedback_multi_reviewer_gate_dependent_pattern]] — DESIGN-gate parallel; revision v2+ sequential QA
- [[feedback_within_artifact_reviewer_blindspot]] — sweep for all occurrences of each pattern-level finding (executed in §1.5)
- [[feedback_supabase_db_push_filename_underscore]] — v2 Phase B-1 + Phase B-2 migration filenames use `_` separator
- [[feedback_supabase_db_push_no_begin_commit]] — v2 SQL artifacts contain NO file-level BEGIN/COMMIT
- [[project_multi_reviewer_policy_framework_v2_shape]] — Event Gate × Risk Label × Severity Mode classification (DESIGN gate, labels: SECURITY + DATA + AGENT BEHAVIOR + PRIVACY + INFRA + ARCHITECTURE; severity NORMAL)

**v2 plan ETA from this synthesis:** ~60 min of dense writing (full rewrite of §2.5, §2.7, §2.8 + insertion of new constraints, helpers, triggers, and tests).
