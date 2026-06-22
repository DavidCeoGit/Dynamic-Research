# Phase 5 GUC-Hardening — MERGE-gate peer review (S154)

> Companion to `Documentation/phase5-guc-hardening-design.md` (DESIGN gate CLEARED S152) and the
> migration `supabase/migrations/20260622_phase5_guc_hardening_tenancy_admin.sql` + harness changes
> (`agent/scripts/test-ssr-auth-cutover.sh` Regime 1b, `agent/scripts/test-phase-b-rls.sh` T7d).
>
> **Event gate:** MERGE. **Risk labels:** SECURITY + DATA + AGENT BEHAVIOR + ARCHITECTURE.
> **Severity:** NORMAL. **Topology:** sequential both-lenses-adversarial — Gemini holistic (v1) →
> integrate → Codex grounded (on integrated v2) → integrate → final. Reviewer order per `~/CLAUDE.md` §11.

---

## 0. What was reviewed

The IMPL of the owed Phase-5 decision-#2 GUC-hardening fast-follow: swap the **bare**
`app.allow_org_migration` GUC escape-hatch in BOTH `public.research_queue` tenant-boundary triggers for a
**two-factor** gate `private.org_migration_enabled() = (GUC='true' AND
pg_has_role(session_user,'tenancy_admin','MEMBER'))`; flip B-1 (`research_queue_immutable_org_id`) to
SECURITY DEFINER; de-oracle B-1's message; create NOLOGIN `tenancy_admin` + grant it to postgres; plus the
harness arm that proves the control (cutover P3/P3b/P3c on a `supabase_admin` superuser connection +
`test-phase-b-rls.sh` T7d sibling).

**What each reviewer saw:** Gemini — the migration SQL + both prior-art trigger migrations
(20260523 B-1, 20260621 Phase 5) + the design doc + the two harness additions + the empirical evidence
block (full repo context for the changed artifacts; no live DB). Codex — the same files in its read/write
sandbox **plus the live local PostgreSQL 17.6 replica** (it could and did run grounded SQL counterexamples).

---

## 1. Empirical baseline (local Supabase replica = schema-only dump of prod `mfjgoghlpqgxcycxoxio`)

- PRE-STATE confirmed the design's central pivot: `postgres` is_superuser=OFF; `supabase_admin`=ON. B-1 fn
  was SECURITY INVOKER; Phase 5 fn already DEFINER; both owned by postgres. Migration not yet applied.
- APPLY as `postgres` (the identity `supabase db push` uses): exit 0; `GRANT ROLE`/`GRANT` succeeded.
- POST-STATE: tenancy_admin (NOLOGIN) created; membership matrix postgres=MEMBER, app roles (service_role/
  authenticated/anon/authenticator)=non-member; B-1 flipped to DEFINER; B-1 message de-oracled.
- CUTOVER HARNESS `test-ssr-auth-cutover.sh`: **27/27 PASS, 0 FAIL, 2 SKIP** (Tier-1 needs a running app;
  Tier-3 opt-in). Regime 1b — through the REAL trigger path — all PASS: P3 (member+GUC → permitted),
  P3b-i (service_role+GUC → cross-org lineage STILL blocked), P3b-ii (service_role+GUC → org_id mutation
  STILL blocked), P3c (B-1 de-oracled). T7d (seeded postmerge) PASS.

---

## 2. Round 1 — Gemini holistic-adversarial (gemini-2.5-pro via @google/genai SDK) — **BLOCK**

Log: `c:/tmp/dr-s154/gemini.log`. Verbatim verdict line: `VERDICT: BLOCK`.

### G-CRITICAL — Latent DoS via helper SEGFAULT (future-reuse landmine)
A direct call to `private.org_migration_enabled()` by a role lacking EXECUTE reproducibly SEGFAULTS the
backend (signal 11). Gemini rejected the v1 "unreachable" characterization as underestimating future
evolution: a future dev could reuse the helper in a new RLS policy `USING (... OR
private.org_migration_enabled())` evaluated as an app role lacking EXECUTE → crash → app-level DoS. "A
function that segfaults on a standard permission check is fundamentally unsafe to merge regardless of its
current call graph." Proposed fix: make the helper SECURITY DEFINER.

