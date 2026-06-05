# Path B — Deferred Reframing Option for CAM AI Report (S35)

**Status:** Deferred (Path A chosen for current ship). Re-evaluate after Path A delivery.
**Author:** S35 (2026-05-11).
**Trigger to revisit:** If Path A's "mandate-in-effect, accelerate operational compliance" framing reads stale or insufficient when AES leadership reviews — OR if a new regulatory milestone surfaces that better anchors strategic urgency.

---

## Path A (chosen, in flight)

Surgical reframe of the existing CAM AI report. Acknowledges that DWC Section 55.1 mandate took effect April 1, 2026, and is now in active enforcement. Preserves 98% of the report's strategic narrative — only the tense/posture changes from "must hit upcoming deadline" to "mandate is in effect, every day of legacy operation carries compliance risk."

**Edits surface:** ~8 lines in u9el's current `strategic-erp-modernization-report-arrowhead-evaluation-serv-20260509-175031-report-v2.md`. Pandoc re-export PDF + DOCX. Upload as v3 of report. Note the local `Projects/cam-ai-program-applications-in-the-quick-420h/*-report.md` is the older 17:07 generation, not the current 17:50 v2 — must edit the downloaded live copy, not the stale local copy.

**Why Path A wins for ship-now:** preserves the existing research, narrative arc, and recommendations. No new LLM call, no new sources, no risk of regression. ~15 minutes to ship.

---

## Path B (deferred — recorded so we don't lose it)

**Pivot to next regulatory milestone.** Reframe the report's strategic urgency around the *next* concrete deadline AES must hit, rather than the now-past April 1, 2026 mandate. Treats the April mandate as accomplished context, not driving urgency.

### What Path B would require

1. **New research call** — Perplexity / NLM follow-up to identify what comes after DWC Section 55.1 effective April 1, 2026. Candidates from existing research:
   - May 2026 DWC office/exam rules (mentioned at report L17 + L79 — already in force per today's date 2026-05-11)
   - 3-year report writing certificate expirations (mentioned at report L68 — rolling)
   - ISO 42001 certification milestones (mentioned in comparison.md as a 2026 target)
   - Q4 2026 GCP architecture targets (mentioned in roadmap)
   - Anything 2027+ on the regulatory horizon (would need Perplexity to surface)

2. **Restructure narrative arc** — current arc: "April deadline → refactor → long-term." Path B arc: "April mandate accomplished/baseline → [next milestone] → long-term." Requires more than line edits — section restructuring.

3. **Confirm AES's actual current compliance state** — Path B's credibility depends on accurately positioning where AES is RIGHT NOW relative to DWC 55.1. If AES is fully compliant: Path B reads strong. If AES is in a compliance gap: Path B understates urgency and Path A is the honest framing.

### Why Path B is deferred (not rejected)

- **Time cost:** 1-2 hours minimum (new research + section restructuring + NLM Studio regen of multiple products to match new framing)
- **Information dependency:** Need AES's actual current compliance posture, which user hasn't confirmed
- **Risk:** A more invasive rewrite is more likely to introduce regressions in the 98% of content that's currently good
- **Reversibility:** Path A's surgical reframing doesn't prevent Path B later. Path B can be the v5 if v4 reads stale.

### When to revisit

- After Path A's v4 lands and AES reviews it — if feedback is "this still feels like we're chasing a passed deadline," pivot to Path B.
- If a new regulatory milestone surfaces in the news cycle that demands repositioning.
- If AES leadership wants the report repositioned for a different audience (e.g., investors vs. operational team).

### Cross-references

- `feedback_date_awareness_in_pipeline.md` — S31 root cause for why this drift happened
- `Documentation/multi-tenancy-and-prompt-enhancement-design.md` §3.4 — date-context.ts helper pattern that prevents future occurrence
- u9el gallery: https://dynamic-research.vercel.app/runs/cam-ai-program-applications-in-the-quick-u9el/gallery
- Notebook (shared with 420h workdir): `1ebb1d25-696e-4e45-b03c-bce359f3812d`
