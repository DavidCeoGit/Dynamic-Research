# Phase 5 (parent-same-org trigger + executable RLS-bypass harness) — DESIGN-gate v3 (FINAL)

> **Status:** DESIGN-gate **v3-FINAL — gate CLOSED**. Sequential MRPF: Gemini holistic-adversarial (BLOCK → integrated v2) → Codex grounded-adversarial (BLOCK → integrated v3) → Codex sequential-QA fidelity pass (BLOCK on **residual stale phrasing only** — all 5 substantive resolutions confirmed RESOLVED/correct; the 3 stale-text spots it enumerated at §exec-summary/§2.2/§2.3/§open-Q swept per the mechanical-fix fidelity-skip precedent). Authored 2026-06-20 UTC (S148). Companion audit trail: `Documentation/phase5-parent-same-org-and-rls-harness-design-gate-peer-review.md`.
>
> **Implementation PARKED** for a human-present session (the migration is DATA + SECURITY, prod-affecting; the harness needs a non-prod target — open-Q #3). The eventual MERGE gate is a separate full tri-vendor gate per project §11.
> **Target migration:** `supabase/migrations/<YYYYMMDD>_phase5_parent_same_org_trigger.sql` (implementation — PARKED for a human-present session; DATA + SECURITY, prod-affecting).
> **Target harness:** `agent/scripts/test-ssr-auth-cutover.sh` (new; executable tenant-isolation proof).
> **Companion peer-review file:** `Documentation/phase5-parent-same-org-and-rls-harness-design-gate-peer-review.md` (forthcoming — Gemini holistic-adversarial → Codex grounded-adversarial).
> **Predecessors:** Phase A — `20260522_phase_a_multi_tenancy.sql`; Phase B-1 — `20260523_phase_b_auth_rls_helpers.sql`; Phase B-2 — `20260602_phase_b_2_rls_enable.sql` (APPLIED, verified live S97).
> **Relationship to "Phase C":** prior docs label the `SET NOT NULL` canonicalisation of `research_queue.organization_id` as "Phase C." That column canonicalisation is **explicitly OUT of scope here** (see §2.3) — B-2's `research_queue_org_id_not_null` CHECK already bridges it. "Phase 5" is this session's label for the next tenant-isolation hardening wave: the parent-same-org trigger + the executable RLS-bypass harness that were both deferred from the Phase B plan (`multi-tenancy-phase-b-plan.md` §6.2/§6.3).

> ### v1 → v2 changelog (Gemini round 1 — holistic-adversarial; BLOCK → integrated; 2 CRITICAL, 1 MAJOR, 2 MINOR, 1 INFO, all ACCEPTED)
>
> - **G-CRIT-1 ACCEPT** (harness service_role emulation unfaithful): v1 emulated service-role via `SET ROLE` to the table owner. The owner ≠ the real `service_role` (different GRANT set; owner is effectively superuser-on-object). The trigger's whole purpose is to fence `service_role`, so the proof must run as the *genuine* role. v2 §5.2 P1/P1b now use `SET LOCAL ROLE service_role` (adopts service_role's real GRANTs + `BYPASSRLS` role attribute) — faithful, no second credential needed; the `SERVICE_ROLE_DATABASE_URL` second-connection variant is retained as an optional connection-default check. Open-question #5 resolved.
> - **G-CRIT-2 ACCEPT** (storage proof misses the authenticated cross-tenant vector): v1 §5.3 tested only anon + catalog. The real threat is an *authenticated* user A inducing an API route to mint a signed URL / list objects for org B's path. v2 §5.3 adds a **required** authenticated cross-org route probe (session-A → org-B's `files`/`manifest`/`file` routes → expect 403/404), reframing catalog assertions as the always-on backstop and the route-level org check as the actual storage boundary under test.
> - **G-MAJ-1 ACCEPT-with-scope** (`app.allow_org_migration` is an unaudited god-mode GUC): integrated the mitigating analysis (a `SET` command is **not reachable** from the PostgREST/supabase-js client surface — clients cannot issue session `SET`, only raw-SQL/server-side paths can, narrowing the real exposure to an existing SQL-injection escalation) AND a tracked follow-up to harden the GUC behind an admin-gated `SECURITY DEFINER` enabler across **both** triggers (it is a B-1-shipped mechanism; redesigning it touches B-1, so it is recorded as a fast-follow rather than silently widened). §3.3 updated.
> - **G-MIN-1 ACCEPT** (error-message org-UUID oracle): v1's `RAISE EXCEPTION` leaked the parent's `organization_id`, usable as an oracle to map foreign-org runs without read access. v2 §3.1 emits a generic message ("references a run in a different organization or does not exist").
> - **G-MIN-2 ACCEPT** (trigger fires on every UPDATE): adopted the `OF parent_run_id, organization_id` narrowing into the **core** design (§3.2), not an open question. Open-question #2 resolved.
> - **G-INFO-1 ACCEPT** (automate the pre-apply audit): the cross-org-link audit (§4.2) is now a fail-loud `DO $$ … RAISE EXCEPTION $$` preflight block at the migration top (mirrors B-2 §1), not a documented manual step. Open-question #3 resolved.

