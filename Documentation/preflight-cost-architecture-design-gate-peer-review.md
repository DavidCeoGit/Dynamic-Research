# S63 Preflight Cost + Failure-Loop Architecture — DESIGN-gate Peer Review Synthesis

**Status:** v3.1 APPROVED post-Codex-QA-fidelity-fix. Ship-ready for MERGE-gate implementation under a separate code-diff review.

**Multi-reviewer policy framework:** `~/CLAUDE.md` MRPF v2.2 — AGENT BEHAVIOR + INFRA risk labels trigger mandatory Gemini → Codex sequential DESIGN-gate; revision QA assigned to whichever reviewer caught more findings in the prior round (Codex, 11 vs 6). Severity NORMAL (no production fire; credit-out was operational not architectural).

**Companion artifact:** `Documentation/preflight-cost-architecture-design-gate.md` (v3.1 design doc, 580+ lines).

## What each reviewer saw

- **Gemini v1 (CLI, `gemini-3.1-pro-preview` with default Deep Think):** brief at `sandbox/working/s63-preflight-mrpf-v1-PROMPT.md` + design doc v1 + `agent/preflight.ts` + `agent/worker.ts` + `agent/api-client.ts` + `agent/lib/notify.ts` + project CLAUDE.md. Read fully per its own "What I read" disclosure. Persona depth self-score: 5/5.
- **Codex v2 (`codex exec -s read-only`, gpt-5):** brief at `sandbox/working/s63-preflight-mrpf-v2-codex-PROMPT.md` + design doc v2 (post-Gemini integration) + `agent/preflight.ts`, `worker.ts`, deep-read of `agent/executor.ts` failure/notify/spawn/usage paths, `agent/lib/notify.ts`, `api-client.ts`, `types.ts`, `agent/lib/plan-transports.ts`, `plan-synthesizer.ts`, `plan-reviewer.ts` swallowed-error paths, `frontend/lib/types/queue.ts`, project + global CLAUDE.md, `dryrun_handoff.md`. Plus web research against Node 22 fetch docs, undici ProxyAgent/EnvHttpProxyAgent docs, Claude Code CLI reference, Anthropic SDK errors + source, SDK issue #618 on credit-out HTTP 400 shape. Persona depth: 5/5.
- **Codex v3 QA (same):** fidelity brief at `sandbox/working/s63-preflight-mrpf-v3-codex-qa-PROMPT.md` + design doc v3 + its own v2 response. Read each disposition section and verified the v3 change matched the recorded fix. Persona depth: 5/5.

## Context

S63 started with an Anthropic credit-out failure loop in the worker daemon. Surface symptom: `worker.log` showed 6 consecutive `claude-spawn ✗ Credit balance is too low` failures across 30 minutes as the cron-scheduled task spawned fresh workers every 5 min. Root architectural smell: the existing preflight check uses a billable `claude -p hello` invocation that costs ~$0.24/restart (per `feedback_claude_cli_cache_priming_cost.md`), AND the cron-spawn model has no backoff during outages.

User confirmed scope of the fix: replace billable preflight with free probes (Tier A) + add exponential backoff on consecutive failures (Tier C). Tier B (queue-first short-circuit) considered + deferred.

5 pre-design decisions confirmed by human owner: 60-min backoff cap; no `ANTHROPIC_API_KEY` to `checkEnv`; no manual `/preflight-reset`; Resend email at N=3; 5-tier (0/10/20/40/60) schedule.

## Trail

