# Sprint 3 Phase A1 — MCP Proxy Scaffold + Executor Wiring MERGE-gate v3 FINAL

**Status:** v3 FINAL = v2 + integrated Codex Round 2 findings. Sequential QA round (Codex fidelity-verify on v3) is the last gate before promote.

**Parent design:** `Documentation/sprint3-mcp-proxy-design-gate.md` §4 Phase A1 (v3 FINAL post-MRPF, S69).
**Phase 0 spike result:** `Documentation/oq11-spike-result-2026-05-30.md` — OQ#11 = YES → Architecture A locked.
**Round 1 (Gemini) raw output:** `sandbox/sprint3-a1-gemini-round1-output.txt`.
**Round 2 (Codex) raw output:** `sandbox/sprint3-a1-codex-round2-output.txt`.

**Sessions:** S70 (author v1) → S71 (Round 1 → v2 → Round 2 → v3 FINAL).

---

## 0. Round 1 + Round 2 findings + author resolution (combined ledger)

### Round 1 (Gemini, REQUEST_CHANGES, 3 findings — resolved in v2)

| ID | Severity | Title | Status |
|---|---|---|---|
| **G-1** | CRIT | Tool namespace prefix collision (`mcp__proxy__*` vs `--allowedTools mcp__perplexity__*`). | RESOLVED in v2 via per-upstream 1:1 model. v3 carries this forward. |
| **G-2** | MAJOR | Hardcoded absolute Windows path in `mcp-config.json` breaks on Linux/other-host. | RESOLVED-WITH-CONCESSION (downgrade to MINOR). Single-host scope explicit in mcp-config `_single_host_note`. Codex Round 2 confirmed no current non-Windows code path exists. |
| **G-3** | MINOR | Cached upstream client persists across upstream crashes. | RESOLVED in v2 via `transport.onclose` handler. Codex Round 2 verified onclose semantics against `@modelcontextprotocol/sdk@1.29.0` source — correct. |

### Round 2 (Codex, REQUEST_CHANGES, 3 findings — resolved in v3)

