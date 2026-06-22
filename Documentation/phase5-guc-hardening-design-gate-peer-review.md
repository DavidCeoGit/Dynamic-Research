# Phase 5 GUC-Hardening — DESIGN-gate peer review (synthesis)

Companion to `phase5-guc-hardening-design.md`. Event Gate **DESIGN**; Risk Labels **SECURITY / DATA / AGENT BEHAVIOR / ARCHITECTURE**; Severity **NORMAL**; topology **sequential both-lenses-adversarial** (Gemini holistic → integrate v2 → Codex grounded on v2 → integrate + empirical probe → v3-FINAL). Session S152 (2026-06-21).

## What each reviewer saw

- **Gemini 2.5-pro (holistic-adversarial, via @google/genai SDK):** the v1 design doc + the v1 proposed migration SQL + the two shipped triggers being modified + the harness escape-hatch section, all in one packet. No repo/DB access — whole-artifact read.
- **Codex (`codex exec -s workspace-write`, ChatGPT auth, grounded-adversarial):** the v2 design + migration in `sandbox/`, AND it **read the live repo + ran real SQL against the local Postgres** (executed `pg_has_role` / `SET SESSION AUTHORIZATION` / grant probes in rolled-back transactions; read `20260523`, `20260611…ntfy`, `20260602`, the harness, `test-phase-b-rls.sh`). Grounded depth.
- **Claude (author + S152 self-probe):** integrated both, then fired the **actual** Phase 5 DEFINER trigger via cross-org INSERTs under different `session_user`s on the local replica to confirm v3 end-to-end (§3.3 of the design).

## Verdicts

| Reviewer | Verdict | Findings |
|---|---|---|
| Gemini (holistic, v1) | **ENDORSE** | 3 INFO confirmations, 1 MINOR, 1 INFO (intentional) |
| Codex (grounded, v2) | **BLOCK** | 2 CRITICAL, 2 MAJOR, 1 MINOR, 2 INFO + 1 extra |
| Claude self-probe (v3) | **CONFIRM** | 3/3 faithful trigger tests pass |

---

## Gemini findings + dispositions

- **F1 `session_user` anchor correctness (INFO).** Confirmed correct & complete across direct-psql / PostgREST `authenticator`→`SET ROLE` / SECURITY DEFINER / nested-DEFINER / `SET SESSION AUTHORIZATION` frames. → No change; carried into design §1.1.
- **F2 DEFINER→INVOKER call-chain privilege model (INFO).** Safe; schema-qualified calls + hardened helper search_path block search_path hijack. → No change.
- **F3 harness `SET SESSION AUTHORIZATION` redesign (INFO).** Correct & only faithful way to test a `session_user` control; superuser can `SET SESSION AUTHORIZATION` to a NOLOGIN role; reverts on ROLLBACK; P3b is the load-bearing test. → Confirmed; drove §3.
- **F4 filename/ordering ASCII justification (MINOR).** The *conclusion* (use a greater date) is right, but the digit-vs-underscore explanation was inverted. → **FIXED** v2: digits (0x30–0x39) sort before `_` (0x5f); the longer same-date name sorts first. Design §2.1 + migration header corrected.
- **F5 superuser implicit bypass (INFO).** Treating superuser as ultimate break-glass is a standard, reasonable choice. → Note: **superseded by Codex C-MAJ-2** — on Supabase `postgres` is not a superuser, so the design uses an explicit grant instead.

**Gemini verdict: ENDORSE.**

---

## Codex findings + dispositions (the BLOCK — all integrated)

- **C-CRIT-1 helper grants miss `tenancy_admin` itself (CRITICAL).** A fixture role granted `tenancy_admin` failed `permission denied for schema private` before the predicate evaluated; with USAGE+EXECUTE it returned `gate_open=t`. → **RESOLVED** v3 via the structural fix (below), not by widening grants to app roles.
- **C-CRIT-2 stale `private` USAGE assumption (CRITICAL).** `20260611…ntfy.sql:109` REVOKED `private` USAGE from `authenticated` (grants only postgres, service_role). A SECURITY INVOKER B-1 trigger calling the helper would `permission denied` at fire time. → **RESOLVED** v3: **make B-1 SECURITY DEFINER** so the helper call runs as owner `postgres` (who has USAGE); `GRANT EXECUTE … TO postgres`; do NOT re-grant `authenticated` private USAGE (would undo the ntfy hardening). Confirmed by the S152 self-probe (which also reproduced + fixed a `permission denied for function` from `CREATE OR REPLACE` not changing owner under `REVOKE FROM PUBLIC`).
- **C-MAJ-1 harness P3b needs a true superuser; local `postgres` isn't one (MAJOR).** `supabase_admin` is the superuser; `SET SESSION AUTHORIZATION service_role` fails as `postgres`. → **RESOLVED**: design §3.1 requires the `supabase_admin` superuser connection + `is_superuser` precheck + `session_user` pre-assert. Used in the §3.3 probe.
- **C-MAJ-2 `postgres` break-glass not guaranteed (MAJOR).** `pg_has_role('postgres','tenancy_admin','MEMBER')` is false (postgres not superuser on Supabase). → **RESOLVED**: migration `GRANT tenancy_admin TO postgres`; design §1.2 rewritten.
- **C-MIN-1 §4 not byte-faithful except predicate (MINOR).** SQL semantics preserved, but comments drift. → **RESOLVED**: §4 claim softened to "SQL semantics identical bar the predicate; comments updated."
- **C-INFO session-anchor + helper-qualification + ordering (INFO×2).** Confirmed sound. → Carried into design.
- **C-INFO+ `test-phase-b-rls.sh:416` T7c also relies on the bare GUC (extra).** Must be retargeted along with the SSR harness. → **ADDED** to design §3.2 (passes as-is given `GRANT tenancy_admin TO postgres`, but add a negative sibling).

**Codex verdict: BLOCK → all findings integrated into v3-FINAL.**

---

## Claude self-probe (v3, faithful trigger path)

Applied the v3 migration in a rolled-back transaction; fired the real Phase 5 trigger via cross-org INSERTs (design §3.3):

- **P3b** service_role + GUC → **BLOCKED** (app cannot escape — the security win).
- **P3** postgres (member) + GUC → **PERMITTED** (break-glass works).
- **NOGUC** service_role, no GUC → **BLOCKED** (baseline).
- Direct: postgres + GUC → `org_migration_enabled()=t`; both trigger fns `prosecdef=t`.

**Verdict: CONFIRM** — v3 validated end-to-end on the local replica.

---

## Synthesis / outcome

DESIGN gate **CLEARED at v3-FINAL.** Codex's grounded BLOCK was high-value: it caught two CRITICAL grant/privilege defects (stale `authenticated` USAGE; missing trigger-owner EXECUTE) and the Supabase-`postgres`-not-superuser fact — none visible to the holistic read, all empirically grounded. The integration restructured the privilege model (B-1 → DEFINER, explicit `GRANT tenancy_admin TO postgres`, `GRANT EXECUTE TO postgres`) and the author self-probe then confirmed the whole gate through the real trigger.

**Owed at IMPL (separate session):** build the harness P3/P3b/P3c + T7c sibling; full **fresh tri-vendor MERGE gate** on the real SQL + harness (the §3.3 probe is evidence, not a substitute); IMPL-verify prod trigger-fn ownership == postgres; prod apply only with explicit human confirm. Logs: `c:/tmp/dr-s152/{gemini,codex}.log`, probes `c:/tmp/dr-s152/probe*.sql`.
