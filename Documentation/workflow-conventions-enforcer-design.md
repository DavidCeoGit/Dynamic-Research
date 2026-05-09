# Workflow Conventions Enforcer — Design Sketch (S30)

**Status:** Design only — no implementation yet.
**Author:** S30 (2026-05-09).
**Background:** `feedback_workflow_drift_layer_3_gap.md` in memory.
**Owner module (when implemented):** `agent/lib/workflow-conventions.ts` (+ `.py` mirror).

---

## Problem

We have three persistence layers for "how the pipeline should behave":

| Layer | Lives in | What it captures | What it enforces |
|---|---|---|---|
| 1. Memory | `~/.claude/projects/.../memory/` + `MEMORY.md` | session-bridging facts | nothing — Claude reads them at session-init |
| 2. Data conventions | `agent/lib/conventions.{json,ts,py}` | filename patterns, skip rules | mechanically — every consumer imports + lint script gates |
| 3. Workflow | `~/.claude/commands/research-compare.md` (~1010 lines) | pipeline phase logic | only what the prompt instructs, no second source |

S28 fixed naming drift in layer 2 by introducing the conventions module. **The same fix is needed for layer 3.**

### Concrete symptoms (S29 evidence)

- **Bug 39 wave-2** (post-Studio source import) was *documented* in S28 memory but not encoded in the slash command. It recurred in S29 (47 cam AI sources sat unimported).
- **Duplicate notebooks per topic** — pipeline always created fresh; no find-or-create logic. cam AI 2x, Gunderson 2x. Quality regressed when Studio products generated against under-sourced fresh notebook (`cd3c290b`, 14 sources) instead of well-sourced original (`eb59f3cf`, 67 sources).
- **Tool sprawl** — S27 shipped `finalize-recovered-run.ts`, S28 shipped `rename-and-finalize.ts`, S29 picked the wrong one and produced 5 noise + 32 wrongly-named files in Supabase (manually cleaned).

These three are workflow drift, not data drift. Conventions module can't catch them because they live in the prompt, not the filenames.

---

## Solution shape

A small declarative module that the pipeline must call at each phase boundary and that returns a go/no-go decision plus remediation steps.

```ts
// agent/lib/workflow-conventions.ts
import { isSkipFile, classifyFile } from "./conventions.js";

export interface PhaseCheckResult {
  ok: boolean;
  phase: string;
  remediation: string[];   // empty when ok=true
  warnings: string[];      // non-blocking advisories
  context?: Record<string, unknown>;  // free-form data the caller may use
}

export type PhaseCheck = (ctx: PipelineContext) => Promise<PhaseCheckResult>;

export const PHASE_CHECKS: Record<string, PhaseCheck> = {
  "phase-0-find-or-create-notebook":   findOrCreateNotebookCheck,
  "phase-3-research-source-import":    researchSourceImportCheck,
  "phase-5.5b-post-studio-reconcile":  postStudioReconcileCheck,
  "phase-7-lint-gate":                 lintDeliverablesCheck,
};
```

`PipelineContext` carries everything a check needs to run: workdir, slug, topic, NLM client handle, state.json contents, etc. Each check is async, idempotent, and returns a structured result the slash command (or any caller) can act on.

---

## Phase-by-phase contracts

### Phase 0 — Find-or-Create Notebook

**Rule:** Before creating a fresh notebook, search existing ones for a title match (`Research: <topic>`, case-insensitive). If found AND owned by current user, reuse and skip duplicate creation.

**Input context:** `{ topic: string }`
**Output context:** `{ notebookId: string, source: "reused" | "created", reusedFromId?: string, sourceCount: number }`
**Remediation when ok=false:**
- "Multiple matches found — operator must pick one. Candidates: [list with source counts]."
- "NLM list call failed — re-auth via `notebooklm login` and retry."

**Why:** S29 cam AI 2x, Gunderson 2x. Studio products generated against under-sourced fresh notebook regressed quality.

### Phase 3 — Research Source Import

**Rule:** After deep research completes, import all `research status` sources that aren't already in the notebook. Wait 60s for processing. THEN proceed to Phase 5.

**Input context:** `{ notebookId: string }`
**Output context:** `{ discovered: number, alreadyPresent: number, imported: number, failed: number, capacityRemaining: number }`
**Remediation when ok=false:**
- "Auth expired during import — re-auth + resume from URL X of N."
- "Capacity exceeded (300-source limit) — N sources skipped. Operator decision needed."

### Phase 5.5b — Post-Studio Source Reconcile

**Rule:** After Studio products download, NLM may have surfaced additional sources during artifact creation. Re-run the research-source import to pick them up. (Bug 39 wave-2 from S29.)

**Input context:** `{ notebookId: string, preStudioSourceCount: number }`
**Output context:** `{ postStudioSourceCount: number, newlyImported: number }`
**Remediation when ok=false:**
- "N new sources couldn't be imported — list URLs for manual review."

