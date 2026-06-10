# ntfy webhook (Phase A) — MERGE-gate peer review synthesis (S103)

**Artifact reviewed:** `sandbox/20260610_phase_a_notifications_ntfy_webhook.sql` + `sandbox/NTFY-SETUP.md`
**Gate:** MERGE
**Risk labels:** INFRA + PRIVACY
**Severity:** NORMAL
**Reviewer chain:** Sequential Gemini 3.1 Pro Deep Think (holistic-adversarial) → integrate v1→v2 → Codex gpt-5.1-codex-max (grounded-adversarial) → primary-source verification → integrate v2→v3 → APPROVED FOR /promote
**Final verdict:** APPROVE-W-CHANGES (Codex findings rebutted with citations; defensive Vault precondition added)

---

## What each reviewer saw

| Reviewer | Input |
|---|---|
| Gemini 3.1 Pro (holistic-adversarial) | v1 SQL + setup doc verbatim (no surrounding code), project context block |
| Codex gpt-5.1-codex-max (grounded-adversarial, via API-key fallback) | v2 SQL + setup doc verbatim, live filesystem access via PowerShell Select-String/Get-Content |
| Primary-source verification | github.com/supabase/pg_net README (Firecrawl) + Perplexity deep search with citations to source SQL |

---

## Round 1 — Gemini holistic-adversarial on v1

**Verdict: BLOCK** (2 BLOCKING + 2 MAJOR + 2 MINOR)

### Gemini findings

- **B-1 (pg_net schema mismatch):** v1 had `create extension if not exists pg_net with schema extensions;`. pg_net's control file hardcodes `schema = net`; CREATE EXTENSION errors on schema mismatch. **INTEGRATED** in v2: dropped `with schema extensions`; added a `DO` block that probes `pg_proc` for `net.http_post()` and raises a clear migration-aborting exception if missing.
- **B-2 (missing test-coverage justification):** PRIVACY-labeled changes require explicit "is this covered by automated tests, and if not, why?". v1 had only a manual smoke test. **INTEGRATED** in v2: explicit TEST COVERAGE JUSTIFICATION block in the migration header — pg_net is async, no test fixture exists in DR, trigger logic has only two branches both covered by the manual smoke test. Follow-up integration test owed when the notification surface grows.
- **M-1 (pg_net async semantics misclaim):** v1 said EXCEPTION block protects the INSERT against ntfy outage. False — pg_net.http_post queues async; HTTP errors land in `net._http_response`, not the trigger context. EXCEPTION catches only synchronous failures. **INTEGRATED** in v2: dedicated FAILURE SEMANTICS block + operator monitoring query at the migration header.
- **M-2 (topic in plaintext table → pg_dump exposure):** v1 stored the ntfy topic name in `private.notification_config`. pg_dump exports plaintext; backup → leak. **INTEGRATED** in v2: topic moved to `supabase_vault` as secret `dr_ntfy_topic` (encrypted at rest); `private.notification_config` now holds only the enabled flag + operational telemetry.
- **m-1 (bulk-insert write amplification):** AFTER INSERT FOR EACH ROW + bulk import = N ntfy POSTs. **NOTED** in v2 comment; acceptable Phase A because the only insert path today is POST /api/queue (single-row Zod-validated). Phase B trigger gating if/when a bulk path lands.
- **m-2 (naming inconsistency):** function vs trigger prefix. **DECLINED** as style nit; `trg_` prefix on trigger is project convention.

### What Gemini saw

Whole-artifact text. No live code access. Probed: pg_net schema-control behavior, pg_dump exposure model, MRPF test-justification clause, async-failure semantics. Did NOT probe: actual column names in `net._http_response`, current extension allowlist on hosted Supabase.

---

## Round 2 — Codex grounded-adversarial on v2

**Verdict: BLOCK** (1 BLOCKING + 1 MAJOR)

### Codex findings

- **B-1 (Vault extension name):** Codex claimed Supabase exposes the Vault extension as `vault`, NOT `supabase_vault`. Claimed v2's `create extension if not exists supabase_vault` would fail "extension not on allowlist" on hosted projects.
- **M-1 (pg_net column names wrong):** Codex claimed `net._http_response` uses `created_at`, `response_body`, `error` — not `created`, `content`, `error_msg` as v2's monitoring query references.

### What Codex saw

v2 text + live filesystem (PowerShell Select-String over the sandbox files + supabase/migrations/ + supabase/config.toml). Found `# [db.vault]` in config.toml — likely the basis for the `vault`-not-`supabase_vault` claim (this is a config section name, NOT an extension name).

---

## Codex findings — primary-source verification + REBUTTAL

Both Codex findings were verified against primary source before integration. **Both REJECTED.**

### Codex B-1 — REJECTED

