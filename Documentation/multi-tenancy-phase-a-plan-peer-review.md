# Phase A Implementation Plan — Peer Review Synthesis (S45)

**Date:** 2026-05-22
**Trigger:** Multi-Reviewer Policy Framework HARD RULE in `~/CLAUDE.md` — DESIGN gate, parallel topology (Gemini + Codex independent reads).
**Reviewers:**
- **Gemini 3.5 Flash + Deep Think** (web app, manual paste) — see `sandbox/gemini-review-phase-a-plan.md`
- **Codex GPT-5.5 + xhigh reasoning** (`codex exec`, detached headless) — see `sandbox/codex-review-phase-a-plan-raw.md`
- **Claude Opus 4.7 (1M)** — plan author, baseline self-assessment in `sandbox/phase-a-implementation-plan.md` (v1)

**Status:** SYNTHESIS COMPLETE. Resolved direction below. v2 of the plan to be drafted after user sign-off on this synthesis.

**What each reviewer saw:**
- Gemini: the Phase A plan (v1) only, with cover-note context briefing.
- Codex: the Phase A plan (v1) + read the actual frontend/api/queue/route.ts code + Supabase docs/CLI source + Postgres docs. **Codex independently grounded its critique against live source, which surfaced findings no surface-pass could catch.**

---

## 1. Agreement Matrix (sorted by weight)

### High weight — both reviewers raised (CRITICAL or MAJOR)

| Decision | Concern | Gemini | Codex | Resolution |
|---|---|---|---|---|
| **A1 — Trigger bypass on `organization_id` / `user_id` mutation** | Limiting trigger to `BEFORE UPDATE OF role` lets an UPDATE that changes `organization_id` of the only owner silently leave the original org without governance. Plan's spoiler-dismissal ("Phase A doesn't enable cross-org migration") is defense-by-policy, not defense-in-depth. | CRITICAL §3/Q3 | CRITICAL C2 + MAJOR M1 (also adds non-concurrent sole-owner→member bypass that BEFORE-trigger would still allow) | **ACCEPT Codex's stronger fix:** replace with `AFTER … DEFERRABLE INITIALLY IMMEDIATE` constraint trigger that fires on INSERT/UPDATE/DELETE, uses `SELECT … FOR UPDATE` on `organizations` for per-org serialization, evaluates final table state ("if there are members but zero owners, raise"), permits zero-member orgs. Captures the declarative invariant rather than enumerating procedural blocks. Full SQL in §3.2 below. |
| **A2 — Topic_slug UNIQUE failure risk on duplicates** | Adding UNIQUE index on a live table with duplicates fails mid-migration. | MAJOR §2.4/Q5 | MAJOR M5 + Q5 | **ACCEPT.** Add explicit preflight in test script: `SELECT topic_slug, COUNT(*) FROM research_queue GROUP BY topic_slug HAVING COUNT(*) > 1` — assertion: 0 rows; abort if non-zero. Additionally: detect existing unique indexes structurally via `pg_index`, not by name (Codex). Prevents the migration's `IF NOT EXISTS` from silently using a wrong name if a manual index already exists. |
| **A3 — Transaction-atomicity claim under-verified** | Plan asserts atomic rollback citing "Supabase wraps migrations in transactions" without verification. `CREATE EXTENSION` and concurrent index builds may escape transaction scope. | MAJOR §6/Q6 | MAJOR M6 + Q6 (definitive answer with citations to Supabase CLI source `pkg/migration/file.go:129-154` `ExecBatch`) | **ACCEPT — and adopt Codex's harder constraint:** **production Phase A must be applied via `supabase db push` ONLY.** Supabase Studio SQL Editor BYPASSES migration history and has no plan-level atomicity. Wrap migration in explicit `BEGIN; … COMMIT;` for paranoia. **This is a real ops-pattern change from the existing convention** (the prior 2 migrations were applied via Studio per their comments — we are reversing that convention.) |
| **A4 — Default slug naming** | `david-workspace` hardcodes personal identity into infrastructure layer; doesn't scale. | MINOR §4/Q1 | MINOR #1 + Q1 | **ACCEPT.** Immutable slug = `system-default`. Mutable display name (`name` column) stays `"David's Workspace"`. Text fields are easily renamed via future admin UI without breaking URL routing or audit lineage. |