### v1 — Gemini round 1 (REQUEST_CHANGES, 1 CRITICAL + 1 MAJOR + 4 MINOR)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| G-C1 | CRITICAL | Dropping credit check enables unbounded queue-burning — without execution-side feedback, worker passes preflight on auth, starts polling, claims job 1 → executor fails → claims job 2 → entire queue chewed at 30s intervals, Resend spammed per job, Tier C bypassed. **The proposed Tier A would have made the failure mode STRICTLY WORSE than current behavior during peak hours.** | **INTEGRATED v2:** NEW §3.5 — executor.ts terminal-provider-error catch + feedback to backoff. Scope expanded to include `agent/executor.ts`. User-approved scope expansion. |
| G-M1 | MAJOR | Node 22 built-in fetch (Undici) ignores `HTTP_PROXY`/`HTTPS_PROXY` env vars; conditional ProxyAgent needed | **INTEGRATED v2** (later refined by C-M2 to always-on `EnvHttpProxyAgent`): §3.1.B. |
| G-m1 | MINOR | Tier C is a file-backed circuit breaker (Open / Half-Open / Closed). Frame it that way | **INTEGRATED v2:** §3.2 reframed. |
| G-m2 | MINOR | Confirms Tier B drop in §6.B was correct. Do NOT reopen | **NO-ACTION:** confirms current design. |
| G-m3 | MINOR | Atomic-write requires fully-awaited `recordFailure()` before `process.exit(1)` | **INTEGRATED v2:** NEW §3.6 atomic-write contract. |
| G-m4 | MINOR | Over-documentation in §3.1.C coverage matrix + §3.2.E exit-code table | **INTEGRATED v2:** trimmed both. |

**Gemini scope statement:** read design doc + live code; did not execute tests. Verdict REQUEST_CHANGES.

### v2 — Codex round 2 on integrated v2 (REQUEST_CHANGES, 2 CRITICAL + 5 MAJOR + 4 MINOR)

Codex performed deep code-grounded review with web research against external SDK sources.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| C-C1 | CRITICAL | §3.5 inline `process.exit(1)` would bypass the `finally` clause at `executor.ts:486` that writes usage telemetry, AND would lose stdout/stderr evidence (only buffered in spawn-side state, not in the thrown `err`). Classifier needs ENRICHED input shape | **INTEGRATED v3:** §3.5.B side-effect-free pure classifier; §3.5.C pending-exit flag pattern; §3.5.D shows worker.ts calling `consumePendingTerminalExit()` AFTER `executeJob()` finally completes. |
| C-C2 | CRITICAL | Phase 0a/0b uses direct Anthropic API transports (NOT `claude -p`). Credit/auth failures there get swallowed: `executor.ts:208` planSynthesis catch + `plan-reviewer.ts:runIntegration` UNAVAILABLE-swallow pattern. §3.5 must extend to those sites | **INTEGRATED v3:** §3.5.D enumerates 3 call-sites (executor:claude-spawn, executor:plan-synthesis, plan-reviewer:integration). Scope expanded by 2 files (`plan-synthesizer.ts`, `plan-reviewer.ts`). |
| C-M1 | MAJOR | `claude --version` does NOT exercise auth/session machinery per docs — overclaim on CLAUDECODE nested-session coverage. Use `claude auth status` (documented for scripting, exit-code semantics, also $0) | **INTEGRATED v3:** §3.1.A renamed to `checkClaudeAuth` using `claude auth status`; §6.A.bis records decision. |
| C-M2 | MAJOR | `undici.ProxyAgent` requires explicit `undici` dep in package.json (not Node built-in surface). Prefer `EnvHttpProxyAgent` for NO_PROXY semantics | **INTEGRATED v3:** §3.1.B uses `EnvHttpProxyAgent` always-on; `agent/package.json` + lockfile added to target artifacts; §6.A revised. |
| C-M3 | MAJOR | Per-PID temp filename doesn't prevent same-process concurrent writes (same PID = same temp path) | **INTEGRATED v3:** §3.6 step 2 uses per-PID-per-monotonic-counter temp. |
| C-M4 | MAJOR | `nlm-auth-warn` listed as backoff failure kind, but NLM is `required: false` warn-only. Invites a future bug | **INTEGRATED v3:** §3.2.A failure-kind enum excludes `nlm-auth-warn` with explicit carveout. |
| C-M5 | MAJOR | Regex-only classification misses cleaner SDK structured signals + omits `billing_error` + model-deprecated/not-found terminal class | **INTEGRATED v3:** §3.5.A restructured as Priority 1 (structured `error.type`/`status`) → Priority 2 (regex fallback); added `billing_error` + `not_found_error` classes. |
| C-m1 | MINOR | §4.1 lacks explicit hung-binary timeout test | **INTEGRATED v3:** §4.1 test 4. |
| C-m2 | MINOR | §3.4 notification predicate underspecified for executor-side jump to N=3 | **INTEGRATED v3:** §3.5.E predicate is "previous<3 AND next>=3". |
| C-m3 | MINOR | §3.1.B success criterion alternates between "200 + data" and "200-anything" | **INTEGRATED v3:** `res.ok && parseable JSON object`; empty `data` accepted. |
| C-m4 | MINOR | Project CLAUDE.md §6 + dryrun_handoff.md need explicit rollout-artifact callouts | **INTEGRATED v3:** §7.B companion-doc updates section. |