### G-MAJOR — Brittle trigger-owner assumption → "all-writes-fail" deploy risk
`GRANT EXECUTE ... TO postgres` hinges on the prod trigger owner being `postgres` forever. If a platform
change / restore / future migration ever made the owner something else, the trigger→helper call would hit
permission-denied at fire time and **every research_queue INSERT/UPDATE would fail** — total outage on the
core table. Proposed fix: also `GRANT EXECUTE ... TO supabase_admin`.

### G-MINOR — P3 positive test could report a misleading headline on an unrelated failure
Test hygiene; Gemini concluded "no code change required, the existing structure is acceptable."

### G-INFO — harness design praised
Dedicated `SUPERUSER_DATABASE_URL` + `SET SESSION AUTHORIZATION` + session_user preconditions called
"exemplary"; the 20260622-vs-20260621 ordering analysis "insightful."

---

## 3. Integration of Round 1 (v1 → v2) — grounded against the live DB before applying

The fix was chosen by EMPIRICAL TEST, not by adopting Gemini's suggestion verbatim:

- **Gemini's proposed CRITICAL fix (helper → SECURITY DEFINER) was VERIFIED INEFFECTIVE.** A DEFINER private
  function, revoked from service_role, **still segfaults** when called by service_role — because the EXECUTE
  permission check is on the **caller** regardless of DEFINER/INVOKER. (Control battery: a *trivial*
  `SELECT true` revoked private fn also segfaults → the crash is a GENERIC PostgreSQL-17.6/Supabase-build
  behavior on the EXECUTE-permission-denied path for non-inlinable SQL functions, **not** a property of our
  body.)
