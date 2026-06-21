# Phase 5 MERGE-gate — peer-review synthesis (parent-same-org trigger + RLS-bypass harness)

> **Gate:** MERGE. **Risk labels:** SECURITY (tenant isolation — blocking on CRITICAL), DATA (trigger gates `research_queue` writes; prod-irreversible migration), ARCHITECTURE. **Severity:** NORMAL.
> **Topology:** sequential, both-lenses-adversarial — Gemini holistic-adversarial → integrate (v2) → Codex grounded-adversarial → integrate (v3) → Codex sequential-QA → Claude concur → CLEARED.
> **Outcome:** gate **CLEARED**. Code committed; the prod **migration apply (`supabase db push`) is PARKED for explicit human confirm** (§11 — must clear the gate BEFORE any prod apply; this gate is that clearance).
> **Date:** 2026-06-21 (S151). Models: `gemini-2.5-pro` (SDK; CLI OAuth tier dead), Codex via `codex exec -s workspace-write` (ChatGPT auth, no API-key flip). Design: `Documentation/phase5-parent-same-org-and-rls-harness-design.md` (v3-FINAL) + `Documentation/phase5-decisions-s150.md`.

## Artifacts reviewed
- `supabase/migrations/20260621_phase5_parent_same_org_trigger.sql` — the prod artifact (parent-same-org SECURITY DEFINER trigger w/ `FOR SHARE`, §0 fail-loud preflight, rollback).
- `agent/scripts/test-ssr-auth-cutover.sh` + `agent/scripts/test-ssr-auth-cutover-seed.ts` — the executable RLS-bypass harness + committed non-prod seed (Admin-API users, self-minting Tier-1 session).

## What each reviewer saw
| Reviewer | Lens | Inputs |
|---|---|---|
| Gemini 2.5 Pro | holistic-adversarial (breadth) | full self-contained packet (all 3 files + design context + grounding facts + local 24/24 green result + the disclosed Tier-1 limitation). No repo access (by design for breadth). |
| Codex | grounded-adversarial (depth) | the INTEGRATED v2 files in the repo + workspace-write reads against `@supabase/ssr`, `@supabase/supabase-js`, `frontend/lib/supabase-server.ts`, the migrations, `test-phase-b-rls.sh`. Ran a live `@supabase/ssr` parse of the self-minted cookie. |
| Codex (QA) | grounded fidelity | the v3 files; verified C-MAJ-1 resolution + chunk emission against the local `@supabase/ssr@0.12.0` chunker. |
| Claude (author) | grounded-adversarial self-review | the migration + harness vs the live local schema; trigger concurrency/fire-order/ERRCODE + harness can't-falsely-pass analysis. |

All external reviewers were prompted to find the STRONGEST reason to BLOCK within their lens. Both returned BLOCK on first read; every finding was integrated to resolution.

---

## Round 1 — Gemini (holistic-adversarial) — VERDICT: BLOCK → all integrated into v2
| # | Sev | Finding | Disposition |
|---|---|---|---|
| G-CRIT-1 | CRITICAL | The harness tests only the INSERT path of the trigger; the trigger is `BEFORE INSERT OR UPDATE`, so the reparent-via-UPDATE activation event (e.g. `parent_run_id` NULL → cross-org value) is entirely unvalidated — a critical gap for a security component. | **ACCEPT** → added **P4** (authenticated cross-org reparent via UPDATE → blocked), **P4b** (genuine `service_role` reparent via UPDATE → blocked), **P5** (same-org reparent via UPDATE → allowed, control). |
| G-MAJ-1 | MAJOR | Tier-1 (the primary, application-layer storage boundary) is skipped by default; the ephemeral per-run seed user can never have a pre-set `SESSION`, so a green run gives false end-to-end assurance. | **ACCEPT** → the seed now **self-mints** an `@supabase/ssr` session cookie for user A (`admin.generateLink` magiclink → anon `verifyOtp` → `base64-` + base64url(JSON) cookie, name `sb-<ref>-auth-token`). Tier-1 runs automatically given a running app (`BASE_URL`); the chicken-and-egg is gone. *(Further hardened in round 2 — see C-MAJ-1.)* |
| G-MIN-1 | MINOR | The seed writes the fixture JSON only on full success; a mid-seed failure orphans non-prod resources because teardown relies on a never-written fixture. | **ACCEPT** → the seed writes a **partial fixture + emits `FIXTURE_PATH` on any failure**, and the harness parses `FX` even on a non-zero seed rc, so the EXIT trap always tears down. |

Local re-run after integration: **24 Pass / 0 Fail / 2 Skip** (Tier-1 skipped — no app; Tier-3 opt-in).

---