**Claim:** Supabase Vault extension name is `vault`, not `supabase_vault`.

**Primary source:** `github.com/supabase/vault/blob/main/supabase_vault.control` (the extension control file). The file itself is named `supabase_vault.control`; Postgres derives the extension name from the control filename. The control file's contents include `comment = 'Supabase Vault Extension'` and `schema = 'vault'` (the SCHEMA where objects live, distinct from the extension name).

**Supabase docs (Perplexity cite [1] supabase.com/blog/supabase-vault):** "from SQL you can do: `CREATE EXTENSION supabase_vault CASCADE;`". Also [7] supabase.com/docs/guides/database/vault: same name.

**Why Codex likely tripped:** Codex's filesystem probe found `# [db.vault]` in `supabase/config.toml`. That is a Supabase CLI config SECTION name for vault-related settings (e.g. service-role token expiry), NOT the extension name. Codex appears to have inferred the extension name from the config section name.

**Resolution:** v2's `create extension if not exists supabase_vault` is correct. v3 adds a defensive `pg_available_extensions` precondition probe so a missing-extension state produces an operator-actionable error message instead of a cryptic default — addresses the SPIRIT of Codex's robustness intent without changing the name.

### Codex M-1 — REJECTED

**Claim:** `net._http_response` columns are `created_at`, `response_body`, `error`, not `created`, `content`, `error_msg`.

**Primary source 1 (Perplexity deep-search cite [3+4]):**

```sql
CREATE UNLOGGED TABLE net._http_response (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status_code int,
    content_type text,
    headers jsonb,
    content text,            -- ← Codex said "response_body"
    timed_out boolean,
    error_msg text,          -- ← Codex said "error"
    created timestamptz NOT NULL DEFAULT now()  -- ← Codex said "created_at"
);
```

**Primary source 2 (Firecrawl direct read of github.com/supabase/pg_net README):** lists example query columns as `id, status_code, content_type, headers, content, timed_out, error_msg, created`. Current pg_net version: 0.20.3.

**Why Codex likely tripped:** unclear. Possible: trained against an older pg_net fork that did rename these columns, OR conflated with a different async-HTTP extension. Codex's confidence on this claim was high but factually wrong vs. shipped Supabase.

**Resolution:** v2's monitoring query references the correct columns. No change.

---

## Integration log (v1 → v2 → v3)

| Version | Driver | Changes |
|---|---|---|
| v1 | initial scaffold | basic trigger + private.notification_config + plaintext topic |
| v2 | Gemini integrations | pg_net schema fix, async-semantics docs, Vault migration, test-coverage justification, bulk-write note |
| v3 | Codex robustness intent (findings REJECTED) | defensive `pg_available_extensions` precondition probe for supabase_vault; comment block citing rebuttal |

---

## Test coverage (MRPF PRIVACY-required clause)

**Not automated. Justification (verbatim from migration header):**

> pg_net.http_post is ASYNC — the request is queued to a background worker; a synchronous "did the call happen" assertion in node --test would race the worker. Integration test requires either a controllable ntfy.sh test endpoint OR a mock at the pg_net layer; neither fixture exists in DR today. The trigger logic is dead-simple: read flag, read vault secret, format redacted payload, call http_post. The only branching is "disabled → no call" + "enabled → 1 call", which the manual smoke test covers in one step.

**Follow-up parked:** when DR adds a notification surface beyond Phase A (job-completion alerts, error alerts), add an integration test that polls `net._http_response` after a queue INSERT and asserts on url+body.

---

## MRPF Disagreement Procedure

This review hit the disagreement pattern: Gemini APPROVE-after-integration, Codex BLOCK on factual claims that did not survive primary-source verification. Per `~/CLAUDE.md` MRPF §Disagreement Procedure:

- Non-security disagreement → record both positions + rationale. PRIVACY-labeled but findings are NOT security-CRITICAL.
- 4-hour author-challenge window: this synthesis IS the documented challenge.
- Resolution: proceed with v3 (rejection-with-citation + defensive Vault precondition for spirit).
- No third-model tiebreaker invoked (would risk "shopping for the convenient answer"); primary-source verification is the higher-quality alternative.

---

## Final verdict

**APPROVE-W-CHANGES (cleared for /promote).** Both reviewer chains drove improvements: Gemini caught real BLOCKING issues that v2 integrated; Codex's findings were factually rebutted but its robustness intent shaped v3's defensive precondition. The merge artifact is materially better than v1.

**Reviewer reduced cross-vendor independence note:** Codex ran via API-key fallback per `~/CLAUDE.md` §1a; ChatGPT-OAuth quota was exhausted. Per fallback policy, the API-key path preserves the Codex lineage. Auth auto-restored to ChatGPT at 19:05 local via `Codex-RestoreChatGPT` Scheduled Task.
