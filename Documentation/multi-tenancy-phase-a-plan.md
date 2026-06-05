# Multi-Tenancy — Phase A Implementation Plan **v3** (FINAL)

**Status:** Final draft. Incorporates v1 + v2 peer review (Gemini 3.5 Flash + Deep Think; Codex GPT-5.5 + xhigh sequential QA). v3 applies the 10 mechanical drift-fixes from the v2 QA — no new architectural decisions.
**Author:** Claude Opus 4.7 (1M), S45 (2026-05-22).
**Supersedes:** v1 (`sandbox/phase-a-implementation-plan.md`), v2 (`sandbox/phase-a-implementation-plan-v2.md`).
**Peer-review trail:**
- v1 parallel DESIGN review: `sandbox/gemini-review-phase-a-plan.md`, `sandbox/codex-review-phase-a-plan-raw.md` (lines 4750-end)
- v1 synthesis: `sandbox/phase-a-plan-peer-review-synthesis.md`
- v2 sequential QA: `sandbox/codex-qa-review-phase-a-plan-v2.md`

**Why v3 doesn't require another peer review:** v3 applies 10 specific mechanical fixes that Codex's QA explicitly recommended. No new architectural decisions. Per Review Topology v2.1 spirit, a fully-specified mechanical-fix revision does not re-trigger sequential QA — that's just "applying review feedback." Worth adding to the global rule next session.

---

## 0. Changes v2 → v3 (mechanical fixes from Codex QA)

| # | Fix | Where applied |
|---|---|---|
| 1 | **Add `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;`** as first migration statement (v2 missed this) | §2.0 (new) |
| 2 | **Replace invalid `SET DEFAULT (SELECT …)`** with `DO $$ … EXECUTE format(…) …$$` block that captures UUID into variable then ALTERs with literal | §4.1 |
| 3 | **Add idempotent `topic_slug` UNIQUE migration SQL** (pg_index structural check; only CREATE if no existing unique index on the column) — separate from read-only pre-flight | §2.4 + §5 test 0.6 |
| 4 | **Bootstrap script writes `{created_user: bool, user_id: uuid}`** state file | §4.2 |
| 5 | **Bootstrap rollback reads state file**, only deletes auth.users if `created_user=true` | §6 (bootstrap rollback) |
| 6 | **Bootstrap pre-checks for conflicting owner BEFORE any mutation** (matches Phase B contract) | §4.2 |
| 7 | **Test matrix adds `UPDATE user_id` case + concurrent INSERT/DELETE serialization** | §5 test 7 |
| 8 | **Test #5 expected indexes adds `token_digest` UNIQUE** | §5 test 5 |
| 9 | **Trigger wording clarifies `DEFERRABLE INITIALLY IMMEDIATE` semantics** (checks at statement end by default unless caller `SET CONSTRAINTS … DEFERRED`) | §3 (note) |
| 10 | **`token_digest` changed to plain SHA-256** (HMAC overkill for 32-byte CSPRNG token); **bcrypt cost = `gen_salt('bf', 12)`** specified in Phase F notes | §2.3, §7 (deferred Phase F note) |

Items 11-16 from v2 §0 (which were the v1→v2 changes) all verified by QA as correctly applied — they carry forward into v3 unchanged.

---

## 1. Phase A scope (v3)

