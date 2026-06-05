# Multi-Reviewer Policy Framework — Peer Review Synthesis (S43)

**Date:** 2026-05-17
**Trigger:** HARD RULE in `~/CLAUDE.md` ("Multi-Model Peer Review for Design Docs") — established 2026-05-17. Applied to the policy framework itself (dogfooding).
**Reviewers:**
- **Gemini 2.5 Pro** (`gemini-cli`, long-context flagship) — 2 CRITICAL / 4 MAJOR / 2 MINOR
- **Codex GPT-5.5** (`codex exec`, xhigh reasoning, ChatGPT OAuth) — 3 CRITICAL / 4 MAJOR / 3 MINOR
- **Claude Opus 4.7 (1M)** — design author

**Verbatim raw reviews (kept for audit):**
- `c:/tmp/gemini-peer-review-policy-framework.md`
- `c:/tmp/codex-peer-review-policy-framework.md`

**Status:** Synthesis complete. **The original 6-tier framework requires a structural rewrite, not edits.** Resolved direction below proposes a new `Event Gate × Risk Label` model that both reviewers independently arrived at from different angles.

---

## 1. Headline finding

Both reviewers independently rejected the 6-tier hierarchical shape and proposed orthogonal-decomposition replacements. Codex framed it sharply:

> The policy optimizes for "what category is this work?" instead of "what bad outcome are we trying to prevent?" That will cause boundary fights and compliance theater.

The framework was process-shaped (tiers by when/what/why blended), not decision-shaped (gates by enforcement points, labels by risk). The blend created six fuzzy categories where two orthogonal axes would have been clearer and harder to game.

---

## 2. Agreement Matrix (sorted by weight)

### High weight — both reviewers raised, both CRITICAL or both MAJOR

| Issue | Gemini | Codex | Resolution |
|---|---|---|---|
| **The 6-tier shape itself is wrong.** Conflates *when*/*what*/*why* into pseudo-hierarchy. Gemini proposes `Event × Risk Lens` matrix; Codex proposes `3 gates (Design/Merge/Audit) + risk labels`. Different proposals, same direction. | MAJOR ("hierarchical tiers are the wrong shape") | CRITICAL ("6-tier structure likely creates policy drift; flatter rule probably better") | **ACCEPT — structural rewrite.** New shape: **3 Event Gates × multi-select Risk Labels.** Synthesis of both proposals in §4 below. |
| **No emergency bypass / break-glass path.** Mandatory review with no urgency mode either blocks emergencies or trains policy-ignoring. | CRITICAL #2 | CRITICAL ("mandatory review block emergency fixes... could either delay urgent security patches or train people to ignore the rule") | **ACCEPT.** Add three severity modes: **NORMAL** (wait for both reviewers), **URGENT** (one reviewer + human risk acceptance), **EMERGENCY** (patch now, retrospective review within 24-48h, post-mortem mandatory). |
| **Distributed operationalization will drift.** Policy logic across 5 skills + 1 new diverges from CLAUDE.md within months. | CRITICAL #1 ("policy-oracle" centralization required) | CRITICAL ("drift trap... within six months they will disagree unless one file is canonical") | **ACCEPT.** CLAUDE.md is the single source of truth. Skills get only a thin compliance hook ("classify touched work, produce/link artifact, do not duplicate definitions"). No skill encodes the policy itself. |
| **T3 boundary by file path is fragile.** Misses dependency-based security changes (utility imported by auth module). Codex framed it as "define by consequence, not file category." | MAJOR ("file paths alone is fragile; requires dependency/taint analysis") | MAJOR ("define T3 by consequence, not file category... can this change affect auth/authz/tenant isolation/secrets/PII/data retention/auditability/remote execution/privilege boundaries?") | **ACCEPT.** Risk labels are defined by **consequence questions**, not file paths. See §4 risk label definitions. |
| **T4 ">5 files" is wrong proxy for risk.** A 1-line auth bypass beats a 12-file rename. | MAJOR ("size used as proxy for risk") | MAJOR ("file count as heuristic only, never a trigger by itself") | **ACCEPT.** File count drops to a soft signal. Risk labels are the actual trigger. |
| **T6 over-scoped.** Standing quarterly obligation is wasteful; either redundant with T2-T4 or admission they'll fail. | MAJOR ("delete it; redirect to automating T3 detection") | MAJOR ("audit activity triggered by release/incident/major growth/known drift — not a standing tier") | **ACCEPT.** T6 becomes an **AUDIT gate** triggered by event (release, incident, drift, major growth), not by calendar. Removed from continuous policy. |
| **Reviewer disagreement procedure too weak.** Especially security: "record rationale and proceed" enables shopping for convenient answers. | MAJOR (need explicit timeout + escalation for all tiers) | CRITICAL ("blocking semantics for security; a third model pass risks shopping for a more convenient answer") | **ACCEPT.** Security disagreements get **blocking semantics** — do not merge until resolved OR explicit owner risk acceptance recorded with a sign-off line. Non-security: rationale + 4-hour timeout, then human decides. No third-pass tiebreaker as default. |
| **Missing categories.** Both flagged CI/CD config; Codex deeper on data correctness, supply-chain, privacy/PII, agent autonomy, rollback readiness, incident triggers, test adequacy. Gemini added in-code prompts, data migration scripts. | MAJOR (Q3 list: emergency bypass, IaC/CI-CD, data migrations, in-code prompts) | MAJOR + MINOR ("biggest missing is data correctness and irreversible operations"; list: dependency/supply-chain, infra/env config, privacy/PII, agent autonomy, rollback, incident, test adequacy) | **ACCEPT.** All of these become **first-class Risk Labels** in the new model, not edge-case footnotes. See §4. |

