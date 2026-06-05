# MERGE-gate peer review — plan-transports.ts OpenAI json_schema migration (S75)

**Status:** APPROVED for promote — v3 sandbox + tests green + live OpenAI smoke pass + Codex fidelity APPROVE.

**Change scope:** `agent/lib/plan-transports.ts` — migrate the OpenAI reviewer transport from `text.format: {type: 'json_object'}` to `text.format: {type: 'json_schema', schema, strict: true}` so the API server-side enforces verdict/severity/origin enums + structural shape. Closes the S67-S74 "codex unreachable" failure class (root cause: downstream `isValidFinding()` rejection of valid-shape OpenAI responses with invalid origin labels).

**MRPF classification:**
- Event Gate: **MERGE**
- Risk Labels: **AGENT BEHAVIOR** (changes auto-classifier contract with OpenAI API)
- Severity Mode: **NORMAL**
- Topology: Sequential **Gemini → integrate → Codex** (per HARD RULE for AGENT BEHAVIOR @ MERGE)
- Post-fix revision: **Codex fidelity QA** (Codex caught more findings; drives the v3 verification)

**Author:** Claude Opus 4.7 [1m] | **Reviewers:** Gemini 3.1 Pro Preview, OpenAI GPT-5 | **Date:** 2026-05-31 UTC

---

## What each reviewer saw

| Reviewer | Scope provided |
|---|---|
| Gemini round 1 | Diff (live→v2 sandbox) + plan-types.ts excerpt (ORIGINS/SEVERITIES/REVIEWER_VERDICTS/isValidFinding) + plan-reviewer.ts callReviewerWithRetry context + S74 root-cause narrative |
| Codex round 1 | Same context as Gemini, but on v2 sandbox (post-Gemini integration) |
| Codex fidelity QA | v3 diff + author's structured response to all 8 round-1 findings + reference to live OpenAI smoke test |

---

## Round 1 findings + dispositions

### Gemini round 1 (v2 sandbox)

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| G-CRIT-1 | CRITICAL | openai-api-contract | **ACCEPTED → integrated v2** | OpenAI strict-mode JSON Schema does NOT support `minimum`/`maximum`/`pattern`/`minLength`. Original v1 used all four. v2 removed them; range/length constraints stay in downstream `parseReviewerJson()` + `isValidFinding()`. Replaced `pattern: /^answer-\d+$/` with finite enum literals (later bumped to answer-0..50 per Codex M-1). |
| G-MIN-1 | MINOR | backward-compat | **DEFERRED** | persona_depth_score required-integer might cause hallucinated scores when model can't legitimately provide one; suggested `["integer", "null"]`. Out-of-scope for this PR — would require parseReviewerJson + personaDepthGap semantic changes. Tracked as carry-forward. |

### Codex round 1 (v2 sandbox)

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| C-CRIT-1 | CRITICAL | openai-api-contract | **REJECTED — verified false** | Claimed Responses API needs `text.format.json_schema.{name,schema,strict}` wrapper instead of `text.format.{type,name,schema,strict}`. Live smoke test (`c:/tmp/openai-schema-smoke-s75.mjs`) returned HTTP 200 with valid output using the un-wrapped form. Codex conflated Responses API + chat.completions API shapes. |
| C-CRIT-2 | CRITICAL | openai-api-contract | **DEFERRED** | Suggested preferring `output_parsed`/`message.parsed` over `output_text`/`content` for structured outputs. Smoke test confirmed `output_text` IS populated with valid JSON. Adding parsed-first fallback is defensive but not currently needed. Carry-forward. |
| C-MAJ-1 | MAJOR | backward-compat | **ACCEPTED → integrated v3** | answer-1..20 cap rejects answer-0 + answer-21+; diverges from downstream `isValidFinding` regex `/^answer-\d+$/`. Bumped to answer-0..answer-50 (ANSWER_N_MAX=50 + Array.from starts at index 0). |
| C-MAJ-2 | MAJOR | backward-compat | **REJECTED** | Hypothesized models might emit benign extras (`code`, `rationale`) that `additionalProperties: false` would reject. Counter: server-side `additionalProperties: false` enforcement is the WHOLE POINT of strict mode. Reviewer prompt explicitly lists 3 fields; strict mode constrains model output. Not observed in practice. |
| C-MAJ-3 | MAJOR | openai-api-contract | **DEFERRED** | chat.completions `response_format: {type: 'json_schema'}` not universally supported (older gpt-3.5/gpt-4 models). Modern openai SDK has `responses.create` so chat.completions branch is dead code in practice; default OPENAI_MODEL is gpt-5. If a user pins a legacy model, they'll get a clear API error diagnosable via S74 logging fix. Carry-forward: add json_schema→json_object fallback on 400. |
| C-MAJ-4 | MAJOR | test-coverage | **DEFERRED** | No mocked-SDK unit tests for new schema paths. Live OpenAI smoke test provides empirical happy-path coverage. Adding tests would extend Task #1 scope beyond 1-3h target. Carry-forward: write integration tests with `__overrideSdkLoadersForTesting()`. |
| C-MIN-1 | MINOR | comment-accuracy | **ACCEPTED → integrated v3** | Original S75 comment block claimed strict mode enforces "persona_depth_score range + non-empty message." Post-Gemini-integration that's false. Corrected to "structural shape (additionalProperties: false + required fields); range/length downstream." |
| C-MIN-2 | MINOR | error-handling | **DEFERRED** | Schema 400s are deterministic; second retry will fail same way. Smarter retry (downgrade to json_object on 400) is a separate concern. Carry-forward. |

