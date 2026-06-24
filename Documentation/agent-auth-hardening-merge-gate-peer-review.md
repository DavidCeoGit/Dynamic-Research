# Agent-auth hardening — MERGE-gate peer review (S167, 2026-06-24)

**Change:** replace the `agentKey !== process.env.AGENT_SECRET_KEY` string compare on the two
`X-Agent-Key` agent routes with a constant-time `crypto.timingSafeEqual` compare (HMAC-normalized)
in a new shared helper `frontend/lib/agent-auth.ts`, plus fail-loud (log, not throw) startup
validation that `AGENT_SECRET_KEY` is configured. Closes audit 2026-06-24 item "agent auth"
(corrected HIGH→MEDIUM) sub-items (a) timing-safe compare + (b) startup validation. Sub-item
(c) optional per-IP failure rate-limit is deliberately OUT OF SCOPE (kept bounded).

## MRPF classification
- **Event gate:** MERGE.
- **Risk labels:** SECURITY (auth/authz boundary). → mandatory Gemini + Codex; Claude grounded
  subagent kept as the standing third lens (per project topology, S162/S166).
- **Severity:** NORMAL. **Topology:** sequential — Gemini holistic → integrate → Codex grounded
  → integrate → Claude grounded subagent.
- **Deploy surface:** `frontend/` (Vercel auto-build from `main`). NOT agent/ worker runtime → no
  DR-Deploy pull, no worker restart, no DB change. Backward-compatible with the unchanged worker
  send side (`agent/api-client.ts`).

## Files changed
- NEW `frontend/lib/agent-auth.ts` — `isValidAgentKey(provided)` + `assertAgentSecretConfigured()`.
- NEW `frontend/lib/__tests__/agent-auth.test.ts` — 9 tests (frontend suite 102 → 111).
- `frontend/app/api/queue/claim/route.ts` (POST) — compare block → `isValidAgentKey(...)`.
- `frontend/app/api/queue/[id]/route.ts` (PATCH) — compare block → `isValidAgentKey(...)`. GET path
  (session auth via `requireOrgOr401`) untouched.
- `package.json` — wired the new suite into the root `test` script.

## Design decisions (all three reviewers confirmed)
1. **HMAC-SHA256(both operands) → `timingSafeEqual`**, not length-check-then-`timingSafeEqual`.
   `timingSafeEqual` throws RangeError on unequal-length buffers; a pre-length-check leaks the
   secret length and short-circuits. HMAC normalizes both operands to a fixed 32-byte digest →
   never throws on length, never leaks length, constant-time in the secret bytes. The per-process
   `randomBytes(32)` HMAC key only needs to be stable within one comparison (same key hashes both
   operands); never persisted/shared, so horizontal scaling is irrelevant.
2. **Fail CLOSED on empty/missing.** `!secret || !provided` guards precede any hashing. Load-bearing:
   `HMAC("")===HMAC("")` is true, so without the guard an empty presented key would match an
   unset/empty secret (a bypass on a misconfigured deploy).
3. **Behavior-preserving.** No trimming/normalization added (old compare was exact-byte). Accept/reject
   set is identical to the old `!==` for all reachable inputs.
4. **LOG, not THROW, at startup.** `assertAgentSecretConfigured()` console.errors at module load if the
   secret is unset; it does NOT throw — because the user-facing GET `/api/queue/[id]` route imports the
   same module, and a module-load throw would take down session-scoped polling. Per-request
   `isValidAgentKey` already fails closed (401). (Claude subagent verified the GET shares the import.)
5. **Lazy per-call env read** — matches the routes' prior behavior, keeps the fn testable, lets a
   rotated key take effect without a code change.

## Reviewer results

### Gemini 3.1 Pro (holistic-adversarial, breadth) — ENDORSE, 0 findings
Validated all 5 decisions at the system level: HMAC normalization ("exceptionally well-designed and
mathematically constant-time"), empty-string bypass anticipated and closed, Node runtime (no
`runtime = "edge"`) so `node:crypto` is supported, log-vs-throw correctly preserves the user GET,
tests pin the structural requirements without crossing the tsc rootDir boundary. "No blockers,
regressions, or auth bypasses." Log: `/c/tmp/dr-s167/gemini.log`.

### Codex gpt-5.5 (grounded-adversarial, depth; xhigh) — ENDORSE
Run banner asserted `model: gpt-5.5` + `reasoning effort: xhigh`. Ran `pnpm -C frontend exec tsc
--noEmit` (pass), the 9-test suite (9/9), full `pnpm test` (pass), and a **44,944-case** matrix
comparing the new helper to the old `!agentKey || agentKey !== secret` logic across string/null/
undefined + long/unicode/whitespace/CRLF + unset/empty secret → **0 mismatches, 0 throws**. No
CRITICAL/MAJOR/MINOR.
- **INFO (acknowledged, no code change):** the prose claim "never throws for ANY input" is too broad
  — forced out-of-contract values (`{}`, `123`, `Symbol()`, `1n`, …) throw in `crypto.update`. NOT
  reachable: both routes pass `request.headers.get("X-Agent-Key")` (runtime domain `string | null`),
  and the helper's TS signature `string | null | undefined` excludes them. The shipped JSDoc is
  already scoped to the length/RangeError path; the no-throw guarantee holds for the declared/
  reachable domain. Recorded for honesty; no edit needed.
Log: `/c/tmp/dr-s167/codex2.log` (the first run `codex.log` was ChatGPT-OAuth quota-blocked — failure
mode #6 — and produced no analysis; re-run after the quota reset, free ChatGPT auth, no API-key flip).

### Claude grounded subagent (depth, fresh context) — ENDORSE
Independent **115-case** hostile matrix (lone high/low surrogates, embedded NUL byte, astral-plane
chars, CRLF/tab, 100 000-char strings, off-by-one at both ends, trailing `\n`, leading space) →
`total=115 mismatches=0 threw=0`. With the secret set, exactly 1 of 23 provided values accepted (the
exact secret); all 3 empty-bypass permutations false; exact match stable across 1000 calls. tsc clean,
9/9 tests. All 5 claims CONFIRMED. Also verified: no stale `!==` left behind, no third call site, and
the Edge `proxy.ts`/`route-protection.ts` do NOT import `agent-auth.ts` (so `node:crypto` never enters
an Edge bundle). 3 INFO (all confirmations: lazy read intentional, per-process HMAC key correct, Node
runtime). Recorded the deferred audit (c) rate-limit as out-of-scope.

## Synthesis
**Unanimous ENDORSE — clean clear, no fixes required.** The two independent grounded matrices
(44,944 + 115 cases) empirically prove behavior preservation (0 mismatches) and the no-throw property
on the reachable domain (0 throws), and the fail-closed guards close the empty-matches-empty bypass.

**What each reviewer saw:** Gemini — review-context + the diff + both new files + both full post-change
routes + the worker send side (no repo tree). Codex — the shipped working tree (read files in its
sandbox), ran tsc/tests/`pnpm test` + a 44,944-case matrix. Claude subagent — the 5 named files +
proxy.ts + the audit doc + a repo-wide grep, ran tsc/tests + a 115-case matrix.

**Automated-test coverage (required for SECURITY label):** YES — `frontend/lib/__tests__/agent-auth.test.ts`
(9 tests) covers exact accept, same-length reject, different-length no-throw, null/undefined/empty
reject, unset-secret fail-closed (incl. empty-matches-empty), empty-string-secret fail-closed, lazy
rotation, and the startup log/return contract. Two reviewer-run matrices (44,944 + 115 cases) provide
behavior-equivalence + no-throw evidence beyond the committed suite.
