# SSR Auth Refactor — Phase 2 MERGE-gate Peer Review

> Authored S56 (2026-05-26). Per `~/CLAUDE.md` Multi-Reviewer Policy Framework v2.2:
> **MERGE-gate**, **SECURITY** + **AGENT BEHAVIOR** + **ARCHITECTURE** labels,
> **NORMAL** severity, sequential topology **Gemini → integrate → Codex → integrate → Codex QA**.
>
> Companion to: `Documentation/ssr-auth-refactor-design.md` (committed `8a24c7d`,
> design v3) and `Documentation/ssr-auth-refactor-phase-1-merge-gate-peer-review.md`
> (Phase 1 v3 shipped `664e216`, deployed `41a2cc8`).
>
> **STATUS: APPROVED for merge after 3 sequential rounds.** Final verdict
> from Round 3 Codex Sequential QA: `VERDICT: APPROVE` (all v3 fidelity
> checks PASS, no regressions, no carry-forward gaps).

---

## Phase 2 scope summary

8 handler bodies across 7 files + 1 new helper export + 1 helper-mirror
parity fix. Implements design §4.1 (Pattern A, env-constant routes), §4.2
(Pattern B, slug-bearing routes), §4.4 (C-C1 BLOCKING fix for cross-tenant
parent_run_id leak):

