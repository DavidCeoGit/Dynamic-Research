# Sprint 3 Phase A1 — MERGE-gate Peer Review Synthesis

**Companion to:** `Documentation/sprint3-a1-merge-gate.md` (v3 FINAL).
**MRPF version:** v2.2 (sequential at every stage — Gemini → integrate → Codex → integrate → QA).
**Sessions:** S70 (author v1) → S71 (Round 1 → v2 → Round 2 → v3 FINAL → QA APPROVE).
**Outcome:** All 6 findings RESOLVED (3 from Gemini, 3 from Codex). QA APPROVE. Promoted to live S71 2026-05-30 UTC.

---

## 1. Round-by-round ledger

### Round 1: Gemini (Round 1 reviewer, holistic / doc-level on v1)

**Model:** `gemini-3-pro-preview` (CLI: `gemini -m gemini-3-pro-preview -p < <prompt>`)
**Verdict:** REQUEST_CHANGES
**What Gemini saw:** v1 MERGE-gate doc + embedded code excerpts (executor.ts wiring, mcp-proxy/index.ts, upstreams.json, mcp-config.json, rollback-test.mjs). No filesystem access.

| ID | Severity | Title | One-line gap |
|---|---|---|---|
| G-1 | CRIT | Tool namespace prefix collision | mcp-config server name = `proxy` → tools surface as `mcp__proxy__*` → executor's `--allowedTools` allowlist (`mcp__perplexity__*` + `mcp__Chrome_DevTools_MCP__*`) excludes all → 0 tools allowed when flag flips |
| G-2 | MAJOR | Hardcoded absolute Windows path | mcp-config.json bakes in `C:/Users/ceo/...` → breaks on Linux/other-host when flag flips |
| G-3 | MINOR | Unhandled upstream crash | Cached client promise persists even if upstream dies → subsequent calls fail rather than respawn |

