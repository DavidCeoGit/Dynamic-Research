# MRPF PUBLISH Gate — DESIGN-gate Peer Review Synthesis

**Date:** 2026-06-06 (DR S100)
**Artifact under review:** a proposed addition to the Multi-Reviewer Policy
Framework (`~/.claude/CLAUDE.md`) to close the failure mode where a research
deliverable shipped fabricated/unsourced factual claims.
**Classification:** DESIGN gate (edits the MRPF itself → propagates to every
future agent session) × Risk Labels AGENT BEHAVIOR + (the change governs
content publication) × Severity NORMAL. Topology: sequential Gemini → integrate
→ Codex, per CLAUDE.md §11. This change was routed through the very review it
governs (the recursion the framework demands of edits to itself).

## Problem statement
The `/research-compare` 3-vendor pipeline (Perplexity + NotebookLM + Claude,
cross-checked via `claimsToVerify`) shipped a polished auto-detailing naming
report (run `808e4b1f`, 2026-06-03) containing fabricated/unsourced quantitative
claims — a named "Schloss-K-Effect" that appears invented, plus unsourced
"40% recall penalty" / "32% GBP-signal weight" / "48% voice-search" figures.
**Root cause:** Perplexity silently 401'd (insufficient_quota); the pipeline
FAILED OPEN — degraded to a WebSearch fallback and continued — so the
cross-vendor verification that normally catches hallucinations never fired.
The existing 7 Risk Labels do not model "a false factual claim reaches a
decision-maker."

## What each reviewer saw
- **Gemini 3.1 Pro (Deep Think):** the MRPF framework context + the problem +
  the v1 proposal, all inline (no repo access — global/gitignored config).
  Holistic structural read.
- **Codex (gpt-5.5, `codex exec -s read-only`, reasoning xhigh):** the
  integrated v2 + Gemini's findings + **grounded reads of the live repo**. It
  cited exact sites: `~/.claude/commands/research-compare.md:355` (the
  Perplexity→WebSearch fallback), `agent/executor.ts:525/591/1222`
  (`verifyPipelineCompletion`/`completeJob` — terminal-phase/upload only, no
  vendor-leg check), `frontend/lib/validate.ts:66` (`claimsToVerify` defaults
  `[]`), `agent/types.ts:74` (no `publish_required`/verification fields).

## v1 (author draft) — REJECTED by Gemini
v1 proposed a **Risk Label** `OUTBOUND/FACTUAL` whose remedy was claim
verification (not Gemini+Codex). Gemini's blocking findings:
1. **Structural violation.** Every Risk Label in the framework requires
   mandatory Gemini+Codex; a label whose remedy is NOT those reviewers breaks
   the dimension's schema. It conflates an agent-code framework with a
   content-publication framework.
2. **Category-gating regression.** The trigger listed categories ("research
   reports, client-facing deliverables, marketing copy") — exactly the
   category shape v2 abolished. Must be consequence-defined.
3. **Self-accept loophole.** "Explicitly risk-accepted" let an autonomous agent
   sign off on bypassing its own fact-checker, end-running the Severity Modes.
4. **Wrong root cause.** The 401-silent-bypass is a code FAIL-OPEN
   (AGENT BEHAVIOR/INFRA), not a policy gap. Policy can't patch a missing
   fail-closed guard.
5. **Blind spots:** stale-but-accurate data, omission/cherry-picking, and
   source-laundering (vendor B "confirms" vendor A because both cite the same
   junk source).

**Gemini's fix:** make it an **Event Gate `PUBLISH`** (not a Risk Label)
routing to the verification pipeline; define the trigger by blast-radius of a
hallucination; exempt internal artifacts; route bypass through URGENT severity.

## v2 (Gemini integrated) — APPROVE-WITH-CHANGES by Codex
Codex confirmed Gemini findings 1 & 2 fixed (PUBLISH is an Event Gate;
trigger is consequence-based), 3 mostly fixed (URGENT mechanics needed
tightening), 4 only acknowledged (code fail-open remains), 5 partially fixed
(stale-data + laundering named but not enforceable; omission still weak).

Codex's blocking findings (all code-grounded):
1. **Policy-only landing would still fail open.** The live command still falls
   back Perplexity→WebSearch and continues; the worker completes on
   terminal-phase/upload without checking vendor-leg health. → **policy and
   fail-closed code must land together, OR the policy must be explicitly
   non-operational with PUBLISH clearance frozen until the code lands.**
2. **No mechanical PUBLISH signal exists.** `claimsToVerify` defaults `[]`;
   job types have no `publish_required`/`verification_status`/manifest. Empty
   claims are indistinguishable from "no claims" vs "missed extraction." →
   add a durable job/state flag + verification-result object before
   `completeJob()`.
3. **URGENT bypass still too loose.** Must state the agent cannot generate or
   infer the signature; a degraded/offline verifier cannot be renamed the
   "single verification path"; URGENT still requires one LIVE grounded path.
4. **Stale-data / anti-laundering / omission not enforceable.** Need required
   manifest fields (claim as-of date, source pub/access date, source-quality
   class, upstream-independence basis, counter-evidence) or the agent can
   write "sources independent" with no evidence.

Codex's "minimal mechanical assertion" (pre-`completeJob` for
`publish_required=true`): refuse completion unless `verification_status ==
passed`, all three `vendor_legs.*.status == ok` and none `degraded`,
`claims.length > 0 || claims_extraction_status == no_load_bearing_claims`, and
every claim verdict ∈ {verified, verified_with_caveat}. Perplexity fallback
must be a HARD FAILURE for PUBLISH jobs, not a substitute.

## Synthesis / resolved direction
Both reviewers converge on the high-weight items: **PUBLISH is an Event Gate,
not a Risk Label; trigger is consequence-based; bypass routes through URGENT
with a human-only sign-off; and policy alone is insufficient — the real
guardrail is a fail-closed pipeline with the policy as its written contract.**

The change is therefore **two deliverables**:
- **(A) Policy** — PUBLISH Event Gate + Validation Rule (verification manifest;
  HARD BLOCK on any degraded leg; URGENT-only human bypass). Carries a
  self-imposed **NON-OPERATIONAL-until-fail-closed-code** header so it can land
  safely now. **LANDED to `~/.claude/CLAUDE.md` this session (S100).**
- **(B) Fail-closed code** — make `/research-compare` hard-fail (not fall back)
  for PUBLISH jobs; add `publish_required` + verification manifest to job
  state/types; gate `completeJob()` on Codex's mechanical assertion; tests for
  Perplexity-401, fallback, empty-claims, missing-anchor, URGENT-without-signoff.
  This is its own **INFRA + AGENT BEHAVIOR** MERGE-gate project with its own
  Gemini→Codex round. **NOT yet built — scheduled as a dedicated effort.**

Until (B) clears its MERGE gate and deploys, PUBLISH is documented-but-frozen:
no `/research-compare` output is "publish-cleared"; load-bearing claims are
verified manually. The pending auto-detailing v2 research run is the intended
first real PUBLISH dogfood (verified manually) — it will pressure-test (B)'s
manifest shape before the code is written.

## Disagreement procedure
No disagreement requiring escalation. Gemini REJECT(v1) → restructure → Codex
APPROVE-WITH-CHANGES(v2) is the standard sequential improvement path; all Codex
blocking items integrated into the landed (A) wording, with (B) split out as a
tracked follow-on. No SECURITY-labeled CRITICAL (no blocking-merge condition).