| ID | Severity | Title | Resolution |
|---|---|---|---|
| **C-1** | MAJOR | MCP proxy launch is cwd-sensitive; `--import=tsx` requires tsx in cwd's node_modules chain. Real executor at executor.ts:888 spawns claude with cwd=per-job workDir (under Projects/<slug>/), which has NO tsx. v2 rollback test forced cwd=agent specifically to hide this. | **ACCEPTED — FIXED.** `mcp-config.json` args now use absolute `file:///` URL to tsx's ESM loader (`agent/node_modules/tsx/dist/esm/index.mjs`) — cwd-independent. v3 rollback test #1 spawns from `cwd=c:/tmp/` to PROVE the fix (would fail without the absolute URL). |
| **C-2** | MINOR | Rollback harness accepts empty `tools/list` (echo upstream stub didn't exist). Misses config-parser issues, server-name prefix behavior, cwd behavior, and actual passthrough. | **ACCEPTED — FIXED.** Added `agent/mcp-proxy/echo-upstream-stub.mjs` (minimal 1-tool MCP server returning `echo: <input>`). Added v3 rollback tests #3 (assert echo_text in tools/list) + #4 (assert tools/call returns expected content). Real end-to-end passthrough validated. |
| **C-3** | MINOR | Upstream env inheritance ambiguous: v2 passes `process.env` only IF `spec.env` present. For A2 perplexity (which won't have spec.env but needs PATH + PERPLEXITY_API_KEY), the SDK default minimal env would strip credentials. | **ACCEPTED — FIXED.** `index.ts` v3 unconditionally spreads `process.env` first, then overlays `spec.env ?? {}`. Spec.env is now optional and additive (was the implicit default in v2; now explicit). Also added optional `cwd` field to UpstreamSpec for A2 ergonomics. |

**Codex's explicit answers on v2:**
- G-1 refactor — **N as runnable artifact** (correct shape; broken launch). Fixed in v3 → now **Y**.
- G-2 single-host concession — **Y** (no non-Windows code path found).
- G-3 disconnect handler — **Y** (`onclose` semantics verified in `agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`).
- Severity Mode NORMAL — **Y** (no security escalators).

**Verdict transition path:**
- v1 → Gemini REQUEST_CHANGES (3 findings)
- v2 → Codex REQUEST_CHANGES (3 findings)
- v3 → both reviewers' findings integrated; awaiting sequential QA fidelity verification by Codex (whose Round 2 read drove the bulk of v3's diff).

---

## 1. What ships at v3 FINAL

### 1.1 Files added (4 new — promotes from sandbox to live)
- **`agent/mcp-proxy/index.ts`** — 148 lines. Per-upstream 1:1 proxy with cwd-passthrough on UpstreamSpec + unconditional env inheritance. Reads `process.argv[2]` for upstreamKey. Returns `serverInfo.name=mcp-proxy-<upstreamKey>`. `transport.onclose` clears cached client.
- **`agent/mcp-proxy/upstreams.json`** — Schema = `{upstreams: {[key]: {command, args, cwd?, env?}}}`. A1 ships only `echo` (absolute-path command targeting `echo-upstream-stub.mjs`). A2 adds `perplexity` + `Chrome_DevTools_MCP`.
- **`agent/mcp-proxy/mcp-config.json`** — One server entry per upstream (A1: `echo` only). `args` uses absolute `file://` URL to tsx ESM loader for cwd-independence. `_single_host_note` documents G-2 acknowledgement. `_codex_c1_note` documents C-1 fix.
- **`agent/mcp-proxy/echo-upstream-stub.mjs`** — ~50 lines. Minimal MCP server with single `echo_text` tool. NEW IN v3 (Codex C-2). Test-only.

### 1.2 Files added (1 new — test harness promote)
- **`agent/scripts/sprint3-a1-rollback-test.mjs`** — 7-test harness. Spawns proxy from `cwd=c:/tmp/` (NON-agent) to prove C-1 cwd-independence. Tests `initialize`, `tools/list`, `tools/call` with passthrough assertion, SIGTERM shutdown, + 2 G-1-safety tests.

### 1.3 Files modified (UNCHANGED from v1/v2)
- **`agent/executor.ts`** — Lines 837-880. Conditional `--mcp-config <proxy-cfg> --strict-mcp-config` under `EXECUTOR_MCP_VIA_PROXY === "true"`. The conditional wire is unchanged from S70.
- **`agent/.env`** — `MAX_JOB_COST_CENTS=1500` + `EXECUTOR_MCP_VIA_PROXY=false`. Unchanged from S70.

### 1.4 Dependencies (UNCHANGED from v1)
- `@modelcontextprotocol/sdk@1.29.0` — already in agent/package.json since S70.

### 1.5 v3 file diff vs v2 (what changed in this round)

**`agent/mcp-proxy/index.ts`**
```diff
  interface UpstreamSpec {
    command: string;
    args: string[];
+   cwd?: string;
    env?: Record<string, string>;
  }

  function getUpstreamClient(): Promise<Client> {
    ...
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
+     cwd: spec.cwd,
-     env: spec.env ? ({ ...process.env, ...spec.env } as ...) : undefined,
+     env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
    });
```

**`agent/mcp-proxy/mcp-config.json`**
```diff
  "args": [
-   "--import=tsx",
+   "--import",
+   "file:///C:/Users/ceo/Documents/AI%20Training/Anti%20Gravity/Dynamic%20Research/agent/node_modules/tsx/dist/esm/index.mjs",
    "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/mcp-proxy/index.ts",
    "echo"
  ]
```

**`agent/mcp-proxy/upstreams.json`**
```diff
  "echo": {
    "command": "node",
-   "args": ["./echo-upstream-stub.mjs"]
+   "args": ["C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/mcp-proxy/echo-upstream-stub.mjs"]
  }
```

**`agent/mcp-proxy/echo-upstream-stub.mjs`** — NEW FILE (~50 lines, minimal echo tool).

**`agent/scripts/sprint3-a1-rollback-test.mjs`** — added tests #3 (tools/list assertion), #4 (tools/call passthrough), made cwd test_cwd=`c:/tmp/`, hardened test #1 stderr filter.

---

## 2. Test results (local, S71 2026-05-30 UTC)

### 2.1 pnpm test (full project gate, v3 staged via swap)
```
> dynamic-research@1.0.0 test
> bash agent/scripts/test-phase-b-storage-paths.sh && pnpm -C agent exec tsc --noEmit && pnpm -C frontend exec tsc --noEmit

PASS: no flat-layout storage path antipatterns detected.
[agent tsc passed silently — no errors]
[frontend tsc passed silently — no errors]

exit_code=0
```

### 2.2 Phase A1 v3 rollback test (cwd=c:/tmp/, NON-agent — proves C-1 fix)
```
PASS  (1) proxy boots from non-agent cwd (cwd-independence; C-1 fix)
PASS  (2) proxy responds to MCP initialize handshake (serverInfo.name=mcp-proxy-echo)
PASS  (3) proxy tools/list returns echo_text from upstream (C-2 fix)
PASS  (4) proxy tools/call echo_text returns passthrough content (C-2 fix)
PASS  (5) SIGTERM stops the proxy
PASS  (6) proxy exits non-zero without upstream-key argv
PASS  (7) proxy exits non-zero on UNKNOWN upstream-key

=== 7/7 passed ===
```

### 2.3 v1 rollback regression (post-restore — confirms swap was clean)
```
PASS  (1) proxy boots without parse error on upstreams.json
PASS  (2) proxy responds to MCP initialize handshake
PASS  (3) proxy responds to tools/list (degrades gracefully on bad upstream)
PASS  (4) SIGTERM stops the proxy

=== 4/4 passed ===
```

Round-trip clean. **Current live `agent/mcp-proxy/` is back at v1 (S70 code)** — v3 lands via /promote after sequential QA passes.

### 2.4 Worker behavior (passive)
Worker PID 52572 still on pre-S70 executor.ts. Flag-off default → no behavior change on next cron rotation. v3 sandbox-staged only.

---

## 3. MRPF classification (UNCHANGED FROM v1)

- **Event Gate:** MERGE.
- **Risk Labels:** ARCHITECTURE + DEPENDENCY + AGENT BEHAVIOR.
- **Severity Mode:** NORMAL (confirmed by both reviewers).
- **Reviewer topology:** Sequential Gemini Round 1 (DONE) → integrate v2 (DONE) → Codex Round 2 (DONE) → integrate v3 (DONE) → Sequential QA Codex on v3 (PENDING).
- **Test coverage answer:** Yes — Phase B storage-paths guard + dual-subproject tsc + 7-step v3 rollback harness + v1-regression round-trip all pass. Not covered (deferred to A2): production-traffic E2E with real upstreams + `EXECUTOR_MCP_VIA_PROXY=true` on a research job.

---

## 4. Architecture deviation from design (Gemini ACCEPTED)

worker-start.bat unchanged; stdio MCP proxy is per-`claude -p`-spawn child via `--mcp-config`. Rationale unchanged from v1. Gemini Round 1 accepted: "matches Claude Code's native MCP client lifecycle... cross-job cache persistence concern is moot since the design explicitly states L9 cache is backed by Supabase."

## 4.5 G-2 single-host path concession (UNCHANGED FROM v2 — Codex CONFIRMED)

`mcp-config.json` + `upstreams.json` carry absolute Windows paths. Single-host scope: the worker daemon never deploys (push-clone deploy is `frontend/`-only). Codex Round 2 explicitly verified: "I found no current non-Windows production path for `agent/`". Linux-port = Phase B+ TODO (regenerate config at runtime in executor.ts).

---

## 5. What reviewers should focus on (Sequential QA — Codex on v3)

This is the **fidelity-verify pass** (per MRPF v2.2 sequential-QA-on-revisions rule). Codex caught more material defects than Gemini in this cycle (C-1 was the most consequential single finding); Codex therefore runs the QA on v3.

QA scope is FIDELITY, not novel critique:

1. **C-1 verification:** Does `sandbox/sprint3-a1-mcp-config-v3.json` correctly use the absolute file:// URL for tsx loader? Does `sandbox/sprint3-a1-rollback-test-v3.mjs:38-43` spawn from cwd=c:/tmp/ as claimed? Would the v3 test FAIL if the absolute URL were removed (i.e., does it actually verify the fix)?
2. **C-2 verification:** Does `sandbox/sprint3-a1-echo-upstream-stub-v3.mjs` actually return a working `echo_text` tool? Do tests #3 and #4 actually exercise the proxy's `tools/list` and `tools/call` forwarding paths?
3. **C-3 verification:** Does `sandbox/sprint3-a1-mcp-proxy-index-v3.ts:82-86` unconditionally spread `process.env`? Is `spec.env ?? {}` the correct null-coalescing form?
4. **Newly-added `cwd` field on UpstreamSpec:** does it round-trip from upstreams.json → UpstreamSpec interface → StdioClientTransport correctly?
5. **No regressions to Round 1 (G-1/G-3) fixes:** are the v2 fixes still in place at v3?
6. **Test pass results match the doc claims:** §2.2 shows 7/7; can Codex confirm tests #1-#7 are well-formed against the staged v3 files?

QA does NOT introduce new findings unless they're CRIT/MAJOR. MINOR drift is recorded but not blocking.

---

## 6. Disagreement procedure (no open disputes entering QA)

Gemini Round 1: explicitly answered Y on worker-start.bat deviation, NORMAL severity.
Codex Round 2: explicitly answered Y on G-2 concession, G-3 sufficiency, NORMAL severity.
Both reviewers' findings are integrated. No SECURITY-labeled findings surfaced (no auth, no secrets, no PII, no migration).

If sequential QA surfaces a NEW CRIT/MAJOR, escalate per MRPF disagreement procedure: 4-hour author-challenge window + human owner decides.

---

## 7. References

- Round 1 (Gemini) raw output: `sandbox/sprint3-a1-gemini-round1-output.txt`
- Round 1 prompt: `sandbox/sprint3-a1-gemini-round1-prompt.md`
- Round 2 (Codex) raw output: `sandbox/sprint3-a1-codex-round2-output.txt`
- Round 2 prompt: `sandbox/sprint3-a1-codex-round2-prompt.md`
- v1 author artifact: `sandbox/sprint3-a1-merge-gate-v1.md`
- v2 post-Gemini integration: `sandbox/sprint3-a1-merge-gate-v2.md`
- Sandbox-staged v3 source files (atomic promote bundle): `sandbox/sprint3-a1-{mcp-proxy-index-v3.ts, upstreams-v3.json, mcp-config-v3.json, echo-upstream-stub-v3.mjs, rollback-test-v3.mjs}` + matching `.meta` sidecars
- v1 backup (post-promote rollback safety net): `c:/tmp/proxy-v1-backup/` (3 files, byte-identical with S70 promoted)
- Parent design: `Documentation/sprint3-mcp-proxy-design-gate.md` (v3 FINAL, 415 lines, S69)
- Phase 0 spike: `Documentation/oq11-spike-result-2026-05-30.md` (OQ#11 = YES, S69)

---

**End of v3 FINAL.** Submit to Codex for sequential QA fidelity-verify. If QA passes (no NEW CRIT/MAJOR findings), proceed to /promote of:
- `Documentation/sprint3-a1-merge-gate.md` (this doc, renamed)
- `Documentation/sprint3-a1-merge-gate-peer-review.md` (synthesis of Rounds 1, 2, and QA)
- `agent/mcp-proxy/index.ts` (v3)
- `agent/mcp-proxy/upstreams.json` (v3)
- `agent/mcp-proxy/mcp-config.json` (v3)
- `agent/mcp-proxy/echo-upstream-stub.mjs` (NEW)
- `agent/scripts/sprint3-a1-rollback-test.mjs` (v3)