### Codex-only high-weight (Gemini missed)

| Decision | Concern | Codex finding | Resolution |
|---|---|---|---|
| **C-only-1 — Future inserts get `organization_id = NULL` during A→B gap** | The single biggest finding. Plan backfills EXISTING rows but doesn't address that the queue insertion endpoint (`frontend/app/api/queue/route.ts:81`) doesn't currently set `organization_id`. Every new submission between Phase A merge and Phase B's org-aware frontend deploy will get a NULL, breaking Phase C's `SET NOT NULL` plan. Codex caught this by reading the actual code. | CRITICAL C1 | **ACCEPT — adopt "Option 1+":** after inserting default org + backfilling existing rows, set a temporary DB `DEFAULT` on `research_queue.organization_id` to the default org UUID. Any insert that omits the column gets the default. Drop the default in Phase B once frontend writes explicit org IDs. Add a test that an insert omitting `organization_id` receives the default. |
| **C-only-2 — Non-concurrent sole-owner→member bypass** | The current (BEFORE) trigger counts only "OTHER members" — updating the sole owner to `member` sees zero other members, passes the check, leaves org with 1 member + 0 owners. This is a DIRECT bypass, not concurrent. Gemini's "expand to BEFORE UPDATE" fix doesn't catch this either — only Codex's AFTER deferrable trigger evaluating final state does. | MAJOR M1 | **ACCEPT** — handled automatically by adopting Codex's trigger redesign (A1 above). |
| **C-only-3 — Invitation token bcrypt-only isn't indexable** | bcrypt is a one-way hash with random salt — equality lookups on the hash itself are impossible for a never-before-seen plaintext. The plan stores `token_hash` (bcrypt) and claims an email index covers token lookup, but token lookup is by TOKEN, not email. As designed, the invite acceptance flow has no way to find the row by token in O(1). | MAJOR M3 | **ACCEPT.** Add `token_digest TEXT NOT NULL UNIQUE` computed as HMAC-SHA-256 (or SHA-256) of the raw 32-byte token. Keep `token_hash` (bcrypt) for the security comparison. Acceptance flow: lookup by digest (indexed, O(1)), THEN verify with bcrypt against `token_hash`. Bcrypt alone is not a workable design here. |
| **C-only-4 — `email_normalized` as text drifts** | If app forgets to normalize on insert, the unique partial index breaks silently. | MAJOR M4 | **ACCEPT.** Define as `email_normalized TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED`. DB maintains it. Alternative: drop the column and use a partial unique expression index `ON (lower(btrim(email)))` — equally valid. Pick the GENERATED column form for explicit schema-as-documentation. |
| **C-only-5 — Idempotency test contradicts skeleton** | Plan's test #8 claims re-run is side-effect-free, but the v1 SQL skeleton has trigger creation that isn't `IF NOT EXISTS`-safe. | MAJOR M7 | **ACCEPT.** Make all DDL fully idempotent: `CREATE OR REPLACE FUNCTION`, `CREATE TRIGGER IF NOT EXISTS` (where supported), `DROP TRIGGER IF EXISTS … ; CREATE TRIGGER …` pattern for trigger redefinition. OR drop test #8 entirely and rely on Supabase migration history for idempotency. Pick the former — explicit idempotency is more defensive. |
| **C-only-6 — Phase B bootstrap contract is under-specified** | Plan defers member insertion to Phase B but doesn't say what Phase B's callback actually does. Risk: Phase B implementation drifts from assumption. | MAJOR M2 | **ACCEPT.** Spec the contract in this synthesis (carries over to Phase B work): "Phase B's magic-link callback handler, when run for `ceo@thewcoachinggroup.com` AND the default org has zero owners, inserts `(organization_id=system-default, user_id=<new>, role='owner')` with `ON CONFLICT (organization_id, user_id) DO NOTHING`. Aborts if the default org already has any owner whose user does not match the expected email." Documents the expectation. |

