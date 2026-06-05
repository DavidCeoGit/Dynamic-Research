# S52 #3 — `<untrusted_input>` fence hardening SECURITY-label MERGE-gate synthesis

**Date:** 2026-05-25
**Project:** Dynamic Research
**Change scope:** Prompt-injection vector closure across both frontend LLM-calling routes AND the agent-side `claude -p` spawn path
**Multi-reviewer policy framework:** `~/CLAUDE.md` MRPF v2.2 — SECURITY label triggers mandatory Gemini → Codex sequential MERGE-gate
**Severity mode:** NORMAL
**Outcome:** **APPROVE + DEPLOYED + VERIFIED.** Gemini Deep Think (v1 → REQUEST CHANGES) + Codex GPT-5.5 xhigh (v2 → REQUEST CHANGES → v3 → APPROVE).

---

## 1. Change summary

| Layer | File | Change |
|---|---|---|
| Frontend helper | `frontend/lib/untrusted-input.ts` | NEW (~50 lines) — exports `fenceUserText(text: string)` |
| Frontend route 1 | `frontend/app/api/queue/extract-context/route.ts` | Added CRITICAL directive + fenceUserText import + Unicode-escape fence + REMINDER sandwich |
| Frontend route 2 | `frontend/app/api/queue/generate-questions/route.ts` | Same 3-change pattern, symmetric (CRITICAL was already present since S33; added fenceUserText + REMINDER) |
| Agent helper | `agent/lib/untrusted-input.ts` | NEW (~70 lines, paired-edit twin) — exports `fenceUserText` + `fenceValue(label, value)` |
| Agent prompt builder | `agent/executor.ts` | Import `fenceValue`; replace inline `fence()` with `const fence = fenceValue` alias (all 12 call sites route through it); add manifest-level CRITICAL directive; add REMINDER sandwich anchor |

**Three-layer defense applied uniformly:**

1. `JSON.stringify` — escapes quotes, backticks, newlines, control characters
2. `.replace(/</g, "<").replace(/>/g, ">")` — Unicode-escape angle brackets so payloads containing literal `</untrusted_input>` cannot present as structural close-tag tokens (the Gemini C1 finding — JSON spec does NOT mandate escaping `<` / `>`)
3. XML `<untrusted_input>` envelope + CRITICAL directive in system prompt + trailing REMINDER sandwich anchor below closing tag

**Lossless:** the model still semantically decodes `<` as `<` during inference, so topics about HTML/XML/code content are NOT mangled. Verified empirically.

---

## 2. What each reviewer saw

| Reviewer | Scope of input | Output basis |
|---|---|---|
| **Gemini Deep Think v1 (web paste)** | v1 bundle (`sandbox/s52-3-fence-gemini-bundle.md`, ~270 lines): change summary + before/after diff + reference pattern + verification done + Q1-Q5 + ready-to-paste prompt. Single-route scope (frontend `extract-context`). No live repo. | Holistic security review against the as-described artifact. Web knowledge of Anthropic / OWASP prompt-injection mitigations. |
| **Codex GPT-5.5 xhigh v2 (`codex exec -s read-only`)** | v2 integration doc + live repo. Read both `frontend/lib/untrusted-input.ts`, both modified frontend routes, `agent/executor.ts`, `agent/preflight.ts`, all `frontend/app/api/**`, all memory files. Sweep for OTHER LLM-calling routes. | Code-grounded pass on integrated v2 against as-built state. |
| **Codex v3 QA-on-fidelity** | v3 doc + live repo (post-Codex-fix). Verified the 4 edits land correctly via file:line + git diff + content-hash. No novel critique. | Per MRPF v2.2: post-fix revision = QA-on-fidelity by the reviewer whose findings drove the fix; Gemini NOT re-invoked. |

---

## 3. Reviewer findings + dispositions

### Gemini Deep Think v1 — REQUEST CHANGES

| ID | Severity | Finding | Author disposition |
|---|---|---|---|
| C1 | **CRITICAL** | `JSON.stringify` does NOT escape `<` / `>`. Attacker payload containing `</untrusted_input>` writes raw close-tag tokens into the prompt; the model may parse it as a structural close and execute trailing text as instructions. | **ACCEPT (concern). MODIFY (fix).** Gemini proposed (a) HTML entity encoding `&lt;` / `&gt;` — **REJECTED** (lossy, mangles topics about HTML/XML/code); (b) cryptographic per-request nonce on tag boundaries — **REJECTED** (over-engineered, breaks prompt caching, adds per-request complexity for marginal benefit at current threat level). **AUTHOR FIX:** post-process `JSON.stringify` output to Unicode-escape `<` → `<` and `>` → `>`. Lossless (model semantically decodes during inference), no per-request mutation, prompt-cache-friendly. |
| M1 | MAJOR | Sister route `generate-questions/route.ts` shares the same angle-bracket vulnerability. | **ACCEPT.** Applied the fix to both routes symmetrically. Asymmetric defense rejected. |
| M2 | MAJOR | Front-loaded CRITICAL directive only — long topics dilute attention. Append a sandwich-anchor REMINDER immediately below the closing fence. | **ACCEPT.** Trailing REMINDER block added to both routes. Restates the data-not-instruction contract close to the generation token. |
| Q3 | (no severity) | System prompt is static + author-controlled — confirmed safe. | Acknowledged. |
| Q5 nonce | (Gemini suggestion) | Cryptographic nonce on tag boundaries. | **REJECTED.** Defense-in-depth via JSON escape + Unicode escape + CRITICAL directive + sandwich anchor is sufficient at current threat level. Documented revisit conditions in synthesis: observed injection in logs, multi-tenant adversarial use, evidence that the model treats escaped delimiters as structural, or a preprocessing layer that decodes `<` back. |

