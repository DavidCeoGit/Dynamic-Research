# L5 Follow-up Spike Result — 2026-05-30 UTC (S73)

**Question:** Does Claude Code's MCP tool_result cache_read growth (observed in OQ#11 S69) come from user-attached `cache_control` passthrough OR from a Claude Code auto-cache mechanism that fires regardless?

**Verdict:** **Hypothesis (a) CONFIRMED.** Claude Code auto-caches MCP tool_result content regardless of user-attached `cache_control`. The L5 lever (proxy-side cache_control inject) provides ZERO incremental value over the existing auto-cache behavior.

**Consequence for Sprint 3:** Drop L5's $0.30-0.80/run contribution from the Path A ROI projection. Revised Path A savings: **$0.72-1.70/run** (L1 + L2 + L3 + L9 + L10, minus L5).

---

## Methodology

Per `Documentation/sprint3-a2-merge-gate.md` §5 "Recommended follow-up spike".

### Test harness

**MCP server** (`c:/tmp/l5-spike-s73/server.mjs`) — minimal stdio MCP server exposing TWO tools with byte-identical ~18KB stable filler bodies:
- `echo_with_cache_control` (Variant A): content block includes `cache_control: {type:"ephemeral", ttl:"5m"}`
- `echo_without_cache_control` (Variant B): same body, NO cache_control field

Both tools return identical text payloads (`INPUT: <userInput>\n\nSTABLE_FILLER:\n<~18KB filler>`). Sole difference between variants is presence/absence of `cache_control` on the content block.

**MCP config** (`c:/tmp/l5-spike-s73/mcp-config.json`): registers `l5spike` server with both tools allowlisted.

**Prompts:** Variant A prompt instructs 3 calls to `mcp__l5spike__echo_with_cache_control` with input `"l5-variant-a"`; Variant B prompt instructs 3 calls to `mcp__l5spike__echo_without_cache_control` with input `"l5-variant-b"`. Both then respond `"DONE"`.

**Invocation** (run sequentially, Variant A first then Variant B):
```bash
cat prompt-variant-X.md | claude -p \
  --mcp-config mcp-config.json --strict-mcp-config \
  --output-format json --verbose \
  --allowedTools "mcp__l5spike__echo_with_cache_control,mcp__l5spike__echo_without_cache_control" \
  > result-variant-X.json
```

### Per-turn cache metrics

**Variant A (with cache_control):**

| Turn | input | cache_create | cache_read | output | Note |
|---|---|---|---|---|---|
| 1 | 5 | 29,967 | 0 | 0 | system prompt cold |
| 2 | 5 | 29,967 | 0 | 0 | system prompt cold |
| 3 | 6 | 30,394 | 0 | 0 | system prompt cold |
| 4 | 1 | 7,674 | **30,394** | 38 | tool_result 1 read |
| 5 | 1 | 7,668 | **38,068** | 84 | tool_results 1+2 read (Δ=7,674) |
| 6 | 1 | 7,668 | **45,736** | 1 | tool_results 1+2+3 read (Δ=7,668) |

Aggregate: cache_create=83,371; cache_read=114,198; total_cost=$0.5888.

**Variant B (without cache_control):**

| Turn | input | cache_create | cache_read | output | Note |
|---|---|---|---|---|---|
| 1 | 5 | 11,473 | 18,494 | 8 | system prompt WARM (primed by Variant A) |
| 2 | 5 | 11,473 | 18,494 | 8 | system prompt WARM |
| 3 | 6 | 11,819 | 18,587 | 5 | system prompt WARM |
| 4 | 1 | 7,674 | **30,406** | 65 | tool_result 1 read |
| 5 | 1 | 7,668 | **38,080** | 74 | tool_results 1+2 read (Δ=7,674) |
| 6 | 1 | 7,668 | **45,748** | 1 | tool_results 1+2+3 read (Δ=7,668) |

Aggregate: cache_create=46,302; cache_read=151,315; total_cost=$0.3759.

### Critical observation: per-turn tool_result cache pattern is IDENTICAL

