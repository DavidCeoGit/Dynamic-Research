# Phase 5 DESIGN-gate — peer-review synthesis (companion to `phase5-rls-canonicalization-design.md`)

> **Gate:** DESIGN. **Risk labels:** SECURITY (tenant isolation), DATA, ARCHITECTURE. **Severity:** NORMAL.
> **Topology:** sequential, both-lenses-adversarial — Gemini holistic-adversarial → integrate (v2) → Codex grounded-adversarial → integrate (v3) → Codex sequential-QA fidelity → sweep → v3-FINAL.
> **Outcome:** gate CLOSED at v3-FINAL. Implementation PARKED (human-present session).
> **Date:** 2026-06-20 (S148). Models: `gemini-2.5-pro` (SDK; CLI OAuth tier dead per [[feedback_gemini_cli_oauth_tier_deprecated_use_sdk]]), Codex via `codex exec -s workspace-write` (ChatGPT auth, no API-key flip needed).

## What each reviewer saw

| Reviewer | Lens | Inputs |
|---|---|---|
| Gemini 2.5 Pro | holistic-adversarial (breadth) | the **full v1 design doc** pasted into the SDK prompt (no repo access — by design for the breadth pass). |
| Codex | grounded-adversarial (depth) | the **v2 doc IN the repo** + workspace-write file reads against the actual migrations (`20260511`/`20260522`/`20260523`/`20260602`), `frontend/app/api/queue|runs/*`, `frontend/lib/{auth,storage,storage-paths}.ts`, `agent/scripts/phase-a-bootstrap-primary-user.ts`, `agent/scripts/test-phase-b-rls.sh`. Could NOT run live psql (`DATABASE_URL` unset in workspace) — static + code-grounded only. |
| Codex (QA) | grounded fidelity | the **v3 doc** + repo, verifying each round-1 finding was faithfully integrated. |

All three were prompted to find the STRONGEST reason to BLOCK within their lens (no rubber-stamp framing). All three returned BLOCK on first read; each BLOCK was integrated to resolution.

---

## Round 1 — Gemini (holistic-adversarial) — VERDICT: BLOCK → all integrated into v2

