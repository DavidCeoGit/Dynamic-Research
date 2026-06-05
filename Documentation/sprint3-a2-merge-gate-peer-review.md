# Sprint 3 Phase A2 — MERGE-gate Peer Review Synthesis (S72, 2026-05-30 UTC)

**Status:** FINAL — Gemini Round 1 (APPROVE) → integrate v2 → Codex Round 2 (REQUEST_CHANGES) → integrate v3 FINAL → Codex Sequential QA (APPROVE) → /promote.

**Companion doc:** [`sprint3-a2-merge-gate.md`](sprint3-a2-merge-gate.md) (v3 FINAL — promoted from `sandbox/sprint3-a2-merge-gate-v3.md`).

**MRPF classification:** Event Gate = MERGE; Risk Labels = ARCHITECTURE + DEPENDENCY + AGENT BEHAVIOR; Severity Mode = NORMAL; Topology = sequential Gemini → integrate → Codex → integrate → Codex QA.

---

## Summary

A2 wired real upstream MCP servers (perplexity-mcp + Chrome_DevTools_MCP) into the A1 proxy scaffold and added policy injection. The MRPF cycle ran cleanly with one mid-stream architecture pivot (L5 dropped per S72 SDK strip finding) and two mid-cycle code corrections (C-1 stateful-cache fix + C-3 replacer hardening) driven by Codex Round 2. Final scope: **L3-static + L10-static**, both shipped with idempotency safeguards. L5 deferred to a follow-up disambiguation spike. Sprint 3 ROI projection requires post-spike revision.

## Round 1 — Gemini

**Model:** `gemini-3-pro-preview` (Gemini CLI v0.43.0)
**Input:** v1 doc + 5 inline sandbox source files (1237-line prompt, ~17K tokens)
**Verdict:** **APPROVE** (5 findings: 2 WELL-HANDLED, 1 MAJOR doc-only, 2 MINOR)
**Wall-clock:** ~60s
**Cost:** included in subscription

| # | Tier | Label | Title | Action in v2 |
|---|---|---|---|---|
| G-1 | WELL-HANDLED | ARCHITECTURE | L5 OQ#11 re-interpretation argument is sound | No action — validates author position on hypothesis (a) Claude Code auto-cache. |
| G-2 | MINOR | CORRECTNESS | `parsePositiveInt` allows 0 — misnomer | Renamed to `parseNonNegativeInt` in `index.ts`. |
| G-3 | WELL-HANDLED | TEST-COVERAGE + DEPENDENCY | Rollback test #11 is excellent canary guard | No action — validates the convert-failed-test-to-regression-guard pattern. |
| G-4 | MAJOR | ARCHITECTURE + OTHER | Follow-up spike must control for payload size + parent design ROI flag | Spike methodology updated to require identical-size >20KB payloads. Parent design ROI TODO added to v3 §5. |
| G-5 | MINOR | AGENT-BEHAVIOR | Policy env vars rely on implicit defaults | Operational posture documented in §6; sandbox .env patch left as-is (intentional). |

**What Gemini saw:** full MERGE-gate v1 doc + all 5 inline sandbox source files + reasoned about .env patch + executor.ts from contextual descriptions.

## Round 2 — Codex

**Model:** Codex CLI v0.130.0 default model (ChatGPT auth, reasoning effort high)
**Input:** v2 doc + sandbox cwd at project root (Codex read files directly)
**Verdict:** **REQUEST_CHANGES** (5 findings: 2 MAJOR, 1 MINOR, 2 WELL-HANDLED)
**Wall-clock:** ~3-4 min
**Tokens used:** 90,542
**Cost:** included in subscription

| # | Tier | Label | Title | Action in v3 |
|---|---|---|---|---|
| C-1 | **MAJOR** | CORRECTNESS + AGENT-BEHAVIOR | L10 caches every tool including stateful Chrome actions | Added `idempotent?: boolean` to `UpstreamSpec`; flagged Chrome_DevTools_MCP `idempotent:false`; added test #13 with `stateful_echo` upstream proving L10 skip. |
| C-2 | **MAJOR** | ARCHITECTURE + TEST-COVERAGE | Implemented L10 doesn't deliver documented token-saving | Rescoped L10 to "upstream-call dedupe only" in v3 §5; parent design ROI TODO expanded to include L10 regrading; reference-return optimization deferred to A3. |
| C-3 | MINOR | CORRECTNESS | `sortedKeysReplacer` accumulator __proto__ hazard | Accumulator switched to `Object.create(null)`; properties assigned via `Object.defineProperty`. |
| C-4 | WELL-HANDLED | CORRECTNESS + DOCUMENTATION | Gemini Round 1 integration + L5 guard applied correctly | No action — Codex re-verified `parseNonNegativeInt`, §1.5 table, §5 spike methodology, §5 ROI TODO, §6 implicit-defaults posture all present. Also independently grounded SDK strip evidence. |
| C-5 | WELL-HANDLED | OPERATIONAL + DEPENDENCY | Config names + env shape + module resolution + no-pinning | No action — Codex grep-verified all key-name matches + module resolution + .gitignore coverage. |

**What Codex saw:** full sandbox v2 + 5 sandbox source files + live A1 `agent/mcp-proxy/*` + `agent/executor.ts` + `agent/.env` + `.gitignore` + `~/.claude.json` + MCP SDK `server/index.js` + `types.js` + `package.json` + 3 Documentation/ reference docs.