- **The effective fix is to remove the permission-denied PATH:** `GRANT EXECUTE ON FUNCTION
  private.org_migration_enabled() TO PUBLIC` (replacing v1's `REVOKE ALL FROM PUBLIC; GRANT … TO postgres`).
  Verified on the live DB: direct service_role call → returns `false` cleanly, **no crash**; roles without
  `private` schema USAGE (anon/authenticated post-ntfy-hardening) get a CLEAN schema-permission error, not a
  segfault — so this does NOT re-grant them private USAGE and does NOT undo the ntfy hardening.
- **This single change closes BOTH findings.** It is owner-agnostic (any trigger owner is a member of PUBLIC
  → the trigger→helper call works regardless of prod ownership), so G-MAJOR is resolved without a separate
  supabase_admin grant. Security rationale: the helper is a NON-SENSITIVE boolean predicate that grants no
  capability — the enforcement point is the two SECURITY DEFINER triggers, which call it internally; an app
  role calling it directly just gets `false`. PUBLIC EXECUTE is the idiomatic Postgres default; v1's REVOKE
  was over-hardening that created the DoS landmine. Boundary UNCHANGED (gate still keys on session_user
  membership inside the DEFINER triggers).
- **G-MINOR:** left as-is per Gemini's own conclusion; the full `$p3` SQLSTATE/SQLERRM output is already
  surfaced in the P3 fail reason, so a debugger sees the real cause.

**Re-validation of v2:** migration re-applied clean (drop+reapply as postgres); helper ACL = PUBLIC EXECUTE;
direct service_role call clean (segfault gone); security property holds (postgres+GUC=true,
service_role+GUC=false); cutover harness **still 27/27, 0 fail, 0 crashes**.

---

## 4. Round 2 — Codex grounded-adversarial on integrated v2 (codex exec -s workspace-write, gpt-5.5, xhigh) — ENDORSE

Log: `c:/tmp/dr-s154/codex.log`. Verbatim verdict line: `VERDICT: ENDORSE`. Codex read the files in its
sandbox AND ran live counterexamples against the local PostgreSQL 17.6 replica:

**Grounded checks Codex ran (all confirmed):**
- `GRANT EXECUTE TO PUBLIC` on the helper is security-neutral: returns only `GUC AND
  pg_has_role(session_user,'tenancy_admin')`; non-members get `false`; `anon` (no `private` USAGE) gets a
  clean schema-permission error; grants no write capability, reads no tenant data.
- B-1's SECURITY DEFINER flip is safe against the ACTUAL body (migration line 152): only reads OLD/NEW,
  calls the schema-qualified helper, raises, returns NEW — no table read, no RLS-bypass surface.
- Live counterexamples: `postgres+GUC` -> gate true -> cross-org lineage permitted; `authenticator -> SET
  ROLE service_role + GUC` -> gate false -> blocked; `service_role session_user + GUC` -> gate false -> B-1
  blocked the org mutation. A plain `postgres` connection with `SET ROLE service_role` returns gate **true**
  — independently confirming WHY the old `SET ROLE`-only P3 test was misleading (the P3 retarget to `SET
  SESSION AUTHORIZATION` was necessary).
- Ran `test-ssr-auth-cutover.sh` itself -> **27/27**, incl. P3/P3b-i/P3b-ii/P3c.
- Idempotency/deploy: re-ran the WHOLE migration as **non-superuser `postgres`** inside a rolled-back txn ->
  succeeded (only a benign "already granted membership" NOTICE). File ordering correct: `20260622_*` sorts
  after `20260621_*` and no later migration overwrites either hardened function.

**Codex finding — MINOR (explicitly NOT a merge blocker):** `test-phase-b-rls.sh` T7d could pass-as-skip
when `research_queue` has no rows, so it was not *independently* load-bearing on an empty/schema-only
target (the self-seeding SSR harness already covered the control). → **INTEGRATED:** T7d now self-seeds a
sacrificial org + research_queue row (handed across the `SET SESSION AUTHORIZATION` boundary via a session
GUC) inside its rolled-back transaction; the no-row skip path is removed. Validated: with only a
`system-default` org present (no rows), T7b/T7c correctly SKIP while **T7d self-seeds and PASSES** — proving
it is now independently load-bearing. (Test-script-only change, worker-inert; re-running the harness green
is adequate QA for a non-blocking, reviewer-specified hygiene fix.)

---

## 5. IMPL-VERIFY — trigger-fn ownership

- LOCAL: both trigger fns owned by `postgres` (the schema-dump-from-prod state) — confirmed. Codex
  re-confirmed via the live ACL dump.
- The owner question is **mooted by PUBLIC EXECUTE** (any owner is a member of PUBLIC -> the trigger->helper
  call works regardless). The design's per-owner IMPL-VERIFY is therefore no longer load-bearing for
  correctness; a read-only prod ownership confirmation is still listed as a belt-and-braces pre-apply step.

---

## 6. Disposition — CLEARED (both reviewers); MERGE approved, PROD APPLY HELD

- **Gemini (holistic, v1): BLOCK** -> both findings (CRITICAL DoS-landmine, MAJOR owner-brittleness) resolved
  by the single `GRANT EXECUTE TO PUBLIC` change, verified empirically (incl. proving Gemini's own proposed
  DEFINER fix ineffective).
- **Codex (grounded, on integrated v2): ENDORSE** -> one MINOR (T7d self-sufficiency) integrated.
- Both lenses adversarial, sequential, reviewer order Gemini->Codex per §11. No SECURITY-CRITICAL left open.
- Empirical: migration applies clean as both postgres and (Codex) non-superuser-postgres-in-rolled-back-txn;
  cutover harness 27/27; T7d self-seeding PASS; segfault eliminated; security property holds.
- **MERGE: approved** (matches the user's S154 "through-merge on a clean clear" authorization).
- **PROD APPLY (`supabase db push --linked`): HELD** for explicit human confirmation (per the user's S154
  decision + design §7.5). Pre-apply belt-and-braces: a read-only confirm that prod has only `20260622`
  pending and (optionally) that trigger-fn ownership is as expected — though PUBLIC EXECUTE moots the latter.

---

## 6. Disposition

_To be finalized after Round 2._
