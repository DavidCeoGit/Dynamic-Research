# Multi-Tenancy + Prompt Trilogy — Peer Review Synthesis (S43)

**Date:** 2026-05-17
**Trigger:** HARD RULE in `~/CLAUDE.md` ("Multi-Model Peer Review for Design Docs") — established 2026-05-17.
**Reviewers:**
- **Gemini 2.5 Pro** (`gemini-cli`, long-context flagship) — 2 CRITICAL / 3 MAJOR / 4 MINOR
- **Codex GPT-5.5** (`codex exec`, xhigh reasoning) — 4 CRITICAL / 6 MAJOR / 5 MINOR
- **Claude Opus 4.7 (1M)** — design author, baseline self-assessment in `c:/tmp/design-doc-decision-baseline.md`

**Verbatim raw reviews (kept for audit):**
- `c:/tmp/gemini-peer-review-multi-tenancy.md`
- `c:/tmp/codex-peer-review-multi-tenancy.md`

**Status:** Synthesis complete. Resolved direction below. Design doc to be updated with §1.5, §1.9, §3.5 (NEW), §4 (DEFERRED) edits before Phase A starts.

---

## 1. Agreement Matrix (sorted by weight)

### High weight — both reviewers raised, both CRITICAL or both MAJOR

| Decision | Concern | Gemini | Codex | Resolution |
|---|---|---|---|---|
| **D5** Worker bypasses RLS via service-role key | Single bug → cross-tenant data leak; "trust the worker" is hope, not security | CRITICAL #1 | CRITICAL §1.3/§1.8 + MAJOR (missing UPDATE/DELETE RLS, immutable org_id) | **ACCEPT & HARDEN.** Add (1) DB-side CHECK/TRIGGER that validates worker writes match claimed queue row's `organization_id`; (2) UPDATE+DELETE RLS policies on `research_queue` with `organization_id` immutable post-insert (enforced via trigger); (3) worker-side single derive-from-claimed-row helper, no caller-supplied org_id. Per-job scoped token (Codex's stronger ask) deferred to Phase A.5 as a hardening pass — too disruptive to bundle into the initial cut. |
| **D9 + D10** Migration plan & "simultaneous deploy" | Non-atomic storage move, no drain mode, no rollback, in-flight workers will corrupt | CRITICAL #2 | CRITICAL §1.5 step 7 + step 9 | **REWRITE §1.5.** Replace with: (1) drain mode (stop new claims, wait for in-flight), (2) copy-then-verify-then-switch-read-path-then-delete-later for storage, (3) backward-compat worker reads both paths during transition, (4) RLS enabled in staging first with prod-like data, (5) migration ledger (old→new path) + idempotent + checksum verification + documented rollback script. See §3 below for the rewritten plan. |
| **E2 / C2** Cost model token-scaling | `form_context` / `form_state` are unbounded — `domainKnowledge[]` alone scales linearly. Chat prepends schema+pipeline+state every turn. Tool-call amplification not counted. | MAJOR #1 | MAJOR §2.4/§4.8 | **ACCEPT.** Replace fixed-token estimates with a cost-as-function-of-input formula. Add server-side per-org daily spend ceiling enforced before LLM call dispatch. Surface live spend to operator dashboard. Specifics: max input bytes per call (32 KB hard cap), per-org daily $ ceiling (default $10), kill switch env var. |

### Codex-only high-weight (Gemini missed)