**Round 1 → Round 2 verdict gap:** Gemini APPROVE → Codex REQUEST_CHANGES. The gap was NOT on L5 (Codex agreed with Gemini and the author on shipping A2 without L5). The gap was on L10's scope — both Codex MAJORs surfaced ONLY via code-grounded read against the actual live executor allowlist + parent design ROI claims. Empirically validates the value of sequential MRPF: holistic-first + code-grounded-second catches what either alone misses.

## Sequential QA — Codex

**Model:** Codex CLI v0.130.0 default model (reasoning effort high)
**Scope:** fidelity-only — did v3 actually apply C-1 + C-2 + C-3 fixes?
**Verdict:** **APPROVE** (all 5 fidelity checks passed with file:line evidence)
**Tokens used:** 29,684

Codex QA file:line evidence:
- **C-1:** `sandbox/sprint3-a2-mcp-proxy-index.ts:72-78` (UpstreamSpec.idempotent), `:103-110` (POLICY.L10_ENABLED AND-gate), `sandbox/sprint3-a2-upstreams.json:18-34` (Chrome + stateful_echo entries), `sandbox/sprint3-a2-rollback-test.mjs:430-481` (test #13)
- **C-2:** `sandbox/sprint3-a2-merge-gate-v3.md:37` (§1.6 row), `:249-259` (§5 L10 scope clarification table), `:295` (parent design ROI TODO expansion)
- **C-3:** `sandbox/sprint3-a2-mcp-proxy-index.ts:189-202` (Object.create(null) + defineProperty)
- **v3 doc-level:** title FINAL, §1.6 covers all 5 Codex findings, §3 test results table has 13 rows, .meta intended_path drops version suffix
- **Swap-test evidence:** 13 tests counted, 2 default skips, test #13 body matches documented assertion

**Notes from QA:** "Ready for `/promote`. I did not execute promotion because this session is read-only."

## Disagreements

None requiring resolution. Reviewers agreed on L5 drop (Gemini G-1, Codex C-4 implicit). Reviewers DIFFERED on L10 scope — but that was a sequence dependency (Codex caught what Gemini's holistic read missed), not a disagreement. v3 integrates Codex's L10 findings; Gemini did not push back on them in a follow-up.

No SECURITY-labeled findings → no blocking semantics applied.

## Test coverage

Per AGENT BEHAVIOR labeled, mandatory answer: "Is this change covered by automated tests, and if not, why?"

**Yes**, covered:
- A1 carry-forward (tests 1-7): boot, handshake, list, call passthrough, SIGTERM, argv guards
- Real upstream boot (tests 8-9): perplexity opt-in PASS, Chrome opt-in skipped by default
- A2 NEW policies (tests 10, 12, 13): L3 trim, L10 enabled, L10 skipped via idempotent flag
- SDK regression guard (test 11): pins the L5-driving strip behavior

Not covered (acknowledged + tolerated):
- L10 token-savings claim (per Codex C-2): rescoped in doc; no test needed for a behavior we've explicitly disclaimed
- L10 stale-result behavior after page mutation (per Codex C-1 secondary): the idempotency flag is the architectural defense; per-tool fine-grained safety would require A3-class instrumentation
- Real Chrome MCP integration (test 9 default-skip): opt-in only to avoid CI browser-window flakiness

## Configuration state at MERGE close

- `agent/.env` post-promote will have S72 additions: `PERPLEXITY_API_KEY=pplx-...` + `PERPLEXITY_TIMEOUT_MS=600000`. All other env vars carry forward unchanged from S70.
- `EXECUTOR_MCP_VIA_PROXY=false` (carry-forward; A4 will flip after this MERGE).

## Outstanding action items (post-merge)

1. **A4 dark-launch** — flip `EXECUTOR_MCP_VIA_PROXY=true` on a single test research job; measure cache_read uplift vs S69 baseline. Per author position + Gemini G-4 caveat, A4 will be the first independent empirical test of whether the proxy path interacts with Claude Code auto-cache.
2. **Follow-up disambiguation spike** (~$2 spend, ~30 min) — per v3 §5: Variant A (cache_control attached) vs Variant B (identical payload, no cache_control). Settles auto-cache vs user-cache mechanism. Schedule BEFORE A3 begins.
3. **Parent design ROI update** — `Documentation/sprint3-mcp-proxy-design-gate.md` §7 must be regraded post-spike with revised Path A savings (L5 drop + L10 rescope).
4. **Worker daemon restart** — required for A4 flag flip to take effect (worker currently on pre-S70 executor.ts code). Per CLAUDE.md §6 HARD RULE: daemon kill requires explicit user authorization (granted in S72 autonomous scope).

## References

- v3 FINAL doc: [`sprint3-a2-merge-gate.md`](sprint3-a2-merge-gate.md) (companion to this synthesis)
- A1 predecessor: [`sprint3-a1-merge-gate.md`](sprint3-a1-merge-gate.md)
- Parent DESIGN gate: [`sprint3-mcp-proxy-design-gate.md`](sprint3-mcp-proxy-design-gate.md)
- OQ#11 verdict (now caveated): [`oq11-spike-result-2026-05-30.md`](oq11-spike-result-2026-05-30.md)
- Sandbox-archived round artifacts (post-/promote): `sandbox/validated/sprint3-a2-merge-gate-v{1,2}.md-s72`, `sprint3-a2-gemini-round1-{prompt,output}.{md,txt}-s72`, `sprint3-a2-codex-round2-{prompt,output}.{md,txt}-s72`, `sprint3-a2-codex-qa-{prompt,output}.{md,txt}-s72`

---

**End of synthesis.**