### Codex fidelity QA (v3 sandbox)

- **fidelity_verdict: APPROVE**
- m1 addressed correctly (ANSWER_N_MAX=50, Array.from with i not i+1, length ANSWER_N_MAX+1 → answer-0..50)
- m-1 comment fix correct (now mentions "structural shape" + downstream range/length)
- One new observation (NOT a new finding): v3 also changes chat.completions branch to json_schema, so the C-MAJ-3 deferral now applies harder if that path ever exercises. Author accepts; chat.completions path remains dead code under modern openai SDK + gpt-5 default.
- All 4 deferrals acknowledged as reasonable carry-forward.

---

## Verification summary

| Check | Result |
|---|---|
| pnpm test on v1 sandbox (storage-paths + tsc strict both subprojects) | ✅ PASS |
| pnpm test on v2 sandbox (post-Gemini integration) | ✅ PASS |
| pnpm test on v3 sandbox (post-Codex integration) | ✅ PASS |
| Live OpenAI smoke test v2 schema (gpt-5, Responses API, strict json_schema) | ✅ HTTP 200, valid output |
| Live OpenAI smoke test v3 schema (51-element answer enum) | ✅ HTTP 200, valid output |
| Codex fidelity QA on v3 | ✅ APPROVE |

---

## Cost summary

| Item | Provider | Tokens | Est. cost |
|---|---|---|---|
| Gemini round 1 | gemini-3.1-pro-preview | 4,183 in + 459 candidates + 5,497 thoughts | ~$0.08 |
| Smoke test v2 schema | gpt-5 | 255 in + 464 out | <$0.01 |
| Codex round 1 | gpt-5 | 3,943 in + 7,178 out | ~$0.08 |
| Smoke test v3 schema | gpt-5 | 379 in + 244 out | <$0.01 |
| Codex fidelity QA v3 | gpt-5 | 3,080 in + 4,944 out | ~$0.06 |
| **Total MRPF review burn** | | | **~$0.24** |

---

## Carry-forward items (NOT blocking this PR)

These were surfaced by Codex/Gemini but deferred to keep this PR surgical:

1. **persona_depth_score nullability** (G-MIN-1) — model may hallucinate scores when not legitimately able to provide one. Would require schema `["integer", "null"]` + parseReviewerJson update + personaDepthGap null-handling.
2. **output_parsed/message.parsed preference** (C-CRIT-2) — defensive fallback to SDK-parsed-fields before string parsing. Not blocking; happy path uses output_text.
3. **chat.completions json_schema fallback** (C-MAJ-3, sharpened by v3 fidelity-QA observation) — add try/catch wrapping chat.completions with json_schema → on 400 invalid_request, retry with json_object.
4. **Mocked-SDK unit tests for transport** (C-MAJ-4) — use existing `__overrideSdkLoadersForTesting()` to write tests covering: Responses API json_schema happy path, chat.completions json_schema happy path, origin enum acceptance/rejection, schema-400 handling.
5. **Smarter retry policy** (C-MIN-2) — schema-driven 400s are deterministic; downgrade to json_object on first 400 invalid_request instead of blind backoff.

---

## Promote checklist (post-approval, pre-merge)

- [x] Sandbox v3 reflects all integrated findings
- [x] pnpm test passes against v3
- [x] Live OpenAI smoke test passes with v3 schema
- [x] Codex fidelity QA approves v3
- [x] MERGE-gate peer-review doc written + reviewed
- [ ] /promote sandbox/plan-transports.ts → agent/lib/plan-transports.ts
- [ ] /promote sandbox/plan-transports-schema-migration-merge-gate-peer-review.md → Documentation/
- [ ] Stop + restart worker daemon (Stop-Process + Start-ScheduledTask)
- [ ] Verify preflight all-green on new worker process
- [ ] Smoke-test plan-review path with a minimal job submission (optional; can be skipped if cost-conservative)

---

**Approval line for sign-off:**
`MERGE-APPROVED-BY: Claude Opus 4.7 [1m] | mode=NORMAL | reviewers=Gemini-3.1-pro-preview,GPT-5 | topology=sequential | revision=v3-post-codex-fidelity | date=2026-05-31`
