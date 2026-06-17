# S136 Pipeline Bug-Fix Design Gate — Studio Video-Poll Stall + Source-Import Gap

**Status:** DRAFT for DESIGN+MERGE gate review (Gemini → Codex, sequential).
**Author:** Claude (DR S136, 2026-06-16).
**Event Gate:** DESIGN (pipeline architecture) + MERGE (skill + worker code).
**Risk Labels:** AGENT BEHAVIOR (worker/skill behavior propagating to all future sessions), ARCHITECTURE (poll/recovery contract spanning skill ↔ worker). No SECURITY/DATA/PRIVACY.
**Severity:** NORMAL.
**Provenance:** S135 run-3 (`fdd367c7`) cap-failed at 90 min on a done-but-stale video poll; recovered manually. Memories: `feedback_studio_video_poll_pinned_task_stall`, `feedback_source_import_gap_perplexity_urls`.

---

## Bug 1 — Studio video-poll pins task_id → stale status → 90-min cap-fail

### Root cause (confirmed in source)
The in-pipeline Studio poll lives in `~/.claude/commands/research-compare.md` (the `claude -p` slash prompt), Python block at lines ~786–882. Per-product completion is decided by:

```python
done_ids = completed_artifact_ids(dl_type)   # {id: artifact} for status_id==3 of this type
is_done  = task_id in done_ids               # ← PINS to the exact submitted task_id
```

with a secondary `artifact poll <task_id>` signal that **lies `in_progress` even after the video renders** (documented S129). Download is always `download <type> -a <task_id>`.

Two ways this stalls to the 90-min `MAX_JOB_DURATION_MS` cap (`executor.ts:1561`, 5,400,000 ms):
1. **ID mismatch.** If the artifact that actually completes carries a different id than the submitted `task_id` (or the submit-returned id is not the artifact-list id), `task_id in done_ids` is never true → `artifact poll` returns stale `in_progress` forever.
2. **List failure swallowed.** `completed_artifact_ids` wraps the whole `artifact list --type <T> --json` call in `try/except → return {}`. Any CLI failure (e.g. Bug 26 cp1252 crash on emoji titles, transient error) silently yields `{}`, so `is_done` is permanently False and the loop falls back to the lying poll.

Either way the loop never marks the video done, never downloads, and because it waits for **all 5** products to read complete, the job runs to the 90-min cap and `claude -p` is SIGTERM-killed (exit≠0).

### Why the worker backstop did NOT save run-3 (coverage boundary)
`agent/lib/studio-completeness.ts` already implements the correct robust resolution (newest-completed of the type, filtered to `created_at >= run-start` floor, downloaded by the *resolved* id, runtime unbounded by the cap). **But** `executor.ts` lines 78–83 document the boundary explicitly: the gate runs **only on the claude exit-0 success path**. A `MAX_JOB_DURATION` cap-kill is exit≠0 → the job fails at the exit-code check *above* the gate → the gate never runs → no recovery. The executor comment itself defers the cure to "the in-pipeline detection fix (research-compare.md poll …)".

### Fix (two layers; ship both)

**Layer 1 — PRIMARY: re-alias the poll id at submit; keep per-attempt pinning (skill prompt).**
*(REVISED post-Gemini CRITICAL-1 — the original "newest-completed ≥ run_floor, abandon task_id" had an intra-run v2-regeneration race: on a same-run retry, a completed v1 satisfies `created_at >= run_floor` and the loop resolves v1, aborting the wait for the still-rendering v2, silently overwriting it. A time-floor isolates only against PREVIOUS jobs, not previous attempts in the SAME job. So we must NOT abandon per-attempt pinning.)*

Root of the S135 stall is an **id alias**: the submit-returned task_id is not the id that `artifact list --type <T>` surfaces for completion (or list errors were swallowed). Fix the alias instead of dropping pinning:

- **Re-alias at each (re)submit.** Immediately AFTER submitting a product generation, capture the id of the newest artifact of that type from `artifact list --type <T> --json` (the just-submitted attempt = the newest, typically `in_progress`). Persist THAT list-canonical id as the product's `poll_id` (replacing the submit-returned id). On a v2+ regeneration within the run, re-capture → `poll_id` advances to the new attempt. This keeps detection **per-attempt** (no v1/v2 race) AND alias-correct (we poll the id the list actually reports).
- Per cycle: `is_done = poll_id in completed_ids(dl_type)`. **Download by `-a <poll_id>`** — never bare `download <type>` (preserves the S31 "no default-latest" rule).
- `created_at >= run_floor_ms` stays ONLY as a cheap sanity assert when capturing `poll_id` (guards against capturing a stale prior-job artifact if the type list is empty of in-progress at capture time) — it is NOT the primary discriminator.
- Keep `artifact poll` ONLY as the auth-expiry detector (`AUTH_EXPIRED`), never as the completion signal (it lies `in_progress` post-render, S129).
- **Harden `completed_artifact_ids`:** distinguish "list returned, no completed yet" (empty set) from "list call ERRORED" (return a sentinel, not `{}`). On consecutive list errors for a product past a small threshold (e.g. 3), log a visible WARN to `phase_status` (today the error is swallowed into a permanent silent stall). Do NOT fall to bare `download <type>` — that reintroduces S31. Errors that persist to `max_p` time out the product (fail-closed), which the worker backstop then recovers.

This keeps the skill's completion contract consistent with `studio-completeness.ts` (id-pinned + `created_at` floor), differing only in that the skill re-aliases the id from the live list (the worker backstop already tolerates an absent submitted id by using its `created_at` floor on the post-`claude` recovery, where no v2 race exists because generation is finished).

**Layer 2 — DEFENSE-IN-DEPTH: run the completeness gate on the cap-kill path (worker).**
*(REVISED post-Gemini CRITICAL-2 — the prerequisite refactor below is MANDATORY, not optional. Today `executor.ts` uses a single shared `killAttempted` boolean for BOTH the `MAX_JOB_DURATION` kill AND the `MAX_JOB_COST_CENTS` kill (Excerpt 2, lines ~1587–1613). Without discriminating the reason, a rogue job killed by the COST circuit breaker whose artifacts happen to be on disk would be recovered and marked SUCCESS — a cost-safety bypass.)*

- **PREREQUISITE refactor:** replace the shared `killAttempted: boolean` with a typed `killReason: "NONE" | "DURATION" | "COST"`. The duration branch sets `"DURATION"`, the cost branch sets `"COST"`. (Terminal-error classifications — credit/auth/billing/model — are already a separate path and stay fail-fast.)
- **Recovery eligibility is `killReason === "DURATION"` ONLY.** `"COST"` and every terminal-error kill remain hard failures and MUST bypass the recovery gate.
- On a `"DURATION"` kill: if `state.json` on disk carries a `notebook_id`, run `enforceStudioCompleteness` (cap-unbounded). Recover-all → upload + `completeJob` as success **with an explicit log line preserving the "recovered cap-kill" telemetry** (so "pipeline too slow" is never silently lost). Any unrecoverable → `failJob` as today.
- Reuse the existing `verdict.state` parse if available; otherwise re-read `state.json` from the working dir. If `notebook_id` is absent, skip (cannot recover) and fail as today.

### Layer-1 vs Layer-2 ordering & risk
Layer 1 is the low-risk primary (prompt/script change, no new worker control flow) and directly prevents the failure. Layer 2 is a worker control-flow change (higher blast radius: it converts a class of hard-fails into successes) and must be gated carefully on the exact kill reason. **Recommendation: ship Layer 1 now; ship Layer 2 in the same gate but flag it for Codex's grounded pass on the kill-reason discrimination.**

---

## Bug 2 — Source-import gap (Perplexity 0 URLs + NLM-discovered sources never imported)

### Root cause (confirmed in source)
`research-compare.md` Phase 1 step 5–6 (lines ~392–393): the skill writes the Perplexity MCP **response text** to `perplexity.md`, then extracts citation URLs by **regex over that text** (`https?://[^\s\)]+`). `perplexity_research` (Sonar deep-research) returns its source URLs primarily in a **structured field** (`citations` / `search_results`), with the text body carrying only inline `[1][2]` markers. When the text body has no appended URL list — as in run-3 — the regex finds **zero URLs**, so Tier-1 scoring (Step D) and the NLM `source add` step (Step E, lines ~425–427) get nothing. Net: the notebook holds only the 2 attachments + NLM's 3 self-generations; the external-source layer is silently lost (run-1 had 23).

Separately, NLM deep research **discovers its own ~25 sources**, but the pipeline never harvests them back as notebook `source add` entries — they live only inside NLM's generated report.

This is NOT a correctness blocker (core deal numbers come from the inline GROUND-TRUTH brief, so run-3 still verified clean), but it degrades **citation depth / authority** of the Studio media.

