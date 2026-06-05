# Multi-Reviewer Policy Framework

**Status:** v2 (replaces v1 6-tier framework, archived at `sandbox/rejected/multi-reviewer-policy-framework-v1-superseded.md`)
**Authored:** 2026-05-17 (S44)
**Canonical source of truth:** `~/CLAUDE.md` "Multi-Reviewer Policy Framework" section. This document is the long-form rationale + reference; `~/CLAUDE.md` is what governs runtime behavior.
**Peer review:** v1 reviewed by Gemini 2.5 Pro + Codex GPT-5.5 in S43; both rejected the 6-tier shape and independently proposed the orthogonal decomposition adopted here. Synthesis at `Documentation/multi-reviewer-policy-framework-peer-review.md`. **v2 does not require an additional peer-review pass** — the synthesis already validates this direction.

---

## 1. Purpose

Define when work in this project requires multi-model peer review (Gemini + Codex in addition to Claude), what risks each review must address, what artifact must be produced, and how disagreements are resolved.

The framework optimizes for one question: **what bad outcome are we trying to prevent?** — not "what category does this work belong to?"

## 2. Shape

The framework is two orthogonal axes plus a severity dimension:

- **Event Gate** — *when* the review fires (mandatory enforcement point in the workflow)
- **Risk Label** — *what* the review must address (multi-select; defined by consequence questions, never by file path)
- **Severity Mode** — *how* much process applies given urgency (normal / urgent / emergency break-glass)

A piece of work is classified by: (1) which gate it crosses, (2) which risk labels apply, (3) what severity mode is in effect.

---

## 3. Event Gates (3)

Mandatory enforcement points. Every applicable piece of work must clear the relevant gate.

| Gate | Fires when | Default reviewers | Artifact location |
|---|---|---|---|
| **DESIGN** | Architectural docs, multi-day initiatives, irreversible product/infra/security decisions, schema designs, new subsystems | Gemini + Codex (mandatory regardless of labels) | Standalone companion file next to the design doc: `<doc>-peer-review.md` |
| **MERGE** | Any code, skill, config, or migration change being adopted into the working tree | Depends on Risk Labels (§4) | PR/commit description for ordinary work; standalone file at `Documentation/<topic>-peer-review.md` for HIGH-RISK merges |
| **AUDIT** | Triggered by release cut, incident postmortem, major growth (>25% LOC since last audit), known drift, or recovery situation (e.g. S43 retroactive sweep) | Structured 3-phase program (inventory → per-module → cross-cutting) | Standalone punch list at `Documentation/code-review/<YYYY-MM-DD>-audit.md` |

**Out of scope for all gates:** single-file bug fixes within an established pattern, comment-only edits, trivial refactors, formatting, test additions within an existing module. These default to Claude-only review at the MERGE gate (see Risk Label `(no labels)`).

---

## 4. Risk Labels (8, multi-select)

Risk labels are defined by **consequence questions**, not file paths or directory categories. A change carries a label if any of its consequence questions answer "yes." Labels are multi-select; a single change can carry several.

| Label | Consequence question — "can this change…" | MERGE-gate default |
|---|---|---|
| **SECURITY** | …affect authentication, authorization, tenant isolation, secrets handling, privilege boundaries, prompt-injection surfaces, or remote execution? Can hostile input reach storage, execution, logs, prompts, or third-party services? | **Mandatory Gemini + Codex. Blocking semantics on CRITICAL findings** (§5) |
| **DATA** | …affect data integrity, run schema migrations, perform backfills, execute destructive operations, or be irreversible without backup restoration? | **Mandatory Gemini + Codex** |
| **AGENT BEHAVIOR** | …change skill triggers, tool permissions, command-execution surface, file-access scope, hook behavior, or auto-mode classifier rules? Can the change silently propagate to future agent sessions? | **Mandatory Gemini + Codex** |
| **PRIVACY** | …handle PII, change data retention, affect deletion/export/import flows, modify consent flows, or alter analytics collection? | **Mandatory Gemini + Codex** |
| **INFRA** | …modify CI/CD configs, deploy pipelines, env vars, cloud permissions, cron jobs, queue config, storage bucket policies, or IaC? | **Mandatory Gemini + Codex** |
| **DEPENDENCY** | …upgrade packages with runtime/security impact, add new libraries, modify build plugins, or change deployment images? | **Mandatory Gemini + Codex** |
| **ARCHITECTURE** | …design/modify schema, change cross-module boundaries, alter contracts between major subsystems, or refactor across ownership boundaries? | **Mandatory Gemini + Codex** |
| **(no labels)** | Routine bug fix within established pattern, UI tweak, comment-only edits, refactor within a single module, test additions | Claude-only review acceptable |