| # | File | Pattern | Notes |
|---|---|---|---|
| 1 | `frontend/lib/auth.ts` | (helper) | `getOrgContextDualPath()` added — session-or-env bridge; `requireOrgContext()` v3 distinguishes query failure from no-membership (Codex C-M1) |
| 2 | `frontend/app/api/state/route.ts` | A + B (slug branch) | `getOrgContextDualPath()`; storage-path scoping is the boundary (v2 — Gemini F1) |
| 3 | `frontend/app/api/runs/route.ts` | A | `getOrgContextDualPath()` for gallery list |
| 4 | `frontend/app/api/runs/[slug]/manifest/route.ts` | B | `projectExists(orgId,slug)` storage-path scoping (v2) |
| 5 | `frontend/app/api/runs/[slug]/files/route.ts` | B | `projectExists(orgId,slug)` storage-path scoping (v2) |
| 6 | `frontend/app/api/runs/[slug]/file/[filename]/route.ts` | B | `projectExists(orgId,slug)` + `scopedStoragePath` scoping (v2); `X-Org-Source: none` on early-400 (Gemini F3) |
| 7 | `frontend/app/api/queue/route.ts` | A | POST: C-C1 fix (parent_run_id same-org lookup, explicit `organization_id` on insert). GET: `.eq('organization_id', orgId)` filter. `X-Org-Source: none` on early-400s (Gemini F3) |
| 8 | `frontend/app/api/queue/[id]/route.ts` | A | GET: `.eq('organization_id', orgId)` filter. PATCH unchanged (X-Agent-Key worker auth) |
| 9 | `frontend/lib/storage-paths.ts` | (helper) | v3 — slug rejects `\`, `..` symmetric with filename validation (Codex C-m1) |
| 10 | `agent/lib/storage-paths.ts` | (helper) | v3 — paired-edit with frontend mirror (Codex C-m1) |

Cross-tenant boundary by route class:
- **Storage routes (2,4,5,6):** storage-path prefix `<orgId>/<slug>/` via
  `scopedStoragePath()` + `findStateFile/listFiles/projectExists/getSignedUrl`
  helpers (all accept `orgId` as the first arg and scope every Supabase
  Storage call to it). Cryptographic isolation, not advisory. **The
  prior design assumed a `research_queue` DB guard was the boundary;
  Gemini round 1 correctly identified this is redundant for storage
  routes and breaks legacy-run access.**
- **Queue routes (3,7,8):** `.eq('organization_id', orgId)` on the
  `research_queue` queries. Load-bearing — these routes query the DB
  directly, no storage-path scoping in play.

## Risk classification (per `~/CLAUDE.md` MRPF v2.2)

| Axis | Value |
|---|---|
| Event Gate | MERGE |
| Risk Labels | SECURITY, AGENT BEHAVIOR, ARCHITECTURE |
| Severity Mode | NORMAL |
| Reviewer order | Sequential Gemini → integrate → Codex → integrate → Codex QA |
| Blocking | SECURITY-labeled CRITICAL findings block merge |

---

## Round 1 — Gemini Deep Think (`gemini-3-pro-preview`, CLI)

- Invoked: 2026-05-26 PDT (post-S55 close)
- Wall-clock: ~5 min
- Prompt: `sandbox/working/gemini_phase2_PROMPT.md` (1289 lines, 44.7KB)
- Response: `sandbox/working/gemini_phase2_response.txt` (5.3KB)
- Verdict: **REQUEST CHANGES (2)** — 1 CRITICAL + 1 MAJOR + 1 MINOR + 1 NIT

### Findings + author dispositions

#### G-C1 (CRITICAL / BLOCKING) — Storage routes block access to legacy runs

**Reviewer text:** The four storage-reading routes (state slug branch,
manifest, files, file/[filename]) query `research_queue` to verify
ownership via `.eq('organization_id', orgId)`. As explicitly noted in
S41 and the `queue/route.ts` v1 comments: many storage-resident
completed legacy runs do not have a queue row. The check
unconditionally returns 404 if no row found → **users lose all access
to pre-Phase A historical runs**. The DB guard is redundant: storage
functions internally prefix the Supabase Storage bucket query with
`<orgId>/`. It is structurally impossible for org-A to read org-B's
files because the requests are hard-locked to the `<orgA>/<slug>/`
path prefix.

**Disposition:** ACCEPT.

**Fix applied (v2):** removed research_queue guard from
`state/route.ts` slug branch, `manifest/route.ts`, `files/route.ts`,
and `file/[filename]/route.ts`. 404 now flows from `findStateFile` /
`projectExists` null returns. `getSupabase` import dropped from 3 of
4 routes (still used in `file/[filename]/route.ts` text branch for
storage download).

**Design-doc impact:** §2.7 + §4.2 pseudocode treated the
`.eq('organization_id', orgId)` research_queue check as the
universal cross-org boundary for slug-bearing routes. The actual
boundary for storage routes is the path prefix in
`scopedStoragePath`. Back-port to design v4 should split §2.7 by
route class (storage-path-scoped vs DB-direct).

---

#### G-M1 (MAJOR) — Worker PATCH fails under RLS via anon client

**Reviewer text:** `queue/[id]/route.ts` PATCH uses `getSupabase()`
which (claim) "will instantiate an anonymous/unauthenticated client";
when Phase B-2 RLS lands, the worker's PATCH will be silently denied.

**Disposition:** REJECT.

**Rationale (verified):** `frontend/lib/supabase.ts:13-32` constructs
the singleton via `SUPABASE_SERVICE_ROLE_KEY` (service-role —
bypasses RLS by design). Design §2.9 explicitly memorializes this.
Gemini's claim derived from the helper's docstring being silent on
key type; reading the actual implementation refutes the finding.

Codex round 2 verified the rejection rationale (full repo access).

This rejection illustrates a Gemini-paste-mode blind spot (memory:
`feedback_within_artifact_reviewer_blindspot.md`): the reviewer had
no access to `lib/supabase.ts` source to verify, only inferred from
naming. Sequential Gemini → Codex topology delivered the verification.

---

#### G-m1 (MINOR) — Early-400 responses miss X-Org-Source header

**Reviewer text:** `queue/route.ts` lines 35 + 41 (invalid JSON +
Zod validation failure) and `file/[filename]/route.ts` line 34
(filename traversal) return 400 BEFORE `getOrgContextDualPath()` is
called → no `X-Org-Source` header → malformed-request traffic drops
out of Phase 3 soak telemetry.

**Disposition:** ACCEPT.

**Fix applied (v2):** added `"X-Org-Source": "none"` header to:
- `queue/route.ts` invalid-JSON 400 + Zod-failure 400
- `file/[filename]/route.ts` path-traversal 400

"none" is the sentinel for pre-auth rejection. Phase 3 soak grep
filters can include or exclude it as desired.

---

#### G-n1 (NIT) — Dual-path edge case on DB outages

Validates current behavior: `getOrgContextDualPath` restricts fallback
to `UnauthorizedError` / `ForbiddenError`; DB-outage errors propagate
as 500.

**Disposition:** NO ACTION — _at the time_. Codex round 2 subsequently
revealed (C-M1) that this rationale didn't hold against the actual
`requireOrgContext` implementation, which conflated DB errors into
ForbiddenError. v3 fixed `requireOrgContext` and the contract Gemini
had assumed in G-n1 is now actually true. Cross-reference: Codex C-M1
below.

---

## Round 2 — Codex code-grounded (`codex exec -s read-only`)

- Invoked: 2026-05-26 PDT
- Wall-clock: ~3 min
- Prompt: `sandbox/working/codex_phase2_PROMPT.md`
- Response: `sandbox/working/codex_phase2_response.txt` (3.5KB)
- Verdict: **REQUEST CHANGES (1)** — 1 MAJOR + 2 MINOR

### Findings + author dispositions

#### C-M1 (MAJOR) — `requireOrgContext` conflates query failure with no-membership

**Reviewer text:** `frontend/lib/auth.ts:51` collapses every
`organization_members` query error into `ForbiddenError`, and
`getOrgContextDualPath()` at `:83` treats `ForbiddenError` as
permission to fall back to `SYSTEM_DEFAULT_ORG_ID`. Local
`postgrest-js` returns fetch/HTTP failures as `{ error, status: 0 }`
unless `.throwOnError()` is used, so DB/network/RLS failures can be
converted into default-org success. Duplicate memberships also become
`ForbiddenError`, masking the intended `.single()` fail-loud invariant.
Pattern in `auth/callback/route.ts:53` (Phase 1 v3) already
distinguishes; bring `requireOrgContext` into line.

**Disposition:** ACCEPT.

**Fix applied (v3) at `frontend/lib/auth.ts:48-79`:**
- Changed `.single()` to `.maybeSingle()`.
- `if (error) throw new Error(...)` — generic Error (not
  ForbiddenError) so `getOrgContextDualPath` does NOT catch + fall
  back to env. Propagates as 500.
- `if (!data) throw new ForbiddenError(...)` — only no-membership.
- File header comment block updated to document the error taxonomy.

This is technically a Phase 1 latent defect that became load-bearing in
Phase 2 (Phase 1 had no consumer of `requireOrgContext` because all
STOPGAP routes still used env). Fixed in Phase 2 since Phase 2 is the
consumer.

---

#### C-m1 (MINOR) — `storage-paths.ts` slug validation asymmetric with filenames

**Reviewer text:** Slugs only reject `/`. Filenames reject `/`, `\`,
and `..`. The helper is the tenant-boundary primitive; should be
symmetric. Not exploitable today (slugs are generated by
`generateSlug()`), but defense-in-depth.

**Disposition:** ACCEPT.

**Fix applied (v3) in both files:**
- `frontend/lib/storage-paths.ts:38-44` — slug check rejects `/`,
  `\`, and `..`.
- `agent/lib/storage-paths.ts:62-68` — paired identical fix.

Both files are sandbox-blocked direct edits; routed through
sandbox + .meta + /promote per `feedback_sandbox_hook_blocks_all_agent_paths`.

---

#### C-m2 (MINOR) — Implicit framework 500s lack X-Org-Source

**Reviewer text:** Explicit 500 responses set `X-Org-Source`; implicit
500s (uncaught exceptions from `findStateFile()`, `projectExists()`
outside try blocks) emit Next framework 500 without the header.
Telemetry debt — fix only if strict all-5xx coverage required.

**Disposition:** NO ACTION (accepted telemetry debt).

**Rationale:** Wrapping every storage helper call in try/catch would
add boilerplate without changing security posture. Phase 3 soak can
detect the gap via vercel logs; if coverage matters, add a Next
`error.tsx` boundary or route-level wrapper. Logged as known
follow-on; not gating merge.

---

#### Verified by Codex round 2 (no action)

- F2 rejection: `frontend/lib/supabase.ts:17` confirmed
  `SUPABASE_SERVICE_ROLE_KEY`. Worker PATCH unaffected by RLS.
- F1 v2 integration: storage routes no longer query `research_queue`;
  isolation is via `<orgId>/<slug>` storage prefixes.
- C-C1 BLOCKING fix correctly integrated: queue POST derives org
  before parent lookup, filters by `organization_id`, inserts
  explicit `organization_id`, returns same-org studio_only 400.

---

## Round 3 — Codex Sequential QA (`codex exec -s read-only`)

- Invoked: 2026-05-26 PDT
- Wall-clock: ~2 min
- Prompt: `sandbox/working/codex_phase2_qa_PROMPT.md`
- Response: `sandbox/working/codex_phase2_qa_response.txt` (2.8KB)
- Verdict: **APPROVE** — all 10 v3 fidelity checks PASS, no regressions

### Round 3 PASS table (verbatim from Codex)

| Check | Result | Evidence |
|---|---:|---|
| C-M1 query failure vs no-membership | PASS | `requireOrgContext()` uses `.maybeSingle()` at `frontend/lib/auth.ts:62`; query `error` throws generic `Error` at `frontend/lib/auth.ts:63`/`:72`; only `!data` throws `ForbiddenError` at `frontend/lib/auth.ts:76`/`:77`. |
| C-M1 dual-path catch boundary | PASS | `getOrgContextDualPath()` catches only `UnauthorizedError \|\| ForbiddenError` at `frontend/lib/auth.ts:106`; generic errors propagate via `throw err` at `frontend/lib/auth.ts:116`. |
| C-m1 frontend slug validation | PASS | Slugs reject `/`, `\`, and `..` at `frontend/lib/storage-paths.ts:38`, `:39`, `:40`; filename validation remains symmetric at `:48`. |
| C-m1 agent slug validation | PASS | Slugs reject `/`, `\`, and `..` at `agent/lib/storage-paths.ts:62`, `:63`, `:64`; filename validation remains symmetric at `:68`. |
| C-m2 accepted telemetry debt | PASS | No route-level synthetic header handling was added for propagated generic errors; `throw err` remains at `frontend/lib/auth.ts:116`. Explicit early-400 telemetry still works where required. |
| F2 rejection still holds | PASS | `getSupabase()` still reads `SUPABASE_SERVICE_ROLE_KEY` at `frontend/lib/supabase.ts:17` and constructs the singleton client with it at `:25`. |
| F1 storage-route guard removal not undone | PASS | Storage routes derive org via `getOrgContextDualPath()` and use storage-prefix checks: `frontend/app/api/runs/[slug]/file/[filename]/route.ts:41`/`:45`, `frontend/app/api/runs/[slug]/files/route.ts:26`/`:29`, `frontend/app/api/runs/[slug]/manifest/route.ts:72`/`:75`, `frontend/app/api/state/route.ts:102`/`:115`. No `research_queue` query remains under `frontend/app/api/runs` or `frontend/app/api/state`. |
| F3 early-400 `X-Org-Source:none` | PASS | Queue invalid JSON/Zod failures return `X-Org-Source:none` at `frontend/app/api/queue/route.ts:43` and `:51`; storage filename traversal does the same at `frontend/app/api/runs/[slug]/file/[filename]/route.ts:37`. |
| C-C1 queue POST org scoping | PASS | POST derives org before DB lookup at `frontend/app/api/queue/route.ts:58`; parent lookup scopes by `.eq("organization_id", orgId)` at `:88`; insert writes `organization_id: orgId` at `:124`. |
| No new false repo-path/comment claims in v3 touchpoints | PASS | Checked v3-added references against code: auth callback pattern exists at `frontend/app/auth/callback/route.ts:53`/`:57`; proxy PATCH short-circuit exists at `frontend/proxy.ts:63`/`:66`. |

**Codex dogfooding observation:** "this would likely have been caught
earlier with a small fidelity checklist for 'fallback catch taxonomy'
and 'mirrored helper validation parity' before merge-gate review."

---

## What each reviewer saw (per `~/CLAUDE.md` synthesis requirement)

- **Gemini round 1:** prompt-embedded source of 8 changed files + design
  context excerpts; no codebase file access (pure paste-and-respond
  via CLI). Could not verify `getSupabase()` implementation directly →
  F2 misread. Caught CRITICAL availability-regression in F1 via
  cross-reference to the v1 code's own S41 comment.
- **Codex round 2:** full repo read access via
  `codex exec -s read-only -C "<project root>"`; ground-truth against
  shipped v2 code + design doc + Round 1 audit trail. Independent
  code-grounded verification of F2 disposition + discovery of C-M1
  MAJOR (Phase 1 latent defect that Phase 2 made load-bearing).
- **Codex round 3:** same access; verified v3 fidelity to round-2
  dispositions + round-1 carryforward integrity.

Sequential topology delivered: Gemini's holistic paste-mode caught
the availability-regression breadth issue + cookie/early-400
telemetry; Codex's code-grounded pass caught the latent Phase 1
error-conflation that Gemini couldn't see (no access to
`requireOrgContext` source) + verified F2 misread. Round 3 closed the
loop cheaply.

---

## Cumulative findings tally

| Round | Reviewer | CRITICAL | MAJOR | MINOR | NIT | Verdict |
|---|---|---|---|---|---|---|
| 1 | Gemini Deep Think | 1 | 1 | 1 | 1 | REQUEST CHANGES (2) |
| 2 | Codex code-grounded | 0 | 1 | 2 | 0 | REQUEST CHANGES (1) |
| 3 | Codex Sequential QA | 0 | 0 | 0 | 0 | **APPROVE** |

All findings ACCEPTED or REJECTED with rationale (G-M1 rejected;
all others either accepted or explicitly deferred as telemetry debt).
Net code surface for Phase 2:
- 8 route handler bodies refactored (~750 LOC touched, ~80 LOC net add)
- 1 new helper export (`getOrgContextDualPath`, 28 LOC)
- 1 Phase-1-latent defect fixed (`requireOrgContext` error taxonomy)
- 2 helper-mirror parity fixes (storage-paths.ts slug validation,
  paired-edit)

CLI cost approximate: Gemini round 1 ~$2-3, Codex round 2 ~$5-7,
Codex round 3 ~$2-3. Total ~$9-13 for a SECURITY-labeled MERGE gate
that surfaced 1 CRITICAL availability regression (Gemini F1) + 1 MAJOR
latent error-taxonomy defect (Codex C-M1) + 2 MINOR hardening items.
Strong cost/value asymmetry — both findings would have been
production fire-drills.

---

## What this MERGE-gate exposed for design-doc back-port (deferred)

1. **§2.7 + §4.2 cross-org guard misclassification (Gemini F1).** The
   design treated `.eq('organization_id', orgId)` as the universal
   cross-org boundary for slug-bearing routes. It is the correct
   boundary for queue routes (which query `research_queue` directly).
   For storage routes, the boundary is the `scopedStoragePath(orgId, slug)`
   path prefix — cryptographic, not advisory. The DB guard was
   redundant AND it broke legacy-run access (S41-known: many completed
   runs have storage but no queue row). Design v4 should split the
   §2.7 guard pattern by route class.

2. **§2.4 helper error taxonomy underspecified (Codex C-M1).** The
   design spec for `requireOrgContext` showed `if (error || !data) throw
   new ForbiddenError(...)`, which conflates query failure with
   no-membership. Phase 1 implemented this faithfully; Phase 2's
   `getOrgContextDualPath` dependency made it dangerous (DB outage →
   silent env fallback). Design v4 should specify the error taxonomy
   explicitly: query failures throw a non-Forbidden error so
   dual-path fallback does not mask them.

3. **`storage-paths.ts` slug validation asymmetry (Codex C-m1).** Both
   the design (§2.6 footnotes) and the helper itself rejected `/` in
   slugs but not `\` / `..`. Symmetric with filename validation now.
   No design-doc back-port needed beyond noting the helper's invariants.

---

## Operationalization

Phase 2 deploys via the standard push-clone path (SoT `frontend/` →
sync to `c:/tmp/Dynamic-Research/frontend/` → push to
`DavidCeoGit/Dynamic-Research` → Vercel auto-builds). Reconcile
push-clone divergence first per `feedback_pushclone_divergence_reconcile.md`.

Phase 3 soak begins at deploy. Watch `X-Org-Source` header:
- `session` = authenticated request (Phase 2 happy path post-login)
- `env` = anonymous request (Phase 2 backward-compat — should disappear
  in Phase 4 when env fallback is retired)
- `none` = pre-auth rejection (Zod failures, path traversal, JSON parse)

Phase 3 success criterion: zero discrepancy between `session` and `env`
response payloads for system-default-org rows. Owner uses the app
normally in logged-in mode; curl probes exercise the env path.

---

*End of Phase 2 MERGE-gate review. Next: Phase 3 (soak, ~3 days), then
Phase 4 (delete env fallback, promote proxy.ts to full route protection),
then Phase 5 (`ENABLE ROW LEVEL SECURITY` migration).*