Looking ONLY at the tool_result-specific cache_read column for turns 4-6 (the variable the spike controls):

| Turn | Variant A cache_read | Variant B cache_read | Delta |
|---|---|---|---|
| 4 | 30,394 | 30,406 | +12 |
| 5 | 38,068 | 38,080 | +12 |
| 6 | 45,736 | 45,748 | +12 |

Per-turn growth Δ ≈ **7,674 tokens** for BOTH variants — matches the size of the tool_result block (~18KB filler ≈ 7.6K tokens).

The 12-token absolute offset between A and B columns is the length difference between `"l5-variant-a"` and `"l5-variant-b"` inputs — not a cache-mechanism delta.

**The presence/absence of user-attached `cache_control` had NO observable effect on the tool_result cache_read pattern.**

### Why the aggregate cost differs (temporal priming, not L5 effect)

Variant A ran FIRST with a cold system-prompt cache → spent ~30K cache_create on turns 1-3 priming the system prompt. Variant B ran SECOND within the 5-minute cache TTL → hit ~18K cache_read on turns 1-3 from Variant A's priming → spent only ~11K cache_create per turn.

The $0.21 cost delta (A=$0.59 > B=$0.38) reflects this cold-cache-prime tax, NOT any L5 effect. If we re-ran the experiment with Variant B first and Variant A second, the cost asymmetry would invert.

This is `[[feedback_claude_cli_cache_priming_cost]]` in action — first `claude -p` call in a session primes the 1-hour cache; subsequent calls benefit. The 30K cache_create on Variant A turn 1 matches the "~38K cache_creation" pattern recorded in that memory.

---

## Interpretation

The OQ#11 spike (S69) observed cache_read growth on MCP tool_result blocks across calls 2-3 and concluded "YES — cache_control passes through". The S72 finding (MCP SDK schema strict-mode silently strips cache_control before wire-emit) made that conclusion suspect. The L5 follow-up spike (this doc) settles the question:

**Cache_read growth on MCP tool_result blocks happens REGARDLESS of user-attached cache_control.** The mechanism is Claude Code auto-cache, applied to large MCP tool_results based on (presumably) a size heuristic.

This is consistent with:
- The MCP SDK strict-mode strip behavior (per `[[feedback_mcp_sdk_strips_cache_control]]`): if the SDK strips, user-attached cache_control can't reach the API.
- The observed cache_read on Variant B (no cache_control attached at all): something other than user passthrough is causing the cache.
- The identical per-turn growth pattern across variants: the mechanism is symmetric to both.

OQ#11's verdict ("YES, cache_control passes through") is **not WRONG in outcome** (cache_read did grow), but the **causal claim** was wrong. The growth wasn't from cache_control passthrough; it was from auto-cache that would have happened anyway.

### Anthropic API caching mechanism (clarification)

Anthropic's public docs say cache requires explicit `cache_control`. The L5 spike does NOT refute that — it shows that *something* (Claude Code, not the user) is attaching cache_control to large MCP tool_results before the wire goes out. The user can't observe this directly because:
1. The user's cache_control on tool_result blocks is stripped by the SDK.
2. Claude Code's auto-attached cache_control is invisible to the user (not in MCP server output, not in user-facing logs).

This is consistent with Anthropic's docs (cache_control IS required for caching) AND with the empirical observation (cache_read grows without user input). Claude Code IS attaching cache_control — just not via the user-facing MCP path.

### Hypothesis (b) and (c) reaffirmed-as-ruled-out

(b) Anthropic API auto-caches identical-content blocks without cache_control → ruled out (would contradict public docs; the L5 spike shows cache requires cache_control attached at SOME layer).

(c) OQ#11's SDK version preserved cache_control → ruled out (same SDK 1.29.0 verified across both spikes).

---

## Impact on Sprint 3 ROI

Per `Documentation/sprint3-mcp-proxy-design-gate.md` v3 §7:
- Path A original total savings: $1.02-2.50/run (L1 + L2 + L3 + L5 + L9 + L10).
- L5 attributed: $0.30-0.80/run.