### Codex GPT-5.5 xhigh v2 — REQUEST CHANGES

| ID | Severity | Finding | Author disposition |
|---|---|---|---|
| Codex-Q1 dispositions | (validation) | All 4 frontend dispositions well-grounded with file:line evidence. | Acknowledged. |
| Codex-Q2 frontend sweep | (validation) | Only 2 LLM-calling routes in `frontend/app/api/**`; both now fenced. No new frontend finding. | Acknowledged. |
| **Codex-Q3 agent gap** | **CRITICAL** | `agent/executor.ts:435-436` has its own inline `fence` helper using `JSON.stringify(value)` only — same Gemini-C1-class vulnerability in a HIGHER-RISK path (spawned `claude -p` has Bash + Read + Write + WebSearch + WebFetch + Perplexity/Chrome MCP tools). Also: `job-manifest.json` is JSON.stringify'd at executor.ts:119 with raw user fields, then Claude is told to read it — manifest-level untrusted-data contract missing. | **ACCEPT — drove v3.** Created paired `agent/lib/untrusted-input.ts` (twin of frontend, but additionally exposes `fenceValue(label, value)` for arbitrary JSON-serializable values). Refactored executor.ts buildPrompt: import `fenceValue`, alias `const fence = fenceValue` (all 12 call sites unchanged), added manifest-level CRITICAL directive, added REMINDER sandwich anchor. |
| Codex-Q4 literal sweep | (validation) | 0 hits for prior-round patterns in frontend routes. | Acknowledged. |

### Codex GPT-5.5 xhigh v3 QA-on-fidelity — **APPROVE**

| Verification | Result |
|---|---|
| Agent CRITICAL fixed (fenceValue at all call sites) | YES — Codex counted 12 live `fence(...)` call sites (I had said 11 — doc-precision drift, non-blocking) |
| Manifest CRITICAL directive landed | YES, positioned before `Read the job manifest` |
| REMINDER sandwich anchor positioned correctly | YES, between params and `Execution rules:` |
| Frontend untouched in v3 vs v2 | YES (byte-identical via content-hash) |
| No prior-round literals leaked | YES — 0 hits for deleted inline-fence pattern + raw `JSON.stringify(job.topic)` |
| Pair-edit invariant (agent + frontend escape logic aligned) | YES — both use `JSON.stringify(...).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")` |
| **FINAL VERDICT** | **APPROVE** |

---

## 4. Sequence followed (per MRPF v2.2)

1. Author drafted v1: single-route frontend fence (extract-context only).
2. Author bundled v1 for Gemini Deep Think (web paste).
3. Gemini v1 → REQUEST CHANGES (C1 + M1 + M2 + scope-dispute).
4. Author integrated v2: extracted `fenceUserText` helper with Unicode escape; applied to BOTH frontend routes (M1); added REMINDER sandwich (M2); rejected Gemini's HTML-entity fix and nonce as documented.
5. Author invoked `codex exec` on v2.
6. Codex v2 → REQUEST CHANGES (CRITICAL — agent gap).
7. Author integrated v3: paired `agent/lib/untrusted-input.ts`; refactored `agent/executor.ts` to use `fenceValue`; manifest CRITICAL + REMINDER sandwich.
8. Author invoked `codex exec` on v3 for QA-on-fidelity (per MRPF v2.2 — Gemini NOT re-invoked on revision).
9. Codex v3 → **APPROVE**.
10. Forward-sync 3 frontend files to push-clone; commit `76d940c`; push to GitHub → Vercel auto-deploy `dynamic-research-ezjqcj66l-...` ● Ready in 19s.
11. Prod smoke: 8/8 routes HTTP 200; rate-limit still functional; 0 collateral damage.
12. Agent-side changes ship via worker-daemon source re-read on next job-claim (no worker restart needed per S50 docs).
13. SoT commit + synthesis doc + dependency-exceptions unchanged + handoff updated.

---

## 5. Empirical findings worth retaining