## Round 2 — Codex (grounded-adversarial, on v2) — VERDICT: BLOCK → integrated into v3
| # | Sev | Finding (file:line grounded) | Disposition |
|---|---|---|---|
| C-MAJ-1 | MAJOR | Tier-1 is STILL silently skippable: with `BASE_URL` set but no session (anon key omitted, or any self-mint failure) the harness records `[SKIP]` and exits 0 — contradicting the "skip only when no BASE_URL" contract and masking the primary storage probe. | **ACCEPT** → (a) up-front guard: `BASE_URL` set + no `SESSION` + no `NEXT_PUBLIC_SUPABASE_ANON_KEY` → exit 2; (b) the "BASE_URL set but no resolved session" branch is now a **`fail` (non-zero), not a `skip`**; (c) the seed **emits `@supabase/ssr` `name.N` chunked cookies** for `>3180`-char sessions instead of skipping. |

**Codex independently VALIDATED the self-mint cookie end-to-end** (the highest-value grounded catch a doc-only read could not make): it parsed the constructed cookie through the installed `@supabase/ssr@0.12.0` — `parsed_user` resolved, `error null` — confirming the name derivation (`sb-<host-first-label>-auth-token`) + `base64-`+base64url(JSON) value are exactly what the SSR server client reads. This de-risks the (this-session-deferred) live Tier-1 run.

---

## Round 3 — Codex sequential-QA (fidelity, on v3) — VERDICT: ENDORSE
Confirmed C-MAJ-1 resolved (a `BASE_URL` run can no longer pass while silently skipping Tier-1). Verified chunk emission against the **actual local `@supabase/ssr@0.12.0` `createChunks`/`combineChunks`**: the seed's manual 3180-char slicing matches `createChunks` byte-for-byte and `combineChunks` reassembles to the original `base64-…` value (prefix preserved). No regression. Checks run: `bash -n`, agent `tsc --noEmit`, direct chunker comparison.

## Claude (author) grounded-adversarial concurrence
- **Migration:** `SECURITY DEFINER` + `SET search_path = private, public, pg_temp` (all refs schema-qualified) — no hijack. `FOR SHARE` is a single-row PK-indexed shared lock: N concurrent children of one parent do not serialize; it blocks only the rare admin org-move; no lock-ordering deadlock (each insert locks only its own parent). Fires AFTER `research_queue_immutable_org_id` (alphabetical `i` < `p`), so an org-id mutation without the hatch is blocked before this trigger runs. `v_parent_org IS NULL ⟺ parent absent` (B-2 NOT NULL CHECK) → nonexistence correctly left to the FK. `ERRCODE = check_violation` matches what the harness greps. §0 preflight is fail-loud inside the wrapped txn. Idempotent + reversible.
- **Harness faithfulness:** every error-expected test routes a swallowed/other error to a non-`OK` marker → fails loud (cannot falsely pass); 0-count tests fail (not pass) if the query errors to empty; `PRECHECK` aborts the matrix if the identity binding misresolves. SAVEPOINT/`BEGIN..ROLLBACK` isolation leaves the committed seed intact for the HTTP tier; explicit-order teardown respects the `ON DELETE RESTRICT` org FK.

---

## Synthesis & final direction
Both external lenses materially strengthened the change; neither rubber-stamped. Net v1→v3:
1. **Trigger (Component 1):** unchanged in mechanism; validated by the harness on BOTH the INSERT and UPDATE arms, for BOTH the authenticated and genuine-`service_role`-BYPASSRLS paths (P1/P1b/P4/P4b), with the same-org control (P2/P5) and escape hatch (P3).
2. **Harness (Component 2):** the biggest change — Tier-1 went from "skipped by default (false assurance)" to "self-minting + non-silent" (a `BASE_URL` run cannot pass without exercising the primary storage boundary), with a Codex-verified `@supabase/ssr` cookie (single + chunked), and orphan-proof partial-failure teardown.

**No unresolved disagreement. No SECURITY-labeled CRITICAL remains open.** Gate CLEARED.

### Verification status (honest)
- **Proven this session (local faithful replica):** migration applied clean (§0 = 0 cross-org links); harness **24/24** incl. P1b/P4b (`service_role` BYPASSRLS fenced on insert + reparent); cookie format validated end-to-end by Codex against `@supabase/ssr@0.12.0`.
- **Deferred to the SSR-auth cutover (decision #4):** the live Tier-1 HTTP run against `next dev` was NOT performed this session (it needs a running app). It is now a one-command, guaranteed-non-silent step; the cookie it depends on is independently validated.

### Owed / carried forward
- **GUC-hardening fast-follow** (decision #2): admin-gated enabler across BOTH `research_queue_immutable_org_id` and the new trigger — its own B-1-touching migration + MERGE gate. The §4.2 post-GUC cross-org-link audit is the hard interim compensating control.
- **PROD APPLY is PARKED** (`supabase db push` of `20260621_phase5_parent_same_org_trigger.sql`) for explicit human confirm — prod-irreversible DATA+SECURITY. Run the §0-audited migration, then the harness against prod-as-non-prod is N/A (prod has no fixtures); rely on the §0 preflight + the proven local matrix.
- **Local-target fidelity note:** the schema-only prod dump dropped B-1's `GRANT USAGE ON SCHEMA private TO authenticated`; restored on the local stack + appended to the gitignored baseline (no prod/repo impact).
