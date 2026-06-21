# Phase 5 — open design-decision close-out (S150)

> **Scope:** DECISIONS ONLY. No code, no migration, no gate, no deploy, no promote, no
> reviewers. This file resolves the open reviewer questions left at the end of the
> Phase 5 DESIGN gate (v3-FINAL, S148) so the eventual implementation session starts
> warm. Authored 2026-06-21 (S150).
>
> **Source design:** `Documentation/phase5-parent-same-org-and-rls-harness-design.md` (v3-FINAL).
> **Companion gate trail:** `Documentation/phase5-parent-same-org-and-rls-harness-design-gate-peer-review.md`.
>
> **Implementation remains PARKED** for a human-present session (the migration is
> DATA + SECURITY, prod-irreversible). The eventual MERGE gate is a separate full
> tri-vendor gate that must clear before any prod apply (§11 agent-prod HARD RULE).
> These decisions do not unpark anything; they pre-resolve the design forks so the
> implementing session is not re-litigating them.

---

## Decision #1 — `FOR SHARE` on the parent lookup (design §3.5)

**DECISION: Include `FOR SHARE`.** The parent lookup becomes:

```sql
SELECT organization_id INTO v_parent_org
FROM public.research_queue
WHERE id = NEW.parent_run_id
FOR SHARE;
```

**Rationale**

1. **It closes a cross-session TOCTOU the FK does not.** Inserting a child takes an
   *implicit* `FOR KEY SHARE` lock on the parent via referential integrity, but
   `FOR KEY SHARE` only blocks key-column changes and DELETEs — it permits a
   concurrent plain `UPDATE` of the non-key `organization_id`. An explicit
   `FOR SHARE` blocks that org-move UPDATE too. Without it, a separate admin
   break-glass session (with `app.allow_org_migration='true'`) could move the
   parent's org *between* the trigger's read and the child's commit, producing a
   cross-org lineage link with no error raised.
2. **The cost is negligible and the "high-fan-out clone burst" worry is a non-issue.**
   `FOR SHARE` is a *shared* row lock: shared locks are mutually compatible, so N
   concurrent children of the same parent do **not** serialize against one another.
   It is a single-row, PK-indexed lock. The only thing it blocks is an exclusive
   UPDATE/DELETE of the parent — i.e. the rare admin org-move, which is exactly the
   contention we want to serialize.
3. **Consistency with the trigger's purpose.** The trigger exists purely as
   defense-in-depth against rare bypass vectors (service-role, direct SQL,
   break-glass races). Declining a near-free lock that tightens precisely that
   surface would be inconsistent with why the trigger is built at all.

**Guardrail (do not over-read this decision)**

`FOR SHARE` makes only the **child-write side** read a consistent parent org. It does
**nothing** for the inverse C-MAJ-3 case — an admin moving a *parent* row and stranding
its *existing* children cross-org. That case is structurally invisible to a child-side
trigger and stays mitigated procedurally: the org-migration tool must move the whole
lineage subtree in one break-glass session, and the mandatory post-GUC §4.2
cross-org-link audit (§3.3 / §3.4) remains required regardless. `FOR SHARE` narrows the
child-insert race; the audit covers the parent-move case. Neither substitutes for the
other.

---

## Decision #2 — God-mode GUC hardening scope (design §3.3, G-MAJ-1)

**DECISION: Keep the bare `app.allow_org_migration` GUC in Phase 5** (parity with B-1's
`research_queue_immutable_org_id`). **Track the admin-gated-enabler hardening as a
B-1-touching fast-follow** — its own small migration + MERGE gate — **not** folded into
Phase 5.

**Rationale**

1. **Phase 5 does not make the flag more reachable.** The client-unreachability analysis
   (§3.3) holds: a session-level `SET` is unreachable from the PostgREST / supabase-js
   client surface; only server-side raw-SQL paths (or a pre-existing SQL-injection
   escalation) can set it. Phase 5 only adds *lineage validation* to what this
   already-server-only flag bypasses — it does not widen *who* can flip it. The
   incremental exposure Phase 5 adds is therefore low.
2. **Hardening must be all-or-nothing across both triggers.** The flag disables **both**
   tenant-boundary triggers (B-1's org-id immutability + Phase 5's parent-same-org). If
   Phase 5 hardened only its own trigger and left B-1's on the bare GUC, the boundary
   would have two *different* bypass mechanisms and the weaker one would set the
   effective security level — strictly worse, and now two things to audit. So the
   hardening (e.g. a `private.org_migration_enabled()` `SECURITY DEFINER` helper gated on
   a dedicated `tenancy_admin` role) must swap the check in **both** triggers in one
   migration. That is a change to B-1's shipped surface and belongs in its own gate.
3. **Sequencing the other way is backwards.** Blocking Phase 5 (an additive
   defense-in-depth trigger whose absence is the status quo) on a larger B-1-touching
   refactor would hold a security improvement hostage to a bigger one. Ship Phase 5;
   harden the GUC next.

**Guardrails / owed items**

- The fast-follow is an **owed, tracked** item, not merely "recommended" — Phase 5
  *widens the blast radius* of an unhardened god-mode flag, so the commitment to harden
  it must be explicit and must cover both triggers together.