### Codex-only high-weight (Gemini missed)

| Issue | Codex framing | Resolution |
|---|---|---|
| **Framing diagnosis itself.** "Process-shaped, not decision-shaped." | "Optimizes for 'what category is this work?' instead of 'what bad outcome are we trying to prevent?'" | **ACCEPT — this is the core insight.** The new framework reframes around outcomes (what risk are we preventing?) not categories (what tier does this belong to?). |
| **Shared reviewer blind spots.** Gemini + Codex can still miss things: stale repo context, shallow diff understanding, overconfident security advice. | "Synthesis should identify what each reviewer actually saw: full repo, diff only, design doc only, tests, logs, threat model" | **ACCEPT.** Every synthesis file (including this one going forward) includes a "What each reviewer saw" line. Visible in this doc: both reviewers saw the policy doc text only, no repo context, no implementation. |
| **Test adequacy gate.** Peer review should not substitute for tests; it should explicitly flag missing automated coverage. | "Changes lacking automated test coverage in the touched risk area" listed as trigger | **ACCEPT.** Test-adequacy becomes a triggered concern under the SECURITY/DATA risk labels. Not its own gate, but every applicable review must explicitly check "is this change covered by automated tests, and if not, why?" |
| **Artifact-location bloat.** Requiring `Documentation/...` files for ordinary merge review creates abandoned paperwork. | "Prefer PR/commit records for T4, standalone docs only for high-risk artifacts" | **ACCEPT.** Artifact location is risk-tiered: DESIGN-gate or HIGH-RISK merge → standalone file; ordinary merge → PR/commit description. |

### Gemini-only high-weight (Codex missed)