> ### v2 → v3 changelog (Codex round 1 — grounded-adversarial; BLOCK → integrated; 1 CRITICAL, 3 MAJOR, 1 MINOR, all ACCEPTED)
>
> - **C-CRIT-1 ACCEPT** (Tier-1 storage probe is incompatible with rollback-wrapped psql fixtures): uncommitted psql fixtures are invisible to the HTTP app (separate DB connection) and storage objects are not rolled back by psql, so the v2 Tier-1 HTTP probe would have tested unrelated data or silently skipped. v3 **splits the harness into two fixture regimes against a NON-PROD target** (§5.1): a **committed** non-prod seed (Admin-API users + orgs + members + runs + real storage objects, with explicit teardown) shared by both the psql RLS matrix and the HTTP Tier-1 probe; per-test `SAVEPOINT`/`ROLLBACK TO` isolates mutating assertions without polluting the seed. A hard guard refuses to run against the prod ref `mfjgoghlpqgxcycxoxio`.
> - **C-MAJ-1 ACCEPT** (auth.users fixture shape is fictional): `agent/scripts/phase-a-bootstrap-primary-user.ts:192` creates users via the **Supabase Admin API `createUser({email, email_confirm})`**, NOT a raw `auth.users` SQL insert. v3 §5.5 corrects this — the harness seeds users via the Admin API (committed, outside the psql txn), matching C-CRIT-1's committed-fixture model and the `organization_members.user_id` FK to `auth.users`.
> - **C-MAJ-2 ACCEPT** (S2 catalog assertion false-passes a `TO public` policy): `roles && ARRAY['anon','authenticated']` misses a `{public}` policy (which applies to all roles). v3 §5.3 S2 now flags any permissive SELECT policy on `storage.objects` granted to `public`/`anon`/`authenticated`.
> - **C-MAJ-3 ACCEPT** (trigger is not a full invariant under its own GUC bypass; threat model overclaimed): counterexample — under `app.allow_org_migration='true'`, moving a **parent** row's `organization_id` does not re-validate its existing **children**, stranding cross-org links the trigger never sees (it only checks the written row's own `parent_run_id`). v3 reframes the trigger as a **child-write-time** fence (§3.4), softens the §6 threat row, and makes a post-break-glass cross-org-link audit (reusing the §4.2 query) **mandatory** after any `app.allow_org_migration` session (§3.3).
> - **C-MIN-1 ACCEPT** (stale control name): `getOrgContextDualPath()` is **retired** (`frontend/lib/auth.ts:5-7`); the live control is `requireOrgOr401()` → `requireOrgContext()` deriving `orgId` from the **session**, and storage isolation is the **session-derived `<orgId>/<slug>/` path prefix** (`files/route.ts:7-10`) — structurally stronger than a per-query `.eq` (the org prefix is never request-supplied). v3 §1.4/§1.5/§5.3 corrected; the Tier-1 probe now verifies this session-derived-prefix invariant.

---

## Executive summary

Phase B-2 enabled RLS on the five tenant-perimeter tables and the 14 policies are live. Two gaps remain in the tenant-isolation boundary, both deferred from the Phase B plan:

1. **No DB-level guarantee that a cloned/replayed child run shares its parent's organization.** `research_queue.parent_run_id` is a self-FK (`20260511`). The RLS `rq_insert` `WITH CHECK` only constrains `organization_id = auth_user_organization_id()` — it says **nothing** about `parent_run_id`. The application layer *does* org-scope the parent lookup (`queue/route.ts:106-117`, `replay/route.ts:101` both `.eq("organization_id", orgId)`), but the worker daemon and every future code path use the **service-role** key, which **bypasses RLS entirely**. A service-role bug, a direct SQL insert, or an admin script could create a child in org B whose `parent_run_id` points at a run in org A — a cross-tenant lineage link. This is the same service-role-bypass vector that the existing `research_queue_immutable_org_id` and `organizations_immutable_columns` triggers (B-1 §4/§5.5) were built to fence. Phase 5 adds the matching fence for the parent-lineage column.

2. **The tenant boundary has never been proven by an executable test that assumes a foreign identity.** B-1's `test-phase-b-rls.sh` verifies the *policies exist* (pg_policies snapshot) but explicitly defers (header lines 28-40) the **RLS-bypass matrix** (§6.2) and **storage RLS** (§6.3) because they require RLS enabled (now true since B-2) and an authenticated-vs-anon client. No test today does `SET ROLE authenticated; SET request.jwt.claims=<user A>` and confirms a cross-org `SELECT` returns **zero** rows. "RLS is enabled" is an unverified claim. Phase 5 builds `test-ssr-auth-cutover.sh` — the deterministic, re-runnable proof that an anon or cross-org session cannot read another org's rows or storage. It is both the one-time gate for the eventual SSR-auth cutover (the flip from the env-fallback/service-role dashboard path to per-user authenticated SSR sessions) **and** a permanent regression guard.

**Core question — "what bad outcome are we preventing?"** Cross-tenant data leakage: (a) a child run in one org silently inheriting another org's lineage/payload/attachments; (b) a future SSR-auth cutover that *looks* isolated but isn't, shipped without a test that would have caught it.

**Risk asymmetry is favourable.** Both deliverables are additive and reversible. The trigger is `DROP TRIGGER` + `DROP FUNCTION` to roll back, mutates no data, and does **not** retroactively validate existing rows (a pre-apply audit query — §4.2 — confirms zero existing violations; prod has exactly one org so the expected count is 0). The harness creates a **committed seed on a NON-PROD project only** (a hard prod-ref guard makes a prod run impossible) and tears it down in a `trap`; it never touches production data (§5.1).

**This document is DESIGN-only.** The migration (DATA + SECURITY, prod-affecting, RLS-adjacent) is **PARKED** for a human-present session after this gate clears. The harness is lower-risk (non-prod-only, self-tearing-down) but ships in the same parked implementation wave so its first run validates the trigger.

---

## 1. Live-state inventory (grounding facts)

Captured from the migrations + code at S148 (2026-06-20). Re-confirm against prod (`psql $DATABASE_URL`) before any apply.

### 1.1 `research_queue` shape relevant to Phase 5

| Column | Type | Constraint | Source |
|---|---|---|---|
| `id` | uuid | PK `DEFAULT gen_random_uuid()` | base |
| `organization_id` | uuid | FK→`organizations(id)` `ON DELETE RESTRICT`; **CHECK `IS NOT NULL`** (`research_queue_org_id_not_null`, B-2 §4); DEFAULT **dropped** (B-2 §3) | Phase A §2.4 / B-2 |
| `parent_run_id` | uuid | self-FK→`research_queue(id)` **`ON DELETE SET NULL`**; nullable | `20260511` |