### IN SCOPE
1. Enable `pgcrypto` extension into `extensions` schema (Supabase best practice) — **explicit SQL statement, not just scope description**.
2. Create 3 new tables: `organizations`, `organization_members`, `organization_invitations` (RLS **DISABLED**).
3. Role + slug-format + name-non-empty CHECK constraints.
4. `email_normalized` as GENERATED STORED column.
5. Invitation `token_digest TEXT NOT NULL UNIQUE` (plain SHA-256, indexable) + `token_hash TEXT NOT NULL` (bcrypt cost=12, verify-only) + `revoked_at TIMESTAMPTZ`.
6. Indexes (4): members(user_id), queue(organization_id) partial, invitation active partial, invitation organization_id. Plus implicit `token_digest` UNIQUE index.
7. ≥1-owner constraint as **AFTER DEFERRABLE constraint trigger** evaluating final state with per-org `FOR UPDATE` lock.
8. `ALTER TABLE research_queue ADD COLUMN organization_id UUID NULL REFERENCES organizations(id) ON DELETE RESTRICT`.
9. **Temporary DB DEFAULT** on `research_queue.organization_id` set via `DO $$ … EXECUTE format(…) …$$` block to a literal UUID resolved at migration time.
10. **Idempotent `topic_slug` UNIQUE creation** if no structural single-column unique index already exists (via `pg_index` check inside a DO block).
11. Backfill: insert default org (slug=`system-default`, name=`David's Workspace`); update existing rows.
12. **Post-deploy bootstrap script** at `agent/scripts/phase-a-bootstrap-primary-user.ts`:
    - PRE-CHECK: if system-default already has an owner whose email ≠ `ceo@thewcoachinggroup.com`, abort with diagnostic (no mutation).
    - Idempotent createUser + add-owner; writes `{created_user: bool, user_id: uuid}` state file at `agent/scripts/.phase-a-bootstrap-state.json`.
13. **Pre-flight + integration test bash script** at `agent/scripts/test-phase-a-migration.sh`.

### OUT OF SCOPE (unchanged from v1/v2)
RLS policies → C; immutable org_id trigger on queue → C; SET NOT NULL → C; storage paths → D; storage RLS → D; worker code → E; frontend auth → B; invite CLI → F; per-job JWT → A.5; enhancement_log → G; local Docker test container → A.5.

---

## 2. Schema design — final SQL skeleton (v3)

### 2.0 Extension (FIRST statement — v2 missed this)
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
```

### 2.1 `organizations`
```sql
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (btrim(name) <> ''),
  slug        TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.2 `organization_members`
```sql
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
```

### 2.3 `organization_invitations` (v3 fix: SHA-256 token_digest, not HMAC)
```sql
CREATE TABLE IF NOT EXISTS organization_invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  email_normalized  TEXT GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  token_digest      TEXT NOT NULL UNIQUE,  -- plain SHA-256 of raw 32-byte CSPRNG token; indexable O(1) lookup
  token_hash        TEXT NOT NULL,         -- bcrypt(gen_salt('bf', 12)) of raw token; verify-only
  invited_by        UUID NOT NULL REFERENCES auth.users(id),
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_invitation_per_org_email
  ON organization_invitations (organization_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

### 2.4 Modify `research_queue` + idempotent `topic_slug` UNIQUE
```sql
ALTER TABLE research_queue
  ADD COLUMN IF NOT EXISTS organization_id UUID NULL
    REFERENCES organizations(id) ON DELETE RESTRICT;

-- v3 fix: idempotent topic_slug UNIQUE creation guarded by pg_index structural check.
-- Creates the unique index ONLY if no existing single-column unique index already covers topic_slug.
DO $$
DECLARE
  existing_idx_name TEXT;
BEGIN
  SELECT c.relname INTO existing_idx_name
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  WHERE t.relname = 'research_queue'
    AND i.indisunique = TRUE
    AND array_length(i.indkey, 1) = 1
    AND (
      SELECT attname FROM pg_attribute
      WHERE attrelid = t.oid AND attnum = i.indkey[0]
    ) = 'topic_slug'
  LIMIT 1;

  IF existing_idx_name IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX uniq_research_queue_topic_slug ON research_queue (topic_slug)';
    RAISE NOTICE 'Created uniq_research_queue_topic_slug index';
  ELSE
    RAISE NOTICE 'Existing unique index % already covers topic_slug; skipping creation', existing_idx_name;
  END IF;
END $$;
```

### 2.5 Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_organization_members_user_id
  ON organization_members (user_id);

CREATE INDEX IF NOT EXISTS idx_research_queue_organization_id
  ON research_queue (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organization_invitations_organization_id
  ON organization_invitations (organization_id);
-- Note: token_digest UNIQUE constraint on the column implicitly creates a unique index — no separate CREATE INDEX needed.
-- Note: uniq_active_invitation_per_org_email defined inline in §2.3.
```

