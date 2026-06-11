# MRPF PUBLISH Fail-Closed Enforcement — MERGE-Gate Peer Review Synthesis

**Date:** 2026-06-11 (S108-N overnight autonomous session)
**Artifact:** branch `feat/mrpf-publish-fail-closed` (v1 `a7bf199` → v2 `02a07ad` → v3 `7992c94`) + lockstep edit to `~/.claude/commands/research-compare.md` (promoted outside the repo).
**Classification:** MERGE gate × **AGENT BEHAVIOR** (the code gates what an autonomous worker may publish; silently propagates to future sessions) × Severity NORMAL. Topology: sequential Gemini → integrate → Codex → integrate, per MRPF v2.3, both lenses adversarial.
**Design provenance:** deliverable (B) of `Documentation/mrpf-publish-gate-design-gate-peer-review.md` (S100 DESIGN gate). The PUBLISH policy in `~/.claude/CLAUDE.md` stays NON-OPERATIONAL until this lands and deploys.

## What shipped

- **NEW `agent/lib/publish-gate.ts`** — runtime-structural mechanical assertion (`evaluatePublishGate`): `verification_status === "passed"`, all three vendor legs `ok` (degraded/failed/skipped HARD BLOCK), claims-extraction consistency (`populated` ⇒ ≥1 claim; `no_load_bearing_claims` ⇒ 0 claims + substantive justification), per-claim completeness (real-calendar-date temporal anchor, parseable http(s) source URLs, dated sources, closed quality-class enum, upstream-independence basis, counter-evidence notes, verdict ∈ {verified, verified_with_caveat}); URGENT human-only bypass with a live-leg floor.
- **`agent/executor.ts`** — gate enforced pre-upload on the full path and pre-completeJob on studio_only; pre-spawn sign-off snapshot; DRY_RUN of publish jobs fails closed; `buildManifest` seeds `publish_required` + `urgent_signoff_present`.
- **`agent/types.ts` / frontend mirrors** — `UserContext.publishRequired` (jsonb, no migration; zod defaults false → dark-launch), `PublishVerification` manifest types.
- **`~/.claude/commands/research-compare.md`** — MRPF PUBLISH contract section; vendor-leg ledger; Phase 1 hard-fail (no WebSearch substitution for publish runs; no cached-Perplexity reuse); Phase 6 Step A.5 claim verification; URGENT degraded-continue exception (only when the worker found a pre-existing human sign-off).
- **Tests:** `agent/test/publish-gate.test.ts` — 35 tests incl. the design-doc list (Perplexity-401, WebSearch-fallback, empty-claims, missing-anchor, URGENT-without-signoff). Suite 345 agent + 57 frontend = 402 GREEN, dual tsc, EXIT 0.

## What each reviewer saw

- **Gemini 3.1 Pro (`gemini -m gemini-3.1-pro-preview`, holistic-adversarial):** the FULL v1 repo diff + the v1 skill diff + design context, inline via stdin (64KB bundle; `-p "$(cat …)"` hit Windows arg-limit — pipe form used). No repo access.
- **Codex (ChatGPT-auth `codex exec -s read-only`, grounded-adversarial; ChatGPT token verified live by a real exec — no API-key spend):** the v2 WORKING TREE (read files directly, cited file:line) + a bundle carrying design context and — **author error — the STALE v1 skill diff** (the v2 degraded-continue exception was missing from its bundle). 119,706 tokens. Transcript: `/c/tmp/s108-codex-run.log`.