Key consequence: **every `research_queue` row has a non-NULL `organization_id`** (CHECK enforced for all roles). So inside the trigger, "parent lookup returned NULL org" can ONLY mean "parent row does not exist" — a clean discriminator (§3.1).

### 1.2 Existing triggers on `research_queue` (the pattern Phase 5 extends)

| Trigger | Timing | Purpose | Bypass hatch |
|---|---|---|---|
| `research_queue_immutable_org_id` (B-1 §4) | BEFORE UPDATE | blocks `organization_id` mutation (service-role tenancy-move fence) | `app.allow_org_migration = 'true'` |
| `trg_queue_updated` (Phase A) | BEFORE UPDATE | maintains `updated_at` | — |

Phase 5's trigger is a **BEFORE INSERT OR UPDATE** sibling. Because `organization_id` is immutable (the trigger above blocks changes except under `app.allow_org_migration`), Phase 5 honours the **same** `app.allow_org_migration` escape hatch so an admin tenancy-migration tool can move a parent+child set without a transient cross-org window (§3.3).

### 1.3 RLS state (post-B-2, verified live S97)

RLS `ENABLED` on all five perimeter tables (`research_queue`, `organization_members`, `organization_invitations`, `organizations`, `audit_storage_writes`); `relforcerowsecurity = false` (owners/service-role bypass — intentional); 14 policies live, all `TO authenticated`, all helper calls wrapped `(select private.<helper>())` (InitPlan-safe). `service_role` has `BYPASSRLS`. `anon` has **no** policies on any perimeter table → default-deny.

### 1.4 Storage isolation model (drives §5 harness storage coverage)

No `storage.objects` RLS policies exist anywhere in `supabase/` (grep-confirmed S148). Tenant isolation for storage is **not** RLS — it is a **session-derived path prefix** (verified against live code at S148, correcting an earlier stale description):

- Bucket `research-projects` is **private** (`public = false`) — no anon object reads at all.
- Every file-serving route resolves `orgId` from the **caller's session** via `requireOrgOr401()` → `requireOrgContext()` (`frontend/lib/auth.ts:49-110`; the Phase-2 `getOrgContextDualPath` bridge is **RETIRED**, `auth.ts:5-7`).
- The storage object path is `scopedStoragePath(orgId, slug, file)` → `<orgId>/<slug>/<file>` (`frontend/lib/storage-paths.ts` + `frontend/lib/storage.ts:201,290`). Because `orgId` comes from the session and is **never request-supplied**, a session-A caller can only ever address paths under `<orgA>/…`. The `slug` is attacker-controlled, but a foreign-org slug simply resolves to a non-existent path under the caller's *own* org prefix → 404. So cross-org storage read is **structurally impossible** through these routes (stronger than a per-query `.eq` check, which a route could forget). `/manifest` additionally does a DB `.eq("organization_id", orgId)` (`manifest/route.ts:91-97`).

The harness proves storage isolation by (a) verifying the **session-derived-prefix invariant** holds through the live routes (Tier-1, §5.3), and (b) catalog backstops (bucket private + no permissive object policy).

### 1.5 Application-layer parent scoping (already present — Phase 5 is defense-in-depth, not the primary control)

- `frontend/app/api/queue/route.ts:106-117` — parent-slug → `parent_run_id` lookup adds `.eq("organization_id", orgId)` (where `orgId` is session-derived); an unknown/foreign slug resolves to `parent_run_id = null` (comment lines 101-106).
- `frontend/app/api/runs/[slug]/replay/route.ts:101` — same `.eq("organization_id", orgId)` scoping; insert at `:231-242` stamps explicit `organization_id` + `parent_run_id`.

The trigger does **not** replace these — it backstops the **service-role / direct-SQL / future-code** paths that never pass through these routes.

---

## 2. Scope

### 2.1 IN scope — Component 1: parent-same-org trigger

A `BEFORE INSERT OR UPDATE` trigger + `SECURITY DEFINER` function in the `private` schema that rejects any `research_queue` row whose `parent_run_id` references a parent in a **different** organization. Honours the `app.allow_org_migration` escape hatch. Full SQL in §3.

### 2.2 IN scope — Component 2: `test-ssr-auth-cutover.sh`

An executable, psql-based tenant-isolation harness that, using `SET ROLE` + `request.jwt.claims` identity emulation over a **committed non-prod seed** (two orgs, two owners, runs + storage objects each; per-test `SAVEPOINT`/`ROLLBACK TO` isolation; full teardown), proves the RLS-bypass matrix (§5.2) and the storage isolation tiers (§5.3), plus the cross-link between Components 1 & 2 (a cross-org parent insert RAISES). Full design in §5.

### 2.3 OUT of scope (explicitly deferred)

- **`SET NOT NULL` on `research_queue.organization_id` ("Phase C" column canonicalisation).** Despite this doc's filename (`…-canonicalization-…`, retained per the session handoff for continuity), the column canonicalisation is **deferred**, not done here. B-2's `research_queue_org_id_not_null` CHECK already enforces non-NULL for every role; `SET NOT NULL` is an over-determined catalogue-tidy with table-rewrite-scan semantics and belongs in its own migration. Tracked separately.
- **Storage `storage.objects` RLS policies.** DR's storage isolation is deliberately route-level + private-bucket + signed-URL, not object-RLS (§1.4). Introducing object-RLS is a larger architectural change, out of scope.
- **Recursive lineage validation** (grandparent+ chains). The trigger validates the immediate parent only; transitivity holds because each link is validated at its own insert (§3.4).
- **Self-reference loops** (`parent_run_id = id`). Not a tenant-isolation concern (same row → same org → passes); orthogonal data-integrity question, out of scope.
- **The frontend SSR-auth cutover itself.** Phase 5 builds the *proof* the cutover will be gated on. (The `getOrgContextDualPath` dual-path bridge is **already retired** — `frontend/lib/auth.ts:5-7` — and routes derive org from the session via `requireOrgOr401()`; the remaining "cutover" work is the broader move off any env-fallback dashboard path, a separate initiative.)