**Author self-classification:** The author runs through every consequence question before completing work. Reviewers cross-check. File count is a soft signal only; a 1-line auth bypass beats a 12-file rename for risk.

**Tests are a triggered concern, not a separate label.** Any review under SECURITY/DATA/AGENT BEHAVIOR/PRIVACY MUST explicitly answer: "is this change covered by automated tests, and if not, why?"

---

## 5. Severity Modes (3)

Replaces v1's missing break-glass path. Mandatory reviews without an urgency mode either block emergencies or train policy-ignoring; this matrix prevents both.

| Mode | When in effect | Procedure |
|---|---|---|
| **NORMAL** | Default for all reviewed work | Wait for both reviewers. Standard synthesis. |
| **URGENT** | Time-pressed production fix, urgent customer-facing patch, schema rollback under time pressure | One reviewer minimum + human written risk acceptance signed into the PR/commit message. Mandatory follow-up second-reviewer pass within 24h with synthesis. |
| **EMERGENCY** | Active security incident, data-loss-in-progress, production-down | Patch now if needed (skip review). Mandatory retrospective Gemini + Codex review within 24–48h. Post-mortem mandatory; learning fed back into framework. |

**Sign-off line format for URGENT/EMERGENCY** (recorded in commit message or PR body):

```
RISK-ACCEPTED-BY: <human-name> | mode=<URGENT|EMERGENCY> | reason=<short> | followup-due=<ISO date>
```

Bypass count is tracked in telemetry (§7).

---

## 6. Disagreement Procedure

| Situation | Resolution |
|---|---|
| Both reviewers agree on findings | Standard synthesis, proceed. |
| Reviewers disagree on a **non-security** finding | Synthesis records both positions + decision rationale. 4-hour wait window for author challenge; if challenged, human owner decides. No third-model tiebreaker by default. |
| Reviewer raises a **SECURITY-labeled CRITICAL** finding | **Blocking.** Do not merge until: (a) the finding is resolved in code, OR (b) the human owner records explicit risk acceptance with a signed sign-off line (same format as §5). No automatic third-model pass — explicit owner judgment required. (Rationale: a third pass risks shopping for a convenient answer.) |
| One reviewer offline / rate-limited | Try alternative endpoint (e.g., Gemini CLI fallback, web paste). If still unavailable >4h and work is NORMAL severity: proceed with one reviewer + recorded "operating under reduced review" note. If URGENT/EMERGENCY: severity mode handles it. |
| Manual Gemini Deep Think (web-only) escalation | Available for the human owner to invoke as a tiebreaker for high-stakes security findings, but **never automatically invoked** by Claude. The owner's judgment is the resolution, not a third model vote. |

---

## 7. Telemetry

Track per-review (rolling window):

- **Actionable-change rate** — did the review surface ≥1 change actually adopted?
- **False-positive rate** — review surfaced no actionable issue
- **Bypass count** — URGENT or EMERGENCY mode invocations
- **Review latency** — time from request to synthesis complete
- **Post-merge defects** in the touched risk-label area (detected within 30 days)

**Calibration rule:** After 8 weeks of data, any Risk Label with `false-positive-rate > 70%` AND `post-merge-defect-rate ≈ 0` is a candidate for downgrade (no longer mandatory at MERGE gate). The reverse is also true: a label with frequent post-merge defects in its area should be tightened, not softened.

---

## 8. Reviewer-Visibility Field (mandatory in every synthesis)

Every peer-review companion file MUST include a "What each reviewer saw" subsection identifying the context provided to each reviewer:
- Full repo / diff only / design doc only
- Tests included? / logs included? / threat model included?

