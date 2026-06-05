# MERGE-gate peer review — S82 executor.ts spawn-env hardening

**Date:** 2026-06-03 UTC
**Change:** Strip `ANTHROPIC_API_KEY` (+ related shadow vars) from the env passed to `claude -p` spawn, so it falls through to the claude.ai Max OAuth subscription instead of billing the Anthropic API account.
**MRPF Classification:** MERGE × AGENT BEHAVIOR + SECURITY × NORMAL → sequential Gemini → integrate → Codex on revised version.
**Author validation:** v3 `pnpm test` PASS + `node --test` 12/12 PASS.

## Root cause + motivation

Recurring credit-out events S76 / S81 / S82 (+ one other) burned **$27.60+ across 4 events in ~10 days**. Today (S82, 2026-06-03 02:20Z) burned $12.57 in 2.9 min of API time on job `e18e1931` before mid-execution credit-out. Memory `feedback_anthropic_api_key_shadows_subscription_in_executor.md` (filed S76, 2026-05-27) documented the root cause and remediation but the remediation was never applied — the same failure mode kept recurring.

The user has a claude.ai Max subscription (unmetered for typical research execution). The `ANTHROPIC_API_KEY` in `agent/.env` is needed only for **Phase 0a/0b direct Anthropic API calls** in `lib/plan-transports.ts` (small bounded cost ~$0.10/job). When inherited by the `claude -p` spawn, it shadows the OAuth subscription and causes the full $5-30 research execution to bill the API account.

## Fix shape (v3)

Extract a pure exported helper `buildClaudeSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv` in `agent/executor.ts`:

- Spreads `parentEnv` (no input mutation)
- Strips a `CLAUDE_SPAWN_ENV_STRIP_KEYS` list **case-insensitively**
- Sets `CLAUDE_CODE_ENTRYPOINT="worker"` AFTER strip (so it can't be accidentally stripped)
- Used at the single `crossSpawn("claude", ...)` site

### Strip list (15 keys)

| Key | Why stripped |
|---|---|
| `CLAUDECODE` | pre-S82: parent-session marker |
| `CLAUDE_CODE_SSE_PORT` | pre-S82: parent-session marker |
| `CLAUDE_CODE_SESSION_ID` | pre-S82: parent-session marker |
| `ANTHROPIC_API_KEY` | **S82 root cause** — API account billing shadow |
| `ANTHROPIC_AUTH_TOKEN` | Gemini round 1: alternate auth path |
| `ANTHROPIC_BASE_URL` | Gemini round 1: endpoint redirect |
| `CLAUDE_CODE_USE_BEDROCK` | Codex round 1: provider routing → AWS billing |
| `CLAUDE_CODE_USE_VERTEX` | Codex round 1: provider routing → GCP billing |
| `CLAUDE_CODE_USE_FOUNDRY` | Codex round 1: provider routing → Foundry billing |
| `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Codex round 1: alt AWS routing |
| `AWS_BEARER_TOKEN_BEDROCK` | Codex round 1: Bedrock auth |
| `ANTHROPIC_FOUNDRY_API_KEY` | Codex round 1: Foundry alt auth |
| `ANTHROPIC_AWS_API_KEY` | Codex round 1: AWS alt auth |
| `ANTHROPIC_BEDROCK_BASE_URL` | Codex round 1: Bedrock endpoint redirect |
| `ANTHROPIC_VERTEX_BASE_URL` | Codex round 1: Vertex endpoint redirect |

Source for provider-routing vars: https://code.claude.com/docs/en/env-vars (Codex grep'd live docs during review).

## v1 — initial draft

- Strips only the original 3 CLAUDE_* vars + ANTHROPIC_API_KEY
- 7 tests
- Local validation: `pnpm test` + `node --test` 7/7 PASS

## Reviewer 1 — Gemini (gemini-3.1-pro-preview, ~$0.05-0.10)

**VERDICT: APPROVE with 2 MINOR findings — both ACCEPTED**

### G-MIN-1 [ENV-CASE-INSENSITIVITY]
**Finding:** On Windows, `process.env` is a case-insensitive proxy. After `{ ...parentEnv }`, the spread produces a plain object with case-preserved keys. A case-naive `delete env.ANTHROPIC_API_KEY` misses casings like `Anthropic_API_Key`, which Windows `CreateProcess` would still merge back to the canonical name on spawn.

**Disposition:** ACCEPT. UPPER_SNAKE is the conventional `.env` casing, but defense-in-depth is cheap. v2 implements case-insensitive delete via:
```typescript
const stripUpper = new Set<string>(CLAUDE_SPAWN_ENV_STRIP_KEYS.map((k) => k.toUpperCase()));
for (const key of Object.keys(env)) {
  if (stripUpper.has(key.toUpperCase())) delete env[key];
}
```
2 new tests: "strips case-insensitively" + tight regression for fully-lowercase `anthropic_api_key`.

### G-MIN-2 [ADDITIONAL-ANTHROPIC-VARS]
**Finding:** `ANTHROPIC_BASE_URL` could redirect the OAuth subscription endpoint after the API key strip, defeating the fix.

**Disposition:** ACCEPT. v2 strips `ANTHROPIC_BASE_URL` AND `ANTHROPIC_AUTH_TOKEN` (alternate auth path identified during integration). 2 new tests.

**Result after v1 → v2:** 11/11 tests pass.

## Reviewer 2 — Codex (gpt-5-codex via codex exec -s read-only, ~$0.05-0.15)

**VERDICT: REQUEST_CHANGES with 1 MAJOR + 1 MINOR — 1 EXPECTED-AS-IS, 1 ACCEPTED**

### C-MAJ-1 [NOT-IN-MERGE-TARGET]
**Finding:** Sandbox files are not yet copied into `agent/executor.ts` and `agent/test/`. Codex flagged this as a missed merge step.

**Disposition:** **EXPECTED-AS-IS.** Codex was not aware of the project's sandbox-required-writes policy ([[feedback_sandbox_hook_blocks_all_agent_paths]]). The sandbox file IS the merge target — `/promote` is the post-MRPF-approval mechanism that copies sandbox → live + archives the sandbox originals to `sandbox/validated/...-s82`. This is the documented workflow, not a missed step. No code change.

### C-MIN-1 [PROVIDER-ENV-SHADOWS]
**Finding:** Beyond the 6 vars in v2, the official Claude Code env-vars docs at https://code.claude.com/docs/en/env-vars list 9 more provider-routing/auth vars (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`/`ANTHROPIC_AWS`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`) that could route the child CLI to non-Max billing.

**Disposition:** ACCEPT. v3 extends the strip-list to include all 9 + adds 1 representative test covering all 9. The invariant being enforced is now explicit: "spawned `claude -p` must use claude.ai Max OAuth."

**Result after v2 → v3:** 12/12 tests pass. **Loop closed at v3** per S78/S79/S81 mechanical-fix precedent (strip-list extension + tests; no architectural change).

## Other ANTHROPIC_API_KEY consumers (confirmed unaffected)

Codex grep-verified during the review:
- `agent/lib/plan-transports.ts:910` — integration transport reads `envStr("ANTHROPIC_API_KEY")` from process.env (parent worker, NOT affected)
- `agent/lib/plan-transports.ts:997` — synthesis transport (same)
- `agent/preflight.ts:229` — preflight env-presence check (parent worker, NOT affected)

The fix only strips from the child `claude -p` spawn (via `env:` option to `crossSpawn`). Phase 0a/0b direct API calls continue to work as before.

## What each reviewer saw

| Reviewer | Pass | Scope |
|---|---|---|
| Gemini round 1 | v1 sandbox | Inline diff blocks + full test file in prompt; no FS access |
| Codex round 1 | v2 sandbox (post-Gemini integration) | Full prompt with Gemini findings + author dispositions; read-only sandbox FS access to inspect sandbox/executor.ts + sandbox/executor-spawn-env.test.ts; grep'd live agent/executor.ts + agent/lib/plan-transports.ts + agent/preflight.ts to verify scope |

## Rollback path

If post-deploy the helper introduces regressions:
1. `git revert <commit-sha>` — single commit, single file family
2. OR temporary mitigation: restore inline env-build at the call site, leave the helper exported but unused

No data migration / schema change / state change — purely runtime behavior. Rollback is purely code-revert.

## Cost summary

| Item | Spend |
|---|---|
| MRPF Gemini round 1 (gemini-3.1-pro-preview, ~30-60s) | ~$0.05-0.10 |
| MRPF Codex round 1 (gpt-5-codex, 112K tokens) | ~$0.05-0.15 |
| Author integration + 3× swap-and-revert validation | $0 (local) |
| **MRPF total** | **~$0.10-0.25** |

vs. the recurring $5-15 burn per credit-out event that this fix prevents.

## Sign-off

Author: Claude Opus 4.7 + David (CEO, authorized via AskUserQuestion).
Reviewers: Gemini 3 Pro Preview + GPT-5 Codex.
Loop closed at v3. Recommended for promote → commit → push.
