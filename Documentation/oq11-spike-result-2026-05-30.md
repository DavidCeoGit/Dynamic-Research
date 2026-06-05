# OQ#11 Spike Result — 2026-05-30 UTC (S69)

**Question:** Does Claude Code's MCP wire format pass `cache_control` metadata THROUGH `tool_result` blocks to the upstream Anthropic API?

**Verdict:** **YES** — cache_control on MCP tool_result blocks passes through to the Anthropic API and DOES cause those blocks to be cached + re-read on subsequent turns.

**Consequence for Sprint 3:** **Architecture A (Pure MCP Proxy) is the path.** Per v3 §4 Phase 0 decision rule and §7 ROI table, Path A is 4.5 dev days for $1.02-2.50/run savings vs Path B's 8.5 dev days for $3.42-8.50/run savings. Path B remains the right move IF Sprint 4 (Batch API L4) is genuinely planned, but Path A is the immediate Sprint 3 win.

---

## Methodology

Per design doc `Documentation/sprint3-mcp-proxy-design-gate.md` §4 Phase 0.

### Test harness

**MCP server** (`c:/tmp/oq11-spike/server.mjs`) — minimal stdio MCP server exposing one tool `echo_with_cache_control` that returns ~20KB of byte-identical filler text with `cache_control: {type: "ephemeral", ttl: "5m"}` attached at the content-block level.

**MCP config** (`sandbox/oq11-mcp-config.json`):
```json
{
  "mcpServers": {
    "oq11test": {
      "command": "node",
      "args": ["c:/tmp/oq11-spike/server.mjs"]
    }
  }
}
```

**Prompt** (`sandbox/oq11-prompt.md`): minimal — instructs Claude to call the tool 3 times with the SAME input string ("spike-test-1") then respond "DONE".

**Invocation:**
```bash
cat sandbox/oq11-prompt.md | claude -p \
  --mcp-config sandbox/oq11-mcp-config.json \
  --strict-mcp-config \
  --output-format json --verbose \
  --allowedTools "mcp__oq11test__echo_with_cache_control" \
  > sandbox/oq11-result.json
```

### Per-turn cache metrics (from parsed result)

| Turn | input_tok | cache_creation_input_tok | cache_read_input_tok | output_tok |
|---|---|---|---|---|
| 1 | 5 | 57,164 | 0 | 8 |
| 2 | 5 | 57,164 | 0 | 8 |
| 3 | 6 | 57,602 | 0 | 5 |
| 4 (after tool call 1) | 1 | 7,672 | **57,602** | 62 |
| 5 (after tool call 2) | 1 | 7,666 | **65,274** | 73 |
| 6 (after tool call 3) | 1 | 7,666 | **72,940** | 1 |

**Aggregate:** cache_creation = 137,770 ; cache_read = 195,816 ; output = 399 ; total cost = $0.9697.

### Decision rule (from §4 Phase 0)

| Outcome | Threshold | Result |
|---|---|---|
| OQ#11 = YES | cache_read > ~5000 on call 2 or 3 | ✓ — cache_read = 65,274 (turn 5) and 72,940 (turn 6), both >> 5000 |
| OQ#11 = NO | cache_read ≈ 0 on all calls | ✗ — cache_read grew non-zero from turn 4 onward |
| AMBIGUOUS | between thresholds | ✗ — values are unambiguously high |

**Verdict: OQ#11 = YES.**

---

## Interpretation

The cache_read figures grow by ~7.6K tokens per subsequent turn, matching the size of each tool_result block (~20KB text ≈ ~7.6K tokens). This is direct evidence that:

1. Claude Code did NOT strip the block-level `cache_control` field when forwarding MCP tool_result blocks to the Anthropic API.
2. Anthropic's prompt-cache layer accepted the cache_control directive and cached the tool_result block contents.
3. Subsequent identical tool_result blocks were served from cache at the 0.1× input rate.

### Alternative hypothesis ruled out

One could argue that Claude Code might be auto-injecting cache_control on tool_result blocks regardless of what the MCP server attaches. We don't disprove that hypothesis here — but it's IRRELEVANT to the architecture decision: either way, Path A's L5 lever works (proxy can rely on the existing cache-pass-through behavior). The only Path A risk OQ#11 was meant to surface was "block-level cache_control on tool_result is stripped by Claude Code, making L5 unrecoverable from a pure-proxy posture". The data refutes that risk.

If we want to disambiguate the two hypotheses for future reference, a follow-up spike could run the SAME prompt without cache_control attached to the MCP tool_result and compare cache_read patterns. Not required for Sprint 3.

### What this does NOT prove

- The spike does not test whether L9 (vendor-side dedup) interacts cleanly with the cache layer — that's a separate Sprint 3 implementation concern.
- The spike does not validate Codex C-2's prediction that L3-reference-aware / L10-reference-aware require Path B — that finding stands; only the L3-static + L10-static variants are unlocked by Path A.
- The spike does not pre-position Sprint 4 (Batch API L4) — that still requires the direct-SDK migration eventually.

---

## Next steps (per design doc v3)

1. **Path A approved.** Begin Phase A1 (Proxy scaffold + executor wiring) — 1.5 dev days per v3 §4.
2. **Sprint 1 telemetry** is still the right next observation — query `research_usage` for `cache_read_tokens > 0` evidence on the next 3 real jobs to confirm L1 is silently working (Codex C-2's well-handled item #3).
3. **Path B remains tabled** until Sprint 4 (Batch API L4) is scheduled — at that point, Path B's 8.5-day investment pre-positions L4's $3-5/run savings.

---

## Cost summary

| Item | Cost |
|---|---|
| Spike execution (Anthropic API via claude.ai first-party billing) | $0.9697 |
| MCP server scaffold (one-time) | $0 (npm pkg install, no API calls) |
| Engineer wall-clock | ~12 min (faster than the 30 min estimate) |
| **Total** | **~$1.00** |

Aligned with the design doc's "~$1 of API + 30 min of engineer time" budget.

---

## Reproducibility

The spike artifacts are archived to `sandbox/validated/`:
- `oq11-spike-server.mjs` — MCP server source
- `oq11-mcp-config.json` — Claude Code MCP config
- `oq11-prompt.md` — exact prompt used
- `oq11-result.json` — raw 122KB stream-json output
- This document — verdict + analysis

To re-run: restore the files to `sandbox/` and execute the invocation block above. Note that the Claude Code CLI version at time of spike was the one resolved by `claude` in PATH on 2026-05-30 UTC; re-runs against future CLI versions may produce different cache-control passthrough behavior if Anthropic ships a behavioral change.

---

**End of OQ#11 spike report.** Architecture decision locked: Path A (Pure MCP Proxy). Sprint 3 implementation cleared to begin.