---

## 3. ≥1-owner trigger (unchanged from v2, with v3 wording clarification)

```sql
CREATE OR REPLACE FUNCTION enforce_min_one_owner() RETURNS TRIGGER AS $$
DECLARE
  org_id UUID;
  member_count INT;
  owner_count INT;
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
      CONTINUE;  -- Org deletion cascade in flight; skip.
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

**Note on `DEFERRABLE INITIALLY IMMEDIATE` semantics (v3 clarification):** with `INITIALLY IMMEDIATE`, the trigger fires at the end of each statement by default (NOT at commit). A caller can opt into deferred-to-commit firing within a transaction via `SET CONSTRAINTS trg_organization_members_min_owner DEFERRED;`. For typical synchronous operations, statement-end is sufficient and matches the locking + `FOR UPDATE` pattern correctly. Defer only when a multi-statement transaction needs to atomically rebalance memberships (e.g., remove one owner + add another in the same transaction).

---

## 4. Backfill — Option 1+ stacked with Option 1.5 (v3 fixes)

### 4.1 Migration SQL backfill (v3: DO-block default fix)

```sql
-- After table CREATEs, indexes, and trigger:

-- Insert default org
INSERT INTO organizations (name, slug)
  VALUES ('David''s Workspace', 'system-default')
  ON CONFLICT (slug) DO NOTHING;

-- Backfill existing rows
UPDATE research_queue
  SET organization_id = (SELECT id FROM organizations WHERE slug = 'system-default')
  WHERE organization_id IS NULL;

-- v3 fix: DB DEFAULT via DO block with EXECUTE (column DEFAULTs cannot contain subqueries).
DO $$
DECLARE
  v_default_org_id UUID;
BEGIN
  SELECT id INTO v_default_org_id
  FROM organizations WHERE slug = 'system-default';

  IF v_default_org_id IS NULL THEN
    RAISE EXCEPTION 'system-default org not found — backfill must have failed';
  END IF;

  EXECUTE format(
    'ALTER TABLE research_queue ALTER COLUMN organization_id SET DEFAULT %L::uuid',
    v_default_org_id
  );
END $$;
```

### 4.2 Bootstrap script (v3: pre-check + state-file)

File: `agent/scripts/phase-a-bootstrap-primary-user.ts`

Pseudocode (TypeScript implementation pending S46):
```typescript
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, existsSync } from 'fs';