### Gemini-only high-weight (Codex missed)

| Decision | Concern | Gemini finding | Resolution |
|---|---|---|---|
| **G-only-1 — Option 1.5 (post-deploy admin bootstrap script)** | New 4th backfill option not in plan: execute Option 1's SQL migration, THEN run an admin script via Service Role API immediately after to insert the primary user. Eliminates the empty-org gap entirely WITHOUT putting auth.* mutations in the SQL migration file. Codex didn't propose this — Codex's Q2 said "zero-member gap is acceptable" via Phase B callback alone. | MAJOR §4/Q2 architectural improvement | **PARTIAL ACCEPT — STACK with Codex's Option 1+.** Codex's DB DEFAULT (C-only-1) solves the *future inserts during A→B* problem. Gemini's admin script solves the *empty-org window* problem. They are complementary, not competing. v2 uses BOTH: (1) DB DEFAULT keeps new inserts safe, (2) post-deploy `agent/scripts/phase-a-bootstrap-primary-user.ts` closes the empty-org window in the same deploy session. Reason to keep both: each is independently defensible if the other fails (defense-in-depth). |
| **G-only-2 — Local Docker test environment** | Suggested as bonus best-practice for trigger testing. | (bonus §7) | **DEFER as Phase A.5 enhancement** — useful but not blocking v2. Track as follow-up. |

### Medium weight — both raised at MINOR or one-side MINOR

| Concern | Reviewer | Resolution |
|---|---|---|
| Slug/name CHECK constraints | Codex Minor #2 | **ACCEPT.** Add `CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')` and `CHECK (btrim(name) <> '')` to `organizations`. |
| Explicit `ON DELETE RESTRICT` on `research_queue.organization_id` FK | Codex Minor #3 | **ACCEPT.** Change `REFERENCES organizations(id)` to `REFERENCES organizations(id) ON DELETE RESTRICT`. Makes intent explicit (can't delete an org while it has queue rows). |
| Invitation lifecycle needs `revoked_at` | Codex Minor #4 | **ACCEPT.** Add `revoked_at TIMESTAMPTZ` to `organization_invitations`. Update partial unique index `WHERE accepted_at IS NULL AND revoked_at IS NULL` so a revoked invite can be reissued. |
| Test #1 should allow `NOTICE` output | Codex Minor #5 | **ACCEPT.** Change test #1 pass condition: "Zero `WARNING` or error; `NOTICE` from `IF NOT EXISTS` allowed; any unexpected NOTICE fails." |
| `pgcrypto` schema-qualification | Codex Q4 | **ACCEPT.** Use `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;` (Supabase best practice — keeps `public` schema clean). |

### Low weight — flagged but rejected or out-of-scope

| Concern | Reasoning to defer/reject |
|---|---|
| Gemini §7 local Docker env | DEFER to Phase A.5; tracked. |

---

## 2. Plan author's baseline predictions — graded

From v1 §7 open questions, my own pre-review flags:
- Q1 slug naming → ✅ Both reviewers agreed: change to `system-default`. Easy fix.
- Q2 backfill option → ✅ Both reviewers went FURTHER. Gemini proposed Option 1.5; Codex proposed Option 1+. v2 stacks both.
- Q3 trigger scope → ❌ I had defense-by-policy posture ("Phase A doesn't enable cross-org migration"). Both reviewers correctly pushed back. **The most important catch of the review.** Codex's deferrable-constraint-trigger is structurally better than my BEFORE-trigger + better than Gemini's BEFORE-expansion.
- Q4 pgcrypto timing → ✅ Both confirmed plan correct; Codex added schema-qualification refinement.
- Q5 topic_slug duplicates → ✅ Both confirmed; concrete preflight SQL given.
- Q6 transaction boundary → ✅ Codex resolved DEFINITIVELY with CLI source citation. Studio NOT atomic; `supabase db push` IS. Changes our ops pattern.
- Q7 indexes on small table → ✅ Both confirmed plan correct.

