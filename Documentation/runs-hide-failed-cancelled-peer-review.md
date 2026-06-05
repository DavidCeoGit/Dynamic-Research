# Hide FAILED + CANCELLED runs — MERGE-gate peer review (S93)

**Date:** 2026-06-05
**Change:** Extend the org-scoped "hide from view" feature (completed runs, S92 v4) to FAILED +
CANCELLED `research_queue` jobs in the dashboard's Active Pipelines section.
**MRPF classification:** MERGE gate × **SECURITY** risk label (extends the v4 unauthenticated-
but-org-bounded write surface to queue jobs) × NORMAL severity.
**Topology:** sequential **Gemini → integrate → Codex** (CLAUDE.md §11).
**Outcome:** Gemini REQUEST_CHANGES (blocking MAJOR) → integrated → Codex APPROVE_WITH_CHANGES
(1 MINOR) → integrated. **No SECURITY-CRITICAL from either reviewer → not blocked.** Cleared to ship.

## What each reviewer saw
- **Gemini** (`gemini --approval-mode plan`, v0.43.0, model unverified — capacity note below):
  the full proposed v1 code embedded INLINE in the prompt (sandbox is gitignored → Gemini's
  file tool cannot read it) + grounding facts + unchanged-dependency signatures. Holistic,
  non-grounded read.
- **Codex** (`codex exec -s read-only`, gpt-5.5, xhigh): the integrated **v2 ON DISK** (read the
  real files, cited real line numbers) + Gemini's findings + how each was integrated. Code-
  grounded verification pass. Confirmed it could not run `node --import=tsx --test` in its sandbox.

## Grounding facts (verified against the live DB this session)
- `research_queue`: failed=28, cancelled=8, completed=11.
- `GET /api/queue` status filter = `['pending','running','failed']` — **cancelled is NOT returned**
  and renders nowhere today. User-confirmed decision: do NOT surface cancelled cards (would add 8
  dead cards just to hide them). The hide ROUTE accepts cancelled for forward-safety; no UI
  surfaces it. In practice only the 28 failed cards get a hide control.
- `user_hidden_runs` = `(id uuid, organization_id uuid, slug text, hidden_at)`, UNIQUE
  `(organization_id, slug)`, RLS ENABLED with 0 policies (service-role only). **REUSED** for queue
  jobs — **no migration**. Completed runs keyed by storage slug; failed/cancelled jobs by queue
  UUID `id`, in the same `slug` text column. Key spaces are disjoint (storage slugs are
  topic-slugs, never UUIDs).
- Only GET consumer of `/api/queue` is `app/page.tsx` (the two other `/api/queue` refs are POST).
- Security posture (carried from v4): the live dashboard runs on the ENV-FALLBACK path
  (`getOrgContextDualPath` → `source:"env"`, no session). Tenant boundary = route-level
  org-scoping (service-role + explicit `.eq("organization_id", orgId)`). Accepted residual: an
  anon visitor can hide/unhide the system-default org's items (rate-limited, reversible, UI-only).
  Intentional for the single-operator deployment.

## Findings & resolutions

### Gemini (v1)
| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| G1 | **MAJOR** | N+1 DoS in `POST /api/runs/hide`: per-target loop = up to 500 sequential `projectExists` + 500 upserts on the unauth path. | **Integrated.** `partitionHideTargets` splits targets; ONE `.in("id", jobIds).eq(org).in(status,[failed,cancelled])` validates all UUIDs; storage targets via `mapLimit(slugs, 8, projectExists)` (bounded concurrency); ONE bulk upsert. (Note: the storage loop was pre-existing v4 behavior; v2 bounds its fan-out + batches the writes.) |
| G2 | MINOR | Queue GET loaded the org's ENTIRE hidden set on every 5s poll. | **Integrated.** `.in("slug", jobIds)` where `jobIds` = returned active-job ids → O(visible jobs). Completed-run hides (storage slugs) never match a job UUID, excluded for free. |
| G3 | NIT | Queue POST parent-lookup swallows a DB error → 400 not 500. | **Out of scope.** Pre-existing S35 code, not touched by S93. Logged for a future cleanup. |
| G4 | NIT | `page.tsx` `isHideable` includes `cancelled` (dead until cancelled is surfaced). | **Kept** for forward-safety with a clarifying comment (Codex concurred). |
| — | TESTS | No coverage of the security boundary. | Extracted pure `partitionHideTargets`; added unit tests. I/O ownership gate + RLS isolation remain deferred DB-integration tests (design §8), same as v4 — documented below. |