| Decision | Concern | Codex finding | Resolution |
|---|---|---|---|
| **X1 / §1.9 phase order** | RLS-C is scheduled BEFORE storage-D and worker-E, but §1.5 says worker must ship first. Doc contradicts itself. | MAJOR | **ACCEPT — reorder phases.** New phase order: **A (schema) → B (auth UI) → D (storage isolation) → E (worker org-stamping) → C (RLS lockdown) → F (invite CLI).** Document why explicitly. |
| **D2 owner split-brain** | `organizations.owner_id` + `organization_members.role='owner'` = two sources of truth, will drift | MAJOR | **ACCEPT.** Drop `organizations.owner_id` column. Single source = `organization_members.role`. Add CHECK constraint + DB function "must have ≥1 owner" enforced on member changes. |
| **D11 invitation token model** | Missing token column entirely; passing row IDs in URLs is unsafe; "invitees read by token" RLS could enumerate metadata | CRITICAL-adjacent (listed MAJOR but flagged as security gap) | **ACCEPT — rewrite §1.7.** Add `token_hash TEXT NOT NULL` column (32-byte random, hashed at rest via bcrypt or pgcrypto), `email_normalized` for unique-per-org constraint, single-use enforced via `accepted_at IS NULL`. RLS does NOT allow invitees to read by token — invitation lookup happens via Edge Function with token in body, never via direct RLS path. |
| **D3 slug uniqueness ambiguity** | `/api/runs/<slug>/files` cannot safely resolve if slugs aren't globally unique | MAJOR | **ACCEPT — enforce.** Keep slug globally unique (current state), add explicit `UNIQUE` constraint on `research_queue.slug` if not already present, document in §1.4 that resolution is "slug → row → org-membership-check," and verify via cross-org isolation test (Codex's "missing test matrix" point). |
| **§1.4 Storage RLS on `storage.objects`** | Doc never mentions Supabase Storage's own RLS policies; private bucket alone doesn't prevent direct anon/authenticated access via Storage API | CRITICAL §1.4 | **ACCEPT.** Add explicit Storage RLS policies in Phase D — `SELECT/INSERT` only via service role; deny anon and authenticated direct access. Frontend ONLY accesses via server-side signed URLs. |
| **§3.2 enhance-field needs org context** | Doc claims "no RLS work needed because it only reads session" — but cost attribution requires active org; multi-org user's spend can't be assigned | MAJOR | **ACCEPT.** `enhance-field` endpoint resolves `current_org` from session at every call, gates on membership, tags cost log row with `organization_id`. |
| **Cut chat from v1** | Open-ended cost, tool-call security, streaming UX, prompt-injection surface, state management — doesn't earn its risk for invite-only internal v1 | "Cut from v1" | **ACCEPT.** Defer Part 4 (Floating Chat Assistant) entirely to v2. Drop Phases J/K/L from the 9-day plan. New total: ~7 days. Rationale recorded in §3.6 below. |
| **Cut multi-org switching from v1** | Single-org membership with many-to-many schema support is fine; switcher complexity deferrable | "Cut from v1" | **ACCEPT.** Drop `<OrgSwitcher>` component. User always sees the first org they're a member of in v1. Schema still supports many-to-many; UI lights up in v2 when there's an actual user with 2+ orgs. |
| **No abuse controls / prompt-injection handling** | Missing entirely | "Missing entirely" | **ACCEPT.** Add to Phase G: server-side rate limits (10 req/min/user on enhance-field), max input size (32 KB), structured-output validation failure → fail closed (return original + warning), prompt-injection mitigation via the `<untrusted_input>` fence pattern (already in memory as standard practice — apply it here too). |

### Gemini-only high-weight (Codex missed)

| Decision | Concern | Gemini finding | Resolution |
|---|---|---|---|
| **Testing & observability strategy** | "Cross-org isolation tests" mentioned once but no concrete plan; no LLM quality eval; no monitoring/alerting | MAJOR #2 | **ACCEPT — new §3.5 added below.** Define test matrix, success metrics, observability before Phase A starts. Use existing Grafana stack (see `reference_grafana.md`). |
| **Storage path enumeration defense-in-depth** | Even with signed URLs, `<org_id>` in path can leak if a URL is ever exposed | MAJOR #3 | **PARTIAL ACCEPT.** Keep `<org_id>` as the directory name (refactoring all paths to hashes is high-cost for marginal benefit in invite-only v1). Compensating control: signed URL TTL stays at 1 hour, no error message ever echoes the path, and the storage move script archives the old path mappings outside production tree. Revisit hash-prefix in v2 if we externalize. |