## Gemini round (v1 → BLOCK, 4 findings)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| G1 | BLOCKING | URGENT bypass unreachable: skill ERROR-exits on leg failure → `verifyPipelineCompletion` fails the job before the gate; no deliverables exist to publish | **Integrated (v2):** `buildManifest` seeds `urgent_signoff_present` (pre-spawn `existsSync`); skill gains the human-authorized degraded-continue exception — signed-off runs complete with an honest failing manifest the gate can bypass. Default remains cheap fail-fast. |
| G2 | BLOCKING | LLM-stringified `"true"` on `state.publish_required` → strict `=== true` reads false → gate silently skipped | **Integrated (v2):** `truthyFlag` accepts boolean `true` and string `"true"` on both flags (fires the gate MORE often — fail-closed direction; junk like `"yes"` still false). |
| G3 | MAJOR | studio_only with corrupted state loses an interactively-declared publish flag | **REJECTED-with-evidence:** `runStudioOnly` is worker-only; worker jobs always carry the durable jsonb flag; corrupted state on a flagged job already blocks via missing manifest. Integrated the spirit: forensics log on state-parse failure. |
| G4 | MINOR | `no_load_bearing_claims` is a friction-free LLM laziness escape | **Integrated (v2):** required `no_claims_justification` (≥20 chars), gate-enforced + skill-documented. |

## Codex round (v2 → BLOCK, 5 findings)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| C1 | BLOCKING | Bypass still not end-to-end (skill ERROR-exits) | **REJECTED-with-evidence + author mea culpa:** Codex reviewed a stale v1 skill diff (bundle assembly error, recorded). The CURRENT skill's degraded-continue exception completes the chain: pre-placed sign-off → manifest flag → skill continues degraded → phase complete + failing manifest → gate consumes pre-spawn snapshot → bypassed completion with deliverables present. Manually re-traced against the live text. |
| C2 | BLOCKING | Replay route rebuilds `userContext` without `publishRequired` → zod defaults false → publish-bound reruns silently downgraded | **Integrated (v3):** replay route preserves the flag. (Form-driven clones remain flagless until a UI exists — inherent to dark-launch; noted.) |
| C3 | BLOCKING | Sign-off file forgeable by the spawned child (same OS user, has Write/Bash, knows its own job id) | **Integrated (v3):** pre-spawn snapshot — executor reads the sign-off BEFORE spawning; the gate consumes the snapshot and never re-reads. A forged file arrives too late; future job UUIDs are unknowable to a child. Residual: OS-level same-user writes outside job runtime are unpreventable in code — operator MAY additionally ACL the directory. |
| C4 | MAJOR | DRY_RUN completes publish jobs ungated (both paths) | **Integrated (v3):** DRY_RUN of a publish-required job fails closed with an explicit reason on both the full and studio_only paths. |
| C5 | MAJOR | Claim validation accepts junk (`"2026-99-99 junk"`, `"not a url"`, free-form quality class) | **Integrated (v3):** real-calendar-date round-trip for `asOfDate`, `URL()`-parsed http(s) `sourceUrls`, dated `sourceDates`, closed `sourceQualityClass` enum. |

Codex also answered the test question: pure-gate coverage good; end-to-end executor/skill path, replay persistence, dry-run completion not unit-covered (the executor wiring is thin glue over the tested pure function; replay/dry-run behaviors landed AFTER its pass with the v3 tests — dry-run/forgeability remain integration-test follow-ups).

## Disagreement procedure

Two REJECT-with-evidence calls (G3, C1) — both grounded in primary-source code/text reads, recorded above per `feedback_grounded_reviewer_can_be_confidently_wrong`. No SECURITY-labeled CRITICAL disagreement; no third-model pass.

## Residual risks (accepted, documented)

1. **Same-user OS writes:** nothing in-code stops a NON-pipeline same-user process from forging a sign-off; the snapshot closes the spawned-child vector specifically. Operator ACL on `agent/.publish-risk-accepted/` is the belt-and-suspenders.
2. **Form-driven clones don't inherit `publishRequired`** until the UI exposes the flag (dark-launch scope).
3. **Layer-3 drift:** the skill is prompt-text; the worker gate is the actual enforcement (defense in depth is exactly the design).
4. **Gate fires only at completion:** a publish run burns full pipeline cost before failing (by design — Gemini G1 trade-off, default fail-fast at the leg).

## Verdict

**APPROVE (gate cleared):** Gemini BLOCK→integrated/rejected-with-evidence; Codex BLOCK→integrated/rejected-with-evidence; suite 402 green. Sequential-QA fidelity pass on v3 is the standard next-revision step if further changes land before merge. **PR is HELD for operator review — do not merge without reading C3's residual.**