- **Interim compensating control:** the §3.3 / §4.2 mandatory post-GUC cross-org-link
  audit is a **hard procedural requirement** on the (not-yet-built) org-migration tool
  for as long as the bare GUC stands. The tool's own DESIGN gate inherits this.

---

## Decision #4 — Tier-1 storage-probe target (design §5.3, open-Q #4)

**DECISION: localhost `next dev` + the dev session-mint is the REQUIRED Tier-1 target.**
A non-prod *deployed* target run is **optional** belt-and-braces, recommended once at the
actual SSR-auth cutover. (Prod is excluded — no fixture orgs there.)

This decision is about **where the app runs**, not where the data lives. The committed
seed (orgs, Admin-API users, runs, storage objects) still lives on the **non-prod
Supabase project** per open-Q #3 in all cases; `next dev` simply points at that
project's `SUPABASE_URL`.

**Rationale**

1. **The invariant Tier-1 proves lives in route code that is identical dev vs deployed.**
   T1–T3 exercise the session-derived `<orgId>/<slug>/` path-prefix invariant — that
   `orgId` is derived from the caller's session via `requireOrgOr401()` and is **never
   request-supplied** (`frontend/lib/auth.ts`, file-serving routes). That logic is
   byte-identical between `next dev` and a Vercel build, so localhost delivers the full
   security signal. A deployed run additionally exercises Vercel Edge / `proxy.ts`
   middleware specifics, which do not change the org-derivation invariant.
2. **localhost is the right default for a re-runnable regression guard:** deterministic,
   fast, no deploy step, and the session-mint already exists and is proven
   (`reference_localhost_dev_session_mint`; reusable probe script). Re-run it whenever
   RLS policies or the file-serving routes change.
3. **The harness is already target-agnostic via `BASE_URL`** (§5.4) and skips Tier-1
   loudly when no session is provided, so a green run never silently omits the primary
   proof. Pointing `BASE_URL` at a non-prod deployment for the optional end-to-end run is
   a no-code config choice.

**Guardrail**

The one thing localhost does *not* exercise is the deployed Edge runtime / `proxy.ts`
end-to-end path. That is why a single non-prod *deployed* Tier-1 run is recommended at
the actual SSR-auth cutover — as an end-to-end confirmation, not as part of the routine
regression guard.

---

## Decision #5 — doc rename (design §2.3, open-Q #5)

**DECISION: Rename the design doc.** The current title names work that §2.3 puts
explicitly OUT of scope.

- **Target name:** `phase5-parent-same-org-and-rls-harness-design.md` (the name the
  design doc itself proposes in open-Q #5). The `-trigger-` variant
  (`phase5-parent-same-org-trigger-and-rls-harness-design.md`) is equivalent if a
  reviewer prefers the extra clarity; either honors the intent.
- **Execute the rename in the implementation session, not this one.** The physical
  `git mv` must be done together with a reference-sweep — the companion peer-review file
  (`phase5-parent-same-org-and-rls-harness-design-gate-peer-review.md`), the
  `[[project_phase5_design_gate_s148]]` memory, and the handoff all point at the current
  name. Doing the rename now would either leave dangling references or trigger a
  multi-file churn cascade beyond this decisions-only scope. The implementation session
  already opens these docs for the migration work, so the rename + sweep land cleanly
  there in one pass.

**Rationale**

A misleading title on a tenant-isolation security doc is a real hazard: every reviewer
who touched it had to reconcile "rls-canonicalization" against content where
canonicalisation is explicitly deferred (§2.3). Fixing it is correct; sequencing the
rename with the reference-sweep keeps it from fragmenting cross-references.

---

## Not decided here (out of this session's scope)

- **Open-Q #3 — provision/confirm a NON-PROD Supabase project** for the committed seed.
  This is the harness's load-bearing *implementation prerequisite*, not a design fork —
  it is a provisioning task for the implementing session, not a decision to make on
  paper. Tier-1 (#4) and the §5.1 committed seed both depend on it existing.
- **Implementation of Components 1 & 2** (the migration + `test-ssr-auth-cutover.sh`)
  remains PARKED for a human-present session behind a separate full tri-vendor MERGE
  gate.

---

## Decision summary

| # | Topic | Decision |
|---|---|---|
| 1 | `FOR SHARE` on parent lookup | **Include it.** Closes a cross-session TOCTOU the FK's `FOR KEY SHARE` doesn't; shared lock, negligible cost. Does **not** replace the post-GUC §4.2 audit. |
| 2 | GUC-hardening scope | **Keep the bare GUC in Phase 5** (B-1 parity); harden **both** triggers together in a tracked B-1-touching fast-follow. Post-GUC §4.2 audit is the interim compensating control. |
| 4 | Tier-1 probe target | **localhost `next dev` + session-mint = required**; non-prod *deployed* run optional, recommended once at the SSR-auth cutover. Data stays on the non-prod project (#3) regardless. |
| 5 | Doc rename | **Rename** to `phase5-parent-same-org-and-rls-harness-design.md`; execute the `git mv` + reference-sweep in the implementation session. |