| # | Finding | Material impact |
|---|---|---|
| 1 | **The Gemini-C1-class delimiter-breakout vector was hiding in a SECOND file Codex caught** — the frontend fence had been live since S33 with the same `JSON.stringify(value)` only pattern AT THE AGENT TOO. Without Codex's code-grounded sweep ("does any OTHER route handle untrusted user input without this fence?"), v2 would have shipped with the worse half of the vuln still in prod. The MRPF v2.2 sequential pattern delivered concentrated value here: Gemini caught the class of vulnerability; Codex caught the second occurrence. | Reinforces MRPF v2.2 value at SECURITY-label gates. Both reviewers found unique-to-them findings. Worth documenting as a high-water-mark for the framework. |
| 2 | **Unicode-escape (`<` / `>`) is the right primitive for fence-tag breakout closure** — chosen over (a) HTML entity encoding (lossy) and (b) cryptographic nonce (over-engineered). Lossless, cache-stable, model-semantically-transparent. Verified empirically with 5-case helper test + 1 adversarial-input test on the agent path. | Establishes the pattern for any future LLM-calling route. Captured in `feedback_untrusted_input_fence_pattern.md` (memory file) along with the `fenceUserText` / `fenceValue` helper API. |
| 3 | **Codex tool-grant context matters for severity grading** — Codex correctly graded the agent gap CRITICAL precisely BECAUSE the spawned Claude has `Bash`, `Read`, `Write`, `WebSearch`, `WebFetch`, and `MCP` tools at lines 487-504. A successful injection there could trigger actual code execution; the same injection at the frontend `generateObject` path could only return malformed structured output. Same vulnerability class, different blast radius. Reviewers must be told the tool surface when grading SECURITY findings. | Document for Codex prompt template: when reviewing prompt-injection, ALWAYS list the LLM's allowed-tools so the reviewer can grade blast radius correctly. |
| 4 | **Pair-edit between subprojects without shared code dependency** — `agent/lib/untrusted-input.ts` and `frontend/lib/untrusted-input.ts` duplicate the 3-line escape primitive because the two subprojects can't import across the boundary (different `package.json`, different `tsconfig`). The pattern is the same as `storage-paths.ts` (S50). File header documents the pair-edit rule. **Drift risk is real** — any future change to the escape semantics must be applied to BOTH. | Codify in CONTRIBUTING-style memory: any change to escape semantics in either file must be paired. |
| 5 | **Codex's "v3 has 12 call sites, not 11" was the only documentation drift** in three revisions of a SECURITY MERGE — extremely tight cycle. Doc-precision items at QA-on-fidelity stage are signs the workflow is well-rehearsed. | Indicator that MRPF v2.2 + paired Gemini→Codex sequential is mature for this team. |

---

## 6. Deploy + verification record

| Step | Outcome | Reference |
|---|---|---|
| `agent/lib/untrusted-input.ts` written | NEW (70 lines) | promoted from `sandbox/agent-untrusted-input.ts` |
| `agent/executor.ts` modified | 4 edits applied via Python script | diff shows +12/-6 around buildPrompt |
| `frontend/lib/untrusted-input.ts` written | NEW (~50 lines) | promoted from `sandbox/untrusted-input.ts` |
| `frontend/app/api/queue/extract-context/route.ts` modified | CRITICAL directive + import + fenceUserText + REMINDER | promoted from sandbox |
| `frontend/app/api/queue/generate-questions/route.ts` modified | import + fenceUserText + REMINDER (CRITICAL was already present since S33) | promoted from sandbox |
| TSC frontend post-modifications | PASS (exit 0) | verified |
| TSC agent post-modifications | PASS (exit 0) | verified |
| Adversarial test on agent `fenceValue` | PASS — `</untrusted_input>` payload Unicode-escaped, cannot present as structural close | verified |
| 5-case frontend `fenceUserText` test | PASS — Gemini C1, triple-quote, benign, HTML-flavored, backtick all neutralized | `sandbox/validated/test-fence-s52-3.ts-s52` |
| Gemini Deep Think v1 review | REQUEST CHANGES (C1 + M1 + M2) | bundle at `sandbox/validated/s52-3-fence-gemini-bundle.md-s52` |
| Codex v2 review | REQUEST CHANGES (CRITICAL — agent gap) | v2 at `sandbox/validated/s52-3-fence-v2-for-codex.md-s52` |
| Codex v3 QA-on-fidelity | APPROVE | v3 doc at `sandbox/validated/s52-3-fence-v3-for-codex-qa.md-s52` |
| Push-clone commit `76d940c` + push | landed | `git push origin main` |
| Vercel auto-deploy `dynamic-research-ezjqcj66l-...` | ● Ready in 19s | `vercel ls` |
| Prod smoke: 8/8 routes HTTP 200 | PASS (incl. `.download()` path) | curl |
| Rate-limit still functional post-deploy | PASS (HTTP 400 = rate-limit allowed, body invalid) | curl |
| Agent changes pickup | At next job-claim via source re-read (no worker restart needed) | per S50 docs |

Total S52 #3 wall clock: ~3h (drafting + 2 reviewer rounds + integration + deploy). Estimate at S51 close was ~30min + review. Reality was 3-6x because Codex's CRITICAL finding expanded scope to the agent side. Worth it — closing both halves of the vuln in one MERGE is much better than fixing the frontend then having a SECURITY-label follow-on commit a week later.
