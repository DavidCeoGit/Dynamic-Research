# Sprint 3 Phase A2 — MERGE-gate v3 FINAL (S72, 2026-05-30 UTC, post-Codex-Round-2)

**Status:** v3 FINAL, integrated Codex Round 2 findings on top of Gemini Round 1 v2 integration. Codex Round 2 verdict was REQUEST_CHANGES (2 MAJOR fixes + 1 MINOR + 2 WELL-HANDLED). All 3 actionable Codex findings are addressed in v3 code + doc. Live swap-test of v3 code passed 11/11 + 2 skipped including the new test #13 (idempotent-flag-driven L10 skip). AWAITING Codex Sequential QA pass.
**Parent design:** [`Documentation/sprint3-mcp-proxy-design-gate.md`](sprint3-mcp-proxy-design-gate.md) §4 Phase A2.
**Predecessor MERGE-gate:** [`Documentation/sprint3-a1-merge-gate.md`](sprint3-a1-merge-gate.md) (v3 FINAL, S71 promoted).
**Per-session log:** `~/.claude/projects/c--Users-ceo-Documents-AI-Training-Anti-Gravity-Dynamic-Research/memory/dryrun_handoff.md` — S72 section.

---

## 1. Summary

A2 wires REAL upstream MCP servers (perplexity-mcp + Chrome_DevTools_MCP) into the A1 proxy scaffold and adds policy injection inside the `tools/call` handler. Originally scoped as L3-static + L5 + L10-static per the parent design; **A2 ships with L3 + L10 only.** L5 (cache_control inject) was dropped during S72 swap-test after discovering that `@modelcontextprotocol/sdk@1.29.0`'s `CallToolResultSchema` silently strips `cache_control` from content blocks before wire-emit (see §5 "L5 finding"). The strip behavior was empirically confirmed via isolated SDK test; OQ#11 spike's reported cache_read growth is now suspected to be Claude-Code-side auto-cache rather than user-attached cache_control passthrough, casting partial doubt on Sprint 3's projected ROI.

A2 changes the worker's runtime behavior only when `EXECUTOR_MCP_VIA_PROXY=true`; default is `false` (carry-forward from A1). Until A4 dark-launches the flag flip, this MERGE has zero behavioral delta on production research jobs.

## 1.5 Gemini Round 1 integration (v1 → v2)

Gemini Round 1 (`gemini-3-pro-preview`, S72 2026-05-30) emitted **APPROVE** with 5 findings. Integration map:

| # | Tier | Title | Action taken in v2 |
|---|---|---|---|
| G-1 | WELL-HANDLED | L5 OQ#11 re-interpretation argument is sound | No action required. Gemini confirmed hypothesis (a) Claude Code auto-cache is overwhelmingly likely; hypothesis (b) ruled out (Anthropic API requires explicit cache_control per docs); hypothesis (c) ruled out (version lock). Author position on shipping A2 without L5 validated. |
| G-2 | MINOR (CORRECTNESS) | `parsePositiveInt` allows 0 — misnomer | **Code change:** renamed to `parseNonNegativeInt` in `agent/mcp-proxy/index.ts`. Added inline comment crediting G-2. Function semantics unchanged. |
| G-3 | WELL-HANDLED | Rollback test #11 is an excellent canary guard | No action required. Gemini validated the "convert failed test into regression guard" pattern. |
| G-4 | MAJOR (ARCHITECTURE+OTHER) | Follow-up spike must control for payload size + parent design ROI update flag | **Doc change:** §5 follow-up spike spec updated to require both variants emit identical-size payloads >20KB (well above Claude Code's likely auto-cache heuristic threshold). Added explicit TODO: parent design `Documentation/sprint3-mcp-proxy-design-gate.md` §7 ROI table must be updated post-spike with revised Path A savings ($0.72-1.70/run if hypothesis (a) confirmed). |
| G-5 | MINOR (AGENT-BEHAVIOR) | Policy env vars rely on implicit defaults | **Doc change:** §6 acknowledges that `PROXY_L3_MAX_CHARS` + `PROXY_L10_ENABLED` are NOT explicitly written into `agent/.env` (relying on `index.ts` fallback defaults of 80,000 + `true`). Operational runbook posture: implicit defaults are safe + reduce env clutter; future tuning would write explicit overrides. **Sandbox `.env` patch left as-is** (no commented placeholders added) to minimize MERGE-gate scope; operator can add overrides ad-hoc when tuning becomes necessary. |

Gemini's "What you saw" line confirmed: full MERGE-gate doc + all 5 inline sandbox source files + reasoned about `agent/.env` patch and `executor.ts` from contextual descriptions. No request for additional inline files.

## 1.6 Codex Round 2 integration (v2 → v3 FINAL)

Codex Round 2 (`gpt-5-codex`, S72 2026-05-30) emitted **REQUEST_CHANGES** with 5 findings. Integration map:

| # | Tier | Title | Action taken in v3 |
|---|---|---|---|
| C-1 | **MAJOR** (CORRECTNESS+AGENT-BEHAVIOR) | L10 caches every tool including stateful Chrome actions | **Code change in `agent/mcp-proxy/index.ts`:** added `idempotent?: boolean` to `UpstreamSpec`; `POLICY.L10_ENABLED` now ANDs env switch with `spec.idempotent !== false`. **Config change in `agent/mcp-proxy/upstreams.json`:** `Chrome_DevTools_MCP` flagged `idempotent: false` + explanatory `_idempotent_note`. **Test added (#13):** new `stateful_echo` upstream entry (same binary as `echo` but flagged `idempotent:false`) drives a positive proof that L10 is skipped when the flag is false. Swap-test 11/11 PASS including #13 confirms the fix. |
| C-2 | **MAJOR** (ARCHITECTURE+TEST-COVERAGE) | Implemented L10 does not deliver documented L10 token-saving mechanism | **Doc change in §5 + §6:** explicit L10 scope rescope. Parent design L10 = "return short reference on repeat → reduce Claude input tokens". Implemented L10 = "byte-identical cached result → saves upstream API call cost only". Token-savings claim for L10 dropped from A2's lever set. **Parent design ROI TODO expanded (§5):** in addition to L5 revision (Gemini G-4), the L10 contribution must also be regraded — A2 L10 saves upstream API costs (e.g. perplexity charges per call), not Claude input tokens. Reference-return optimization deferred to A3 with the L9 Supabase backing. |
| C-3 | MINOR (CORRECTNESS) | `sortedKeysReplacer` accumulator vulnerable to own `__proto__` keys | **Code change in `agent/mcp-proxy/index.ts`:** accumulator switched from `{}` to `Object.create(null)`; property assignment uses `Object.defineProperty` with explicit enumerable+writable+configurable for defense-in-depth. Inline comment credits C-3. Low risk for MCP-tool JSON args, but mitigated. |
| C-4 | WELL-HANDLED (CORRECTNESS+DOCUMENTATION) | Gemini Round 1 integration + L5 guard applied correctly | No action required. Codex verified `parseNonNegativeInt` rename, §1.5 integration table, §5 spike methodology, §5 parent ROI TODO, §6 implicit-defaults posture all present and accurate. Codex also independently re-verified the SDK strip via `server/index.js:138` + `types.js:1015-1029` file:line cross-reference. |
| C-5 | WELL-HANDLED (OPERATIONAL+DEPENDENCY) | Config names + env shape + module resolution + no-pinning rationale | No action required. Codex verified `perplexity` and `Chrome_DevTools_MCP` keys match `executor.ts:858-874` allowlist exactly; sandbox env mirrors `~/.claude.json` shape; test #11 SDK import resolves via the SDK package's `./*` exports map (`agent/node_modules/@modelcontextprotocol/sdk/package.json:62-65`); .gitignore covers the sandbox env file. |

**Verdict gap from Round 1 → Round 2:** Gemini APPROVE → Codex REQUEST_CHANGES. The gap is not on L5 (Codex agrees with Gemini and the author on shipping A2 without L5) — it's on L10's scope. Codex's code-grounded read surfaced two material issues Gemini's holistic read missed: (a) the global L10 cache fires on EVERY tool including stateful Chrome actions, and (b) the implemented L10 doesn't deliver the parent design's reference-return token-savings mechanism. This is the empirically-validated value of sequential MRPF — Codex's grounded second pass caught what the holistic first pass didn't.

## 2. File inventory

Six sandbox files (5 code + 1 .env patch + this doc) promoted via `/promote`:

| Sandbox name | Intended path | Size | Status |
|---|---|---|---|
| `sandbox/sprint3-a2-upstreams.json` | `agent/mcp-proxy/upstreams.json` | ~1.2 KB | REPLACES A1 (echo-only → echo + perplexity + Chrome_DevTools_MCP) |
| `sandbox/sprint3-a2-mcp-config.json` | `agent/mcp-proxy/mcp-config.json` | ~2.0 KB | REPLACES A1 (1 server entry → 3 server entries) |
| `sandbox/sprint3-a2-mcp-proxy-index.ts` | `agent/mcp-proxy/index.ts` | ~8.0 KB | REPLACES A1 v3 FINAL (adds L3 + L10; L5 dropped) |
| `sandbox/sprint3-a2-echo-upstream-stub.mjs` | `agent/mcp-proxy/echo-upstream-stub.mjs` | ~2.6 KB | REPLACES A1 (adds `echo_big_text` + `echo_with_counter` tools for L3/L10 tests) |
| `sandbox/sprint3-a2-rollback-test.mjs` | `agent/scripts/sprint3-a1-rollback-test.mjs` | ~13.0 KB | REPLACES A1 7-test (extends to 12: opt-in real upstream boots + L3 trim + SDK-strip regression guard + L10 dedupe). Filename keeps "a1" historical suffix; future phases may rename. |
| `sandbox/agent-env-sprint3-a2-s72` | `agent/.env` | ~5.5 KB | REPLACES live `.env` (appends `PERPLEXITY_API_KEY` + `PERPLEXITY_TIMEOUT_MS` mirroring `~/.claude.json:879-882` exactly) |

`Documentation/sprint3-a2-merge-gate.md` (this doc, post-v3-FINAL) + `Documentation/sprint3-a2-merge-gate-peer-review.md` (synthesis) added separately to `Documentation/` after MRPF closes.

No new dependencies added (uses `@modelcontextprotocol/sdk@1.29.0` already vendored by A1; uses Node's built-in `crypto` for L10 SHA-256). Worker daemon untouched (PID 52572 still on pre-S70 executor.ts).

## 3. Test results

### `pnpm test` (Phase B storage-paths guard + agent tsc + frontend tsc)
- **Exit 0** before swap-test (A1 baseline).
- **Exit 0** with A2 installed live (swap-test).
- No regressions from L3+L10 type definitions or import additions.

### `node agent/scripts/sprint3-a1-rollback-test.mjs` (extended A2 suite)
Run during swap-test with A2 installed at live paths. cwd=c:/tmp/ (NON-agent, proves cwd-independent boot per A1 C-1 fix).

| # | Test | Status | Notes |
|---|---|---|---|
| 1 | proxy boots from non-agent cwd | **PASS** | A1 C-1 carry-forward |
| 2 | MCP initialize handshake (serverInfo.name=mcp-proxy-echo) | **PASS** | A1 G-1 carry-forward |
| 3 | tools/list returns echo_text from upstream | **PASS** | A1 C-2 carry-forward |
| 4 | tools/call echo_text returns passthrough content | **PASS** | A1 C-2 carry-forward |
| 5 | SIGTERM stops the proxy | **PASS** | A1 carry-forward |
| 6 | proxy exits non-zero without upstream-key argv | **PASS** | A1 carry-forward |
| 7 | proxy exits non-zero on UNKNOWN upstream-key | **PASS** | A1 carry-forward |
| 8 | proxy boots with `perplexity` argv (real upstream initialize) | **PASS** (opt-in) | RUN_PERPLEXITY_TEST=1; ~8-15s; verifies real `npx -yq @perplexity-ai/mcp-server` launch + MCP handshake returns `serverInfo.name=mcp-proxy-perplexity` |
| 9 | proxy boots with `Chrome_DevTools_MCP` argv | **SKIP** (default) | RUN_CHROME_TEST=1 to run; opens browser window. Chrome installed at `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 10 | L3-static trim: PROXY_L3_MAX_CHARS=400 + echo_big_text(20) yields trim suffix | **PASS** | Body exactly 400 chars + "[...trimmed N chars by mcp-proxy L3-static]" |
| 11 | SDK CallToolResultSchema STRIPS cache_control (regression guard) | **PASS** | Replaces failed L5 test; asserts the SDK strip behavior so any future SDK upgrade that preserves cache_control surfaces here. See §5 "L5 finding". |
| 12 | L10-static dedupe ENABLED via default `echo` upstream: echo_with_counter same-args byte-identical, different-args advances counter | **PASS** | t1="call #1: X", t2===t1 (cached), t3="call #2: Y" (upstream advanced counter to 2, NOT 3, proving t2 hit cache) |
| 13 | **NEW v3**: L10 SKIPPED for non-idempotent upstream (Codex C-1 fix). spawnProxy(["stateful_echo"]) where upstreams.json marks idempotent:false. Call echo_with_counter twice with same args + assert counter advances BOTH times (L10 skipped). | **PASS** | t1="call #1: Z", t2="call #2: Z". If L10 had fired, t2 would equal t1. Asserts the per-upstream idempotency gate works. |

**Default run: 11/11 PASS + 2 skipped (v3, post-Codex). With `RUN_PERPLEXITY_TEST=1`: 12/12 PASS + 1 skipped.**

### Live restore + A1 verification post swap-test
A1 7/7 PASS confirmed on live after swap-test. Production proxy back to known-good state. A2 sandbox-staged for /promote after MRPF closes.

## 4. MRPF classification

Per the framework in `~/CLAUDE.md` (HARD RULE):

- **Event Gate: MERGE** (adopting code/skill/config change at the worker daemon's proxy entry point + adding a real-upstream policy layer).
- **Risk Labels (multi-select):**
  - **ARCHITECTURE** — adds policy injection at the MCP proxy layer; changes the worker's tool-result flow shape (L3 trim + L10 dedupe) when the EXECUTOR_MCP_VIA_PROXY flag is on. Mutates content blocks server-side before wire-emit.
  - **DEPENDENCY** — adds real-upstream invocation paths via `npx -yq @perplexity-ai/mcp-server` and `npx chrome-devtools-mcp@latest --viewport 1280x720`. These npm packages are fetched at proxy spawn time; if either is removed/version-pinned-wrong upstream, the proxy fails to boot.
  - **AGENT BEHAVIOR** — affects the worker's MCP tool surface. Allowlist (`mcp__perplexity__*` + `mcp__Chrome_DevTools_MCP__*` per executor.ts:858-874) requires exact server-name-key match in mcp-config.json. Mis-named keys silently strip ALL tools from Claude.
- **(NOT-labeled risks):** SECURITY (no auth/authz surface change — service-role bypass continues for the worker), DATA (no schema/migration), PRIVACY (no PII path change), INFRA (no CI/CD/cron change).
- **Severity Mode: NORMAL** (no incident, no time pressure, dark-launch flag default `false` keeps prod untouched).

### Required reviewer topology (per HARD RULE table — "MERGE gate, fresh code/SQL" row):
> Sequential | Gemini first → revise → Codex final on revised version.

- **Gemini Round 1** on `sandbox/sprint3-a2-merge-gate-v1.md` (this doc) + sandbox files via long-context whole-codebase read (gemini-3-pro-preview).
- **Integrate Round 1 findings → sandbox/sprint3-a2-merge-gate-v2.md.**
- **Codex Round 2** on v2 via `codex exec -s read-only -C "<project>"` (gpt-5-codex, xhigh reasoning, foreground mode).
- **Integrate Round 2 findings → sandbox/sprint3-a2-merge-gate-v3.md (FINAL).**
- **Codex Sequential QA** on v3 verifying ALL findings resolved with file:line evidence.

Disagreement procedure: per HARD RULE §"Disagreement Procedure" — both reviewers agree → standard synthesis. Non-security disagreement → 4h author challenge then human owner. No SECURITY label → no blocking semantics.

Reviewers MUST explicitly answer: "is this change covered by automated tests, and if not, why?" — the SECURITY/DATA/AGENT BEHAVIOR test-coverage rule applies because AGENT BEHAVIOR is labeled.

## 5. L5 finding — discovered S72 during swap-test (CRITICAL: read in full)

### What changed vs the parent design

Sprint 3 DESIGN gate v3 (`Documentation/sprint3-mcp-proxy-design-gate.md`) called for **three** A2 policies: L3-static (size-cap trim), **L5** (cache_control inject), and L10-static (input-sig dedupe). The S71 implementation plan staged at `sandbox/sprint3-a2-implementation-plan.md` carried L5 forward into A2 with pseudo-code that attaches `cache_control:{type:"ephemeral", ttl:"1h"}` to the last text block in any upstream tool_result exceeding a threshold (default 2,000 chars).

**A2 ships WITHOUT L5.** This MERGE-gate doc captures the empirical discovery that drove the drop.

### Empirical evidence

During S72 swap-test, the extended rollback test #11 (the originally-planned L5 cache_control inject assertion) failed against live A2 with:

```
FAIL  (11) L5 cache_control inject: echo_text with 3000-char input gets cache_control on last block
      expected cache_control on block; got block={"type":"text","text":"echo: XXXXXXXX...
```

The block reached the test process via the JSON-RPC wire format with only `type` + `text` keys — no `cache_control`. Investigation steps:

1. **L3 worked, L10 worked.** Same code path mutates content[] for all three policies. L3 modifies `block.text` (a schema-allowed field); L10 returns the upstream result unchanged (when cache miss) or returns the prior cached result (when hit). L5 added a new field `cache_control` to the block.

2. **Schema location.** `agent/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts` defines `TextContentSchema` with `z.core.$strict` shape (and same for `CallToolResultSchema`). The compiled JS at `types.js:1015-1029` declares: `_meta: z.record(z.string(), z.unknown()).optional()` — meaning the schema lists `type`, `text`, `_meta` and rejects any other top-level keys.

3. **Server validation.** `agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:138` wraps every `tools/call` handler in `safeParse(CallToolResultSchema, result)`. The wrapped handler returns `validationResult.data` (line 143) — the parsed-and-coerced data, NOT the raw `result`. The schema's strict mode coerces by silently STRIPPING unknown fields rather than throwing (Zod 4 behavior diverges from Zod 3 strict-throws semantics; this is what we observed empirically).

4. **Isolated SDK test (definitive).** A standalone harness was run:
   ```javascript
   import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
   const sample = { content: [{ type:"text", text:"hello world",
                                 cache_control:{type:"ephemeral", ttl:"1h"} }] };
   const result = CallToolResultSchema.safeParse(sample);
   // result.success === true
   // result.data.content[0] === { type:"text", text:"hello world" }
   //                            ^ cache_control STRIPPED
   ```
   Confirmed: SDK silently strips. `_meta` IS preserved when used as the cache_control container, but Anthropic API does not read from MCP `_meta`.

### OQ#11 verdict — needs re-interpretation

OQ#11 spike result (`Documentation/oq11-spike-result-2026-05-30.md`, 2026-05-30 UTC, ~$1 spend) reported: cache_read_input_tokens grew 0 → 57,602 → 65,274 → 72,940 across turns 4-6, with the spike MCP server emitting `cache_control:{type:"ephemeral", ttl:"5m"}` on a ~20 KB stable-text tool_result. Verdict was "**YES** — cache_control on MCP tool_result blocks passes through to the Anthropic API."

That verdict is **NOT REFUTED** by the S72 finding, but its causal claim is now in doubt. The OQ#11 spike used the SAME SDK version (`@modelcontextprotocol/sdk@1.29.0`). If the SDK strips cache_control on server-side serialization, then the spike's user-attached `cache_control` could not have reached the API — yet cache_read grew. Three candidate explanations:

| Explanation | Evidence for | Evidence against |
|---|---|---|
| (a) Claude Code auto-attaches cache_control to large MCP tool_results | Would explain cache_creation rising without user input; consistent with the size-correlated growth pattern in OQ#11 (~7.6K tokens cached per turn matches the tool_result size) | No public Claude Code documentation confirming this behavior; would mean OQ#11 spike's user-attached cache_control was placebo |
| (b) Anthropic API auto-caches identical-content blocks across turns | Would explain cache_read growth even without user-attached cache_control | Public docs say cache requires explicit cache_control; would contradict published behavior |
| (c) OQ#11's SDK version actually preserved cache_control (different behavior than current) | OQ#11 was 8 days ago; SDK in package.json is `^1.29.0`, current install at 1.29.0 per pnpm-lock | Same version installed; the in-flight strip behavior empirically observed today must have applied then too |

Most likely: **(a) Claude Code auto-cache on large MCP tool_results.** This means L5 as designed (user-attached cache_control via the proxy) is either a no-op the system already gets for free, OR adds nothing the SDK doesn't already strip.

### Impact on Sprint 3 ROI

The DESIGN gate's per-run savings projection had L5 as one of two primary levers (alongside L1/L2 Sprint 1 cache TTL). The exact ROI table at design-gate v3 §7:
- Path A total savings: $1.02-2.50/run (L1 + L2 + L3 + L5 + L9 + L10).
- L5 was attributed $0.30-0.80/run of that.

If L5 is actually a no-op or Claude-Code-auto-cache redundant: **Path A revised savings range = $0.72-1.70/run.** Still positive ROI vs Path A's 4.5 dev-day cost, but materially lower. Sprint 3 should be regraded at the end of A2 or earlier.

If OQ#11's verdict needs revision: the architecture decision (Path A vs Path B) made on the basis of "OQ#11 YES → Path A locked" may need re-litigation when Sprint 4 (Batch API L4) is scoped. Path B's $3.42-8.50/run savings still requires the direct-SDK migration regardless.

### Recommended follow-up spike (estimated $2 spend, 30 min wall-clock)

Re-run OQ#11 with two variants:
- **Variant A:** spike MCP server attaches `cache_control` to tool_result (same as original OQ#11).
- **Variant B:** spike MCP server emits IDENTICAL text but NO `cache_control`.

**Methodology requirement (per Gemini G-4):** both variants MUST emit payloads of IDENTICAL byte-size, well above Claude Code's likely auto-cache heuristic threshold (target ≥20KB stable filler, same as the original OQ#11 spike's ~18KB filler). Same payload size eliminates "size threshold" as a confounding variable so the only delta is presence/absence of user-attached cache_control. Run each variant for ≥6 turns (matching original OQ#11) to allow cache to warm.

Compare cache_read_input_tokens growth across the 6-turn trace:
- Both grow identically → auto-cache is the mechanism. L5 is unnecessary; remove L5 from any future phase plan.
- Variant A grows but Variant B does not → user-attached cache_control DOES survive somehow (possibly via an SDK-internal bypass for tool_result schema). Investigate the survival path; potentially salvage L5 via the same mechanism.
- Variant A grows MORE than Variant B → user-attached cache_control adds incremental cache hits beyond auto-cache. L5 has partial value but not the full $0.30-0.80/run.

This spike should run BEFORE A3 begins. Not a blocker for A2 ship.

**Parent design ROI update (per Gemini G-4 flag):** once this spike concludes, `Documentation/sprint3-mcp-proxy-design-gate.md` §7 ROI table must be formally updated with the revised Path A savings range. Outcome scenarios:
- Hypothesis (a) confirmed (most likely per Gemini) → revise to Path A = $0.72-1.70/run (drop L5's $0.30-0.80/run contribution).
- Hypothesis (a) partially confirmed → revise with the spike's empirical L5-incremental delta.
- Hypothesis ruled out → restore L5 to A3 scope and salvage the mechanism.

This update is critical context for Sprint 4 (Batch API L4) ROI comparison vs Path B reconsideration.

### Workarounds NOT taken in A2 (rationale)

| Workaround | Why deferred |
|---|---|
| W1: Monkey-patch `CallToolResultSchema` to use `.passthrough()` before `new Server()` | Brittle to SDK upgrades; unclear whether Claude Code's MCP CLIENT layer ALSO strict-validates incoming results and would strip on receipt; would need its own spike to confirm end-to-end |
| W2: Custom transport that re-injects cache_control after SDK serialization | ~3-4h impl; brittle; preserves L5 lever but probably not worth it given (a) hypothesis |
| W3: Bypass SDK entirely with raw JSON-RPC stdio writes | Loses SDK helpers (capabilities negotiation, error mapping); high engineering cost vs uncertain benefit |
| W4: Use `_meta` as the cache_control container | Preserved by SDK schema, but Anthropic API does not read MCP `_meta` — has no effect on caching |

A2 explicitly chooses to ship without L5 + capture the finding here + extend the rollback test (#11) with a regression guard that fires if a future SDK upgrade ever PRESERVES cache_control on content blocks (signaling we should revisit L5 implementation).

## 6. Architecture-deviation rationale

### Per-upstream proxy spawn (carried forward from A1 v3 FINAL — Gemini G-1 fix)

Each MCP server entry in `mcp-config.json` mcpServers spawns its OWN proxy instance with the upstream key as argv[2]. This makes the tool prefix surface as `mcp__<key>__<tool>`, matching the `--allowedTools` allowlist at `executor.ts:858-874` exactly. **Key names are case-sensitive and must match the allowlist verbatim** — `Chrome_DevTools_MCP` (not `chrome_devtools_mcp` or `Chrome-DevTools-MCP`) and `perplexity` (lower-case).

A misspell silently strips ALL tools from Claude when the flag flips, because the allowlist filter rejects every prefix that doesn't match. The rollback test does not cover this footgun directly; reviewers should flag if they see a path to a runtime assertion.

### Worker-start.bat NOT modified (carried forward from A1)

Design §4 Phase A1 step 5 said "Wire `worker-start.bat` to launch proxy as a sibling process." A1 chose not to per [[feedback_stdio_mcp_servers_are_per_call_not_daemons]] — stdio MCP servers are per-call child processes spawned by the MCP client (Claude Code via `--mcp-config`), NOT long-lived daemons. A2 carries this forward.

### npx upstream invocation (A2 NEW)

Both perplexity-mcp and chrome-devtools-mcp are invoked via `npx -yq <pkg>` / `npx <pkg>@latest`. These npm packages are NOT pinned in any project package.json — they're fetched per `claude -p` spawn × per upstream. First-spawn latency is 5-20s (npm fetch); subsequent spawns are 1-3s (npm cache). On a fresh worker host, the first job after A4 flag flip will incur ~30-60s additional latency for the npm cold start.

**No version pinning rationale:** `~/.claude.json:872-893` (the existing Claude Code MCP config the worker daemon parallels) uses the same `-yq` + `@latest` pattern. A2 matches that exactly so behavior under flag-on is byte-identical to current Claude-Code-default MCP path. If upstream perplexity-mcp / chrome-devtools-mcp ships a breaking change, both paths break simultaneously — which is the same blast radius the user accepts today via Claude Code's own MCP config.

### POLICY env-var configurability

Sprint 3 DESIGN gate v3 §4 Phase A3 mentioned env-var configurability for policy tuning. A2 implements this for the two shipped policies:
- `PROXY_L3_MAX_CHARS` (default 80,000; set 0 to disable L3)
- `PROXY_L10_ENABLED` (default `"true"`; set `"false"` to disable L10 GLOBALLY for this proxy instance)

Both are read at proxy boot via `parseNonNegativeInt` (renamed per Gemini G-2) / direct env check. Forward-compatible with A3's expected L9 + future L5-resurrection scenarios.

### L10 idempotency control — per-upstream gate (Codex C-1 fix)

In addition to the master env switch above, `POLICY.L10_ENABLED` is ANDed with the per-upstream `spec.idempotent` field read from `agent/mcp-proxy/upstreams.json`. Default is true (treat as idempotent unless flagged otherwise). Currently flagged false:
- `Chrome_DevTools_MCP` — stateful tools (click, press_key, navigate_page, take_snapshot, take_screenshot, type_text, fill, hover, drag, etc.) mutate external page state. L10 dedup-cache MUST be skipped or the agent operates on stale prior screenshots.
- `stateful_echo` (test-only) — drives rollback test #13.

Currently allowed (idempotent unflagged = true default):
- `echo` (test stub; echo_text + echo_big_text are stateless; echo_with_counter exists for test #12 to prove L10 fires).
- `perplexity` — perplexity_research, perplexity_search, perplexity_ask, perplexity_reason are search/research tools whose results are stable enough within a single research job's wall-clock to make caching net-positive.

If A3 adds new upstreams whose tools mutate external state, those entries MUST set `idempotent: false`. The proxy fails-safe to LESS caching when the flag is missing-from-spec (default true), so reviewers should explicitly verify the flag on every new upstream entry.

### L10 scope clarification — what A2 L10 does and does NOT do (Codex C-2)

Parent DESIGN gate's L10-static was specified as: "cache snapshot blob server-side and return a short reference on repeat (saves Claude input tokens on repeated large tool_results)." The A2 IMPLEMENTATION is narrower: caches the byte-identical CallToolResult and returns it whole on repeat. This means:

| Cost layer | A2 L10 saves it? | Why |
|---|---|---|
| Upstream API cost (e.g. perplexity per-call charge) | **YES** | The proxy skips the upstream client.callTool() on cache hit. Identical perplexity_research(...) calls within one claude-p run = 1 charge, not N. |
| Claude INPUT tokens on the next turn (Claude sees the cached result) | **NO** | Claude still gets the full cached blob as a tool_result content block. Same input-token cost as if the upstream had been called. |
| Upstream wall-clock latency | YES | Cache hit returns immediately (~ms) vs upstream round-trip (~seconds for perplexity research). |

**Sprint 3 ROI implications:** L10's projected savings in the DESIGN gate `§7` ROI table need regrading. The reference-return token-savings mechanism is deferred to A3 (which can lean on the L9 Supabase-backed cache to keep references stable across proxy invocations). For A2, L10 is best understood as "upstream-call dedupe" — narrowly valuable, but materially smaller than the design's pre-finding projection.

### Defensive `sortedKeysReplacer` hardening (Codex C-3 fix)

The L10 dedup key uses `JSON.stringify(args, sortedKeysReplacer)` to normalize argument-key ordering before hashing. The replacer's accumulator is now `Object.create(null)` (no Object.prototype) and properties are assigned via `Object.defineProperty(acc, k, {...})`. This defends against an attacker-controlled own enumerable `__proto__` key in the input args from polluting the accumulator prototype chain on the assignment path. Low practical risk for MCP-tool JSON args (which are sanitized by JSON.parse on the wire), but cheap defense per Codex C-3.

**Operational posture on implicit defaults (per Gemini G-5):** the A2 `agent/.env` patch does NOT explicitly write `PROXY_L3_MAX_CHARS=80000` or `PROXY_L10_ENABLED=true` — both rely on the `index.ts` fallback defaults. This is intentional: it reduces env clutter and avoids the operator-confusion failure mode where a stale `.env` value contradicts the in-code default after a future code change. Future tuning (e.g. A3 introduces a different default, or operator wants to disable L10 for a specific job class) can write explicit overrides ad-hoc. The implicit-defaults posture is documented here so runbooks + telemetry notes know the proxy is running on `80000` + `true` until explicitly overridden.

### L10 SHA-256 key + sorted-keys JSON.stringify

L10 dedupe key = `sha256(toolName + "|" + JSON.stringify(args, sortedKeysReplacer))`. The replacer recursively sorts object keys to avoid non-deterministic hits across calls that differ only in argument-key order. Codex MAY surface a concern if the upstream tool semantically treats argument order as significant — would need to be a tool-specific override. None of the current upstreams (perplexity-mcp, Chrome_DevTools_MCP) appear to care, but if A3 adds new upstreams this assumption should be re-verified.

## 7. Reviewer focus lists

### Gemini Round 1 (long-context whole-codebase read)
1. **L5 finding section §5 — is the OQ#11 re-interpretation argument sound?** Specifically the (a) / (b) / (c) hypothesis ranking. Gemini should pull in its understanding of Anthropic API prompt-caching docs + MCP spec to weigh the three explanations.
2. **POLICY env-var configurability — are the env-var names + parser semantics consistent with the rest of the codebase?** Specifically, the worker's existing env conventions (lower_snake vs UPPER_SNAKE, default-on vs default-off, parse-int patterns at `agent/.env`).
3. **MRPF classification: is "ARCHITECTURE + DEPENDENCY + AGENT BEHAVIOR" the right label set?** Specifically: should ARCHITECTURE be elevated to a stronger label given L5 was a primary lever and is now dropped (potential design-revisit)?
4. **Rollback test #11 (SDK-strip regression guard) — is this the right shape?** It asserts the strip behavior so an SDK upgrade that PRESERVES cache_control triggers the test. Alternatives: deletion entirely, or a parameterized fixture that lets us flip between expectations.
5. **§5 follow-up spike scope — appropriate variant design?** Variant A vs Variant B; is the comparison sufficient to disambiguate auto-cache vs user-attached-cache mechanisms?

### Codex Sequential QA on v3 (fidelity check — verify all Codex Round 2 findings resolved)

**Note (post-Round-2):** Codex Round 2 returned REQUEST_CHANGES with 5 findings (2 MAJOR + 1 MINOR + 2 WELL-HANDLED). v3 integrates C-1, C-2, C-3 per the §1.6 table. Sequential QA is FIDELITY-only — does v3 actually apply the fixes Codex requested, with file:line evidence?

1. **C-1 fix verification** — `agent/mcp-proxy/index.ts`:
   - `UpstreamSpec` interface includes `idempotent?: boolean` field
   - `POLICY.L10_ENABLED` constructor ANDs env switch with `spec.idempotent !== false`
   - Inline comment credits C-1
   - `agent/mcp-proxy/upstreams.json` has `idempotent: false` on `Chrome_DevTools_MCP` entry
   - `agent/mcp-proxy/upstreams.json` has `stateful_echo` entry with `idempotent: false`
   - `agent/scripts/sprint3-a1-rollback-test.mjs` test #13 spawns `stateful_echo` + asserts counter advances on both calls

2. **C-2 fix verification** — `sandbox/sprint3-a2-merge-gate-v3.md`:
   - §1.6 row for C-2 explicitly states the rescope (upstream-call dedupe only, NOT token savings)
   - §5 "L10 scope clarification" subsection has the 3-row "what L10 saves" table
   - §5 parent design ROI TODO mentions L10 regrading in addition to L5

3. **C-3 fix verification** — `agent/mcp-proxy/index.ts`:
   - `sortedKeysReplacer` accumulator uses `Object.create(null)` (not `{}`)
   - Property assignment uses `Object.defineProperty` with explicit attributes
   - Inline comment credits C-3

4. **Post-fix validation evidence** — confirm v3 swap-test ran live:
   - 11/11 PASS + 2 skipped (default mode)
   - Test #13 specifically passed (validates the C-1 fix)
   - A1 was restored after swap-test (production untouched)

5. **No regressions introduced by v3 edits** — verify the §3 test results table reflects 13 tests + the file inventory table doesn't claim any new files that don't exist in sandbox.

If QA finds any of C-1/C-2/C-3 NOT actually fixed, return REQUEST_CHANGES with the specific gap. Otherwise APPROVE.

## 8. Disagreement procedure

Per HARD RULE `~/CLAUDE.md` §"Disagreement Procedure":
- Reviewers agree → standard synthesis, proceed to v3 + /promote.
- Non-SECURITY disagreement → 4h author challenge window, then human owner decides. No third-model tiebreaker.
- SECURITY label not present → no blocking semantics on findings.

Author challenge sentinel value: if Gemini and Codex disagree on the §5 L5 finding interpretation specifically (e.g., one says "ship as-is", other says "block on follow-up spike first"), the author position is "**ship A2; schedule follow-up spike for the auto-cache disambiguation; do not block A2 on it**" — rationale: A2's L3 + L10 wins are real and orthogonal to the L5 mechanism question; deferring the whole MERGE on a Sprint-3-ROI-revision question wastes the integration work already done. A4 dark-launch will provide independent empirical evidence on cache_read tokens under the proxy path either way.

## 9. References

### S72 swap-test
- `c:/tmp/proxy-a1-backup-s72/` — backup of live A1 files before swap (5 files: index.ts, upstreams.json, mcp-config.json, echo-upstream-stub.mjs, sprint3-a1-rollback-test.mjs)
- A1 7/7 restored + verified post-swap

### S71 A1 predecessor MERGE-gate
- `Documentation/sprint3-a1-merge-gate.md` (v3 FINAL, promoted S71)
- `Documentation/sprint3-a1-merge-gate-peer-review.md` (S71 synthesis: Gemini 3 findings + Codex 3 findings + Codex Sequential QA APPROVE)

### OQ#11 spike (verdict caveated by §5 finding)
- `Documentation/oq11-spike-result-2026-05-30.md` (S69 verdict YES; mechanism now suspected as Claude Code auto-cache, NOT user-attached cache_control passthrough)
- `sandbox/validated/oq11-spike-server.mjs-s69` (spike MCP server source)
- `sandbox/validated/oq11-result.json-s69` (raw spike output)

### Memory feedback
- `feedback_stdio_mcp_servers_are_per_call_not_daemons.md` (A1 architectural-deviation rationale)
- `feedback_mcp_tool_prefix_is_server_key.md` (A1 G-1 lesson; carried into A2 key-naming discipline)
- `feedback_node_import_tsx_cwd_resolution.md` (A1 C-1 lesson; carried into A2 mcp-config.json absolute tsx loader)
- `feedback_stdio_transport_default_env_strips_keys.md` (A1 C-3 lesson; carried into A2 unconditional env spread for perplexity API key propagation)
- **NEW S72**: TBD — author memory file capturing the SDK CallToolResultSchema strip discovery + the OQ#11 caveat. To author after v3 FINAL closes (avoid duplicating doc content).

### Sprint 3 DESIGN gate
- `Documentation/sprint3-mcp-proxy-design-gate.md` (v3 FINAL, promoted S69; L5 lever spec now caveated by §5)
- `Documentation/sprint3-mcp-proxy-design-gate-peer-review.md` (S69 synthesis)

### Configuration state at MERGE time
- `agent/.env`:
  - `EXECUTOR_MCP_VIA_PROXY=false` (carry-forward from A1; A4 will flip to `true` post-MERGE)
  - `ENABLE_PROMPT_CACHING_1H=1` (S67; Claude Code auto-uses 1h cache TTL on system+tools)
  - `PLAN_REVIEW_ENFORCE=true` (S68)
  - + S72 NEW: `PERPLEXITY_API_KEY=pplx-...`, `PERPLEXITY_TIMEOUT_MS=600000`
- Worker daemon: PID 52572 alive on pre-S70 executor.ts; flag-off default = no behavior delta until rotation OR manual restart.

---

**End of v3 FINAL. Awaiting Codex Sequential QA. After QA APPROVE → /promote bundle to live (agent/mcp-proxy/* + agent/scripts/sprint3-a1-rollback-test.mjs + agent/.env + Documentation/sprint3-a2-merge-gate.md + Documentation/sprint3-a2-merge-gate-peer-review.md).**