**Things I missed that BOTH reviewers found:** trigger bypass via `organization_id` mutation; transaction-boundary unverified.

**Things only Codex found** (5): future-NULL inserts during A→B (the single biggest finding), sole-owner→member non-concurrent bypass, bcrypt-not-indexable, email_normalized-as-text, idempotency mismatch, Phase B bootstrap contract under-spec.

**Things only Gemini found:** Option 1.5 architectural alternative; local-Docker test env (bonus).

**Reviewer-mix observation:** Codex was substantially deeper this round because it READ THE ACTUAL CODE (`route.ts`, Supabase CLI source on GitHub, Postgres extension docs). Gemini reviewed the plan in isolation. **This validates running Codex via the headless CLI (with read-only sandbox) over the web-app paste pattern when code-grounded review matters.** For purely abstract architectural reviews, Gemini's Deep Think mode is still strongest. v2 of the gate-dependent rule could refine: DESIGN gate parallel BUT prefer Codex over Gemini when the artifact references code paths that should be verified.

---

## 3. Resolved Direction (v2 of plan)

### 3.1 Cut from v1
- Studio SQL Editor as a production-migration path (A3 / Codex Q6). Production = `supabase db push` only.

### 3.2 Trigger redesign — replace v1 §3 wholesale

```sql
-- Declarative invariant: "an organization with any members must have at least one owner."
-- Zero-member orgs are valid (during A→B gap and otherwise).
-- AFTER DEFERRABLE constraint trigger:
--   - sees final table state (catches sole-owner→member bypass)
--   - DEFERRABLE handles concurrent transactions
--   - SELECT … FOR UPDATE serializes per-org

CREATE OR REPLACE FUNCTION enforce_min_one_owner() RETURNS trigger AS $$
DECLARE
  org_id uuid;
  member_count int;
  owner_count int;
BEGIN
  FOR org_id IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.organization_id END,
      CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.organization_id END
    ]) AS t(x)
    WHERE x IS NOT NULL
  LOOP
    PERFORM 1 FROM organizations WHERE id = org_id FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE; -- org deletion cascade in flight
    END IF;

    SELECT count(*), count(*) FILTER (WHERE role = 'owner')
      INTO member_count, owner_count
    FROM organization_members
    WHERE organization_id = org_id;

    IF member_count > 0 AND owner_count = 0 THEN
      RAISE EXCEPTION 'organization % must have at least one owner while it has members', org_id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_organization_members_min_owner ON organization_members;
CREATE CONSTRAINT TRIGGER trg_organization_members_min_owner
  AFTER INSERT OR UPDATE OR DELETE ON organization_members
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_min_one_owner();
```

### 3.3 Backfill strategy — Option 1+ stacked with Option 1.5

**Phase A migration SQL** (wrapped in `BEGIN; … COMMIT;`, applied via `supabase db push`):

```sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- (tables + indexes + trigger from §3.2 + §3.4 below)

INSERT INTO organizations (name, slug)
  VALUES ('David''s Workspace', 'system-default')
  ON CONFLICT (slug) DO NOTHING;

-- Backfill existing rows
UPDATE research_queue
  SET organization_id = (SELECT id FROM organizations WHERE slug = 'system-default')
  WHERE organization_id IS NULL;

-- Option 1+: temporary DEFAULT so new inserts during A→B aren't NULL
ALTER TABLE research_queue
  ALTER COLUMN organization_id
  SET DEFAULT (SELECT id FROM organizations WHERE slug = 'system-default');

COMMIT;
```

**Post-deploy bootstrap script (Option 1.5)** — `agent/scripts/phase-a-bootstrap-primary-user.ts`:

```typescript
// Idempotent. Uses SUPABASE_SERVICE_ROLE_KEY. Runs AFTER `supabase db push` completes.
// 1. supabase.auth.admin.createUser({ email: 'ceo@thewcoachinggroup.com', email_confirm: true })
//    Detect-if-exists-else-create. If exists, fetch the user.id.
// 2. INSERT INTO organization_members (organization_id, user_id, role)
//      VALUES ((SELECT id FROM organizations WHERE slug='system-default'), <user_id>, 'owner')
//      ON CONFLICT (organization_id, user_id) DO NOTHING;
// 3. Verify: count owners in system-default == 1, count members == 1.
// Aborts non-zero if owner count != 1 after step 2 (means an unexpected owner exists).
// Logs to stdout for audit.
```

**Phase B contract** (specified now, implemented later):
> When the magic-link callback handler runs for `ceo@thewcoachinggroup.com`:
> - If `auth.users` row already exists (post-bootstrap), no auth action needed.
> - If `organization_members` row for this user + system-default org already exists, no member action needed.
> - If owner role already filled by a different user_id, abort with explicit error (operator intervention required).
> - All inserts use `ON CONFLICT DO NOTHING`.

### 3.4 Schema additions vs. v1

`organizations`:
- ADD: `CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')` (Codex Minor #2)
- ADD: `CHECK (btrim(name) <> '')` (Codex Minor #2)

`organization_invitations`:
- CHANGE `email_normalized TEXT NOT NULL` to: `email_normalized TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED` (Codex M4)
- ADD: `token_digest TEXT NOT NULL UNIQUE` (HMAC-SHA-256 of raw token, for indexable lookup) (Codex M3)
- KEEP: `token_hash` (bcrypt) for security verification
- ADD: `revoked_at TIMESTAMPTZ` (Codex Minor #4)
- UPDATE partial unique index: `WHERE accepted_at IS NULL AND revoked_at IS NULL` (Codex Minor #4)

`research_queue`:
- CHANGE: `REFERENCES organizations(id)` → `REFERENCES organizations(id) ON DELETE RESTRICT` (Codex Minor #3)
- ADD: temporary `DEFAULT (SELECT id FROM organizations WHERE slug='system-default')` (Codex C1) — to be dropped in Phase B

Indexes (Codex Q7 refinement):
- Add `idx_organization_invitations_token_digest UNIQUE` (already covered by `UNIQUE` constraint on the column, but document)
- Existing partial index on `email_normalized WHERE accepted_at IS NULL` becomes `WHERE accepted_at IS NULL AND revoked_at IS NULL`
- Add `idx_organization_invitations_organization_id` for the "list invites for this org" path (small but useful)

### 3.5 Pre-merge test surface (rewritten v1 §5)

Tests to live in `agent/scripts/test-phase-a-migration.sh` (Codex's recommendations integrated):

| # | Test | Pass condition |
|---|---|---|
| 0 | NEW: PRE-FLIGHT — staging clone of production at expected baseline schema | Schema hash matches |
| 0.5 | NEW: PRE-FLIGHT — no `topic_slug` duplicates | `SELECT topic_slug, COUNT(*) FROM research_queue GROUP BY topic_slug HAVING COUNT(*) > 1` returns 0 rows; abort otherwise |
| 0.6 | NEW: PRE-FLIGHT — no existing unique index on `topic_slug` with conflicting name | `pg_index` structural check; if found, use existing name |
| 1 | Migration runs cleanly via `supabase db push` | Exit 0; only `NOTICE` from `IF NOT EXISTS` allowed; any `WARNING`/`ERROR` fails |
| 2 | All pre-existing rows backfilled | `SELECT COUNT(*) FROM research_queue WHERE organization_id IS NULL` returns 0 |
| 3 | Default org exists with correct slug + name | `SELECT * FROM organizations WHERE slug = 'system-default'` returns exactly 1 row with `name = "David's Workspace"` |
| 4 | DB DEFAULT works | INSERT a `research_queue` row WITHOUT `organization_id` → row receives default org UUID (Codex C1 critical test) |
| 5 | Indexes created | `\d` checks for all expected indexes incl. partial invitation index |
| 6 | Trigger function compiles + behaves declaratively | `\df enforce_min_one_owner` returns 1 row |
| 7 | Trigger refuses all bypass vectors | Test matrix: (a) DELETE sole owner → block; (b) UPDATE role from owner→member when sole owner → block; (c) UPDATE organization_id of sole owner → block; (d) UPDATE user_id of sole owner → block; (e) zero-member org → permitted; (f) concurrent INSERT/DELETE serialization → no race |
| 8 | Re-running migration is idempotent | Apply twice → second run is no-op (post-Codex M7 fix: all DDL is fully idempotent) |
| 9 | Bootstrap script runs idempotent | Run twice → no duplicate auth.users / organization_members rows |
| 10 | Rollback restores prior state | Apply migration → run rollback → schema matches snapshot |

### 3.6 Rollback procedure (v1 §6 updated)

```sql
BEGIN;

DROP TRIGGER IF EXISTS trg_organization_members_min_owner ON organization_members;
DROP FUNCTION IF EXISTS enforce_min_one_owner();

ALTER TABLE research_queue ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE research_queue DROP COLUMN IF EXISTS organization_id;

DROP TABLE IF EXISTS organization_invitations CASCADE;
DROP TABLE IF EXISTS organization_members CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- NOTE: pgcrypto extension intentionally left enabled (cheap; possibly used by other migrations later).
-- NOTE: topic_slug UNIQUE index intentionally left in place if it was added (it's a generally-correct invariant).

COMMIT;
```

Bootstrap-script rollback (if Option 1.5 ran but migration needs revert):
```bash
# Delete auth.users row (via Supabase Admin API): supabase.auth.admin.deleteUser(<user_id>)
# organization_members row CASCADEs when organizations is dropped
```

### 3.7 Phase A is now two artifacts, not one

v1 treated Phase A as a single SQL migration. v2 makes it explicit:
1. **`supabase/migrations/20260522-phase-a-multi-tenancy.sql`** — the migration (applied via `supabase db push`)
2. **`agent/scripts/phase-a-bootstrap-primary-user.ts`** — the post-deploy bootstrap (run manually OR added as a CI step)
3. **`agent/scripts/test-phase-a-migration.sh`** — the pre-merge test suite

Sequence:
```
1. Pre-flight tests (0, 0.5, 0.6) → PASS or abort
2. supabase db push → applies migration atomically
3. Bootstrap script → idempotent post-deploy
4. Post-merge tests (1-11) → PASS or rollback
5. Deploy frontend (Phase B) — picks up `organization_id` from new rows automatically
```

---

## 4. Open follow-ups / design debt

- **Local Docker test environment for trigger** (Gemini bonus #7) — Phase A.5 test-suite enhancement.
- **Drop the temporary DB DEFAULT** in Phase B once org-aware frontend is shipping — track explicitly.
- **bcrypt-vs-HMAC for token_hash** — decision: keep both, HMAC for lookup + bcrypt for verify. Document in Phase F skill notes.
- **Refine gate-dependent rule:** when an artifact references code paths, prefer Codex (code-grounded) over Gemini for at least one of the two parallel reviewers. Add to `feedback_multi_reviewer_gate_dependent_pattern.md` as a memory update post-this-session.
- **Document the supabase-db-push-only convention** — current ops convention was Studio SQL editor; Phase A reverses this. Add a note to memory or `Documentation/`.

---

## 5. Sign-off readiness

This synthesis is the authoritative direction for v2 of the Phase A implementation plan. The v2 plan will be drafted next, applying every "ACCEPT" decision above. The pre-existing v1 plan + Gemini review + Codex raw review remain in `sandbox/` as the audit trail.

**The HARD RULE earned its keep this round.** Two independent reviewers caught complementary issues — Codex's code-grounded depth (5 unique findings + the single biggest catch via reading route.ts) + Gemini's structural Option 1.5 invention + both converging on the trigger bypass and transaction boundary → v2 will be substantially stronger than what Claude-only review would have produced.

— Claude Opus 4.7 (1M), S45 (2026-05-22), synthesis complete pending user sign-off.