### Medium weight — both reviewers raised at MINOR level

| Decision | Concern | Resolution |
|---|---|---|
| **E5 per-annotation accept/dismiss UX** | Over-engineered for v1 (Gemini MINOR #2, Codex Cut #3) | **ACCEPT cut.** V1 modal = "Accept All / Edit / Reject" only. Per-annotation toggle deferred to v2. Char-offset mapping problem (Codex MINOR §2.3) also avoided. |
| **E4 "aggressive" enhancement level** | Single `standard` mode sufficient for v1 (Gemini MINOR #1) | **ACCEPT.** Drop `enhancement_level` parameter. Single tuned standard. |
| **Codex MINOR §1.2 indexes** | `organization_members(user_id)`, `research_queue(organization_id)`, invitation lookup fields | **ACCEPT.** Add to Phase A migration. |
| **Codex MINOR §1.2 role enum** | Use CHECK constraint or PG enum for role | **ACCEPT.** `role TEXT CHECK (role IN ('owner','member'))`. |
| **Codex MINOR §4.7 chat history bounds** | N/A — chat is cut from v1. |

### Low weight — flagged but rejected or out-of-scope

| Decision | Concern | Reasoning to reject/defer |
|---|---|---|
| Gemini MINOR #4 "Sonnet 4.6 doesn't exist" | Gemini training-cutoff staleness | **REJECT.** Sonnet 4.6 IS the current model per `reference_ai_models_latest.md`. Reviewer blindspot — record as evidence of why peer review needs multiple models with different cutoffs. |
| Gemini MINOR #3 "admin UI" | Defer to v2 | **DEFER.** Explicit non-goal for v1; doc already states this. |
| Codex CRITICAL §1.3 "worker assumes user role / per-job scoped token" | Strongest version of D5 hardening | **DEFER to Phase A.5.** The CHECK/TRIGGER + immutable org_id (above) handles ~80% of the risk; per-job scoped JWT is the right v2 direction. Capture as design debt with explicit follow-up. |

---

## 2. My baseline predictions — grading

From `c:/tmp/design-doc-decision-baseline.md` "Decisions I personally flag for harder peer-review scrutiny":

| Prediction | Verdict |
|---|---|
| D5 worker trust model | ✅ **Hit hard by both.** My ask for "defense-in-depth via CHECK/trigger" was the right direction; Codex went further with per-job scoped tokens. |
| D9+D10 migration plan | ✅ **Hit hard by both.** My "rollback story is silent" became Codex's "migration ledger + idempotent + checksums + rollback script." Specific, actionable. |
| D8 404-vs-403 slug enumeration | ❌ **Neither pushed back.** Gemini pivoted to org_id-in-path leak; Codex hit slug uniqueness. The 404 choice itself stands. |
| E2 3-passes-in-one-Sonnet-call | ⚠ **Neither pushed back.** Either acceptable, or both blind-spotted. Risk acknowledged in design doc; revisit if quality drops in practice. |
| E7 no v1 quota | ✅ **Hit by Codex.** Strong "server-side per-org daily spend ceilings before chat ships" — applied to enhance-field too. |
| C2 full form state every turn | ✅ **Hit by both.** Moot since chat is cut from v1, but the principle (input scales with form size) survives in enhance-field cost model. |
| X1 9-day timeline | ⚠ **Implicitly hit by Codex** via "cut chat from v1." New total ~7 days. |

**Things I missed that reviewers found:**
- D2 owner split-brain (Codex) — would have caused user-confusion bugs
- D11 invitation token model — security gap I had not noticed
- §1.4 Storage RLS on `storage.objects` — assumed private-bucket-alone was enough; it isn't
- §1.9 phase order contradicting §1.5 dependency story (Codex) — the doc literally contradicted itself
- Testing & observability strategy entirely missing (Gemini)

**Things only reviewer-1 (Gemini) found:**
- Testing/observability gap
- Storage path enumeration defense-in-depth

**Things only reviewer-2 (Codex) found:**
- Phase order contradiction
- D2 owner split-brain
- D11 invitation tokens
- Storage RLS on `storage.objects`
- Multi-org switching cut from v1
- Audit trail missing
- enhance-field still needs org context

**Conclusion on reviewer mix:** the two reviewers had complementary blindspots, validating the HARD RULE's premise that "different training data → different blind spots." Codex (xhigh reasoning) was more security-aggressive; Gemini was stronger on architectural completeness. Both were needed.

---

## 3. Resolved Direction (changes to design doc)

### 3.1 Cut from v1 entirely

- **Part 4 — Floating Chat Assistant.** Deferred to v2. Removes Phases J/K/L. (Codex)
- **Multi-org switching UI** (`<OrgSwitcher>` component). Schema retains many-to-many; user sees first org. (Codex)
- **Per-annotation accept/dismiss UX** in enhance-field modal. V1 = Accept All / Edit / Reject. (Gemini + Codex)
- **`enhancement_level` parameter** — single `standard` mode only. (Gemini)
- **`organizations.owner_id` column** — owner role lives only in `organization_members.role`, enforced by trigger requiring ≥1 owner. (Codex)

### 3.2 New phase order (replaces §1.9)

| Phase | Work | Time | Why this order |
|---|---|---|---|
| **A** | Schema migration + default org backfill + role enum + indexes. RLS DISABLED. | 1 day | Schema must land first; no RLS yet because workers still on old code. |
| **B** | Frontend auth (login, middleware, callback). No org switcher. | 1 day | Auth surface needs to exist before storage isolation enforces it. |
| **D** | Storage isolation: server-side signed-URL gallery API, private bucket, Storage RLS policies on `storage.objects`. Backward-compat reads (both old + new paths). | 1 day | Must precede C (Codex's reorder). Worker and frontend co-tolerant of both paths. |
| **E** | Worker daemon org-aware: derive-from-claimed-row helper, stamp `org_id` everywhere, dual-path reads/writes during transition. | 0.5 day | Worker must speak new schema before RLS locks down. |
| **C** | RLS lockdown: SELECT/INSERT/UPDATE/DELETE policies on `research_queue`, `organizations`, `organization_members`, `organization_invitations`. Immutable `organization_id` trigger. CHECK constraint matching queue-row org to worker writes. Cross-org isolation tests pass before merge. | 1 day | Only safe to enable RLS once worker + frontend + storage are all org-aware. |
| **A.5** | Hardening pass: optionally explore per-job scoped JWT for worker (Codex's stronger ask). Decision recorded here regardless. | 0.5 day | Defense-in-depth; doesn't block v1 launch. |
| **F** | Invite CLI helper with hashed token model (NOT row-id in URL). Email-normalized + single-use + expiry. | 0.5 day | Last because it depends on `organization_invitations` table being RLS-locked. |

**Multi-tenancy total: ~5.5 days** (vs. original 4-5; the extra time is for proper RLS UPDATE/DELETE + invitation token model + storage RLS).

| Phase | Work | Time |
|---|---|---|
| **G** | `/api/queue/enhance-field` — single Sonnet 4.6 call (3 passes), Zod validation, server-side rate limits, 32KB max input, fail-closed on schema validation failure, per-org daily spend ceiling, `<untrusted_input>` fence around user data, org context resolved at call time | 1 day (up from 0.5 — abuse controls + org-aware cost log added) |
| **H** | `<FieldEnhancer>` component — modal with simple Accept All / Edit / Reject (no per-annotation UX) | 0.5 day |
| **I** | Form integration: topic, persona, queryFraming, jobDescription, domainKnowledge[i] | 0.5 day |

**Prompt enhancement total: ~2 days** (vs. original 1.5; the extra time is for abuse controls and the org-attribution cost log).

**New trilogy total: ~7.5 days** (was 9). Chat deferred to v2.

### 3.3 Rewritten §1.5 — Migration plan with drain mode + rollback

1. **PRE:** Snapshot DB + Storage to staging. Run full migration against staging clone first; produce checksums of source state.
2. **Schema only (RLS off):** Create `organizations`, `organization_members`, `organization_invitations` with role CHECK + indexes.
3. **Backfill:** Insert default org `"David's Workspace"`, insert primary user as `owner` in `organization_members`.
4. **Add column nullable:** `ALTER TABLE research_queue ADD COLUMN organization_id UUID NULL`.
5. **Backfill nullable col:** `UPDATE research_queue SET organization_id = '<default_org_id>'`.
6. **Deploy backward-compatible worker** that reads new column when present, falls back gracefully when absent.
7. **Drain mode:** Set `WORKER_DRAIN_MODE=true` (worker stops claiming new queue rows). Wait for in-flight job count = 0 (poll Supabase).
8. **Storage copy-not-move:** Copy files from `research-projects/<slug>/...` → `research-projects/<org_id>/<slug>/...` (preserving originals). Verify checksums. Build migration ledger CSV (old → new) committed to repo.
9. **Switch reads:** Deploy frontend + worker that read from new path, fall back to old path on miss (log fallback).
10. **NOT NULL + RLS:** `ALTER COLUMN organization_id SET NOT NULL`. Apply all RLS policies (SELECT/INSERT/UPDATE/DELETE) + immutable-org_id trigger + Storage RLS.
11. **Resume:** Set `WORKER_DRAIN_MODE=false`. Worker claims new jobs against locked-down schema.
12. **Soak window:** 48-hour monitoring window where fallback-to-old-path is logged. Zero fallbacks → run deletion script for old paths.
13. **Cleanup:** Delete old `research-projects/<slug>/...` paths (idempotent script, requires `--confirm` flag).

**Rollback procedure (documented + tested):**
- Failure during steps 4-6 (additive only): drop column, redeploy old worker.
- Failure during steps 7-9: `WORKER_DRAIN_MODE=true`, restore from snapshot (DB + Storage), redeploy old worker, post-mortem.
- Failure during steps 10-11: disable RLS via migration revert, frontend rolls back to dual-path code, soak then retry.
- Failure during 12-13: stop; old paths still present; safe state.

### 3.4 RLS hardening additions (replaces §1.3 sketch)

```sql
-- research_queue: SELECT + INSERT + UPDATE (constrained) + DELETE (constrained)
CREATE POLICY "members read their org's jobs"
  ON research_queue FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

CREATE POLICY "members create jobs in their orgs"
  ON research_queue FOR INSERT
  WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

CREATE POLICY "members update their org's jobs, but not org_id"
  ON research_queue FOR UPDATE
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

CREATE POLICY "members delete their org's jobs"
  ON research_queue FOR DELETE
  USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

-- Trigger: organization_id is immutable after insert
CREATE OR REPLACE FUNCTION lock_organization_id() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable after insert';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER research_queue_lock_org_id
  BEFORE UPDATE ON research_queue
  FOR EACH ROW EXECUTE FUNCTION lock_organization_id();

-- Storage RLS: deny all anon/auth direct paths; only service role can access objects
CREATE POLICY "service role only" ON storage.objects FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- organization_members policies — avoid recursion via SECURITY DEFINER helper
CREATE OR REPLACE FUNCTION is_member_of(org_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE organization_id = org_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE POLICY "read-self org memberships" ON organization_members FOR SELECT
  USING (user_id = auth.uid());
```

### 3.5 NEW §3.5 — Testing & Observability (from Gemini MAJOR #2)

**Pre-implementation test matrix (must pass before Phase A merges):**
- Schema migration runs cleanly on staging clone of production DB
- All existing rows backfill correctly to default org
- Storage move ledger reconciles 1:1 (source count = dest count = ledger row count)

**Pre-RLS-enable test matrix (Phase C gate):**
- User A in org X cannot SELECT/UPDATE/DELETE rows in org Y (one test per CRUD op)
- User A cannot insert a row with `organization_id` = org Y (RLS WITH CHECK blocks)
- User A cannot UPDATE another row to change `organization_id` (trigger blocks)
- Direct Storage API call with anon/authenticated key returns 403 (Storage RLS enforces)
- Signed URL for org X file works for member of X; signed URL for org Y file rejected for member of X
- Worker daemon with service-role key stamps correct `organization_id` (integration test with mocked queue claim)
- Cross-org slug collision returns 404 from `/api/runs/<slug>/files`

**Observability (Phase A.5 ships before launch):**
- Grafana dashboard panel: per-org daily LLM spend, worker job throughput, RLS denial count
- Alerts (existing Grafana stack — see `reference_grafana.md`): RLS denial spike > 10/min, worker fallback-to-old-path count > 0 after soak, daily org spend > 80% of ceiling
- Structured logs (already in worker): tag every Storage write + DB insert with `organization_id` for grep-ability

### 3.6 §3.6 — Why we cut Part 4 (Floating Chat Assistant) from v1

Codex's recommendation, accepted in synthesis. Reasoning preserved here so we don't re-litigate in a future session:

1. **Open-ended cost surface.** Form state (10K char topic + 25K char persona/queryFraming + N×10K domainKnowledge entries) × 30-turn cap = trivially $5+ per session. With no quotas it's a self-DoS.
2. **Tool-call security.** `polish_field` invokes `enhance-field` — nested model calls, exception surface, abort/retry semantics, structured-output validation across boundaries. Substantial engineering for unproven UX.
3. **Prompt-injection surface.** User-controlled form values flow into chat system prompt every turn; attacker-friendly territory before the rest of the stack is even hardened.
4. **Streaming UX complexity.** SSE + token-by-token + tool-call event interleaving + cancel semantics + multi-tab + state-persistence — all 1-2 days of bug-fix that doesn't compound with multi-tenancy or enhancement learning.
5. **The point of internal v1 is to validate multi-tenancy and enhance-field together.** Chat doesn't earn that risk yet.

**Trigger to revisit:** ≥3 invite-only users hit the form weekly and ≥1 of them asks "can I get help filling this out?" Defer until then.

---

## 4. Open follow-ups / design debt

- **Per-job scoped worker JWT** (Codex's stronger CRITICAL #1 ask). Tracked as Phase A.5 v2 exploration. Memory ref needed: `feedback_worker_scoped_jwt_per_job.md` after implementation begins.
- **Storage path hash defense-in-depth** (Gemini MAJOR #3). Deferred to v2 unless external invite-out happens.
- **Admin UI for cross-org operator view** (Gemini MINOR #3). Explicit v2.
- **Whole-form Enhance v2** (already in design doc Open Questions Q5). Untouched by peer review.
- **Multi-org switcher UI** (Codex Cut). v2 when there's a real 2-org user.
- **Audit trail server-side** (Codex Missing). Will use existing Supabase log surface for v1; product audit log is v2.
- **Workflow-conventions-enforcer extension** (from `feedback_workflow_drift_layer_3_gap.md`). Independent of this design; separate effort.

---

## 5. Sign-off

This synthesis is the authoritative direction for S43+ implementation. The design doc itself will be amended with pointers to this file at the affected sections (§1.3, §1.5, §1.7, §1.9, §2.2, §2.3, §3.2, §3.5 NEW, §4 DEFERRED). Phase A implementation may begin after the design doc amendments land.

— Claude Opus 4.7 (1M context), S43, 2026-05-17