| # | Sev | Finding | Disposition |
|---|---|---|---|
| G-CRIT-1 | CRITICAL | Harness `service_role` emulation unfaithful: v1 used `SET ROLE` to the **table owner** as a stand-in, but the owner ≠ the real `service_role` (different GRANT set; owner is superuser-on-object). The trigger's whole purpose is to fence `service_role`, so the proof must run as the genuine role. | **ACCEPT** → v2 §5.1/§5.2 use `SET LOCAL ROLE service_role` (adopts its real GRANTs + `BYPASSRLS`); P1b is the load-bearing service-role case. |
| G-CRIT-2 | CRITICAL | Storage proof incomplete — misses the **authenticated cross-tenant** vector (user A inducing a route to mint a signed URL for org B's path); v1 tested only anon + catalog. | **ACCEPT** → v2 added a required authenticated cross-org route probe (Tier-1). *(Further refined in round 2 — see C-CRIT-1 + C-MIN-1: the real boundary is the session-derived path prefix, and the probe needs committed fixtures.)* |
| G-MAJ-1 | MAJOR | `app.allow_org_migration` is an unaudited god-mode GUC disabling BOTH tenant triggers; rests on convention, not a technical control. | **ACCEPT-with-scope** → v2 §3.3 adds the mitigating analysis (a session `SET` is **not reachable** from the PostgREST/supabase-js client surface; exposure narrows to raw-SQL/server paths + a pre-existing SQL-injection) + a tracked fast-follow to gate the GUC behind an admin-only `SECURITY DEFINER` enabler across both triggers (it is a B-1-shipped mechanism; hardening touches B-1 → its own migration). |
| G-MIN-1 | MINOR | Trigger error message leaks the parent's `organization_id` → usable as an oracle to map foreign-org runs without read access. | **ACCEPT** → v2 §3.1 emits a generic message (no org UUID echoed). |
| G-MIN-2 | MINOR | Trigger fires on every UPDATE (no `OF` clause) → runs an RLS-bypassing SELECT on high-frequency status/updated_at writes. | **ACCEPT** → v2 §3.2 adopts `OF parent_run_id, organization_id` into core. |
| G-INFO-1 | INFO | Pre-apply cross-org-link audit should be an automated fail-loud migration block, not a manual step. | **ACCEPT** → v2 §4.2 makes it a `DO $$ … RAISE EXCEPTION $$` §0 preflight. |

Gemini's breadth pass correctly elevated the harness-faithfulness and storage-completeness gaps to CRITICAL — the design's central security claims were not yet provable by the proposed tests.

---

## Round 2 — Codex (grounded-adversarial, on v2) — VERDICT: BLOCK → all integrated into v3

| # | Sev | Finding (file:line grounded) | Disposition |
|---|---|---|---|
| C-CRIT-1 | CRITICAL | Tier-1 HTTP probe **cannot** use rollback-wrapped psql fixtures: uncommitted fixtures are invisible to the HTTP app's own pooled connection, and psql cannot roll back Storage objects (`auth.ts:59-66`, `files/route.ts:30-38`, `storage.ts:201,290`). T1–T4 would test unrelated data or silently skip. | **ACCEPT** → v3 §5.1 splits into a **committed non-prod seed** (Admin-API users + orgs + runs + real storage objects, teardown via `trap`) shared by the psql matrix (SAVEPOINT-isolated mutations) + HTTP Tier-1, with a hard **prod-ref guard** (refuses `mfjgoghlpqgxcycxoxio`). |
| C-MAJ-1 | MAJOR | The cited "known-good `auth.users` SQL column set from `phase-a-bootstrap-primary-user.ts`" **does not exist** — that file uses the Supabase **Admin API** `createUser({email, email_confirm})` (`:192-195`), not SQL. FK `organization_members.user_id → auth.users(id)` (`20260522:92-95`). | **ACCEPT** → v3 §5.5/§5.1 seed users via the Admin API (committed), matching the real call site; teardown via `admin.deleteUser`. |
| C-MAJ-2 | MAJOR | Catalog S2 `roles && ARRAY['anon','authenticated']` **false-passes** a `TO public` policy on `storage.objects` (public applies to all roles but isn't in that array). | **ACCEPT** → v3 §5.3 S2 predicate now includes `public` + `roles = '{public}'` + permissive-SELECT shape. |
| C-MAJ-3 | MAJOR | Trigger is **not** a full invariant under its own GUC: with `app.allow_org_migration='true'`, moving a **parent's** org doesn't re-validate existing **children** (trigger only checks the written row's own `parent_run_id`) → strands cross-org links; §6 overclaimed direct-SQL/admin coverage. | **ACCEPT** → v3 §3.4 reframes the trigger as a **child-write-time** fence + documents the break-glass gap; §3.3 makes a post-GUC §4.2 audit + whole-subtree-move **mandatory**; §6 threat row softened (parent-move explicitly NOT covered). |
| C-MIN-1 | MINOR | Stale control name: `getOrgContextDualPath` is **retired** (`auth.ts:5-7`); live control is `requireOrgOr401()` + session-derived `<orgId>/<slug>/` path prefix (`files/route.ts:7-10`) — structurally stronger than a per-query `.eq`. | **ACCEPT** → v3 §1.4/§1.5/§5.3 corrected; Tier-1 reframed to verify the **session-derived-prefix invariant** (orgId never request-supplied). |

Codex's depth pass corrected two factual errors a doc-only read could not (the fictional `auth.users` shape; the retired auth bridge) and produced the GUC parent-move counterexample — the grounded value-add the topology is designed to extract on the integrated v2.

---

## Round 3 — Codex sequential-QA (fidelity, on v3) — VERDICT: BLOCK (residual stale text only) → swept

QA confirmed the substantive resolutions: **C-MAJ-2 RESOLVED, C-MAJ-3 RESOLVED**; C-CRIT-1 / C-MAJ-1 / C-MIN-1 correct in their core sections (PARTIAL only because of leftover phrases elsewhere). The trigger SQL (§3.1/§3.2) and §0 pre-apply audit (§4.2) verified intact (not damaged by edits). The BLOCK was entirely **doc-consistency residue** from the restructure:

| Stale spot | Fix (v3-FINAL sweep) |
|---|---|
| Exec summary still said fixtures "roll back / touch no production data" | rewritten to committed-non-prod-seed + prod-ref guard + teardown |
| §2.2 still said "transaction-rolled-back fixtures" | rewritten to committed seed + SAVEPOINT isolation |
| §2.3 future-cutover line still said "collapsing `getOrgContextDualPath`" | corrected — bridge already retired; cutover = move off env-fallback path |
| Open-Q #3 still asked about "rollback-wrapped `auth.users` insertion" | replaced with the now-load-bearing non-prod-target provisioning question |

Per the mechanical-fix fidelity-skip precedent ([[project_multi_reviewer_policy_framework_v2_shape]] / wave-b-2 "loop closed at v3, all mechanical"), the pure-text sweep does not require a fresh Codex round — the QA itself enumerated the exact spots and they were corrected verbatim. **Gate CLOSED at v3-FINAL.**

---

## Synthesis & final direction

Both lenses materially strengthened the design; neither was a rubber stamp. The net shape change v1→v3:

1. **Trigger (Component 1):** unchanged in mechanism (SECURITY DEFINER child-side fence honouring `app.allow_org_migration`), but hardened in three places — generic error message (no org-UUID oracle), `OF`-narrowed firing, and an honest scope boundary (it does **not** cover a break-glass parent org-move; that needs a procedural subtree-move + post-GUC audit). Pre-apply audit is now a fail-loud §0 migration block.
2. **Harness (Component 2):** the biggest change — from "one rolled-back psql txn" to **two regimes over a committed non-prod seed** (psql RLS matrix with SAVEPOINT isolation + genuine `service_role`; HTTP Tier-1 proving the session-derived storage-path-prefix invariant), Admin-API user fixtures, a `TO public`-aware storage catalog check, and a hard prod-ref guard.

**No unresolved disagreement.** No SECURITY-labeled CRITICAL remains open (all integrated). The one residual *decision* for the implementing session is open-Q #3 — provisioning a non-prod Supabase target for the committed seed (now the harness's main prerequisite).

**Carried into the implementation/MERGE gate (separate, full tri-vendor, must clear BEFORE any prod apply per §11):**
- The GUC-hardening fast-follow (admin-gated enabler across both triggers) — tracked, not folded into Phase 5.
- The non-prod target provisioning (open-Q #3).
- Open-Qs #1 (`FOR SHARE` on the parent lookup), #2 (GUC hardening scope), #4 (Tier-1 target), #5 (doc rename).