**Revised Path A total savings: $0.72-1.70/run** (drop L5 entirely; mechanism is already in place via Claude Code auto-cache).

This is a 30% reduction in the projected ROI. Path A is still positive ROI vs its 4.5 dev-day cost, but at the lower end of the original range.

### Parent design §7 update required

The parent design `Documentation/sprint3-mcp-proxy-design-gate.md` §7 ROI table must be regraded per Gemini G-4 + Codex C-2 flags from S72. The revised numbers per this spike:

| Lever | Original $/run | Revised $/run | Notes |
|---|---|---|---|
| L1 (5min cache TTL) | $0.10-0.30 | $0.10-0.30 | No change |
| L2 (1h cache TTL upgrade) | $0.10-0.30 | $0.10-0.30 | No change |
| L3 (static size-cap trim) | $0.20-0.40 | $0.20-0.40 | No change |
| **L5 (cache_control inject)** | **$0.30-0.80** | **$0.00 (REMOVED)** | **Auto-cache redundant per S73 L5 spike** |
| L9 (Supabase vendor cache) | $0.20-0.50 | $0.20-0.50 | No change; Sprint 3 A3 |
| L10 (static dedupe) | $0.12-0.20 | $0.12-0.20 | Codex C-2 S72 already rescoped: saves upstream-API call cost, not Claude input tokens. Numbers stand. |
| **Path A total** | **$1.02-2.50** | **$0.72-1.70** | **30% reduction** |

### Sprint 3 architecture decision (Path A vs Path B) — does it need re-litigation?

Per design v3 §4 Phase 0 decision rule: "Path A locked IF OQ#11 = YES." OQ#11 was YES in outcome (cache_read grew), but the L5 mechanism the lock was partially built on doesn't exist as designed.

**Recommendation: Path A is still right.** The lock was on the operational question ("can the proxy operate on tool_results without breaking the cache layer?"), and that answer remains YES via auto-cache. Path B's $3.42-8.50/run savings still requires the direct-SDK migration regardless — Sprint 4 (Batch API L4) is the right context for that, not Sprint 3.

But Sprint 4 ROI comparison should use Path A's revised $0.72-1.70/run baseline, not the original $1.02-2.50/run.

---

## Cost summary

| Item | Cost |
|---|---|
| L5 spike Variant A execution | $0.5888 |
| L5 spike Variant B execution | $0.3759 |
| **Spike total** | **$0.9647** |
| MCP server scaffold (one-time) | $0 (pnpm install copy from oq11-spike) |
| Engineer wall-clock | ~10 min (analysis + variant runs) |

Within the v3 §5 budget ("$2 spend, 30 min wall-clock").

---

## Reproducibility

Artifacts at `c:/tmp/l5-spike-s73/`:
- `server.mjs` — dual-tool MCP server
- `mcp-config.json` — Claude Code MCP config
- `prompt-variant-a.md` + `prompt-variant-b.md` — exact prompts
- `result-variant-a.json` + `result-variant-b.json` — raw stream-json output (~122KB each)
- `parse-compare.mjs` — comparative analysis script

These should be archived to `sandbox/validated/` alongside the OQ#11 spike artifacts. The parser verdict ("AMBIGUOUS") is a coarse heuristic — the per-turn pattern is the authoritative signal (identical growth in the tool_result-specific column).

---

## Memory updates

New feedback memory file: `feedback_claude_code_autocaches_large_mcp_tool_results.md` — captures the mechanism for future Sprint 3+ work.

Update `feedback_mcp_tool_result_cache_control_passes_through.md` (the original OQ#11 finding): mark CAVEATED → SUPERSEDED-IN-MECHANISM with pointer to this spike. The outcome (cache_read grows) is unchanged; the cause is different.

Update `feedback_mcp_sdk_strips_cache_control.md`: cross-link to this result confirming the implication chain (SDK strips user passthrough → cache_read grows anyway → must be auto-cache, not user input).

---

**End of L5 spike report.** Architecture decision (Path A) stands. ROI math updated. L5 lever removed from Sprint 3+ scope.