---

## 3. Component 1 — parent-same-org trigger (design)

### 3.1 Trigger function

```sql
-- =============================================================================
-- Phase 5 §1 — parent-same-org fence on research_queue
-- =============================================================================
-- DB-level defense-in-depth: a child run (parent_run_id IS NOT NULL) must share
-- its parent's organization_id. RLS rq_insert only constrains the child's own
-- organization_id; it does not constrain parent_run_id, and service-role bypasses
-- RLS entirely. This trigger is the matching fence for the cross-tenant-lineage
-- vector, mirroring research_queue_immutable_org_id (B-1 §4).
--
-- SECURITY DEFINER: the internal lookup must see the TRUE parent row regardless
-- of the caller's RLS visibility. An `authenticated` caller cannot SELECT a
-- foreign-org parent (rq_select hides it); without DEFINER the lookup would
-- return NULL and we could not distinguish "foreign org" (must BLOCK) from
-- "nonexistent" (let the FK reject it). Owned by the migration role (postgres),
-- which bypasses RLS — so the lookup always observes the real org.
CREATE OR REPLACE FUNCTION private.research_queue_parent_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
DECLARE
  v_parent_org uuid;
BEGIN
  IF NEW.parent_run_id IS NULL THEN
    RETURN NEW;  -- fresh submission, no lineage to validate
  END IF;

  -- Admin tenancy-migration escape hatch — aligned with
  -- research_queue_immutable_org_id so a parent+child set can be moved
  -- atomically under one session flag without a transient cross-org window.
  IF COALESCE(current_setting('app.allow_org_migration', true), 'false') = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO v_parent_org
  FROM public.research_queue
  WHERE id = NEW.parent_run_id;

  -- organization_id is NOT NULL on every row (research_queue_org_id_not_null
  -- CHECK, B-2 §4). So v_parent_org IS NULL <=> parent row not found — leave
  -- nonexistence to the FK constraint (which fires AFTER BEFORE-triggers); do
  -- not mask it here.
  IF v_parent_org IS NOT NULL
     AND v_parent_org IS DISTINCT FROM NEW.organization_id THEN
    -- Generic message (G-MIN-1): do NOT echo v_parent_org. Echoing the parent's
    -- organization_id turns the trigger into an oracle — a user with only
    -- INSERT rights in their own org could guess parent_run_id UUIDs and read
    -- back which org each belongs to without any SELECT visibility. The
    -- non-tenant detail (the offending parent_run_id, which the caller already
    -- supplied) is safe to include.
    RAISE EXCEPTION
      'parent_run_id % references a run in a different organization or does not exist',
      NEW.parent_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION private.research_queue_parent_same_org() IS
  'Phase 5: BEFORE INSERT/UPDATE on public.research_queue. Rejects a child whose parent_run_id references a run in a different organization. SECURITY DEFINER so the lookup bypasses RLS and sees the true parent org. Honours app.allow_org_migration. Catches the service-role / direct-SQL cross-tenant-lineage vector RLS cannot.';

REVOKE ALL ON FUNCTION private.research_queue_parent_same_org() FROM PUBLIC;
```

### 3.2 Trigger binding

```sql
DROP TRIGGER IF EXISTS research_queue_parent_same_org ON public.research_queue;

-- OF parent_run_id, organization_id (G-MIN-2): fire only when a lineage-relevant
-- column changes (or on any INSERT). organization_id is immutable
-- (research_queue_immutable_org_id), so in practice this fires on INSERT and on
-- the rare parent_run_id mutation — NOT on the high-frequency status/updated_at
-- UPDATE path. An ON DELETE SET NULL of parent_run_id → NULL still fires and
-- returns NEW harmlessly. Correctness is identical to the unqualified form.
CREATE TRIGGER research_queue_parent_same_org
  BEFORE INSERT OR UPDATE OF parent_run_id, organization_id ON public.research_queue
  FOR EACH ROW
  EXECUTE FUNCTION private.research_queue_parent_same_org();
```