**Cleared checks Codex verified ALL clear in v2:**
- `/v1/models` header pin `2023-06-01` still current
- `fetch` dispatcher option shape is correct
- `claimJob()` contract unaffected
- No frontend mirror impact
- Existing Resend posture (swallow notification failures) is reusable

**Codex sources:** Node 22 fetch docs, undici ProxyAgent + EnvHttpProxyAgent docs, Claude Code CLI reference, Anthropic API errors docs, anthropic-sdk-typescript source, SDK issue #618. Persona depth: 5/5.

### v3 — Codex QA fidelity pass (REQUEST_FIXES → 2 leftover-literal fixes → CLEAN)

QA verified each v2→v3 disposition was applied correctly.

- ✅ FIDELITY-OK: C-C1, C-C2, C-M2, C-M3, C-M5, C-m1, C-m2, C-m3, C-m4 (9 dispositions clean)
- ⚠️ FIDELITY-FAIL: **C-M1** — §3.1.A + §6.A.bis fixed but §3.1.C, §3.1.D, §5 still referenced `checkClaudeBinary` / `claude --version`. **Fixed in v3.1:** replaced all 3 remaining occurrences. Re-grep clean (only historical-context occurrences remain in integration-record tables, which is correct).
- ⚠️ FIDELITY-FAIL: **C-M4** — §3.2.A enum fixed but §3.2.D + §8 still listed `nlm-auth-warn` in failure-kind enumeration. **Fixed in v3.1:** §3.2.D now lists only `env, claude-auth, anthropic-auth` with explicit NLM-bypass note; §8 reworked to list preflight + terminal kinds separately.

Both gaps were the same class as S62's 1-character fix: section-local fixes that missed leftover literals in adjacent sections. Self-fidelity sweep pattern from `feedback_self_fidelity_sweep_before_qa.md` would have caught both pre-QA; lesson recurs.

**Codex QA scope statement:** read v3 design doc + own round-2 response file; verified each disposition row against the corresponding section content. No novel critique introduced. No `OBSERVE-S64` items raised.

## Files shipped (v3.1 sandbox → live mapping for promote step)

| Sandbox file | Live destination |
|---|---|
| `sandbox/preflight-cost-architecture-design-gate.md` | `Documentation/preflight-cost-architecture-design-gate.md` |
| `sandbox/preflight-cost-architecture-design-gate-peer-review.md` (this file) | `Documentation/preflight-cost-architecture-design-gate-peer-review.md` |

**Working files retained in `sandbox/working/`** for audit trail:
- `s63-preflight-mrpf-v1-PROMPT.md` + `-response.txt` + `-stderr.log`
- `s63-preflight-mrpf-v2-codex-PROMPT.md` + `-response.txt` + `-stderr.log`
- `s63-preflight-mrpf-v3-codex-qa-PROMPT.md` + `-response.txt` + `-stderr.log`
- `run_gemini_s63_preflight.ps1`, `run_codex_s63_preflight.ps1`, `run_codex_s63_qa.ps1`

