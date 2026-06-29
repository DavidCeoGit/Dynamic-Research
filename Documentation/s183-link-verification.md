# S183 — Exhaustive Click-and-Verify Pass (LIVE DR app, Aira demo readiness)

**Date:** 2026-06-28 · **Session:** S183 (autonomous, user away) · **Prod:** https://dynamic-research.vercel.app
**Git:** main `2c997ee` (clean, no code touched) · **Tests:** 663 agent / 142 frontend, 0 fail · **Worker:** PID 26320, breaker CLOSED, queue empty
**Auth used:** admin-minted email OTP for `saw.guch@gmail.com` (no inbox needed) → authed in org **Aira** (`166ba70a…`)

## VERDICT: 🟢 GREEN — demo-ready

Every route, nav link, content tab, and all **14 deliverables** load (HTTP 200, correct content-types, no real console errors). Auth works end-to-end. Tenant isolation verified (aira session cannot reach the system-default run). The hide control is reversible and was tested on a throwaway that has been fully deleted. **No demo-blocking break found.** Six non-blocking display/data observations are listed at the bottom — the only one a viewer might notice is the run-detail CI chart header (#1).

The aira staged run is **untouched and intact** for Monday: 1 completed run, 14 storage objects, queue empty, dashboard shows exactly that one run (0 hidden).

---

## PASS/FAIL — Routes

| Route | HTTP | Console | Content verified | Result |
|---|---|---|---|---|
| `/login` | 200 | clean | "Send code" present, "Send magic link" gone; 2-step OTP form | ✅ PASS |
| `/` (dashboard) | 200 | clean | "Research Dashboard"; **aira-scoped** — shows ONLY the 1 aira run (14 files), not system-default runs | ✅ PASS |
| `/new` | 200 | clean | 5-step wizard (Topic→Refine→Products→Customize→Review); topic textarea (25k cap); file attach. **RENDER ONLY — not submitted** | ✅ PASS |
| `/runs/<aira-slug>` | 200 | clean | Full metadata, CI chart, 4 content tabs, stats, output-file list | ✅ PASS |
| `/runs/<aira-slug>/gallery` | 200 | clean | Media Gallery — 8 items categorized (5 docs, audio, infographic, slides) | ✅ PASS |
| `/no-org` | 200 | clean | "Account not provisioned… contact the workspace owner" + Sign out (what an un-provisioned Aira user would see — graceful) | ✅ PASS |
| `/new?clone=<aira-slug>` | 200 | clean | "Clone & Edit"; topic textarea pre-filled from the run (127 chars) | ✅ PASS |

## PASS/FAIL — Nav links & controls

| Element | Behavior | Result |
|---|---|---|
| "Dynamic AI Research" logo (every page) | → `/` (clicked, navigates) | ✅ PASS |
| "New Research" nav link (every page) | → `/new` | ✅ PASS |
| "Media Gallery" link (run detail) | → `/runs/<slug>/gallery` | ✅ PASS |
| "Clone & Edit" link (run detail) | → `/new?clone=<slug>`, pre-fills form | ✅ PASS |
| Content tabs: Final Synthesis / Perplexity / NotebookLM / Claude | All switch + render distinct real content (e.g. Perplexity: 12 passed source URLs; NotebookLM: Notebook ID `cda8e990…`) | ✅ PASS |
| **Replay** button | Renders w/ cost tooltip ("~$5-15, ~30-90 min"). **NOT clicked** (fires real run) — render-only per boundary | ✅ RENDER-ONLY |
| **Hide run / Hide all / Show hidden / Unhide** | Full reversible round-trip verified on a throwaway (see below) | ✅ PASS |
| Refresh button | Renders | ✅ PASS |
| Sign out (`/no-org`) | Renders. **NOT clicked** (would end my session) | ✅ RENDER-ONLY |

## PASS/FAIL — 14 deliverables (via the exact session-scoped proxy `/api/runs/<slug>/file/<name>`)

All fetched from inside the authenticated page context (carries session cookie). All **HTTP 200** with correct content-types:

| # | File | Type | Result |
|---|---|---|---|
| 1 | …slides.pdf | application/pdf (4.27 MB) | ✅ 200 |
| 2 | …infographic.png | image/png (4.69 MB) | ✅ 200 |
| 3 | …report.docx | wordprocessingml (18 KB) | ✅ 200 |
| 4 | …report.md | text/markdown | ✅ 200 |
| 5 | …audio.mp3 | audio/mpeg (38.9 MB) | ✅ 200 |
| 6 | …brief.docx | wordprocessingml | ✅ 200 |
| 7 | …brief.md | text/markdown | ✅ 200 |
| 8 | …comparison.docx | wordprocessingml | ✅ 200 |
| 9 | …comparison.md | text/markdown | ✅ 200 |
| 10 | …notebooklm.docx | wordprocessingml | ✅ 200 |
| 11 | …notebooklm.md | text/markdown | ✅ 200 |
| 12 | …perplexity.docx | wordprocessingml | ✅ 200 |
| 13 | …perplexity.md | text/markdown | ✅ 200 |
| 14 | …state.json | application/json | ✅ 200 |

Plus: inline markdown viewer renders the **full brief.md content** (real research — 2026 enterprise AI automation landscape); Download buttons resolve to the `.docx` (`?download=1`). Supporting APIs `/api/runs/<slug>/files`, `/manifest`, `/api/state?slug=` all 200.

## PASS/FAIL — Security / tenant isolation (bonus)

| Probe (as the aira session) | Expected | Actual | Result |
|---|---|---|---|
| Dashboard run list | Only aira's runs | 1 run (aira), system-default runs NOT visible | ✅ ISOLATED |
| `GET /api/state?slug=<system-default slug>` | blocked | **404** "No state.json found" | ✅ ISOLATED |
| `GET /api/runs/<system-default slug>/file/<name>` | blocked | **404** | ✅ ISOLATED |
| `GET /api/runs/<system-default slug>/files` | blocked | **404** "Project not found" | ✅ ISOLATED |

Confirms the session-derived `<orgId>/<slug>/<file>` prefix boundary: a foreign slug resolves under the caller's own org prefix → 404. Cross-org read is structurally impossible.

## Hide control — reversible round-trip (on a THROWAWAY, then deleted)

1. Created throwaway run in aira (DB row `207f72da…` + 1 storage `…-state.json`, slug `zzz-s183-throwaway-hide-test-…`). Dashboard then showed **2 runs**.
2. Clicked the **throwaway's** "Hide run from my view" → it vanished; aira run stayed; `hiddenCount: 1`; "Show hidden (1)" appeared. ✅
3. "Show hidden" → throwaway reappeared with an "Unhide run" restore control. ✅
4. "Unhide run" → throwaway restored to normal; `hiddenCount: 0`; both runs visible. ✅ (fully reversible — backed by `user_hidden_runs`, org-scoped)
5. **Full cleanup**: deleted the throwaway's storage object + `research_queue` row + `user_hidden_runs` row.
6. **Verified final state**: aira org has exactly ONE storage folder (the real run), 14 objects intact, queue empty, `/api/runs` returns 1 run / 0 hidden, dashboard shows only the aira run. ✅ The aira run was never touched.

---

## Observations (non-blocking — PARK; do NOT fix under Monday freeze)

> All are display/data artifacts on the **cloned** run. None breaks a route, link, deliverable, or auth. Listed worst-visible first.

1. **Run-detail "Tier 1 — URL Confidence Scores" header misrenders as "0 passed / 5 rejected."** The real CI data in `state.json` is correct — `tier1_scores` = **54 URLs total, 13 passed, 41 rejected, 12 added to notebook** (gate: SourceCredibility≥18, no social/UGC) — and the Perplexity tab correctly shows "12 passed / 0 rejected." So the underlying numbers and the demo story (the S180 "41/54 rejected" CI-filter differentiator) are intact; only the run-detail summary header shows wrong counts. **This is the one wart a viewer could notice.** Recommendation: demo via the **Media Gallery + deliverables** (flawless) and, if showing the run-detail page, narrate CI from the **brief's** methodology section (correct) rather than the chart header. (Likely a clone-specific display issue; can't confirm against a fresh run since only aira's run is reachable from this session.)
2. **"Artifacts Completed 0/4"** on the run-detail stats despite Complete status + 14 files — the cloned state's `artifacts` field isn't populated; cosmetic.
3. **Counter mismatch: "Files Written 9" (run detail) vs "14 files" (dashboard).** 9 = `files_written` the pipeline tracked (.md + studio); 14 = actual storage objects (adds the 5 `.docx`). Both are internally consistent for their source; just two different counters.
4. **Polling chatter on a completed/idle run:** run-detail fires ~10 repeated `/api/state` calls; dashboard polls `/api/queue` every 5 s. All 200 — wasteful, not broken.
5. **Malformed/nonexistent filename to the file proxy returns 500, not 404.** Observed only via a synthetic test fetch I issued (`…/file/the-2026-competitive-landscape-of-enterp-` with a truncated name); **not reachable through any UI flow** (the UI only requests real filenames). Minor hardening note for later.
6. **Cloned storage filenames retain the source run's slug `…8202437f`** (the clone copied objects as-is into the new `…a1a40001` folder). The folder/prefix is the new slug, so everything resolves; display labels just carry the old stem. Cosmetic.

## Demo posture (Monday, Brad ~06-29, Aira-only, FROZEN)

- Brad logs in single-org → sees ONLY aira → the 1 completed run + 14 deliverables. Confirmed live this session. Fallback also exists in system-default.
- Strongest demo surface: **Media Gallery** (8 deliverables, all open) + the inline **markdown viewer** (full research renders) + the **3-source content tabs** (Perplexity/NotebookLM/Claude with real CI data). All flawless.
- Avoid dwelling on the run-detail top CI chart header (observation #1).
- **OPEN question for the user:** does Brad drive Monday (READY now), or do Aira's CEO/CTO log into their OWN accounts? (If the latter, they must be provisioned into the `aira` org first — they are not members yet; only brad `1081c1e0` + saw.guch `591d2ba8` are.)