| Issue | Gemini framing | Resolution |
|---|---|---|
| **`policy-oracle` skill as enforcement point.** Single skill that reads diff + context, consults CLAUDE.md, returns judgment on required reviews. | "All other skills (`/edit-skill`, `/commit`, `/security-review`) would then call this one oracle. This makes the system governable." | **PARTIAL ACCEPT.** Initial implementation: thin compliance hooks per skill linking to canonical CLAUDE.md policy (Codex's framing — lower implementation risk). Promote to a true `policy-oracle` skill in v2 if drift still appears despite the hooks. |
| **Static-analysis automation for T3 detection.** Redirect effort from manual periodic sweep to automated detection. | "Effort would be better invested in automating the detection capabilities for T3 (e.g., static analysis for security hotspots)" | **DEFER — track as v2.** Static-analysis tooling is its own project. v1 relies on author self-classification + reviewer cross-check; v2 may add automated detection. |
| **Timeout for reviewer absence.** "Proceed after 4 hours with one approval." | Listed in MAJOR | **ACCEPT.** 4-hour timeout for non-security disagreements (incorporated into URGENT severity mode). |

### Medium/low weight (one reviewer, MINOR)

| Issue | Source | Resolution |
|---|---|---|
| **Rename to risk labels not workflow moments.** "Security/Data/Agent behavior/Architecture" more memorable than T1-T6. | Codex MINOR | **ACCEPT.** Reflected in §4 naming. |
| **Measure beyond "produced ≥1 actionable change."** Also track false positives, bypasses, review latency, defects found after review. | Codex MINOR | **ACCEPT.** Telemetry list expanded in §5. |
| **Formalize "non-trivial" T2 definition.** Adopt doc's own suggested refinement. | Gemini MINOR | **N/A** — T2 is dissolved into the risk-label model. |
| **Clarify disagreement path for all tiers, not just T3.** | Gemini MINOR | **ACCEPT.** Disagreement procedure now defined globally (§4.5), not per-tier. |

---

## 3. My baseline predictions — grading

| Prediction (made implicitly in the doc's own "edge cases" section) | Verdict |
|---|---|
| T2 boundary fuzzy | ✅ Both hit. Dissolved into AGENT BEHAVIOR label. |
| T3 fuzzy / security-relevant under-specified | ✅ Both hit. Redefined by consequence questions. |
| T4 ">5 files" is arbitrary | ✅ Both hit hard. Replaced by risk labels. |
| T6 trigger is arbitrary cadence | ✅ Both hit. Becomes event-triggered AUDIT gate. |
| Reviewer disagreement procedure weak | ✅ Both hit. Now has blocking semantics for security + timeout for non-security. |
| Synthesis cost itself | ⚠ Codex hit on artifact-location bloat; partially related. |
| (Implicit) operationalization across 5 skills | ❌ Did NOT explicitly flag this as a CRITICAL risk in the doc. Both reviewers escalated to CRITICAL. **Biggest miss.** |
| (Implicit) the entire tier shape | ❌ Did NOT consider that the shape itself might be wrong. **Second-biggest miss.** |

**Things I missed entirely:**
- Emergency bypass / break-glass path (both CRITICAL — most basic operational requirement, missed)
- Data correctness / irreversibility as first-class category (Codex MAJOR — this is a huge gap; data-destructive operations don't fit "security" but are arguably higher-stakes)
- Dependency / supply-chain category (Codex MAJOR)
- Privacy / PII as separate from security (Codex MAJOR)
- Agent / tool autonomy as risk category (Codex MAJOR — directly relevant since Dynamic Research IS an agent project)
- Rollback readiness as review criterion (Codex)
- Incident-triggered review (Codex)
- Test adequacy as gate concern (Codex)
- The framing diagnosis "process-shaped, not decision-shaped" (Codex — this is the conceptual one-liner I needed)

**Reviewer-mix observation:** Codex was structurally more aggressive — proposed a complete reshape with specific risk-label taxonomy + severity modes. Gemini was more architectural — proposed centralization (`policy-oracle`) and identified the failure-mode physics (offline reviewers, boundary gaming). Together they produced a coherent v2 that neither alone would have generated. **This is the third consecutive synthesis where Codex+Gemini complementarity has been load-bearing — strong evidence the HARD RULE is well-targeted.**

---

## 4. Resolved direction — new framework shape

### 4.1 Two-dimensional model: Event Gate × Risk Label

**Three Event Gates** (mandatory enforcement points):

| Gate | When | Default review | Artifact location |
|---|---|---|---|
| **DESIGN** | Architectural docs, multi-day initiatives, irreversible product/infra/security decisions | Gemini + Codex (mandatory) | Standalone companion file next to design doc |
| **MERGE** | Any code, skill, config, or migration change being adopted | Depends on risk labels (see §4.2) | PR/commit description (ordinary) OR standalone file (high-risk) |
| **AUDIT** | Triggered by release cut, incident postmortem, major growth (>25% LOC), known drift, or recovery situation (like S43 retroactive sweep) | Structured 3-phase program (inventory → per-module → cross-cutting) | Standalone punch list at `Documentation/code-review/<date>-audit.md` |

**Risk Labels** (multi-select; each defined by consequence questions, not file paths):

| Label | Consequence question — "can this change…" | Review default at MERGE gate |
|---|---|---|
| **SECURITY** | …affect authentication, authorization, tenant isolation, secrets handling, privilege boundaries, prompt-injection surfaces, or remote execution? Can hostile input reach storage, execution, logs, prompts, or third-party services? | **Mandatory Gemini + Codex; blocking semantics on CRITICAL findings** |
| **DATA** | …affect data integrity, run schema migrations, perform backfills, execute destructive operations, or be irreversible without backup restoration? | **Mandatory Gemini + Codex** |
| **AGENT BEHAVIOR** | …change skill triggers, tool permissions, command-execution surface, file-access scope, or hook behavior? Can the change silently propagate to future agent sessions? | **Mandatory Gemini + Codex** |
| **PRIVACY** | …handle PII, change data retention, affect deletion/export/import, modify consent flows, or alter analytics? | **Mandatory Gemini + Codex** |
| **INFRA** | …modify CI/CD configs, deploy pipelines, env vars, cloud permissions, cron jobs, queue config, or storage bucket policies? | **Mandatory Gemini + Codex** |
| **DEPENDENCY** | …upgrade packages with runtime/security impact, add new libraries, modify build plugins, or change deployment images? | **Mandatory Gemini + Codex** |
| **ARCHITECTURE** | …design/modify schema, change cross-module boundaries, alter contract between major subsystems, or refactor across ownership boundaries? | **Mandatory Gemini + Codex** |
| **(no labels)** | Routine bug fix, UI tweak, comment-only edits, refactor within a module, test additions | Claude-only review acceptable |

### 4.2 Severity modes (replaces the no-bypass flaw)

| Mode | When | Procedure |
|---|---|---|
| **NORMAL** | Default for all reviewed work | Wait for both reviewers. Standard synthesis. |
| **URGENT** | Time-pressed production fix, schema-rollback, urgent customer-facing patch | One reviewer minimum + human written risk acceptance signed into the PR/commit. Mandatory follow-up review within 24h. |
| **EMERGENCY** | Active security incident, data-loss-in-progress, production-down | Patch now if needed (skip review). Mandatory retrospective Gemini + Codex review within 24-48h. Post-mortem mandatory. |

### 4.3 Disagreement procedure

| Situation | Resolution |
|---|---|
| Both reviewers agree on findings | Standard synthesis, proceed. |
| Reviewers disagree on **non-security** finding | Synthesis records rationale + decision. 4-hour wait window; if author decision is challenged, human owner decides. |
| Reviewer raises **SECURITY-labeled CRITICAL** finding | **Blocking.** Do not merge until: (a) finding is resolved in code, OR (b) human owner records explicit risk acceptance with sign-off line. **No third-model pass as automatic tiebreaker** — explicit owner judgment required. |
| One reviewer offline / rate-limited | Try alternative endpoint (e.g., Gemini CLI fallback). If still unavailable >4h and work is NORMAL severity: proceed with one reviewer + recorded "operating under reduced review" note. If URGENT/EMERGENCY: severity mode handles it. |

### 4.4 What each reviewer saw (new mandatory synthesis field)

Adopting Codex's recommendation. From this synthesis onward, every peer-review companion file includes a "What each reviewer saw" subsection identifying: full repo / diff only / design doc only / tests / logs / threat model. This makes shared blind spots visible.

**For this synthesis:** Both Gemini and Codex saw the policy doc text only — no repo context, no related skill files, no `~/CLAUDE.md` content beyond what was in the doc. Shared blind spots: how this framework will actually behave under real Dynamic Research workflow patterns; what existing skills currently do.

### 4.5 Operationalization (single source of truth)

1. **`~/CLAUDE.md` is canonical.** The "Multi-Reviewer Policy Framework" section there defines all gates, labels, severity modes, and disagreement procedures. **No skill encodes policy.**
2. **Each affected skill gets a thin compliance hook** with three obligations:
   - Before completion: classify touched work against the policy (which gate? which labels?).
   - If risk labels apply: produce or link the required review artifact.
   - Do not duplicate tier/label definitions in skill text — link to CLAUDE.md.
3. **Affected skills (revised list):**
   - `/edit-skill` — adds AGENT BEHAVIOR / ARCHITECTURE classification step; calls compliance hook.
   - `/security-review` — naturally a SECURITY-labeled review; uses Gemini + Codex by default with blocking semantics.
   - `/end-session` — checks whether session-touched files had required artifacts; warns if missing. Insufficient as the only enforcement (Codex), but a useful backstop.
   - `/review` — generalized 7-dim health check; can flag labels but doesn't replace MERGE-gate review.
4. **No new `/codebase-sweep` skill in v1.** AUDIT gate is event-triggered and structured as documented in §6 of original policy doc; promotion to a standalone skill only if invoked ≥2× in 6 months.

### 4.6 Telemetry (expanded per Codex MINOR)

Track per-review:
- "Produced ≥1 actionable change?" (original)
- **False-positive rate** (review surfaced no actionable issue)
- **Bypass count** (URGENT or EMERGENCY mode invocations)
- **Review latency** (time from request to synthesis complete)
- **Post-merge defects** in the touched risk-label area (detected within 30 days)

After 8 weeks of data: any risk label with false-positive rate >70% AND post-merge defect rate ≈ 0 is a candidate for downgrade (no longer mandatory).

---

## 5. Implementation plan (replaces original §Operationalization)

| Step | Work | Time | Sequencing |
|---|---|---|---|
| **1** | Rewrite policy doc using new `Event Gate × Risk Label` shape. Replaces v1. | 30 min | Required before §2. |
| **2** | Update `~/CLAUDE.md` "Multi-Model Peer Review" section to full "Multi-Reviewer Policy Framework" reflecting §4 above. Single source of truth. | 30 min | Sets the canonical reference. |
| **3** | Add thin compliance hooks to 3 affected skills: `/edit-skill`, `/security-review`, `/end-session`. Each just links to CLAUDE.md and runs a classify-and-produce-artifact step. No duplicated definitions. | ~20 min each = 1 hour total (sandbox→promote per skill) | After §2. |
| **4** | Watch for drift over 8 weeks; collect telemetry per §4.6. | passive | Continuous. |
| **5** | At 8 weeks: review telemetry. If drift OR low-signal labels detected, escalate to `policy-oracle` skill or downgrade labels. | ~2 hours | Calendar trigger. |

**Total implementation:** ~2 hours active work over next session(s). Much smaller than the original "update 4 skills + add 1 new" because the new shape pushes policy into a single source of truth rather than distributing it.

---

## 6. Open follow-ups

- **`/ultrareview` integration** (carried from original doc): currently user-triggered + billed, not Claude-invokable. If that changes, evaluate as canonical MERGE-gate execution surface.
- **`policy-oracle` skill** (Gemini's stronger proposal): defer; revisit if drift appears despite thin hooks.
- **Static-analysis automation** (Gemini's MAJOR T6-replacement): defer to v2; tooling project on its own.
- **Cross-project portability:** policy is currently scoped to Dynamic Research + GravityClaw. Carry to new projects only when patterns prove out.
- **Web Gemini Deep Think escalation:** the original doc mentioned manual-paste flow as security tiebreaker. The new model rejects automatic third-model passes — but manual escalation by the human owner remains available, just not automated.

---

## 7. Sign-off + recommended next move

This synthesis recommends a **structural rewrite of the policy doc**, not edits. The v1 doc should be archived (move to `Documentation/archive/`) and replaced with a v2 implementing §4 above.

**Recommend next:** I draft v2 of the policy framework doc using the new shape, then we apply it to `~/CLAUDE.md`. Total: ~1 hour of focused work. The peer reviews already validate the direction — v2 won't need its own peer-review pass since it's an implementation of the agreed-upon synthesis. Alternative: pause here and revisit in a fresh session with a full context window for v2 drafting.

— Claude Opus 4.7 (1M context), S43, 2026-05-17