### Fix (Prong A + C; Prong B dropped post-Gemini)

**Prong A — capture Perplexity structured citations (skill).** In Phase 1, do not rely on regex-over-text alone. Capture the `perplexity_research` tool result's structured citation array (`citations` and/or `search_results[].url`), de-duplicate against URLs already parsed from the text, and append a canonical `## Sources` URL list to `perplexity.md`. Feed that union into Tier-1 scoring (Step C/D). Add a state field `perplexity_source_urls_captured: N` and **log a WARN when N == 0** so a silent zero is visible in `phase_status` (today it passes invisibly).

**Prong B — DROPPED (post-Gemini MAJOR).** The NotebookLM CLI does not expose NLM's internal *discovered* sources from a deep-research pass in any machine-readable form. Instructing the skill to harvest them would induce the LLM to hallucinate non-existent CLI commands → pipeline command-execution failures. Prong B is removed from scope; NLM-discovered-source enrichment is a documented limitation, addressed operationally via Prong C (`additionalUrls`).

**Prong C — no-code stopgap for the immediate comparison run (`additionalUrls`).** The form's `additionalUrls[]` field already flows to step 13 upload (CI-exempt, user-curated). For the S136 comparison run, the user supplies curated source URLs via `additionalUrls`; no code path is required to get a richer-sourced A/B candidate tonight. Prongs A+B make this systematic for future runs.

### Telemetry / fail-visibility
Add a soft signal (NOT a hard block): if a run completes with `perplexity_source_urls_captured == 0` AND `additionalUrls` empty AND not a reuse of a well-sourced notebook, write `phase_status` note `"WARN: external-source layer empty"`. This is a non-publish quality signal, not a gate — it must not fail the job.

---

## Codex grounded-adversarial pass — verdict & integration (round 2, on v2)
Verdict: **BLOCK** (2 CRITICAL + 3 MAJOR + 1 MINOR), all integrated into v3 below. Codex read the shipped files and **overturned Gemini's Q3**.

