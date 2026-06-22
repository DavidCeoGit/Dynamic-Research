# Phase 5 GUC-Hardening — `tenancy_admin`-gated `org_migration_enabled()` (DESIGN)

> Fast-follow to Phase 5 (decision #2, `phase5-decisions-s150.md`). DESIGN-only artifact for the §11 DESIGN gate. Implementation (local apply → harness P3/P3b/P3c green → MERGE gate → merge → prod apply) is a separate session. **Status: v3-FINAL (DESIGN gate CLEARED — Gemini ENDORSE + Codex BLOCK fully integrated + empirical faithful-probe confirmation, S152).**

---

## 0. Problem

Both tenant-boundary triggers on `public.research_queue` share a single, **bare** escape hatch:

```sql
COALESCE(current_setting('app.allow_org_migration', true), 'false') = 'true'
```

- `research_queue_immutable_org_id()` (B-1, `20260523_phase_b_auth_rls_helpers.sql` §4) — blocks `organization_id` mutation on UPDATE.
- `research_queue_parent_same_org()` (Phase 5, `20260621_phase5_parent_same_org_trigger.sql`) — blocks cross-org `parent_run_id` lineage on INSERT/UPDATE.

The flag is a **god-mode** override: any session that can run `SET app.allow_org_migration='true'` disables **both** tenant boundaries. The Phase 5 design's client-unreachability analysis established the flag is not reachable from the PostgREST/supabase-js surface — only server-side raw-SQL paths can set it. But Phase 5 *widens the blast radius* of that single flag (it now also gates lineage), so decision #2 made hardening an **owed, tracked** fast-follow: add a second factor so that *setting the GUC is necessary but not sufficient* — the caller must also be an authorized tenancy admin.

**Goal:** decouple "**can set** the GUC" (any server-side raw-SQL path) from "**is authorized** to migrate a tenant boundary" (must be a `tenancy_admin`), across **both** triggers, in one migration — without breaking the legitimate break-glass workflow.

---

## 1. Mechanism (dedicated `tenancy_admin` role)

A NOLOGIN marker role `tenancy_admin` + a two-factor helper `private.org_migration_enabled()` returning:

```
app.allow_org_migration = 'true'   AND   pg_has_role(session_user, 'tenancy_admin', 'MEMBER')
```

Both triggers swap their bare check for `private.org_migration_enabled()` (B-1: `NOT private.org_migration_enabled()`; Phase 5: `IF private.org_migration_enabled() THEN RETURN NEW`).

### 1.1 Why `session_user`, not `current_user` (central correctness pivot)

| Frame | `current_user` | `session_user` |
|---|---|---|
| Direct admin psql (`postgres`) | postgres | postgres |
| App: PostgREST login `authenticator` → `SET ROLE service_role` | service_role | **authenticator** |
| Inside the **SECURITY DEFINER** trigger | **owner (postgres)** | (unchanged from caller) |

`current_user` is **wrong** for the gate: inside a SECURITY DEFINER trigger it is the function owner (`postgres`), so a `current_user`-based check would be satisfied by the *definer* identity regardless of who called — trivially bypassable. `session_user` is the original authenticated LOGIN role and is **immutable across SECURITY DEFINER and `SET ROLE` frames** (Gemini + Codex both confirmed empirically), so it faithfully identifies the human/tool that opened the connection.

Real-world semantics that fall out of the `session_user` anchor:

- **App (worker / API routes)** reaches the DB as PostgREST login `authenticator`, then `SET ROLE service_role`. `session_user = authenticator`, which is **not** a `tenancy_admin` member → gate is **closed even if the app sets the GUC**. This is the security win — empirically confirmed (§3.3 P3b).
- **Direct admin break-glass** connects as `postgres`, an explicit `tenancy_admin` member (§1.2) → gate opens.
- **Future dedicated admin tool** logs in as its own role granted `tenancy_admin` → gate opens for it specifically.

**Assumption (stated for the gate):** the org-migration tool is a **direct-connection** server-side path (raw SQL as a member login role), NOT a PostgREST path. Decision #2 / B-1 already describe the flag as "reserved for an explicit admin tenancy-migration tool" set via server-side raw SQL, never via PostgREST routes — so a direct-connection `session_user` is the correct anchor. *(Gemini Finding 1: ENDORSED as correct and complete across all frames.)*

### 1.2 Membership model — **the `postgres`-superuser correction (Codex C-MAJ-2)**

The v1 design assumed superusers auto-pass `pg_has_role(...,'MEMBER')` so `postgres` would be the implicit "ultimate break-glass." **Grounded against the live Supabase replica this is FALSE:** on Supabase the `postgres` role is **NOT a superuser** (only the internal `supabase_admin` is — verified: `rolsuper` is `t` for `supabase_admin`, `f` for `postgres`). So `postgres` does **not** implicitly satisfy the role check, and a break-glass session as `postgres` + GUC would be wrongly **blocked**.

**Resolution:** the migration explicitly `GRANT tenancy_admin TO postgres`. `postgres` is the canonical Supabase admin/break-glass identity (dashboard SQL editor / direct admin connection), so it must be an explicit member. The app roles (`anon` / `authenticated` / `service_role` / `authenticator`) are deliberately **not** members — their non-membership is precisely what blocks the app.

- `tenancy_admin` is **NOLOGIN** — a marker, nobody authenticates *as* it.
- A future admin tool becomes able to break-glass via `GRANT tenancy_admin TO <its direct-connection login role>` — a deliberate, auditable act outside this migration.

### 1.3 Helper + trigger privilege model — **the grant/ownership correction (Codex C-CRIT-1/C-CRIT-2 + S152 self-probe)**

The v1 design assumed `authenticated` + `service_role` already held `private` USAGE and granted the helper `EXECUTE` to them. **Grounded, this was wrong on two counts:**

1. **`authenticated` lost `private` USAGE.** A later shipped migration (`20260611000000_phase_a_notifications_ntfy_webhook.sql:109`) ran `revoke all on schema private from public, anon, authenticated; grant usage on schema private to postgres, service_role`. So an `authenticated`-invoker call into `private.*` fails with *permission denied for schema private*. Re-granting `authenticated` private USAGE here would silently **undo** that hardening.
2. **`CREATE OR REPLACE` does not change an existing function's owner**, and the helper's owner = whoever runs the migration. So a postgres-owned trigger calling a (possibly supabase_admin-owned) helper under `REVOKE ALL FROM PUBLIC` hits *permission denied for function org_migration_enabled* at fire time — **empirically reproduced S152**.

**Resolution (two coupled changes):**

- **Make the B-1 trigger `SECURITY DEFINER`** (it was INVOKER). The shipped trigger fns are owned by `postgres` (verified `pg_proc.proowner`), and `CREATE OR REPLACE` preserves that owner. As DEFINER, B-1's call to the helper runs as `postgres` (who holds `private` USAGE), so **no app-role grant is needed** and the ntfy hardening stays intact. B-1's body reads only `OLD`/`NEW` + `RAISE`s (no table access), so DEFINER introduces no privilege-escalation surface; the gate still keys on `session_user`, so the boundary is unchanged. Both triggers are now DEFINER → uniform mental model.
- **`GRANT EXECUTE ON FUNCTION private.org_migration_enabled() TO postgres`** — the confirmed trigger-owner — so the trigger→helper call works regardless of the migration-runner's identity. `REVOKE ALL FROM PUBLIC` (defense-in-depth: app roles cannot call the helper directly). No grant to app roles.

Helper hardening retained: `SECURITY INVOKER` (default; runs as its caller = the DEFINER trigger's owner postgres), `STABLE`, `LANGUAGE sql`, `SET search_path = pg_catalog, pg_temp`. *(Gemini Finding 2 + Codex INFO: schema-qualified calls + pinned search_path block search_path hijack.)*

> **IMPL-VERIFY at the MERGE gate:** confirm prod trigger-fn ownership == `postgres` (the EXECUTE grantee). If Supabase owns them as another role, grant EXECUTE to that role too.

### 1.4 B-1 message de-oracle (folded in)

B-1's shipped exception text leaks the bypass-flag name: `'... is immutable (set app.allow_org_migration=true to override)'`. The swap replaces it with the generic `'research_queue.organization_id is immutable'` (parity with the Phase 5 trigger's oracle-safe message). A real information-leak fix that belongs with this trigger rewrite.

---

## 2. The migration (proposed artifact)

`supabase/migrations/20260622_phase5_guc_hardening_tenancy_admin.sql` (full text in `sandbox/`). Sections: §1 idempotent `CREATE ROLE tenancy_admin NOLOGIN` + `GRANT tenancy_admin TO postgres`; §2 `private.org_migration_enabled()` + `REVOKE FROM PUBLIC` + `GRANT EXECUTE TO postgres`; §3 `CREATE OR REPLACE` B-1 trigger fn (now SECURITY DEFINER, helper + generic message); §4 `CREATE OR REPLACE` Phase 5 trigger fn (helper predicate only; SQL semantics otherwise identical).

### 2.1 Filename / ordering rationale (load-bearing)

Date is **`20260622`** (one day after the `20260621` Phase 5 trigger), deliberately:

1. **Version-token collision** — a same-date `20260621_*` sibling collides on the supabase version token `20260621` and the second file is **silently skipped** (`feedback_supabase_migration_version_collision_silent_skip`).
2. **Rebuild ordering** — on a fresh rebuild, files sort lexicographically. Digits (`0`–`9`, 0x30–0x39) sort **before** `_` (0x5f). A longer same-date name like `20260621120000_guc...` has a **digit** where `20260621_phase5_parent_same_org_trigger.sql` has `_`, so it sorts **first** (runs before the Phase 5 file). Its §4 `CREATE OR REPLACE` would then be **overwritten** by the Phase 5 file's bare-GUC body → hardening silently lost on rebuild. A strictly-greater **date** is the only filename under `YYYYMMDD_` that yields both a distinct token **and** correct after-Phase-5 ordering. *(Gemini G-MIN-1 corrected the ASCII direction in this paragraph; Codex INFO confirmed the conclusion sound.)*

> The 2026-06-22 date is a sequencing device, not a claim about when it is authored/applied (today is 2026-06-21). Documented inline in the migration header.

### 2.2 Idempotency / re-runnability

`CREATE ROLE` guarded by `pg_roles` existence check; `GRANT` is idempotent; helper + both trigger fns are `CREATE OR REPLACE`. Re-running is a no-op. No data writes, no DDL on tables.

---

## 3. Harness coupling

### 3.1 The `SET SESSION AUTHORIZATION` requirement (Codex C-MAJ-1)

`agent/scripts/test-ssr-auth-cutover.sh` P3 (and `agent/scripts/test-phase-b-rls.sh` T7c) exercise the escape hatch with `SET LOCAL ROLE service_role` / a bare GUC over the `postgres` connection. **`SET ROLE` changes `current_user`, NOT `session_user`** — the gate keys on `session_user`, so to faithfully exercise the role factor the escape-hatch tests must use **`SET SESSION AUTHORIZATION`** (changes `session_user`; superuser-only; reverts on `ROLLBACK`).

Critically, **`SET SESSION AUTHORIZATION` requires a true superuser connection**, and on local Supabase `postgres` is NOT superuser — `supabase_admin` is. So the escape-hatch arm must connect with the **`supabase_admin` superuser** URL (`postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres`), assert `current_setting('is_superuser')='on'` up front, and assert `session_user` is the intended role before checking the expected outcome (so a test cannot pass for the wrong reason).

### 3.2 Required harness changes (design — built at IMPL)

- **P3 (positive, member can override) — retarget.** `SET SESSION AUTHORIZATION postgres` (a `tenancy_admin` member) + GUC → cross-org lineage **PERMITTED**.
- **P3b (NEW, negative — the load-bearing assertion).** `SET SESSION AUTHORIZATION service_role; SET app.allow_org_migration='true';` → cross-org lineage **STILL BLOCKED** (service_role is not a member). Symmetric arm for the B-1 UPDATE path. Assert `session_user='service_role'` before the block check.
- **P3c (NEW, negative — B-1 message).** Assert the B-1 exception text no longer contains `allow_org_migration`.
- **`test-phase-b-rls.sh` T7c (Codex C-INFO+).** This second harness also asserts the bare GUC permits B-1 org mutation. Because the migration `GRANT tenancy_admin TO postgres` and T7c runs over the `postgres` connection (`session_user=postgres` ∈ tenancy_admin), T7c continues to **pass as-is**; add a sibling negative case (`SET SESSION AUTHORIZATION service_role` + GUC → blocked) so the hardening is actually asserted there too.
- The existing **role-firing** tests (P1/P1b/P2/P4/P4b/P5) assert the trigger blocks with **no** GUC set — `org_migration_enabled()` returns false unconditionally there, so they are **unaffected** by the swap.

### 3.3 Empirical grounded validation (S152 self-probe — through the REAL trigger)

The v3 migration was applied inside a rolled-back transaction on the local replica and the **actual** Phase 5 SECURITY DEFINER trigger was fired via cross-org `INSERT`s under different `session_user`s (`SET SESSION AUTHORIZATION` on the `supabase_admin` superuser connection):

| Probe | `session_user` | GUC | Outcome | Meaning |
|---|---|---|---|---|
| **P3b** | `service_role` (app) | set | **BLOCKED** | App cannot escape even with the GUC — the security win |
| **P3** | `postgres` (member) | set | **PERMITTED** | Break-glass works for a member |
| NOGUC | `service_role` | unset | **BLOCKED** | Baseline |

Plus the direct helper check: `session_user=postgres` + GUC → `org_migration_enabled()` = **t**; both trigger fns confirmed `prosecdef=t` (DEFINER). This validates the whole v3 direction end-to-end through the real trigger→helper path, including the `GRANT EXECUTE TO postgres` fix (without it, the postgres-context call hit *permission denied*, reproduced then resolved S152).

---

## 4. Compensating control during/after

Decision #2's interim compensating control (the mandatory post-GUC §4.2 cross-org-link audit on any break-glass session) **remains owed** and is inherited by the not-yet-built org-migration tool's own DESIGN gate. This hardening reduces *who* can break-glass; it does **not** replace the audit that catches the inverse parent-move-strands-children case (which a child-write-time trigger structurally cannot see).

---

## 5. Risk classification (§11)

- **Event gate:** DESIGN (this doc, CLEARED) → then MERGE (the migration + harness) at IMPL.
- **Risk labels:** SECURITY (tenant-boundary override path), DATA (alters integrity-trigger behavior on `research_queue`), AGENT BEHAVIOR (changes a security control the worker's writes pass through), ARCHITECTURE (touches B-1's shipped contract — incl. flipping it to SECURITY DEFINER).
- **Severity:** NORMAL.
- **Topology:** sequential both-lenses-adversarial — Gemini holistic (ENDORSE) → integrate v2 → Codex grounded on v2 (BLOCK) → integrate + empirical probe → v3-FINAL.
- **Tests?** Yes — the harness P3/P3b/P3c arm + T7c sibling is the automated coverage for the new control; designed §3.2, built at IMPL; the §3.3 probe is interim grounded evidence.

---

## 6. Open questions — DISPOSITIONS after the gate

1. **`session_user` vs `current_user` anchor** — RESOLVED: correct & complete across all frames (Gemini Finding 1; empirical §3.3).
2. **`tenancy_admin` vs JWT-claim / allow-list** — RESOLVED: role chosen (decision #2); gate did not contest it.
3. **EXECUTE grant scope** — RESOLVED: `GRANT EXECUTE TO postgres` (trigger owner) + both triggers DEFINER; no app-role grant (Codex C-CRIT-1/2 + §3.3 probe).
4. **`SET SESSION AUTHORIZATION` to NOLOGIN `service_role`, ROLLBACK-revert** — RESOLVED: valid on a superuser connection; reverts (Codex confirmed; §3.3 used it).
5. **Superuser-passes-implicitly** — SUPERSEDED: on Supabase `postgres` is not superuser, so the design uses an **explicit** `GRANT tenancy_admin TO postgres` instead of relying on implicit superuser pass (Codex C-MAJ-2).
6. **Helper `SECURITY INVOKER` vs `DEFINER`** — RESOLVED: INVOKER is correct; the *triggers* carry DEFINER and call the helper as owner (Gemini Finding 2; §3.3 probe).

---

## 7. Implementation checklist (next session, NOT this one)

1. `/promote` the migration + this doc + the peer-review companion.
2. Build the harness changes (sandbox → /promote): P3 retarget + P3b/P3c on a `supabase_admin` superuser connection; `test-phase-b-rls.sh` T7c sibling.
3. Apply the migration to LOCAL (`docker exec … psql < migration`); run the full harness (24/24 + new arm) → green.
4. Full tri-vendor **MERGE** gate on the real SQL + harness (fresh Gemini → Codex sequential; the §3.3 probe is evidence, not a substitute for the MERGE gate). **IMPL-VERIFY:** prod trigger-fn ownership == `postgres`.
5. Merge on clean; **prod apply via `supabase db push --linked` only with explicit human confirm** (not in standing auth).
6. Memory: update `project_phase5_design_gate_s148` (GUC fast-follow → built/applied), `reference_local_supabase_nonprod_target` (the `supabase_admin` superuser connection + `SET SESSION AUTHORIZATION` technique + the `GRANT EXECUTE TO postgres` ownership gotcha).