### Phase 7 — Lint Gate

**Rule:** Run `lint-deliverables.ts <workdir> --strict`. Pipeline cannot reach `phase: "Complete"` if lint reports errors.

**Input context:** `{ workdir: string }`
**Output context:** `{ violations: number, warnings: number, classifications: Record<FileClass, number> }`
**Remediation when ok=false:**
- The lint script's own output (which lists each violation with file + reason).

---

## How the slash command integrates

Two paths considered:

### Path A — slash command calls each check explicitly

The prompt has a `## Phase 0 Pre-check` block that says:

> Before continuing, run:
> ```bash
> cd agent && node --import=tsx scripts/run-phase-check.ts phase-0-find-or-create-notebook \
>   --topic "$ARGUMENTS"
> ```
> If exit != 0, follow the remediation lines printed by the script. Do NOT proceed until ok=true.

**Pros:** Maximally explicit. Each check is a real binary the prompt invokes.
**Cons:** Adds 4 new bash blocks to a prompt that's already 1010 lines.

### Path B — workflow runner wraps the prompt

A new `agent/scripts/run-research-pipeline.ts` is the entrypoint. It executes the slash-command-equivalent logic but calls `PHASE_CHECKS[name](ctx)` at every boundary and refuses to advance unless `ok=true`. The slash command becomes a thin invoker.

**Pros:** Code-enforced — drift impossible.
**Cons:** Big refactor. The slash command's "interactive prompts to user" behavior would need a different shape (return value semantics, or pause-and-emit-question protocol).

**Recommendation:** Start with Path A — patch the slash command to explicitly call each check. Cheaper to ship, doesn't change the architecture, and proves the check module is correct before committing to a runtime rewrite. After 2-3 successful runs, revisit Path B.

---

## Implementation phases

1. **Skeleton (1 hr):** `agent/lib/workflow-conventions.ts` with the 4 checks as stubs that always return `ok: true` + an empty context. Full TypeScript types. `agent/scripts/run-phase-check.ts` CLI wrapper.

2. **Phase 7 lint check (30 min):** Real implementation — wrap `lint-deliverables.ts` and parse its output. **Lowest-risk first** — already a separate process today.

3. **Phase 0 find-or-create (1 hr):** Real implementation — wraps `notebooklm list --json` + filters + interactive prompt. Caller (the slash command) handles the "ask user which one" UX.

4. **Phase 3 + Phase 5.5b source import (1 hr):** Real implementation — extracts the `import_and_dedup.py` logic into `importResearchSources(notebookId)`. Both Phase 3 and Phase 5.5b call the same function.

5. **Slash-command patch (30 min):** Add 4 phase-check bash blocks to research-compare.md, one per check. **Note:** Phase 0 + Phase 7 already partially patched in S30 (find-or-create logic, lint gate). Bringing them under the workflow-conventions interface is the migration step.

6. **Smoke test (30 min):** Run the pipeline against a fresh small topic. Verify all 4 checks fire and report `ok=true`.

**Total:** ~4-5 hours from skeleton to first green run.

---

## Open questions

1. **Where do checks live language-wise?** TypeScript only (Node-side) or both TS + Python? The slash command often shells out to Python (NLM CLI is Python). A pure-TS implementation means Python helpers stay shell-driven. Recommendation: TS with a thin Python `run-phase-check` wrapper that calls back via stdout JSON.

2. **State persistence.** Each check produces a context dict. Where does it live between calls? Options: `state.json` (already used by pipeline), separate `phase-checks.json`, or no persistence (every check re-derives from filesystem + NLM). Recommendation: piggy-back on `state.json` — append a `phase_checks: { phase_name: PhaseCheckResult }` field.

3. **What about the 4-of-10 already-existing phases?** The current slash command has Phases 0, 0.5, 0.5b, 1, 1.5, 2, 3, 4, 5, 5.5, 5.5a, 5.5b, 6 — many more than the 4 enforcers. This proposal only covers the 4 highest-leverage drift points. Adding more later is incremental.

4. **Failure mode communication.** When a check returns `ok=false`, who reads the remediation? Today: Claude reads it from the slash-command output and acts. With Path B (workflow runner): the runner needs to either pause-and-prompt or hand off to a human-in-the-loop step. Path A keeps Claude in the driver's seat.

---

## Cross-references

- `feedback_workflow_drift_layer_3_gap.md` — the memory entry that motivated this design
- `agent/lib/conventions.{json,ts,py}` — the data-conventions module this mirrors
- `agent/scripts/lint-deliverables.ts` — already does Phase 7 work, will be wrapped
- `~/.claude/commands/research-compare.md` — Phase 0 D-1, Phase 5.5b D-2, Phase 7 D-3 patches landed in S30 inline (will migrate to phase-check calls when this module exists)