## Implementation surface (for the upcoming MERGE-gate)

Code files to touch in S64 implementation:

| File | Change shape |
|---|---|
| `agent/preflight.ts` | Replace `checkClaudeSpawn` → `checkClaudeAuth` (`claude auth status`); add `checkAnthropicAuth` (fetch + EnvHttpProxyAgent); wire backoff state file ops |
| `agent/worker.ts` | `main()` backoff-check on startup; `poll()` post-executeJob terminal-exit handler via `consumePendingTerminalExit` |
| `agent/executor.ts` | Classifier check at Claude spawn catch (~L416/434) + planSynthesis catch (~L208) with enriched input shape |
| `agent/lib/plan-synthesizer.ts` | Classifier check before throw |
| `agent/lib/plan-reviewer.ts` | Classifier check in `runIntegration` BEFORE UNAVAILABLE swallow |
| `agent/lib/preflight-backoff.ts` (NEW) | `classifyTerminalError()`, state-file CRUD, pending-exit flag pattern |
| `agent/package.json` + `pnpm-lock.yaml` | Add `undici` as explicit dependency |
| `agent/test/preflight.test.ts` (NEW) | 11 unit tests per §4.1 |
| `agent/test/terminal-errors.test.ts` (NEW) | 9 unit tests per §4.2 |
| Project `CLAUDE.md` §6 | Update worker-daemon description for circuit-breaker semantics |
| `memory/dryrun_handoff.md` | S63 close + S64 implementation handoff |
| `memory/feedback_preflight_circuit_breaker.md` (NEW) | Memoize the pattern |

**No frontend changes, no Vercel deploy required.** Worker daemon restart picks up new code on next cron tick.

## Cost summary

| Round | Reviewer | Wall-clock | Cost |
|---|---|---|---|
| v1 | Gemini CLI | 106s | $0 (CLI OAuth subscription quota) |
| v2 | Codex exec | 554s | $0 (CLI OAuth subscription quota) |
| v3 QA | Codex exec | 196s | $0 (CLI OAuth subscription quota) |
| **Total** | | **~14 min** | **$0 (vs. ~$0.24 saved per future worker restart + 288 daily failure spawns/day eliminated)** |

## What this design avoided

- **Strictly-worse behavior during outages.** Without G-C1 + C-C2 integration, the v1 design would have replaced cron-pummeling-every-5-min with queue-burning-every-30s. Net regression.
- **Telemetry loss on terminal exit.** Without C-C1 integration, naive `process.exit(1)` in catch blocks would bypass usage telemetry writes — exactly the kind of architectural debt this design was meant to ELIMINATE, not introduce.
- **Brittle classifier.** Without C-M5, structured-fields-first ordering, regex-only classification would have under-matched newer SDK error shapes.
- **Dev-environment proxy bricks.** Without G-M1 + C-M2 integration, corporate-proxy deployments would have false-failed `checkAnthropicAuth` despite `claude -p` working fine.

## Decisions confirmed (locked, repeated for ship-record)

| # | Decision | Where |
|---|---|---|
| A | Backoff cap = 60 min | §3.2.B |
| B | `ANTHROPIC_API_KEY` NOT in `checkEnv` | §3.1.B |
| C | No manual `/preflight-reset` override | §6.G |
| D | Resend email at N=3 (preflight or terminal-error origin) | §3.4 + §3.5.F |
| E | 5-tier schedule (0/10/20/40/60 min) | §3.2.B |

## What remains for S64+

- MERGE-gate review on actual code diff (sequential Gemini → Codex per MRPF; same risk labels)
- Implementation under sandbox + /promote workflow
- Worker daemon restart + post-deploy verification per §7.B
- One DLQ test per §4.3 manual steps