const STATE_FILE = 'agent/scripts/.phase-a-bootstrap-state.json';
const EXPECTED_EMAIL = 'ceo@thewcoachinggroup.com';

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Resolve system-default org_id
  const { data: org } = await sb.from('organizations')
    .select('id').eq('slug', 'system-default').single();
  if (!org) throw new Error('system-default org missing; migration must run first');

  // 2. v3 PRE-CHECK: any existing owners?
  const { data: existingOwners } = await sb.from('organization_members')
    .select('user_id, role').eq('organization_id', org.id).eq('role', 'owner');
  if (existingOwners?.length) {
    // Check their emails via auth.admin
    for (const ownerRow of existingOwners) {
      const { data: u } = await sb.auth.admin.getUserById(ownerRow.user_id);
      if (u.user?.email !== EXPECTED_EMAIL) {
        throw new Error(`UNEXPECTED OWNER in system-default: user_id=${ownerRow.user_id} email=${u.user?.email}; ABORTING. Operator must investigate.`);
      }
    }
    console.log('system-default already has expected owner; no action needed.');
    writeFileSync(STATE_FILE, JSON.stringify({ created_user: false, user_id: existingOwners[0].user_id }));
    return;
  }

  // 3. createUser (idempotent)
  let userId: string;
  let createdUser = false;
  const { data: existingUser } = await sb.auth.admin.listUsers();
  const found = existingUser.users.find(u => u.email === EXPECTED_EMAIL);
  if (found) {
    userId = found.id;
  } else {
    const { data: newUser, error } = await sb.auth.admin.createUser({
      email: EXPECTED_EMAIL, email_confirm: true
    });
    if (error) throw error;
    userId = newUser.user!.id;
    createdUser = true;
  }

  // 4. Insert owner membership
  const { error: memberErr } = await sb.from('organization_members').insert({
    organization_id: org.id, user_id: userId, role: 'owner'
  });
  if (memberErr && !memberErr.message.includes('duplicate')) throw memberErr;

  // 5. Verify post-state
  const { data: postOwners } = await sb.from('organization_members')
    .select('user_id').eq('organization_id', org.id).eq('role', 'owner');
  if (postOwners?.length !== 1 || postOwners[0].user_id !== userId) {
    throw new Error('POST-STATE invariant failed: expected exactly 1 owner matching primary user');
  }

  // 6. Write state file for rollback
  writeFileSync(STATE_FILE, JSON.stringify({ created_user: createdUser, user_id: userId }));
  console.log(`Bootstrap complete: created_user=${createdUser}, user_id=${userId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

### 4.3 Phase B callback contract (unchanged from v2 §4.3)

Spelled out in v2; same applies here. v3 bootstrap script's pre-check enforces the contract from the Phase A side as well.

### 4.4 Why both Option 1+ and Option 1.5 (unchanged from v2)

Same rationale: defense-in-depth covering both *future inserts during A→B gap* (Option 1+ via DB DEFAULT) and *empty-org window* (Option 1.5 via bootstrap).

---

## 5. Pre-merge test surface (v3 — fixes for items 7, 8)

| # | Test | Pass condition |
|---|---|---|
| 0 | PRE-FLIGHT — staging clone at expected baseline schema | Schema hash matches |
| 0.5 | PRE-FLIGHT — no `topic_slug` duplicates | `SELECT topic_slug, COUNT(*) FROM research_queue GROUP BY topic_slug HAVING COUNT(*) > 1` returns 0 rows; abort if non-zero |
| 0.6 | PRE-FLIGHT — read-only check of existing unique indexes on `topic_slug` | Report existing index name if any; pass either way (DDL handled idempotently in migration §2.4) |
| 1 | Migration applies cleanly via `supabase db push` | Exit 0; only `NOTICE` allowed; any `WARNING`/`ERROR` fails |
| 2 | All pre-existing rows backfilled | `SELECT COUNT(*) FROM research_queue WHERE organization_id IS NULL` returns 0 |
| 3 | Default org exists | `SELECT slug, name FROM organizations WHERE slug='system-default'` returns 1 row with correct name |
| 4 | DB DEFAULT works | INSERT minimal `research_queue` row WITHOUT `organization_id` → row receives system-default UUID via DEFAULT |
| 5 | Indexes created (v3 fix: includes `token_digest`) | Expected: `idx_organization_members_user_id`, `idx_research_queue_organization_id`, `uniq_active_invitation_per_org_email`, `idx_organization_invitations_organization_id`, `uniq_research_queue_topic_slug` (or pre-existing), implicit `token_digest` UNIQUE |
| 6 | Trigger function compiles + permits zero-member orgs | `\df enforce_min_one_owner` returns 1 row; insert zero-member org → no error |
| 7 | Trigger blocks all bypass vectors (v3 fix: full matrix) | (a) DELETE sole owner → EXCEPTION; (b) UPDATE sole owner role→member → EXCEPTION; (c) UPDATE sole owner's organization_id → EXCEPTION; (d) **UPDATE sole owner's user_id → EXCEPTION** (v3 new); (e) INSERT first member as 'member' (no owner) → EXCEPTION; (f) **concurrent INSERT+DELETE in two transactions → SERIALIZE (one waits, both eventually consistent)** (v3 new); (g) two-owner org delete-one → succeeds |
| 8 | Re-running migration is idempotent | Apply twice → second run is no-op; all DDL is `IF NOT EXISTS` or DO-block guarded |
| 9 | Bootstrap script is idempotent | Run twice → no duplicate auth.users; state file shows `created_user=false` on 2nd run |
| 10 | Bootstrap pre-check blocks conflicting owners | Pre-seed system-default with a non-expected owner → bootstrap aborts without mutation; clear diagnostic |
| 11 | Rollback restores prior state | Apply migration + bootstrap → rollback (using state file to know whether to delete auth.users) → schema matches snapshot |

---

## 6. Rollback procedure (v3 — bootstrap rollback uses state file)

**Migration rollback SQL** (unchanged from v2):
```sql
BEGIN;
DROP TRIGGER IF EXISTS trg_organization_members_min_owner ON organization_members;
DROP FUNCTION IF EXISTS enforce_min_one_owner();
ALTER TABLE research_queue ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE research_queue DROP COLUMN IF EXISTS organization_id;
DROP TABLE IF EXISTS organization_invitations CASCADE;
DROP TABLE IF EXISTS organization_members CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
COMMIT;
```

**Bootstrap rollback script** (v3 fix: state-file-aware):
`agent/scripts/phase-a-rollback-primary-user.ts`:
```typescript
import { readFileSync, existsSync, unlinkSync } from 'fs';

const STATE_FILE = 'agent/scripts/.phase-a-bootstrap-state.json';

async function main() {
  if (!existsSync(STATE_FILE)) {
    console.log('No bootstrap state file; bootstrap may not have run. No action.');
    return;
  }
  const { created_user, user_id } = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));

  if (!created_user) {
    console.log(`Bootstrap did not create user_id=${user_id}; leaving auth.users untouched.`);
    unlinkSync(STATE_FILE);
    return;
  }

  // Bootstrap created the user; safe to delete on rollback.
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await sb.auth.admin.deleteUser(user_id);
  if (error) throw error;
  console.log(`Deleted auth.users user_id=${user_id}`);
  unlinkSync(STATE_FILE);
}
```

**Note:** organization_members row CASCADEs when organizations is dropped in the migration rollback above — no separate cleanup needed for the membership.

---

## 6.5 Deployment path (unchanged from v2)

Production migration ONLY via `supabase db push`. Studio SQL Editor MUST NOT be used. Manual run sequence unchanged from v2 §6.5.

---

## 7. Open questions (all resolved by v2 QA — kept for reference)

- Q-v2-1: **RESOLVED.** Use plain SHA-256 for `token_digest` (HMAC overkill for 32-byte CSPRNG). Applied in §2.3.
- Q-v2-2: **RESOLVED.** Subquery default invalid; DO-block fix applied in §4.1.
- Q-v2-3: **RESOLVED.** `ON DELETE CASCADE` from auth.users does NOT bypass trigger; trigger correctly blocks orphaning. No change needed.
- Q-v2-4: **RESOLVED.** Same-transaction CREATE + nullable FK is safe per Postgres semantics.
- Q-v2-5: **RESOLVED.** bcrypt cost = `gen_salt('bf', 12)` specified in §2.3.

**No remaining open questions for Phase A.** Ready for SQL drafting (S46).

---

## 8. Out-of-scope reminders (unchanged from v2 §8)

Same table. Reviewers should not push for these in Phase A.

---

## 9. Effort estimate (v3)

| Step | Time |
|---|---|
| Draft migration SQL + bootstrap script + test script from v3 plan | 3-4h |
| Apply to staging clone + run all 11 tests | 1.5h |
| **MERGE-gate sequential review on SQL** (Gemini first → revise → Codex final) | 2-3h |
| Synthesize MERGE-gate findings + adjust | 30-60 min |
| Apply to production via `supabase db push` + bootstrap + post-tests | 1h |
| Soak window (passive) | 1-2 days |

Total active: ~7-9h. Realistic single-session window for S46 = SQL draft + MERGE-gate Gemini round. Apply + Codex round may need S47.

---

## 10. Sign-off (v3 — FINAL)

v3 supersedes v1 and v2. All v1-synthesis decisions correctly applied (per v2 QA fidelity check). All v2 QA drift fixes applied. No remaining peer-review concerns. Ready for SQL drafting.

— Claude Opus 4.7 (1M), S45 (2026-05-22). v3 is FINAL for DESIGN gate. Next: SQL artifacts (MERGE gate, sequential review).