**Note on `UPDATE OF` + INSERT:** the `OF` column list constrains only the UPDATE event; INSERT always fires the trigger regardless of the column list (correct — a fresh row's lineage must be validated). This is standard PostgreSQL `CREATE TRIGGER` semantics.

### 3.3 Escape-hatch semantics + god-mode-GUC analysis (G-MAJ-1)

`app.allow_org_migration = 'true'` (session-scoped) skips the check, identical to `research_queue_immutable_org_id`. Rationale: an admin tenancy-migration tool that moves a whole org's runs to a new org must (a) set the flag to mutate `organization_id` at all, and (b) avoid this trigger blocking the intermediate state where the parent has moved but the child has not. Aligning the two triggers on one flag keeps the bypass surface singular and auditable. The flag is **never** set in worker code or user-facing routes (B-1 §4 invariant).

**The flag disables BOTH tenant-boundary triggers, so its reachability is a security property, not a convention (G-MAJ-1).** Analysis:

- **Not reachable from the client/PostgREST surface.** A session `SET app.allow_org_migration = 'true'` is a raw SQL statement. The Supabase JS client (`.from().insert()/.update()`) and PostgREST expose **no** way for `anon`/`authenticated` callers to issue a session-level `SET` — query-builder calls and RPCs run inside PostgREST's own statement, and a custom GUC cannot be flipped through them. So the normal multi-tenant attack surface (a logged-in user) **cannot** set this flag. The exposure narrows to paths that can execute arbitrary SQL on a shared connection: (a) server-side raw-SQL code (service-role, server-only), and (b) a **pre-existing SQL-injection** vulnerability in a raw query — itself an independent CRITICAL that this flag merely amplifies.
- **Phase 5 widens the flag's blast radius** (it now also gates lineage, not just org-id immutability), which is why the analysis is recorded here rather than left implicit.
- **Mandatory operational post-condition (C-MAJ-3):** any session that sets `app.allow_org_migration='true'` MUST run the §4.2 cross-org-link audit query as a **post-condition** before the connection is released, because the bypass it grants can strand children on a parent org-move (§3.4). This is a hard procedural requirement on the (not-yet-built) org-migration tool, recorded here so the tool's own DESIGN gate inherits it.
- **Recommended fast-follow (tracked, not silently folded in):** replace the bare GUC check in **both** triggers with an admin-gated enabler — e.g. a `private.org_migration_enabled()` `SECURITY DEFINER` helper that returns true only when invoked under a dedicated `tenancy_admin` role, instead of trusting a mutable GUC any raw-SQL path can set. Because the GUC is a **B-1-shipped** mechanism shared with `research_queue_immutable_org_id`, hardening it is a change to B-1's surface and belongs in its own small migration + MERGE gate — not silently widened inside Phase 5. v3 keeps the GUC for Phase 5 (consistency + the client-unreachability mitigation above) and records the hardening as a follow-up. Reviewers: confirm this scoping, or argue the hardening must land *with* Phase 5.

### 3.4 Why immediate-parent-only is sufficient — and its one break-glass gap (C-MAJ-3)

Each child→parent link is validated at the moment that child is inserted/updated. Inductively, if every link `child.org = parent.org` holds, the whole lineage chain is within one org. A recursive walk would add cost and lock-footprint for zero additional safety. Cross-org grandparent is impossible without an intermediate cross-org link, which is itself blocked.

**This inductive guarantee is a child-WRITE-TIME fence, and it holds only while `organization_id` is immutable.** It does NOT cover one path: under the `app.allow_org_migration` break-glass (§3.3), an admin **moves a PARENT row's `organization_id`**. The trigger fires on that parent UPDATE but — because the GUC is set — returns early; and even without the early return it only validates the *written* row's own `parent_run_id`, never its children. So a parent org-move silently **strands its existing children cross-org**. This is an inherent limit of a per-row child-side trigger (a parent has no cheap way to enumerate+revalidate children in a BEFORE trigger without an expensive scan + lock-storm). **Mitigations (required, not optional):** (a) the org-migration tool MUST move a parent together with its lineage subtree (children+descendants) in the same break-glass session, never a parent alone; (b) every `app.allow_org_migration` session MUST be followed by the §4.2 cross-org-link audit as a **post-condition** (the same query doubles as the post-break-glass check). The §6 threat model is scoped accordingly: the trigger fences cross-org links created by ordinary child writes (incl. service-role); it does **not** by itself make a careless break-glass parent-move safe.

### 3.5 Concurrency / TOCTOU

The parent's `organization_id` is immutable (blocked by `research_queue_immutable_org_id` except under `app.allow_org_migration`). A concurrent admin org-migration of the parent during a child insert is the only TOCTOU, and it requires the explicit, rare admin flag. **Hardening option (reviewer call):** add `FOR SHARE` to the parent lookup (`SELECT … WHERE id = NEW.parent_run_id FOR SHARE`) to lock the parent against concurrent UPDATE/DELETE for the child-insert's duration. v1 leans toward **including `FOR SHARE`** (cheap, single-row PK lock, closes the window cleanly); reviewers asked to confirm vs. the lock-contention cost on high-fan-out clone bursts (negligible at current volume).

### 3.6 Injection / safety

`NEW.parent_run_id` is a `uuid` bound as a parameter in the `WHERE id =` predicate — no dynamic SQL, no injection surface. `SET search_path = private, public, pg_temp` blocks search-path hijack of an unqualified reference (defense-in-depth; all references here are schema-qualified). `REVOKE ALL … FROM PUBLIC` prevents direct invocation (trigger firing does not check EXECUTE, so this is belt-and-braces).

---

## 4. Component 1 — migration packaging, pre-apply audit, rollback

### 4.1 Migration file conventions (house rules)

- Path `supabase/migrations/<YYYYMMDD>_phase5_parent_same_org_trigger.sql` — **underscore** separator (else `supabase db push` silently skips it).
- **No** file-level `BEGIN`/`COMMIT` (CLI ExecBatch wraps file + history insert in one implicit txn).
- **Plain `SET`**, never `SET LOCAL`, for any session timeout (SET LOCAL warns 25P01 outside an explicit txn and evaporates).
- Apply via `supabase db push` ONLY — never Studio SQL Editor (bypasses migration history).
- Idempotent: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER`.

### 4.2 Pre-apply audit — existing cross-org links (BLOCKING gate before apply)

The trigger is `BEFORE INSERT/UPDATE` only; it does **not** retroactively validate existing rows. A latent cross-org link already in the table would survive. The migration MUST be preceded by (and the migration header documents) this audit:

```sql
-- Run read-only BEFORE apply. Expected result: 0 rows.
SELECT c.id AS child_id, c.organization_id AS child_org,
       p.id AS parent_id, p.organization_id AS parent_org
FROM public.research_queue c
JOIN public.research_queue p ON p.id = c.parent_run_id
WHERE c.organization_id IS DISTINCT FROM p.organization_id;
```

Prod has exactly one org (system-default), so the expected count is **0**. If it ever returns rows, those must be remediated (re-parent or null `parent_run_id`) **before** apply — otherwise the boundary the trigger asserts is already violated in stored data.

**Decision (G-INFO-1): this audit is encoded as a fail-loud preflight `DO` block at the TOP of the migration** (mirrors B-2 §1), so a dirty state aborts the apply atomically rather than relying on an operator to run the manual query:

```sql
-- Phase 5 §0 preflight — abort if any cross-org lineage link already exists.
-- BEFORE-triggers do NOT retroactively validate stored rows, so a pre-existing
-- violation would survive the migration. Fail loud instead.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
  FROM public.research_queue c
  JOIN public.research_queue p ON p.id = c.parent_run_id
  WHERE c.organization_id IS DISTINCT FROM p.organization_id;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Phase 5 precondition violated: % existing cross-org parent links found — remediate before applying the trigger', v_bad;
  END IF;
END $$;
```

The block runs inside the same CLI-wrapped implicit transaction as the trigger DDL, so an abort leaves nothing partially applied.

### 4.3 Rollback

Additive, no data mutation:

```sql
DROP TRIGGER IF EXISTS research_queue_parent_same_org ON public.research_queue;
DROP FUNCTION IF EXISTS private.research_queue_parent_same_org();
```

No RLS change, no column change, no backfill — strictly reversible.

---

## 5. Component 2 — `test-ssr-auth-cutover.sh` (design)

### 5.1 Mechanism: two fixture regimes against a NON-PROD target (restructured per C-CRIT-1)

v2 tried to run everything inside one rolled-back psql transaction. Codex (C-CRIT-1) showed that cannot work for the storage proof: **uncommitted psql fixtures are invisible to the HTTP app** (it uses its own pooled DB connection + the Supabase Storage API), and **psql cannot roll back storage objects**. So the harness uses two regimes over a **single committed non-prod seed**, never against prod.

> **Hard prod guard (required).** The harness aborts (exit 2) unless `DATABASE_URL` points at a NON-PROD project — it asserts the host/ref is NOT the prod ref `mfjgoghlpqgxcycxoxio`. The seed is *committed*, so running it against prod would inject phantom orgs/users/storage. The harness also requires an explicit `DR_TEST_ENV=nonprod` env acknowledgement.

**Setup (committed seed — run once at harness start):**

1. Create two users via the **Supabase Admin API** `supabase.auth.admin.createUser({ email, email_confirm: true })` (the exact call `agent/scripts/phase-a-bootstrap-primary-user.ts:192` uses — NOT a raw `auth.users` SQL insert, which is the C-MAJ-1 correction). Capture `U_A`, `U_B`.
2. `INSERT` two orgs (`O_A`, `O_B`), then two `organization_members` (owners — org-before-member order satisfies the min-owner CONSTRAINT trigger; `om_one_org_per_user` UNIQUE holds since each user joins one org), then a run per org (`R_A`, `R_B`). All committed.
3. Upload one real storage object under each org's prefix via `scopedStoragePath`: `<O_A>/<slug_A>/probe.txt`, `<O_B>/<slug_B>/probe.txt`. Committed (Storage API).

**Regime 1 — psql RLS matrix (§5.2)** runs against the committed seed. Each *mutating* assertion (INSERT/UPDATE/DELETE attempts) is wrapped in `SAVEPOINT s; … ; ROLLBACK TO SAVEPOINT s;` so the seed is never polluted; read assertions see the committed seed directly. Identity emulation per test:

```sql
-- emulate authenticated user A
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','<U_A>','role','authenticated')::text, true);
--   ... §5.2 X*/A*/P* read assertions; mutating ones inside SAVEPOINT ...
RESET ROLE;

-- emulate anon  → SET LOCAL ROLE anon;  (no claims)  → §5.2 A* ; RESET ROLE;

-- emulate the GENUINE service_role (G-CRIT-1) — NOT the table owner.
-- service_role is the real Supabase role with the BYPASSRLS attribute + its own
-- GRANT set; SET ROLE adopts both, faithfully exercising the boundary the
-- trigger must fence. The table owner is superuser-on-object and would prove
-- nothing about the real service_role path.
SET LOCAL ROLE service_role;
--   ... §5.2 P1b (cross-org parent INSERT must RAISE even with RLS bypassed) ...
RESET ROLE;
```

**Regime 2 — HTTP Tier-1 storage probe (§5.3)** runs against a **running non-prod deployment** (or `next dev`) pointed at the same seeded project, using a real session for user A (minted via the localhost dev session-mint, `reference_localhost_dev_session_mint`, or a non-prod magic-link). It hits the live file-serving routes — see §5.3.

**Teardown (always, even on failure — trap):** delete the two storage probe objects; `DELETE` the orgs (cascades members/runs via FK); `supabase.auth.admin.deleteUser(U_A/U_B)`. Idempotent; safe to re-run.

Notes: `set_config(…, true)` is transaction-local; `auth.uid()` resolves from `request.jwt.claims->>'sub'` (Supabase definition — verify the helper reads the JSON `claims` form, not the dot-path `claim.sub` form, against `auth_user_organization_id()` at build time). The seed's slugs use a `dr-test-` prefix + random suffix so they are visibly synthetic and collision-free. **Optional second-connection check:** a `SERVICE_ROLE_DATABASE_URL` (connecting *as* `service_role` rather than `SET ROLE`-ing into it) additionally exercises the role's connection-default search_path/role-membership; treated as optional belt-and-braces over the required `SET LOCAL ROLE service_role`.

### 5.2 RLS-bypass matrix (the required core)

For orgs A/B and owners U_A/U_B:

| # | Identity | Action | Expected | Asserts |
|---|---|---|---|---|
| X1 | U_A | `SELECT count(*) FROM research_queue` | only A's rows (B invisible) | rq_select scoping |
| X2 | U_A | `SELECT count(*) FROM research_queue WHERE organization_id='<OB>'` | **0** | no cross-org read |
| X3 | U_A | `INSERT … organization_id='<OB>'` | **error** (WITH CHECK) | rq_insert can't forge org |
| X4 | U_A | `UPDATE research_queue SET status='x' WHERE organization_id='<OB>'` | **0 rows** | rq_update USING hides B |
| X5 | U_A | `DELETE FROM research_queue WHERE organization_id='<OB>'` | **0 rows** | rq_delete USING hides B |
| X6 | U_A | `SELECT count(*) FROM organization_members WHERE organization_id='<OB>'` | **0** | om_select scoping |
| X7 | U_A | `SELECT count(*) FROM organizations WHERE id='<OB>'` | **0** | orgs_select scoping |
| X8 | U_A | `SELECT count(*) FROM organization_invitations WHERE organization_id='<OB>'` | **0** | oi_select scoping |
| X9 | U_A | `SELECT count(*) FROM audit_storage_writes WHERE organization_id='<OB>'` | **0** | asw_select scoping |
| A1 | anon | `SELECT count(*) FROM research_queue` | **0** | default-deny (no anon policy) |
| A2 | anon | same for the other 4 perimeter tables | **0** each | default-deny perimeter-wide |
| P1 | U_A (authenticated) | `INSERT … organization_id='<OA>', parent_run_id='<RB>'` | **error** (Component 1 trigger) | cross-org lineage blocked, authenticated path |
| P1b | **genuine `service_role`** (§5.1) | `INSERT … organization_id='<OA>', parent_run_id='<RB>'` | **error** (Component 1 trigger) | trigger fires even when RLS is bypassed — the core claim |
| P2 | U_A | `INSERT … organization_id='<OA>', parent_run_id='<RA>'` | **success** | same-org lineage allowed |
| P3 | `service_role` + `SET app.allow_org_migration='true'` then P1b | **success** | escape hatch works |

P1–P3 are the cross-link that makes the harness validate Component 1 on its first run (the reason both ship together). **P1b is the load-bearing case (G-CRIT-1):** it runs as the genuine `service_role` (which has `BYPASSRLS`), proving the trigger fences the service-role vector that RLS cannot — exercising the real role, not the over-privileged table owner.

### 5.3 Storage isolation coverage (restructured per G-CRIT-2)

**The storage tenant boundary is the API route layer, not DB RLS** (§1.4): there are no `storage.objects` policies; isolation comes from each route deriving org context and `.eq("organization_id", orgId)` *before* it mints a signed URL or lists objects. So the authenticated **cross-tenant route probe is the primary, required proof** — catalog assertions alone (which only show the bucket is private) would give a *false* sense of security because they cannot catch a route that mints a signed URL for a foreign-org path.

**Tier 1 — required authenticated cross-org route probe (the real boundary).** Using a genuine session for user A (minted via the localhost dev session-mint, ref `reference_localhost_dev_session_mint`, or a real magic-link session against a non-prod target), attempt to reach **org B's** objects through the file-serving routes:

| # | Probe (as authenticated session A) | Expected | Asserts |
|---|---|---|---|
| T1 | `GET /api/runs/<orgB-slug>/files` | `403`/`404` (not B's file list) | route org-scopes the listing |
| T2 | `GET /api/runs/<orgB-slug>/manifest` | `403`/`404` | manifest route org-scoped |
| T3 | `GET /api/runs/<orgB-slug>/file/<name>` (would mint a signed URL) | `403`/`404`, **no signed URL issued** | signed-URL mint refuses foreign-org path |
| T4 | `GET /api/runs/<orgA-slug>/files` (own org) | `200` + A's files | positive control (probe is wired correctly) |

T1–T3 exercise the **session-derived `<orgId>/<slug>/` path-prefix invariant** (C-MIN-1 correction): the routes resolve `orgId` from session A via `requireOrgOr401()` (NOT the retired `getOrgContextDualPath`), so a foreign-org slug resolves under `<orgA>/…` and 404s — the org prefix is structurally un-spoofable because it is never request-supplied. The probe proves a future route refactor never lets `orgId` become caller-controlled. (Implementation note: this tier needs the running non-prod app + a real session from the §5.1 seed; the harness runs it when `BASE_URL` + a session cookie/JWT are provided, and **skips with a loud `[SKIP] storage Tier 1 — no session provided`** otherwise, so a green run never *silently* omits the primary proof.)

**Tier 2 — always-on catalog backstop (no fixture, no session).** Cheap invariants that must hold for Tier 1's assumptions to be valid:

| # | Query | Expected | Asserts |
|---|---|---|---|
| S1 | `SELECT public FROM storage.buckets WHERE id='research-projects'` | `false` | bucket is private (no anon object reads at all) |
| S2 | `SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND cmd IN ('SELECT','ALL') AND permissive='PERMISSIVE' AND (roles && ARRAY['anon','authenticated','public']::name[] OR roles = '{public}')` | **0** | no permissive read policy opened storage to client roles — **includes `public`** (C-MAJ-2: a `TO public` policy applies to anon+authenticated but would be missed by an anon/authenticated-only role check) |

**Tier 3 — optional anon HTTP probes (`--http`, network-coupled, default OFF).**

| # | Probe | Expected | Asserts |
|---|---|---|---|
| H1 | `curl -s -o /dev/null -w '%{http_code}' https://dynamic-research.vercel.app/api/runs` | `401` | anon API denied (matches manual S148 check) |
| H2 | `curl … https://dynamic-research.vercel.app/` | `307` | unauthenticated root redirect |
| H3 | unsigned GET to a `…supabase.co/storage/v1/object/research-projects/<path>` | `400`/`403` | no unsigned object read |

Tier 2 is the deterministic CI-safe portion; Tier 1 is the security-load-bearing portion and is **required** whenever a session is available (and its absence is surfaced loudly, never silently skipped); Tier 3 is opt-in.

### 5.4 Harness contract

- Usage: `DATABASE_URL=<non-prod> DR_TEST_ENV=nonprod [BASE_URL=… SESSION=…] bash agent/scripts/test-ssr-auth-cutover.sh [--http]`. The Admin-API seed needs the non-prod project's `SUPABASE_URL` + `SERVICE_ROLE_KEY` (read from a non-prod `.env`, never echoed — the gemini-review.mjs key-handling pattern).
- Exit `0` all-pass / `1` one+ fail (name + reason to stderr) / `2` env/dependency/guard error — same contract as `test-phase-b-rls.sh`.
- Requires `psql` + `node`/`tsx` (Admin-API seed/teardown) (+ `curl` for Tier-3).
- **NOT side-effect-free** (the v2 "rolled-back txn" claim is retired per C-CRIT-1): it creates a *committed* seed on a NON-PROD project and tears it down in a `trap`. The hard prod-ref guard (§5.1) makes running against prod impossible. The psql RLS matrix isolates its *mutations* via `SAVEPOINT`/`ROLLBACK TO`, so it leaves the seed intact for the HTTP tier.
- **Not** added to the root `pnpm test` chain (needs a non-prod DB + service-role key + optionally a running app; `pnpm test` is offline/unit). It is a manually-invoked gate, run at the SSR-auth cutover and whenever RLS policies / the file-serving routes change.

### 5.5 auth.users fixture — Admin API, not SQL (C-MAJ-1 correction)

v2 wrongly stated the harness inserts `auth.users` rows directly with a "known-good column set from `phase-a-bootstrap-primary-user.ts`." That file does **not** do a SQL insert — it calls the **Supabase Admin API** `sb.auth.admin.createUser({ email, email_confirm: true })` (`:192-195`). The harness does the same: it creates the two fixture users via the Admin API (committed, outside any psql txn), which satisfies the `organization_members.user_id` → `auth.users(id)` FK (`20260522_phase_a_multi_tenancy.sql:92-95`) without coupling to GoTrue's internal `auth.users` column shape (which GoTrue evolves). Teardown uses `sb.auth.admin.deleteUser(id)`. This is the harness's only external-service coupling and it reuses an already-proven call site — no fragile hand-rolled `auth.users` DML. (Because users are now committed, they exist for the duration of the run; the prod-ref guard + non-prod requirement keep this off production.)

---

## 6. Threat model summary

| Vector | Pre-Phase-5 control | Gap | Phase 5 control |
|---|---|---|---|
| Authenticated user clones a foreign-org run via UI | route `.eq(org)` + rq_insert WITH CHECK | parent_run_id unconstrained by RLS; FK check ignores RLS | parent-same-org trigger (fires for all roles) |
| Service-role / worker bug links child to foreign parent | none (service-role bypasses RLS) | **open** | parent-same-org trigger, proven by harness P1b (genuine `service_role`) |
| Direct SQL / admin script cross-org link **at child write** | none | **open** | parent-same-org trigger (+ §0 fail-loud pre-apply audit for existing rows) |
| Break-glass parent org-move strands existing children (GUC set) | none | **NOT covered by the trigger** (C-MAJ-3) | child-side trigger can't see it → mitigated procedurally: org-migration tool moves the whole subtree + mandatory post-GUC §4.2 audit (§3.3/§3.4) |
| Anon reads tenant rows | RLS default-deny (untested) | unproven | harness A1/A2 |
| Cross-org authenticated read | RLS policies (untested) | unproven | harness X1–X9 |
| Authenticated user reaches a foreign-org storage path | session-derived `<orgId>/<slug>/` prefix (untested) | unproven (the primary storage vector) | harness Tier-1 T1–T3 (proves orgId stays session-derived) |
| Unsigned/anon storage read | private bucket + path scoping (untested) | unproven | harness Tier-2 S1/S2 + Tier-3 H1–H3 |
| SSR-auth cutover ships a hidden isolation regression | none | **open** | harness as cutover gate |

---

## 7. MRPF classification

- **Event Gate:** DESIGN (new DB trigger on the tenant boundary + a security test harness; architectural). → Gemini + Codex mandatory, sequential, both-lenses-adversarial. Companion `Documentation/phase5-parent-same-org-and-rls-harness-design-gate-peer-review.md`.
- **Risk Labels:** SECURITY (tenant isolation — blocking semantics on CRITICAL), DATA (trigger gates `research_queue` inserts), ARCHITECTURE (tenant-boundary contract). AGENT BEHAVIOR / PRIVACY / INFRA / DEPENDENCY: no.
- **Severity:** NORMAL.
- **Topology:** Gemini holistic-adversarial (whole-artifact "strongest case to BLOCK") → integrate → Codex grounded-adversarial (file:line against the migrations/code this references) → integrate → v-final. Per project §11, the eventual **MERGE gate** for the migration is a separate full tri-vendor gate that must clear **before** any prod apply (agent/prod-deploy HARD RULE) — but Phase 5's migration is **PARKED** for a human-present session regardless.
- **DESIGN-gate Codex-unavailable note:** if Codex is quota/offline during *this DESIGN gate*, the MRPF substitute hierarchy is permitted (run substitutes now, owe the real Codex pass <24h) — §11's hold-for-agent-PROD applies to the MERGE/deploy gate, not this DESIGN gate.

---

## 8. Open questions for reviewers

> Resolved by Gemini round 1 and removed from this list: old #2 (`OF` narrowing → adopted into core, §3.2), old #3 (pre-apply audit → now a fail-loud preflight block, §4.2), old #5 (service-role emulation → now genuine `SET ROLE service_role`, §5.1/§5.2).

1. **`FOR SHARE` on the parent lookup** (§3.5) — include it (v1 leans yes) or rely on org-immutability alone?
2. **God-mode GUC hardening scope** (§3.3, G-MAJ-1) — accept keeping the bare `app.allow_org_migration` GUC for Phase 5 (with the client-unreachability mitigation) and tracking the admin-gated-enabler hardening as a B-1-touching fast-follow, or insist the hardening lands *with* Phase 5?
3. **Non-prod target provisioning** (§5.1) — v3 requires a NON-PROD Supabase project for the committed seed (users via Admin API, real storage objects). Does a suitable non-prod project/branch exist, or does Phase 5 implementation need to stand one up first? (This is now the harness's main prerequisite, replacing the resolved v2 `auth.users`-SQL-shape question — C-MAJ-1 settled it on the Admin API.)
4. **Storage Tier-1 target** (§5.3) — run the required authenticated cross-org route probe against localhost dev (session-mint) only, or also against a non-prod deployed target? (Prod is excluded — no fixture orgs there.)
5. **Naming** — the file is `phase5-parent-same-org-and-rls-harness-design.md` but the content is the trigger + harness (canonicalisation is OUT, §2.3). Keep the handoff-continuity name, or rename to `phase5-parent-same-org-and-rls-harness-design.md`?
```
