# Multi-Tenancy + Prompt Trilogy — Unified Design (S31)

**Status:** Design only — no implementation yet.
**Author:** S31 (2026-05-09; expanded same day with Part 4 chat assistant).
**Background:** User requested in S31 three features that share auth/RLS/cost concerns: (a) multi-tenant access for distributed people/agencies (internal + invite-only model), (b) per-field prompt enhancement to compress the user's manual Grammarly → expert-rewrite → inconsistency-fix workflow, and (c) floating chat assistant for context-aware form-fill help.
**Owner files (when implemented):** Listed per phase.

---

## Why one design doc

These features share ~40% of their concerns and a coherent design avoids the "two docs that contradict each other on auth" problem:

- Both need **Supabase Auth** (multi-tenancy gates the app shell; prompt enhancement gates the cost-bearing endpoint).
- Both need **RLS discipline** (multi-tenancy on data tables; future enhancement-cost tracking on a usage table).
- Both need **cost attribution** thinking (per-org compute spend matters once 5+ orgs exist).
- Both touch the same form (multi-tenancy decides which forms you see; prompt enhancement edits what's in them).

Writing them together forces consistency and lets shared sections (auth, RLS, cost) be factored once.

---

## Goals

**Multi-tenancy (internal + invite-only):**
- Multiple users sign in via magic link.
- Each user belongs to one or more organizations.
- Users see only their org's runs (queue, gallery, history). Storage paths and database rows enforce isolation; guessing a slug from another org returns 404.
- Existing runs migrate to a default org owned by the primary user (no data orphaned).
- Invitations are operator-issued (CLI or simple admin script). No public signup.

**Prompt enhancement (per-field v1):**
- Per-field "Enhance ✨" button on key textareas (topic, persona, queryFraming, jobDescription) and on each `domainKnowledge[i]`.
- Single Sonnet call performs three logical passes — clarity / expert rewrite / inconsistency-flagging — and returns a structured response with color-coded annotations.
- User reviews diff: accept clarity edits silently, review structural additions one-by-one, manually resolve flagged inconsistencies.
- Lives behind authenticated session (post-multi-tenancy).

---

## Non-goals (v1)

**Multi-tenancy:**
- No per-org billing or quotas (telemetry only).
- No role tiers beyond owner/member (defer admin/auditor for v2).
- No SSO (defer; agency tier eventually wants SAML).
- No audit log UI (the data is in Supabase logs; surface in v2).

**Prompt enhancement:**
- No auto-on-blur trigger (button only — predictable cost, no jarring auto-mutation).
- No whole-form coherent rewrite (v2 design doc — needs cross-field consistency model).
- No polish history / undo beyond browser-level form state.
- No A/B test infrastructure measuring "enhanced vs. raw" research quality (future).

---

## Part 1 — Multi-Tenancy

### 1.1 Auth choice

**Supabase Auth, magic-link only (no passwords).** Rationale:
- Native to existing Supabase stack — zero integration overhead, JWTs auto-set on `auth.uid()` for RLS.
- Magic links eliminate password-management UX (no reset flows, no hash-breach risk).
- Free tier covers 50K MAU — wildly sufficient for invite-only internal use.
- Email magic-link UX is well-understood by non-technical agency users.

Trade-off accepted: Supabase Auth's UI is less polished than Clerk/Auth0 and lacks enterprise SSO. That trade is right for invite-only internal; revisit if SaaS pivot happens.

### 1.2 Schema additions

Three table changes, all enforced via RLS. Skeleton SQL:

```sql
-- New: organizations
CREATE TABLE organizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  owner_id     UUID NOT NULL REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New: organization_members (many-to-many)
CREATE TABLE organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- New: organization_invitations (operator-issued)
CREATE TABLE organization_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  invited_by      UUID NOT NULL REFERENCES auth.users(id),
  role            TEXT NOT NULL DEFAULT 'member',
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Modified: research_queue gains organization_id
ALTER TABLE research_queue
  ADD COLUMN organization_id UUID REFERENCES organizations(id);
-- Migration backfills then sets NOT NULL (see 1.5).
```

### 1.3 RLS policies

> ⚠ **Superseded by peer review (S43).** See synthesis §3.4 at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. The SELECT-only sketch below is incomplete: add UPDATE + DELETE policies, an immutable-`organization_id` trigger, Storage RLS on `storage.objects` (service-role only), and a `SECURITY DEFINER is_member_of()` helper to avoid `organization_members` recursion. Use the resolved SQL in synthesis §3.4 as the implementation source.

All three new tables and `research_queue` get policies. The shape:

```sql
-- research_queue SELECT: only rows where user is in the org
CREATE POLICY "members read their org's jobs"
  ON research_queue FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

-- research_queue INSERT: only with an org_id the user belongs to
CREATE POLICY "members create jobs in their orgs"
  ON research_queue FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );
```

Same shape for `organizations` (members can read their own orgs; owners can update), `organization_members` (read-self only), `organization_invitations` (org owners create; invitees read by token).

**Worker daemon bypass:** worker continues using `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS — that's correct for trusted infrastructure. Worker MUST faithfully stamp `organization_id` on outputs (no leaks possible if it does its job right).

### 1.4 Storage isolation

Path structure changes from:
```
research-projects/<slug>/<file>
```
to:
```
research-projects/<org_id>/<slug>/<file>
```

Gallery becomes server-side-only:
1. Client requests `/api/runs/<slug>/files`.
2. Server resolves slug → row → org_id, then checks `auth.uid() ∈ organization_members(org_id)`.
3. If allowed: server generates signed URLs (1-hour expiry) for each file. Returns array.
4. If denied: server returns **404** (do not leak existence — denying with 403 lets attackers enumerate slugs).

Bucket itself becomes private (no public read). Existing anonymous-readable URLs in old gallery pages stop working — accepted (we control the URLs and re-issue via signed flow).

### 1.5 Migration plan

> ⚠ **Superseded by peer review (S43).** Both reviewers flagged this as CRITICAL — the 9-step plan below has a non-atomic storage move, no drain mode, and no rollback. Use the rewritten 13-step plan in synthesis §3.3 at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`: drain mode (`WORKER_DRAIN_MODE`), copy-then-verify-then-switch-then-delete-later for storage, backward-compatible dual-path workers, migration ledger CSV with checksums, and a documented + tested rollback procedure per failure window.

Order matters — RLS-disabled until Phase C is done, otherwise existing worker breaks:

1. Create `organizations`, `organization_members`, `organization_invitations` (RLS **DISABLED** initially).
2. Insert default org `"David's Workspace"` (slug `david-workspace`), owner_id = primary user's auth.users.id.
3. Insert primary user as owner member.
4. `ALTER TABLE research_queue ADD COLUMN organization_id UUID NULL`.
5. `UPDATE research_queue SET organization_id = '<default_org_id>'` (all existing rows).
6. `ALTER TABLE research_queue ALTER COLUMN organization_id SET NOT NULL`.
7. Move existing Storage files from `research-projects/<slug>/...` to `research-projects/<default_org_id>/<slug>/...` (one-time script, ~50 files).
8. **Deploy frontend + worker simultaneously** with org-aware code.
9. Enable RLS + apply policies.

Step 8 is the critical sync moment — frontend and worker must both ship before step 9, or RLS denies in-flight queries.

### 1.6 Frontend changes

| File / Component | Change |
|---|---|
| `app/login/page.tsx` | NEW — magic link form (Supabase Auth UI or custom) |
| `middleware.ts` | NEW — redirect unauthed `/runs/*`, `/new`, `/` → `/login` |
| `app/api/auth/callback/route.ts` | NEW — handles magic link redirect, exchanges code for session |
| `components/OrgSwitcher.tsx` | NEW — nav dropdown (only shown if user has 2+ orgs) |
| `lib/auth.ts` | NEW — `getCurrentUser()`, `getCurrentOrg()`, server-side helpers |
| `app/page.tsx` (dashboard) | Filter by current org; org switcher in header |
| `app/new/page.tsx` (form) | Pass `organization_id` from current context with submission |
| `app/runs/[slug]/page.tsx` | Server component checks org access before rendering |
| `app/runs/[slug]/gallery/page.tsx` | Same — gallery auth-gated, signed URLs |

### 1.7 Invite flow (minimal)

> ⚠ **Superseded by peer review (S43).** See synthesis (D11) at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. The flow below has no token column — passing row IDs in URLs is unsafe and an "invitees read by token" RLS path could enumerate metadata. Add `token_hash TEXT NOT NULL` (32-byte random, hashed at rest via pgcrypto/bcrypt), `email_normalized` for a unique-per-org constraint, single-use via `accepted_at IS NULL`. Invitation lookup happens via an Edge Function with the token in the request body — never a direct RLS read path.

v1 = operator-only, via CLI:

```bash
node --import=tsx agent/scripts/invite-user.ts <email> <org_id> [role]
```

Script:
1. Inserts row in `organization_invitations`.
2. Calls Supabase `auth.admin.inviteUserByEmail()` — sends magic-link email with the invitation token in the redirect URL.
3. On link click → user creates account → callback handler matches invitation token → auto-joins org → marks invitation `accepted_at`.

v2 = UI for org owners to issue invites (defer).

### 1.8 Worker daemon contract

Worker reads `organization_id` from claimed `research_queue` row. Stamps it on:
- Storage upload paths (`<org_id>/<slug>/<file>`).
- `state.json` field `organization_id`.
- Future audit log entries.

Worker continues using service-role key. `agent/lib/conventions.ts` gets a new helper `orgScopedPath(orgId, slug, file)`.

`agent/scripts/finalize-recovered-run.ts` honors org_id (reads from state.json or accepts as CLI flag).

### 1.9 Phases

> ⚠ **Superseded by peer review (S43).** Codex flagged that the order below contradicts §1.5 — RLS-C was scheduled before storage-D and worker-E, but §1.5 requires the worker to ship first. Use the resolved order in synthesis §3.2: **A (schema, RLS off) → B (auth UI) → D (storage isolation) → E (worker org-stamping) → C (RLS lockdown) → A.5 (hardening) → F (invite CLI)**. Multi-tenancy total ~5.5 days. The org-switcher UI is cut from v1 (single-org membership; user sees their first org).

| Phase | Work | Time | Owner |
|---|---|---|---|
| **A** | Schema migration + default org backfill + Storage move script | 1 day | Backend |
| **B** | Frontend auth (login, middleware, callback, org switcher) | 1 day | Frontend |
| **C** | RLS policies + cross-org isolation tests | 1 day | Backend |
| **D** | Storage isolation + signed URL gallery API | 0.5 day | Backend |
| **E** | Worker daemon org-aware updates | 0.5 day | Agent |
| **F** | Invite CLI helper + email template | 0.5 day | Backend |

Total: **~4-5 days** from start to internal launch.

---

## Part 2 — Prompt Enhancement (per-field v1)

### 2.1 Endpoint contract

```typescript
// POST /api/queue/enhance-field
interface EnhanceFieldRequest {
  field_name: 'topic' | 'persona' | 'queryFraming' | 'jobDescription' | 'domainKnowledge';
  field_value: string;
  form_context: {                                  // for cross-field awareness
    topic?: string;
    persona?: string;
    vendorEvaluation?: { vendorType, serviceArea, jobDescription };
    constraints?: string[];
    domainKnowledge?: string[];
  };
  enhancement_level: 'conservative' | 'standard' | 'aggressive';
}

interface EnhanceFieldResponse {
  original: string;
  enhanced: string;
  annotations: Array<{
    type: 'clarity' | 'structural' | 'inconsistency';
    location: { start: number; end: number };     // char offsets in `enhanced`
    rationale: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  warnings: string[];                              // factual claims model couldn't verify
  meta: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    model: 'claude-sonnet-4-6';
  };
}
```

### 2.2 System prompt structure

> ⚠ **Superseded by peer review (S43).** See synthesis at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. The `conservative` / `standard` / `aggressive` aggressiveness levels are cut from v1 — single tuned `standard` mode only; drop the `enhancement_level` parameter. Also wrap all user-supplied form values in the `<untrusted_input>` fence pattern, enforce a 32 KB max input size, and fail closed (return original + warning) on structured-output validation failure.

Three logical sections in ONE Sonnet call (efficient + lets the model reason across passes):

1. **CLARITY pass:** Fix grammar, ambiguous pronouns, broken parallelism. **Must not change meaning.** Annotate as `type: 'clarity'`, `confidence: 'high'`.
2. **EXPERT REWRITE pass:** Restructure for the audience inferred from `form_context.persona` + `form_context.vendorEvaluation.jobDescription`. Add research-prompt scaffolding (scope boundaries, decision context, named entities). **Tone-only changes** annotate as `clarity`; **content additions** (e.g., "I assumed you meant X") annotate as `structural`, `confidence: 'medium'` or `'low'`.
3. **INCONSISTENCY flag:** Scan for contradictions across `field_value` + `form_context`. **Do not resolve them** — annotate as `type: 'inconsistency'`, `confidence: 'high'`, with rationale explaining the conflict. User resolves manually.

Date awareness: inject `TODAY` (same fix as the slash command — see `feedback_date_awareness_in_pipeline.md`).

Aggressiveness levels:
- **conservative** — only `clarity` annotations applied; structural and inconsistency surfaced as warnings only.
- **standard** (default) — all three annotation types active; user reviews structural/inconsistency individually.
- **aggressive** — same as standard but model encouraged to make bolder structural rewrites.

### 2.3 UI component

> ⚠ **Superseded by peer review (S43).** See synthesis at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. The per-annotation accept/dismiss UX is cut from v1 — the modal action bar is **Accept All / Edit / Reject** only. This also avoids the char-offset annotation-mapping problem Codex flagged. Per-annotation toggles deferred to v2.

`<FieldEnhancer>` wraps each enhanceable Textarea:

| State | UI |
|---|---|
| Idle | Textarea + ✨ button in top-right corner |
| Loading | Skeleton overlay; ✨ button shows spinner; ESC cancels |
| Result | Modal opens with side-by-side diff |

Modal content:
- **Left pane:** original (read-only)
- **Right pane:** enhanced with **inline color-coded highlights**:
  - 🟢 green underline = `clarity` (low-risk, accept silently)
  - 🟡 amber bracket = `structural` (review individually)
  - 🔴 red wavy = `inconsistency` (resolve manually)
- **Action bar:** `Accept All Clarity` (auto-applies green) | `Accept` (replaces field) | `Edit` (loads enhanced into field for further editing) | `Reject` (closes, no change)

Per-annotation interactions: hover shows rationale; click toggles accept/dismiss for that specific annotation.

Final action emits `field_value: <enhanced with accepted annotations applied>`.

### 2.4 Cost discipline

| Calculation | Value |
|---|---|
| Per call (Sonnet 4.6) | ~5K in + 3K out = **~$0.05** |
| Per form (5 fields × 1-3 iterations) | $0.05 - $0.75 |
| Per org per day (estimate: 10 forms × $0.50) | ~$5 |
| Per research run downstream cost | $5-15 (NLM Studio + APIs) |

ROI: $0.05 enhancement to make a $10 research run **20% better** is decisively positive. No quota needed for v1; telemetry table `enhancement_log` (org_id, user_id, field_name, tokens, cost) supports future per-org dashboards.

### 2.5 Integration with existing endpoints

`extract-context` (Path B from S29) and `enhance-field` overlap conceptually — both analyze prompt structure. Don't refactor v1; ship `enhance-field` as a separate endpoint. **v2 consolidation:** extract a `lib/prompt-analysis.ts` module with shared inference helpers, both endpoints import.

### 2.6 Phases

| Phase | Work | Time |
|---|---|---|
| **G** | Backend `/api/queue/enhance-field` + system prompt + Zod schema + tests | 0.5 day |
| **H** | UI: `<FieldEnhancer>` component + diff modal + annotation rendering | 0.5 day |
| **I** | Integrate into form (topic, persona, queryFraming, jobDescription, domainKnowledge[i]) + user-pref polish-level setting | 0.5 day |

Total: **~1.5 days**, kicks off after multi-tenancy F.

---

---

## Part 4 — Floating Chat Assistant (added S31 by user request)

> 🚫 **DEFERRED TO v2 by peer review (S43).** Codex recommended cutting Part 4 from v1 and both reviewers' synthesis accepted it — see §3.6 of `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. Reasons: open-ended cost surface, tool-call security, prompt-injection surface, and streaming-UX complexity that doesn't compound with multi-tenancy or enhance-field. Phases J/K/L are dropped; new trilogy total ~7.5 days. **Do not implement Part 4 in v1.** Trigger to revisit: ≥3 invite-only users hit the form weekly and ≥1 asks for fill-in help. The Part 4 content below is retained for v2 reference only.

### 4.1 Goals

- Persistent floating chat panel available throughout form-fill experience.
- Domain-grounded: knows the form schema, current focused field, all entered values, and the downstream research pipeline.
- Can recommend concrete actions: "Use this as your topic", "Insert into persona field", "Open ✨ Enhance for this field" — with one-click apply.
- Can call `enhance-field` as a tool ("polish this for the user") and apply the result inline through the existing `<FieldEnhancer>` UI.

### 4.2 Why ship this LAST in the trilogy (not first or alongside enhance-field)

1. **Without enhance-field, chat has nothing to recommend.** "I can polish that for you" → "click here" is the killer move. Without the underlying tool, chat is just a help desk in a sidebar.
2. **Enhance-field validates the diff/accept UX pattern.** Chat reuses that pattern when applying suggestions to fields.
3. **Order of risk:** Multi-tenancy is highest-impact (gates everything). Enhance-field is lowest-risk single-call. Chat is highest-risk (open-ended cost surface, harder UX, easier to abuse). Ship safe → safe → risky.

### 4.3 Honest design constraint — don't ship a generic chatbot

If this is just "Claude in a sidebar" it's a worse ChatGPT. The differentiator is in the system prompt + tool surface, not the model:
- System prompt loads form schema, downstream pipeline phase descriptions, and current form state on EVERY turn.
- Tool surface includes form-aware actions (`set_field_value`, `polish_field`, `explain_pipeline_phase`, `suggest_topic_refinement`).
- Chat history scoped per form draft, cleared on submit (no cross-form context accumulation).

Generic = pointless. Domain-grounded = genuinely a copilot.

### 4.4 Endpoint contract

```typescript
// POST /api/queue/chat (Server-Sent Events streaming)
interface ChatRequest {
  conversation_id: string;                          // per-form draft UUID
  message: string;                                  // user's new message
  form_state: {                                     // entire current form state
    topic?: string;
    persona?: string;
    queryFraming?: string;
    constraints?: string[];
    domainKnowledge?: string[];
    vendorEvaluation?: object;
    selectedProducts?: object;
  };
  focused_field?: string;                           // which field is currently focused, if any
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Streamed response (SSE):
//   data: { type: 'text', content: string }              // token-by-token
//   data: { type: 'tool_call', tool: 'set_field_value', input: {...} }
//   data: { type: 'tool_call', tool: 'polish_field', input: {...} }
//   data: { type: 'meta', tokens_in, tokens_out, cost_usd }
//   data: { type: 'done' }
```

### 4.5 System prompt structure

Three sections, prepended on every turn so model context is always current:

1. **DOMAIN SCHEMA** — form field definitions, max lengths, expected formats, downstream usage (e.g., "the `persona` field is fed to NLM as the persona for Studio products").
2. **PIPELINE GROUND TRUTH** — high-level description of Phases 0-7 of the research pipeline, what they produce, what makes them succeed.
3. **CURRENT FORM STATE** — JSON dump of `form_state` + `focused_field`. Refreshed every turn so chat always sees latest values.

Tools available to the model:
- `set_field_value(field_name, value, reason)` — emits `tool_call` event; UI shows "Apply this to your topic field?" button.
- `polish_field(field_name, level)` — invokes `enhance-field` endpoint server-side, streams result back through chat.
- `explain_pipeline_phase(phase_number)` — returns the phase's description from system prompt.
- `suggest_topic_refinement()` — uses extracted context to suggest 2-3 topic variants.

Date awareness: same `TODAY` injection (`lib/date-context.ts` helper from §3.4).

### 4.6 UI component

`<FloatingChatPanel>`:

| State | UI |
|---|---|
| Collapsed (default after first dismiss) | Bottom-right bubble icon, persistent, shows badge if unread suggestion |
| Expanded (auto on first form view, then user-controlled) | Side panel ~380px wide, slides over form; ESC or X to collapse |
| Streaming response | Token-by-token text + skeleton for tool calls |
| Tool call rendered | Inline action card: "Suggested: Use this as your topic" + Apply / Dismiss buttons |

Per-action interactions:
- `set_field_value` action card → "Apply" replaces field, "Dismiss" closes card.
- `polish_field` action card → "Open Enhance" opens the existing `<FieldEnhancer>` modal pre-loaded with model's polish.
- All actions logged in chat history so user can scroll back.

### 4.7 State persistence

| Concern | Choice | Rationale |
|---|---|---|
| Chat history scope | Per-form-draft, browser local storage | Privacy + cost — don't accumulate cross-form context |
| Cleared on submit | Yes | Fresh form = fresh chat; no stale advice carried forward |
| Server-side persistence | None for v1 | Defer telemetry/audit to v2 |
| Multi-tab | Last-write-wins | Don't try to sync; rare edge case |

### 4.8 Cost discipline + quotas

| Calculation | Value |
|---|---|
| Per turn (Sonnet 4.6, ~3K in + 1.5K out) | **~$0.03** |
| Average session (8 turns) | ~$0.24 |
| Per org per day (10 forms × 8 turns) | ~$2.40 |
| Combined with enhance-field per form | $0.50 - $1.50 |

Quotas:
- **Soft warning** at 20 turns per form ("You've used the chat 20 times — still helpful?")
- **Hard cap** at 30 turns per form (forces user to submit form or start new draft)
- These cap abuse without limiting genuine power-user need.

### 4.9 Phases

| Phase | Work | Time |
|---|---|---|
| **J** | Backend `/api/queue/chat` SSE endpoint + tool definitions + system prompt | 0.5 day |
| **K** | UI: `<FloatingChatPanel>` component + tool-call action cards + form-state subscription | 1 day |
| **L** | System-prompt tuning against real conversation transcripts; edge cases (long messages, tool errors) | 0.5 day |

Total: **~2 days**, kicks off after enhance-field ships.

---

## Part 3 — Cross-feature concerns

### 3.1 Auth gate

`enhance-field` requires authenticated session (via Supabase JWT in cookies). Same pattern as the existing `extract-context` endpoint will gain post-Multi-B middleware. Server-side check in route handler:

```typescript
const session = await getServerSession();
if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
```

### 3.2 RLS impact on enhancement

> ⚠ **Superseded by peer review (S43).** Codex flagged this as MAJOR — see synthesis at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md`. "No RLS work needed" is wrong: cost attribution requires an active org, and a multi-org user's spend can't be assigned without it. `enhance-field` MUST resolve `current_org` from the session at every call, gate on membership, and tag the cost-log row with `organization_id`. Add server-side rate limits (10 req/min/user) and a per-org daily spend ceiling enforced before the LLM call.

`enhance-field` doesn't touch DB beyond reading user session — no RLS-policy work needed for v1.

Future telemetry table:

```sql
CREATE TABLE enhancement_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  field_name TEXT NOT NULL,
  tokens_in INT NOT NULL,
  tokens_out INT NOT NULL,
  cost_usd NUMERIC(10,4) NOT NULL,
  enhancement_level TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
RLS: members read their org's logs; insertion is server-only.

### 3.3 Cost attribution (future)

Multi-tenancy enables per-org cost tracking via `enhancement_log` + future `research_run_log`. Daily rollup → per-org dashboard. Defer to billing phase (post-SaaS pivot if it happens).

### 3.4 Date awareness consistency

The same `TODAY` injection pattern applies to:
- Slash command (already shipped S31, see `feedback_date_awareness_in_pipeline.md`)
- `enhance-field` system prompt
- `extract-context` system prompt (apply during Multi-B refactor)

Single source of truth: a `lib/date-context.ts` helper that returns `{ TODAY, TODAY_HUMAN }` strings, imported by every LLM-touching endpoint. Avoids the same drift problem we hit on slug naming pre-conventions module.

### 3.5 Testing & observability (NEW — from peer review S43)

> ➕ **Added by peer review (S43).** Gemini flagged (MAJOR #2) that the original design had no concrete testing or observability strategy. The full test matrix and observability plan live in synthesis §3.5 at `Documentation/multi-tenancy-and-prompt-enhancement-design-peer-review.md` — treat that as the implementation source. Summary:
>
> - **Pre-Phase-A gate:** schema migration runs clean on a staging clone; all rows backfill to the default org; storage move ledger reconciles 1:1 (source = dest = ledger rows).
> - **Pre-RLS-enable gate (Phase C):** cross-org isolation tests — one per CRUD op — must pass; `WITH CHECK` blocks cross-org insert; immutable-org_id trigger blocks org reassignment; direct Storage API call with anon/auth key returns 403; signed-URL scoping verified; cross-org slug collision returns 404.
> - **Observability (ships in Phase A.5, before launch):** Grafana panel for per-org daily LLM spend, worker throughput, RLS denial count; alerts on RLS denial spike, post-soak path-fallback count > 0, and org spend > 80% of ceiling. See `reference_grafana.md`.

---

## Implementation order

Total: **~9 days from start to shipped (all three trilogy features).**

| Day | Phase | Outcome |
|---|---|---|
| 0 | (wait) | Cam AI rerun completes (gated on the S31 Phase-0-failure remediation) |
| 1 | Multi-A | Schema + migration deployed (RLS off) |
| 2 | Multi-B | Login + middleware + callback live |
| 3 | Multi-C | RLS locked down + cross-org isolation tested |
| 3.5 | Multi-D | Storage isolated, signed URL gallery |
| 4 | Multi-E | Worker daemon org-aware |
| 4.5 | Multi-F | Invite CLI helper shipped |
| 5 | Enhance-G | Enhance backend endpoint live |
| 5.5 | Enhance-H | `<FieldEnhancer>` + diff modal built |
| 6 | Enhance-I | Per-field integration live |
| 6.5 | Buffer | Bug-fix between enhance + chat |
| 7 | Chat-J | `/api/queue/chat` SSE endpoint + tool definitions live |
| 8 | Chat-K | `<FloatingChatPanel>` UI built + form-state subscription |
| 8.5 | Chat-L | System-prompt tuning + edge cases |
| 9 | Buffer | Final integration polish + Vercel deploy |

Pre-req: cam AI rerun must complete — schema migration against running worker job invites lock contention.

---

## Open questions (small, not blocking)

1. **Magic-link email provider** — Supabase default vs. Resend (better deliverability + branded sender)? **Default for v1; revisit if delivery issues.**
2. **Org name on signup** — auto-generate `<username>'s Workspace` vs. prompt user? **Auto-generate; allow rename later.**
3. **Multi-org URL structure** — `/o/<org_slug>/...` vs. nav switcher only? **Switcher only for v1 — less plumbing, no SEO concerns for invite-only.**
4. **Invitation expiry** — 7 / 14 / 30 / never? **14 days; expired generates "request new invite" prompt.**
5. **Whole-form Enhance v2** — does the cross-field enhancer rewrite all fields with mutual awareness in one call, or sequence per-field with a coherence check at the end? **Defer to v2 design doc.**
6. **Enhancement diff library** — `jsdiff` (mature, simple) vs. `diff-match-patch` (Google, semantic) vs. custom? **`jsdiff` for v1; revisit if word-level diffs feel wrong on long fields.**
7. **Worker concurrency post-multi-tenancy** — single local worker still fine, or move to Railway? **Local for invite-only internal; revisit if 3+ concurrent agencies submitting.**

---

## Cross-references

- `feedback_workflow_drift_layer_3_gap.md` — multi-tenancy doesn't address workflow drift; that lives in the workflow-conventions-enforcer module.
- `feedback_date_awareness_in_pipeline.md` — same `TODAY` injection pattern applies to `enhance-field`.
- `Documentation/workflow-conventions-enforcer-design.md` — sister design doc; both deferred to ship after the multi-tenant + enhancement work.
- `agent/lib/conventions.{json,ts,py}` — extend with `orgScopedPath()` helper in Multi-E.
- `frontend/app/api/queue/extract-context/route.ts` — pattern reference for enhancement endpoint structure.