**Gemini's explicit answers (Both reviewers):**
- worker-start.bat deviation acceptable? **YES** (per-call stdio framing matches Claude Code's native MCP client lifecycle; L9 cache backs to Supabase per design).
- Real upstreams in `upstreams.json` now? **NO** — keep stub for A1 (note: G-1 refactor changes the shape anyway).
- Severity Mode NORMAL? **YES.**

### Author integration (v1 → v2, S71 main-loop)

| Finding | Resolution |
|---|---|
| G-1 | **Accepted; refactored.** Per-upstream 1:1 model: each upstream gets its own mcp-config server entry (key = upstream key = tool prefix). Proxy reads `process.argv[2]` for upstreamKey. `serverInfo.name = mcp-proxy-<upstreamKey>`. Routing schema simplified (routing field removed; implicit via argv). |
| G-2 | **Accepted with concession; downgraded to MINOR.** Single-host scope is real: worker daemon never deploys (push-clone is `frontend/`-only). `_single_host_note` field added to mcp-config.json. Linux-port = Phase B+ TODO. Codex Round 2 explicitly verified no current non-Windows code path exists. |
| G-3 | **Accepted; fixed.** `transport.onclose` handler clears `cachedClient` so subsequent calls reconnect. Per-instance scope (post-G-1) keeps the fix scope tight. |

### Round 2: Codex (code-grounded on v2)

**Model:** `gpt-5.5` (CLI: `codex exec -s read-only -C "<dir>"`)
**Verdict:** REQUEST_CHANGES
**What Codex saw:** Full filesystem read-only access to project (including `agent/node_modules/@modelcontextprotocol/sdk/dist/...` and `agent/node_modules/tsx/`). Codex actually verified SDK source code, package layout, and tsx loader path.

| ID | Severity | Title | One-line gap |
|---|---|---|---|
| C-1 | MAJOR | MCP proxy launch is cwd-sensitive | `--import=tsx` resolves `tsx` from cwd's node_modules chain; real executor at `executor.ts:888` spawns claude with `cwd=per-job workDir` (under `Projects/<slug>/`) which lacks tsx → proxy fails to boot when flag flips. v2 rollback test cheated by setting `cwd=agent`. |
| C-2 | MINOR | Rollback harness too permissive | Tests accept empty `tools/list` because echo upstream stub doesn't exist → no real passthrough validation → misses config-parser issues, server-name prefix behavior, actual upstream forwarding |
| C-3 | MINOR | Env inheritance ambiguous | v2: `spec.env ? {...process.env, ...spec.env} : undefined` — passing undefined causes SDK to fall back to minimal default env, stripping API keys for A2 upstreams that don't need spec.env but DO need PATH + API keys |

**Codex's explicit answers on v2:**
- G-1 refactor — **N as runnable artifact** (correct shape, broken launch — fixed in v3).
- G-2 single-host concession — **Y** (no current non-Windows path found).
- G-3 disconnect handler — **Y** (`onclose` semantics verified in `@modelcontextprotocol/sdk@1.29.0` source).
- Severity Mode NORMAL — **Y.**

### Author integration (v2 → v3, S71 main-loop)

| Finding | Resolution |
|---|---|
| C-1 | **Accepted; fixed.** `mcp-config.json` args now use absolute `file:///` URL to tsx's ESM loader entry: `file:///<abs-path>/agent/node_modules/tsx/dist/esm/index.mjs`. cwd-independent. v3 rollback test #1 spawns from `cwd=c:/tmp/` (non-agent) to PROVE the fix; would fail without the absolute URL. Codex QA confirmed: tsx loader file exists; test discriminating. |
| C-2 | **Accepted; fixed.** Added `agent/mcp-proxy/echo-upstream-stub.mjs` — minimal MCP server with `echo_text` tool that returns `echo: <input>`. New v3 rollback tests #3 (asserts `echo_text` in `tools/list`) + #4 (asserts `tools/call echo_text` returns `echo: hello-mcp-proxy`). Real end-to-end passthrough validated against the proxy's actual handler code. |
| C-3 | **Accepted; fixed.** `index.ts` v3 unconditionally spreads `process.env` first then overlays `spec.env ?? {}`. Pattern: `env: { ...process.env, ...(spec.env ?? {}) }`. Added optional `cwd` field to UpstreamSpec for A2 ergonomics. |

### Sequential QA: Codex (fidelity-verify on v3)

**Codex was the higher-yield reviewer this cycle (C-1 was the most consequential single finding), so Codex runs the QA per MRPF v2.2 sequential-QA rule.**

**Verdict:** APPROVE (proceed to /promote)

| Verification | Status | Evidence |
|---|---|---|
| C-1 | FIXED | `mcp-config-v3.json:9-12` uses absolute file:// URL. `rollback-test-v3.mjs:45` sets `TEST_CWD="c:/tmp"`. tsx loader file exists on disk (Codex Test-Path returned True). |
| C-2 | FIXED | `echo-upstream-stub-v3.mjs` declares ListTools + CallTool handlers. Tests #3 and #4 exercise proxy handlers at `mcp-proxy-index-v3.ts:112-116` and `:125-132`. |
| C-3 | FIXED | `mcp-proxy-index-v3.ts:84-89` unconditionally spreads `process.env`; old conditional form gone. New `cwd` field round-trips correctly. |
| G-1 (regression check) | FIXED | Per-upstream 1:1 model intact; `process.argv[2]` reads upstreamKey; serverInfo.name=`mcp-proxy-<key>`. |
| G-3 (regression check) | FIXED | `transport.onclose` wired; cached client clears on disconnect. |
| Test claims fidelity | FIXED | Tests #1-#7 have discriminating assertions matching the v3 doc's §2.2 claims. |

Codex's recommendation: "Recommend /promote."

---

## 2. Round-by-round verdict transitions

```
v1 → Gemini Round 1: REQUEST_CHANGES (3 findings)
      ↓ integrate
v2 → Codex Round 2: REQUEST_CHANGES (3 findings)
      ↓ integrate
v3 → Codex Sequential QA: APPROVE
      ↓ promote
LIVE
```

Each round produced material defects that would not have surfaced in independent parallel review:
- Gemini surfaced G-1 (CRIT architecture defect) by reading the doc holistically against the executor's allowlist — a whole-artifact reasoning catch.
- Codex surfaced C-1 (MAJOR runtime defect) by verifying the test methodology against the executor's actual cwd behavior — a code-grounded catch on the POST-Gemini-integration state.

**Empirical reinforcement of MRPF v2.2 sequential-at-every-stage rule:** the C-1 catch was only possible because Codex reviewed the integrated v2 (where the per-upstream refactor existed). A parallel Codex review of v1 would have spent its budget on the multiplex model that Gemini's G-1 was about to invalidate. The sequential ordering preserves Codex's strength (code-grounded verification of the *current* direction) instead of the *original* direction.

---

## 3. What each reviewer saw

| Reviewer | Round | Scope |
|---|---|---|
| Gemini | Round 1 | v1 MERGE-gate doc with code excerpts embedded in prompt. No filesystem access. |
| Codex | Round 2 | Full filesystem read-only (project + agent/node_modules/). Verified SDK source. |
| Codex | Sequential QA | Same as Round 2 + read sandbox/sprint3-a1-codex-round2-output.txt (its own prior findings) for fidelity reference. |

---

## 4. Test coverage at v3 FINAL

**Mandatory MRPF answer (SECURITY/DATA/AGENT BEHAVIOR labels):** Yes, covered.

| Test surface | Coverage |
|---|---|
| Phase B storage-paths guard | PASS (no flat-layout antipatterns) |
| agent/ tsc --noEmit | PASS (strict TS, 0 errors) |
| frontend/ tsc --noEmit | PASS (strict TS, 0 errors) |
| Proxy boots cwd-independent (C-1) | PASS (test #1, cwd=c:/tmp/) |
| MCP initialize handshake (G-1 verify) | PASS (test #2, serverInfo.name=mcp-proxy-echo) |
| tools/list passthrough (C-2) | PASS (test #3, echo_text returned) |
| tools/call passthrough (C-2) | PASS (test #4, echo: hello-mcp-proxy returned) |
| SIGTERM shutdown | PASS (test #5) |
| Missing argv (G-1 safety) | PASS (test #6, non-zero exit + stderr message) |
| Unknown upstream (G-1 safety) | PASS (test #7, non-zero exit + stderr message) |
| v1 regression (post-restore) | PASS (4/4) |

Not covered (deferred to A2 MERGE-gate with explicit rationale):
- Production-traffic E2E with `EXECUTOR_MCP_VIA_PROXY=true` on a real research job. Defer rationale: A1 ships the proxy with no real upstreams configured; flipping the flag with only the echo stub would route nothing useful. A2 wires perplexity + Chrome_DevTools_MCP as real upstreams and runs the dark-launch validation per the parent design's Phase A4.

---

## 5. Open items at end-of-MRPF-cycle (none blocking)

- **G-2 Linux-port fix** (Phase B+ TODO): mcp-config.json's absolute paths would need runtime generation if the worker ever runs on Linux. Tracked in mcp-config.json `_single_host_note` field. Not blocking; not on roadmap.
- **`Server` deprecation** (per @modelcontextprotocol/sdk@1.29.0): the `Server` class is marked `@deprecated Use \`McpServer\` instead`. v3 carries v1's `Server` choice forward; OQ#11 spike also used `Server`. Migration to `McpServer` is a non-A1 cleanup, ideally before A4 flip.

Neither item is blocking for v3 FINAL /promote.

---

## 6. References

- v1 author artifact: `sandbox/sprint3-a1-merge-gate-v1.md` (S70)
- v2 post-Gemini: `sandbox/sprint3-a1-merge-gate-v2.md` (S71)
- v3 FINAL: `Documentation/sprint3-a1-merge-gate.md` (S71 promoted)
- Round 1 raw output: `sandbox/sprint3-a1-gemini-round1-output.txt`
- Round 2 raw output: `sandbox/sprint3-a1-codex-round2-output.txt`
- Sequential QA raw output: `sandbox/sprint3-a1-codex-qa-output.txt`
- Parent design: `Documentation/sprint3-mcp-proxy-design-gate.md` (v3 FINAL, S69)
- Phase 0 spike: `Documentation/oq11-spike-result-2026-05-30.md` (OQ#11 = YES, S69)
- Parent MRPF policy: `~/CLAUDE.md` Multi-Reviewer Policy Framework section + `Documentation/multi-reviewer-policy-framework.md`

---

**This synthesis closes the Phase A1 MERGE-gate cycle.** Next: begin Phase A2 implementation per the parent design §4 Phase A2 (real perplexity + Chrome_DevTools_MCP upstreams + L3/L5/L10 policies).