**Gemini verdict:** REQUEST_CHANGES (blocking on G1 + test coverage).

### Codex (integrated v2)
| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| C1 | **MINOR** | Uppercase UUID targets pass `isQueueJobId` but Postgres returns canonical **lowercase** ids; `targets.filter(t => validJobIds.has(t))` then misses → a valid uppercase id is silently skipped as `not_found_in_org` (fails CLOSED — no over-hide). DELETE has the same raw-string issue. | **Integrated.** New `canonicalizeTarget()` lowercases UUID-shaped targets inside `parseHideBody` (covers POST + DELETE + dedup). Added 2 tests. |

Codex explicitly confirmed correct: batched org-scoped queue gate, bounded storage checks,
single bulk upsert, bounded queue hidden-set query, parent-lookup left out of scope, cancelled
UI forward-safety. **No cross-tenant issue found.**

**Codex verdict:** APPROVE_WITH_CHANGES (C1 only).

## MERGE-gate mandatory question — "is this covered by automated tests?"
**Partially, by design.** The pure, security-relevant helpers are unit-tested (17 tests in
`frontend/lib/__tests__/hidden-runs.test.ts`): `isQueueJobId` (the key-space disjointness
predicate), `partitionHideTargets` (gate routing), `canonicalizeTarget` (case normalization),
and `parseHideBody` (body validation + traversal rejection + bulk cap + UUID dedup). The I/O
ownership gate, the Supabase queries, and RLS/cross-org isolation are **DB-integration tests
deferred per design §8** (require a seeded Supabase) — the SAME posture v4 shipped under. The
tenant boundary itself (service-role client + explicit `.eq("organization_id", orgId)`) is
unchanged from the already-shipped v4 read path.

## Residual risks (accepted)
1. Anon visitor on the env path can hide/unhide the system-default org's failed jobs + completed
   runs (rate-limited 20/IP refill 1/180s, reversible, UI-only). Same accepted posture as v4;
   gate behind SSR-auth login (S53+) if the app opens to the public.
2. Storage-existence fan-out for a 500-target bulk body is bounded to concurrency 8 but still up
   to 500 calls total; the realistic bulk caller ("Hide all completed") sends the operator's own
   small run set. Future: lower the bulk cap or batch storage existence.
3. Queue POST parent-lookup error-swallow (G3) remains pre-existing; unrelated to this change.

## Files changed (5)
- `frontend/lib/hidden-runs.ts` — +`isQueueJobId`, +`partitionHideTargets`, +`canonicalizeTarget`; `parseHideBody` canonicalizes UUIDs.
- `frontend/app/api/runs/hide/route.ts` — batched dual ownership gate (UUID query + bounded storage + bulk upsert).
- `frontend/app/api/queue/route.ts` — GET envelope `{jobs,hiddenCount,canHide}` + bounded org-scoped hidden-set filter; POST unchanged.
- `frontend/app/page.tsx` — Active Pipelines hide/unhide on failed (forward-safe cancelled) cards; shared Show-hidden toggle; envelope consumption.
- `frontend/lib/__tests__/hidden-runs.test.ts` — 17 unit tests.

## Reviewer-runner notes (S93)
- **Gemini arg-length limit:** a ~46KB inline prompt via `-p "$(cat ...)"` failed with
  `Argument list too long` (exit 126). Fix: **pipe via stdin** — `cat promptfile | gemini
  --approval-mode plan --skip-trust` (no `-p`). Worked at 46KB.
- Codex read the working-tree v2 directly (gitignore-independent), citing real line numbers —
  the reason the integrated-v2 grounded pass catches what the holistic inline pass cannot.
