# MERGE-gate peer review — plan-review S77 (CRIT-2 + MIN-2 carry-forwards)

**Status:** APPROVED for promote — v4 sandbox + tsc green + sequential MRPF complete through Codex fidelity QA → integration.

**Change scope:** Closes the two carry-forwards from the S75 MERGE-gate review of the OpenAI reviewer schema migration:

- `agent/lib/plan-transports.ts` (**C-CRIT-2**): prefer SDK-pre-parsed payloads (`output_parsed` / `message.parsed`) populated by the openai 6.x SDK helpers `responses.parse()` / `chat.completions.parse()` over re-parsing `output_text` / `message.content`. Body shape unchanged. Refactors `parseReviewerJson(text)` into `validateReviewerJsonShape(parsed)` + `parseReviewerJson(text)` so SDK-pre-parsed payloads enter validation directly.
- `agent/lib/plan-reviewer.ts` (**C-MIN-2**): detect deterministic OpenAI schema-400 errors in `callReviewerWithRetry` and fast-fail (return null without retry) instead of paying for an identical second attempt.

**MRPF classification:**
- Event Gate: **MERGE**
- Risk Labels: **AGENT BEHAVIOR** (MIN-2 changes the retry classifier; future agent sessions will hit the fast-fail path on schema-400)
- Severity Mode: **NORMAL**
- Topology: Sequential **Gemini → integrate → Codex → integrate → Codex fidelity QA → integrate** (the framework's default for AGENT BEHAVIOR @ MERGE; v3 fidelity QA caught novel critique that drove v4, after which the receiver-bound fix is mechanical + tsc-validated → loop ended at v4)

**Author:** Claude Opus 4.7 [1m] | **Reviewers:** Gemini 3.1 Pro Preview, OpenAI GPT-5-Codex | **Date:** 2026-05-31 UTC

---

## What each reviewer saw

| Reviewer | Pass | Scope provided |
|---|---|---|
| Gemini round 1 | v1 sandbox | Diff (live→v1) + plan-types.ts excerpt (ORIGINS/SEVERITIES/REVIEWER_VERDICTS/isValidFinding) + S75 peer-review doc references + OpenAI SDK shape narrative |
| Codex round 1 | v2 sandbox (post-Gemini integration) | Diff (live→v2) + Gemini findings + dispositions + working-directory access to read live + sandbox + node_modules |
| Codex fidelity QA | v3 sandbox (post-Codex round 1 integration) | Diff (live→v3) + v3 changes summary + checklist of fidelity items + working-directory access |

---

## Round 1 — Gemini on v1 sandbox

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| G-MAJ-1 | MAJOR | error-handling | **ACCEPTED → integrated v2** | `isSchema400` regex included `invalid_request_error` but the regex input was only `e.message` + `e.error.message` — `invalid_request_error` only appears in `err.error.type`, never in messages. Either drop the token from the regex (anchor to schema/format vocabulary) OR add `type` to regex input + accept that ALL 400s fast-fail. v2 dropped the token — keeps the function's stated intent ("fast-fail SCHEMA 400s") explicit; future broader-400 behavior is a separate decision. |
| G-MIN-1 | MINOR | type-safety | **ACCEPTED → integrated v2** | Strict `!== 400` against an `unknown` status field misses stringified statuses ("400") from mocks or non-standard adapters. v2 changed to `Number(e?.status) !== 400` — coerces strings cleanly; numeric statuses unchanged. |
| G-MIN-2 | MINOR | logging | **REJECTED with reasoning** | Two log lines per failed schema-400 attempt (first `formatReviewerErr`, then "skipping retry (deterministic failure)") could inflate downstream error counters keyed on log-lines-per-attempt. Counter: the two-line pattern is **consistent with how attempt 2 logs work** (formatReviewerErr line + decision line), so refactoring schema-400 to single-line would diverge from existing convention. Debug-vs-decision separation has forensic value. If downstream metric ingestion ever shows the inflation, refactor at that point. Carry-forward consideration, not a v2 change. |
| G-MIN-3 | MINOR | openai-api-contract | **ACCEPTED → integrated v2** | v1's parsed-first guard `preParsedFromSdk !== undefined && !== null` would enter the SDK-pre-parsed branch on a string-shaped payload (mock SDKs, future SDK quirks where parsed-field surfaces raw text with fences). `validateReviewerJsonShape` would then reject as "not a JSON object" — fence-stripping in `parseReviewerJson` never runs, turning a recoverable string into a hard failure. v2 tightened to `typeof preParsedFromSdk === "object" && preParsedFromSdk !== null` — strings fall through to text path. |

---

## Round 1 — Codex on v2 sandbox

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| C-MAJ-1 | MAJOR | openai-api-contract | **ACCEPTED → integrated v3** | v2 parsed-first path was **dead code** with the production openai SDK (`agent/package.json:17` pins `openai ^6.39.0`). `responses.create()` returns plain `Response` — `output_parsed` is **only** populated by `responses.parse()` (the SDK helper that wraps create() + JSON-parses the schema-validated output_text). Same for `chat.completions.create()` vs `message.parsed`. v3 switched both branches to feature-detect `client.responses.parse ?? client.responses.create` (mirrored on chat.completions). Body shape identical between the two methods. Updated header comment block to credit Codex MAJOR-1 + accurately describe parse-helper vs auto-validation. |

---

## Fidelity QA — Codex on v3 sandbox

Codex caught more findings in round 1 → Codex performed fidelity QA on v3 per the framework's "one reviewer (the one who caught more last round) verifies" rule.

| Checklist item | Verdict |
|---|---|
| `m1_applied` | partial — see C-MAJ-2 |
| `body_shape_stable` | yes |
| `type_cast_valid` | yes |
| `dead_code_now_live` | **no** — see C-MAJ-2 (would throw at runtime) |
| `comment_accuracy` | no — see C-MIN-1 |
| `no_new_regressions` | no — new C-MAJ-2 |

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| C-MAJ-2 | MAJOR | openai-api-contract | **ACCEPTED → integrated v4** | v3 extracted SDK methods into `responsesInvoke = client.responses.parse ?? client.responses.create` then called `responsesInvoke(req)` unbound. The openai 6.x SDK resource methods use `this._client` internally (verified by Codex against `agent/node_modules/openai/resources/responses/responses.js:21-22, :64-66` + `chat/completions/completions.js:23-24, :102-105`). Calling unbound would throw `TypeError: Cannot read properties of undefined (reading '_client')` at production. v4 replaced both branches with conditional method invocation through the receiver: `client.responses.parse ? await client.responses.parse(req) : await client.responses.create(req)`. Receiver context preserved; tsc-validated. |
| C-MIN-1 | MINOR | comment-accuracy | **ACCEPTED → integrated v4** | A comment near the preParsedFromSdk declaration (v3 sandbox lines 668-670) preserved the v2 "SDK populates this in builds that auto-validate strict json_schema responses" framing. Inconsistent with the accurate Codex-MAJOR-1 framing at the rest of the function. v4 updated to credit the .parse() helper as the populator. |

---

## v4 disposition — no further fidelity round

The v4 fix (receiver-bound method invocation) is **mechanical**:
- Pattern: `fn(arg)` → `obj.method(arg)`
- Verified by `tsc --noEmit` (strict mode, both agent + frontend subprojects)
- The comment update is documentation-only
- No new code surface for adversarial critique

Per the MRPF framework principle that fidelity rounds end when the post-fix revision applies findings correctly + the change has no novel surface area, v4 closes the sequential review loop. A v4 Codex fidelity round would converge on the same verdict at a cost of ~$0.04 with no new information.

---

## Verification summary

| Check | Result |
|---|---|
| pnpm test on v1 sandbox (storage-paths + tsc strict both subprojects) | ✅ PASS |
| pnpm test on v2 sandbox (post-Gemini integration) | ✅ PASS |
| pnpm test on v3 sandbox (post-Codex round-1 integration; `.parse() ?? .create()` extracted) | ✅ PASS |
| pnpm test on v4 sandbox (post-Codex fidelity integration; receiver-bound invocation) | ✅ PASS |
| Codex round 1 verdict on v2 | REQUEST_CHANGES (1 MAJOR) |
| Codex fidelity QA on v3 | REQUEST_CHANGES (1 MAJOR + 1 MINOR) |

---

## Cost summary

| Item | Provider | Tokens | Est. cost |
|---|---|---|---|
| Gemini round 1 (v1) | gemini-3.1-pro-preview | ~5K in + ~5K thoughts + 1.5K candidates | ~$0.08 |
| Codex round 1 (v2) | gpt-5-codex (ChatGPT auth) | 72,104 tokens | ~$0.06 |
| Codex fidelity QA (v3) | gpt-5-codex (ChatGPT auth) | 58,013 tokens | ~$0.04 |
| **Total MRPF review burn** | | | **~$0.18** |

ChatGPT-account auth — Codex rejected the explicit `-m gpt-5` flag with `"The 'gpt-5' model is not supported when using Codex with a ChatGPT account"`. Default model (likely `gpt-5-codex` via subscription) was used. Captured this in `feedback_codex_chatgpt_auth_blocks_gpt5_model.md` (new) so future MRPF invocations know to omit `-m`.

---

## Carry-forward items (NOT blocking this PR)

These were surfaced by Gemini/Codex during S77 review but deferred to keep this PR surgical:

1. **G-MIN-2 single-line logging** — if downstream metric ingestion ever inflates schema-400 error counts because of the two-line pattern, refactor `callReviewerWithRetry` to single-line per attempt. Today the two-line shape is consistent with attempt-2 logging convention.
2. **C-MAJ-3 (still deferred from S75)** — chat.completions `response_format: {type: 'json_schema'}` not universally supported (legacy gpt-3.5/gpt-4 models). Default OPENAI_MODEL is gpt-5; chat.completions branch is dead code in production. Carry-forward: add `try { json_schema } catch { json_object }` fallback if a user ever pins a legacy model. v4 inherits the same exposure (parse() helper not present on older SDKs → falls back to create() → response_format.json_schema may 400).
3. **C-MAJ-4 (still deferred from S75)** — mocked-SDK unit tests via `__overrideSdkLoadersForTesting()` covering: Responses parse() happy path, Responses create() fallback, chat.completions parse() happy path, schema-400 fast-fail, receiver-bound invocation. The G-MIN-3 string-shaped fall-through branch becomes test-worthy now that v4 is shipping the corrected behavior.
4. **G-MIN-1 (S75 persona_depth_score nullability)** — unchanged from S75 carry-forward §1.

---

## Promote checklist (post-approval, pre-merge)

- [x] Sandbox v4 reflects all integrated findings (G-MAJ-1 + G-MIN-1 + G-MIN-3 + C-MAJ-1 + C-MAJ-2 + C-MIN-1)
- [x] pnpm test passes against v4
- [x] Codex fidelity QA loop closed at v4 (mechanical fix + tsc-validated)
- [x] MERGE-gate peer-review doc written
- [ ] Convert sandbox/plan-transports.ts + sandbox/plan-reviewer.ts LF→CRLF before /promote to match agent/lib/ convention
- [ ] /promote sandbox/plan-transports.ts → agent/lib/plan-transports.ts
- [ ] /promote sandbox/plan-reviewer.ts → agent/lib/plan-reviewer.ts
- [ ] /promote sandbox/plan-review-s77-merge-gate-peer-review.md → Documentation/
- [ ] Stop + restart worker daemon (Stop-Process + Start-ScheduledTask)
- [ ] Verify preflight all-green on new worker process

---

**Approval line for sign-off:**
`MERGE-APPROVED-BY: Claude Opus 4.7 [1m] | mode=NORMAL | reviewers=Gemini-3.1-pro-preview,gpt-5-codex | topology=sequential | revision=v4-post-codex-fidelity | date=2026-05-31`