This makes shared blind spots visible. (Adopted from Codex S43 critique — both reviewers having the same partial view is a hidden risk; the synthesis must make that explicit.)

---

## 9. Operationalization (Single Source of Truth)

**`~/CLAUDE.md`** is canonical. The "Multi-Reviewer Policy Framework" section there defines all gates, labels, severity modes, and procedures. This document is the long-form reference.

**No skill encodes policy.** Each affected skill gets a **thin compliance hook** with three obligations:

1. Before completion: classify touched work against the policy (which gate? which labels?).
2. If risk labels apply: produce or link the required review artifact.
3. **Do not duplicate** gate/label definitions in skill text — link to `~/CLAUDE.md`.

**Affected skills (v2 list):**

- **`/edit-skill`** — adds AGENT BEHAVIOR / ARCHITECTURE classification step before completing any skill edit; calls the compliance hook.
- **`/security-review`** — naturally a SECURITY-labeled review; uses Gemini + Codex by default with blocking semantics per §6.
- **`/end-session`** — checks whether session-touched files had required peer-review artifacts; warns if missing. Insufficient as the only enforcement (per Codex critique), but a useful backstop.

**Not currently in scope:**
- `/review` (7-dim health check) — can flag labels but doesn't replace MERGE-gate review.
- No new `/codebase-sweep` skill in v1. AUDIT gate is event-triggered and structured in §3; promotion to a standalone skill only if invoked ≥2× in 6 months.

---

## 10. Decision Provenance

This shape was not invented top-down. It emerged from peer review of a previous attempt (v1: 6-tier hierarchical framework T1–T6). Both Gemini 2.5 Pro and Codex GPT-5.5, with different reasoning baselines and no coordination, independently rejected the tier shape and proposed orthogonal decomposition. Codex framed the underlying problem sharply:

> "The policy optimizes for 'what category is this work?' instead of 'what bad outcome are we trying to prevent?' That will cause boundary fights and compliance theater."

Both reviewers also independently raised:
- No emergency bypass / break-glass path → §5 added.
- Distributed-policy drift across multiple skills → §9 single-source-of-truth pattern.
- "Define by consequence, not file category" → §4 consequence questions.
- File-count as a proxy for risk is broken → §4 reduced to soft signal.
- Standing quarterly obligation (v1 T6) is wasteful → §3 AUDIT becomes event-triggered.
- Reviewer disagreement procedure too weak, especially for security → §6 blocking semantics on SECURITY CRITICAL.

This convergence — different training data, different reasoning baselines, same fix — is the strongest validation of the HARD RULE itself (peer review at the design stage). Three consecutive synthesis cycles have shown Codex + Gemini complementarity is load-bearing. See `Documentation/multi-reviewer-policy-framework-peer-review.md` for the full agreement matrix.

---

## 11. Open Follow-Ups

| Item | Status | Trigger to revisit |
|---|---|---|
| `/ultrareview` integration | Deferred — currently user-triggered + billed, not Claude-invokable | If product changes to allow agent invocation |
| `policy-oracle` skill (single skill that classifies + dispatches reviews) | Deferred — Gemini's stronger proposal, lower-risk to start with thin hooks per Codex | Revisit if drift appears across skills after 8 weeks |
| Static-analysis automation (auto-detect SECURITY-label hotspots) | Deferred to its own tooling project | When manual self-classification miss rate becomes visible in telemetry |
| Cross-project portability | Currently scoped to Dynamic Research + GravityClaw | Carry to new projects only when patterns prove out |
| Web Gemini Deep Think escalation | Manual-only by human owner | Never automated |

---

## 12. Versioning

- **v1** (S42, 2026-05-16): 6-tier hierarchical framework T1–T6. Peer-reviewed S43, structurally rejected by both reviewers. Archived at `sandbox/rejected/multi-reviewer-policy-framework-v1-superseded.md`.
- **v2** (S44, 2026-05-17): This document. Event Gate × Risk Label × Severity Mode model.
- Future revisions: track at top of this file with date + S-tag + summary of structural change. Editorial revisions (typos, clarifications) do not require version bumps.