- **CRITICAL-A — Prong A unsound vs the real MCP:** the official `@perplexity-ai/mcp-server` does NOT surface raw `citations`/`search_results` to the prompt; it appends them as TEXT in the response string / `structuredContent.response` (`research-compare.md:391-393` warning is still accurate). **v3 Prong A:** write the FULL `structuredContent.response` (not a truncated field) to `perplexity.md`, parse URLs from the appended citation text, WARN on zero. Direct Sonar-API call is the higher-fidelity option but OUT OF SCOPE (adds a metered dependency). Gemini's "read the structured array" is WRONG for this MCP.
- **CRITICAL-B — Layer 1 "newest after submit" unsafe:** the NLM CLI does NOT sort `artifact list` (emits API order); the worker sorts itself (`studio-completeness.ts:405-411`). "Grab newest" + `created_at` floor is too weak (same-run v1 or another same-type artifact passes the floor). **v3 Layer 1: SNAPSHOT-DIFF** (below).
- **MAJOR — stronger alias algorithm:** pre-submit ID snapshot → submit → poll `artifact list --type <T> --json` until EXACTLY ONE new id appears for that type since submit; 0 or >1 = ambiguous → fail closed / mark alias-capture-failed. Include pending/processing/completed during capture (not just completed). Persist `poll_id` into `state.artifacts[product]` — the same path the worker reads at `studio-completeness.ts:211-221` (bonus: tightens the backstop's `expectedArtifactId`).
- **MAJOR — Layer 2 not merge-ready:** `waitForProcess` returns only a number, `killAttempted` local (`executor.ts:1556-1628`); nonzero-exit branch (`656-687`) precedes completeness (`761-805`, exit-0 only). **v3 Layer 2:** `waitForProcess` returns `{code, killReason}`; recovery requires `killReason==="DURATION"` AND terminal-error-class is NONE (classify terminal errors FIRST — a duration kill that already emitted auth/credit/billing/model must NOT recover); cost-cap stays fail-fast (separate branch `1587-1613`), asserted. Extract a PURE `shouldRecoverAfterDurationKill(killReason, terminalClass, hasNotebookId)` helper so the cost-bypass guard is unit-testable without the private `estimateInFlightCostCents`/`waitForProcess`/`spawnClaude` internals.
- **MAJOR — Layer 1 covers ALL 5 products** uniformly (`research-compare.md:777-800`; slides type = `slide-deck`), not just video — the alias/list race is type-agnostic.
- **MINOR — list-error sentinel:** `completed_artifact_ids` must return a sentinel (mirror the worker's `null` at `studio-completeness.ts:385-416`), NOT `{}`, so "list errored" ≠ "nothing completed yet."

### v3 Layer 1 — SNAPSHOT-DIFF alias capture (supersedes the v2 re-alias)
Per product, at submit time:
1. `before = set(ids of ALL artifacts of type <T>)` (any status) via `artifact list --type <T> --json`.
2. Submit the generation.
3. Poll `artifact list --type <T> --json`; `new = current_ids - before`.
   - `len(new)==1` → that id is `poll_id`. Persist to `state.artifacts[<product>] = {task_id: poll_id}`.
   - `len(new)==0` → not surfaced yet; keep polling up to a bounded capture window.
   - `len(new)>1` → AMBIGUOUS → mark `alias_capture_failed`, fall back to the worker backstop (do NOT guess).
4. Completion: `is_done = poll_id in completed_ids(<T>)`. Download `-a <poll_id>`. This is per-attempt (no v1/v2 race) and alias-correct (the id the list actually reports).

### v3 Layer 2 — pure decision helper
```
shouldRecoverAfterDurationKill(killReason, terminalClass, hasNotebookId):
  return killReason === "DURATION" && terminalClass === "NONE" && hasNotebookId
```
Unit-test this directly (DURATION+NONE+nb → true; COST → false; DURATION+auth-out → false; no-nb → false). The executor wires `waitForProcess(): {code, killReason}` and calls the helper before invoking `enforceStudioCompleteness` on the kill path.

## Gemini holistic-adversarial pass — verdict & integration (round 1)
Verdict: **BLOCK** (2 CRITICAL + 1 MAJOR), all integrated into v2 above:
- **CRITICAL-1 (Layer 1 v2-regen race):** integrated — Layer 1 now RE-ALIASES the poll id from the live `artifact list` at each (re)submit and keeps per-attempt id pinning; `created_at` floor demoted to a capture-time sanity assert. No newest-completed abandonment.
- **CRITICAL-2 (Layer 2 cost-cap bypass):** integrated — Layer 2 now mandates a `killAttempted boolean → killReason enum` refactor; only `"DURATION"` is recovery-eligible; `"COST"` + terminal-error stay hard-fail.
- **MAJOR (Prong B infeasible):** integrated — Prong B dropped (NLM CLI exposes no machine-readable discovered sources).
- **Q3 confirmed:** Perplexity MCP exposes `citations`/`search_results` in the structured tool return → Prong A sound.

## Open items for Codex grounded-adversarial pass (round 2, on this v2)
1. **Layer 1 re-alias mechanics:** is "newest artifact of type `<T>` immediately after submit" a SAFE way to capture the attempt's list-canonical id? Race window: could a concurrent/older in-progress artifact of the same type be newest at capture time? Verify against the NLM CLI's `artifact list` ordering + `created_at` semantics. Is there a v2-submit ordering where re-alias captures the wrong attempt?
2. **Layer 2 kill-reason refactor:** grounded read of `executor.ts` ~1561–1613 + the exit-code check ~750s — is `killReason` cleanly threadable to the post-exit branch, and are cost-cap + terminal-error paths provably excluded from recovery? Confirm the cost-cap test (mock `estimateInFlightCostCents` → instant high → assert `killReason==="COST"` and `enforceStudioCompleteness` NEVER called).
3. **Prong A:** grounded confirmation of the exact `perplexity_research` MCP return field names the skill must read (`citations` vs `search_results[].url`), so the skill instruction names the right keys.
4. **Within-artifact blindspot:** does Layer 1's re-alias need to apply to ALL 5 products uniformly, or only video? (Same stall class could hit any product.)

## Test plan
- **Layer 2 (worker):** unit tests via `studio-completeness.ts` injectable deps + the new `killReason`: (a) `"DURATION"` + recover-all → complete; (b) `"DURATION"` + partial → fail-closed; (c) `"COST"` → `enforceStudioCompleteness` NEVER called, job fails (the Gemini-prescribed cost-bypass guard test).
- **Layer 1 (skill):** no unit harness; validate live on the S136 comparison run. Assert the poll logs `re-aliased <product> poll_id <list-id>` at submit and no product stalls to `max_p`.
- **Bug2 Prong A:** on the comparison run, assert `perplexity_source_urls_captured > 0` (or a truthful WARN) and that `perplexity.md` carries a `## Sources` list.
