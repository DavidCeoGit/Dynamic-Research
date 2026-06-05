# MERGE-gate peer review — plan-review S78 (C-MAJ-3 + C-MAJ-4 carry-forwards)

**Status:** APPROVED for promote — v2 sandbox + tsc green + 35/35 mocked-SDK unit tests pass + sequential MRPF complete (Gemini round 1 → integrate → Codex final APPROVE).

**Change scope:** Closes the last two carry-forwards from the S75/S77 plan-review MERGE-gate sequence:

- `agent/lib/plan-transports.ts` (**C-MAJ-3**): chat.completions `json_schema` → `json_object` fallback. Older OpenAI SDK builds (pre-strict-structured-outputs) and some 3rd-party-hosted OpenAI-compatible endpoints reject the `json_schema` `response_format` with a 400 schema-vocabulary error. The fallback catches that specific 400 (via the same `isSchema400` regex anchors as `plan-reviewer.ts:isSchema400` — `json_?schema|response_format|invalid.*schema|unsupported.*keyword`) and retries via `.create()` with the looser `json_object` shape. Strict-mode constraint enforcement moves back to `parseReviewerJson()` + `isValidFinding()` downstream (the safety net the pre-S75 code relied on). Non-schema 400s + auth/rate/billing errors propagate untouched.
- `agent/test/plan-transports.test.ts` (**C-MAJ-4**): six new mocked-SDK unit tests + one stale-assertion fix. Covers the receiver-bound `.parse() ?? .create()` semantics on both Responses + chat.completions branches + string-shaped `preParsedFromSdk` fall-through to `parseReviewerJson` (S77 G-MIN-3) + four new C-MAJ-3 fallback paths (parse-throws-schema-400, create-throws-schema-400, non-schema-400 propagation, schema-400 with no response_format anchor propagation).

**MRPF classification:**
- Event Gate: **MERGE**
- Risk Labels: **AGENT BEHAVIOR** (the OpenAI reviewer transport runs on every plan-review pass; the fallback path silently changes the reviewer's accepted input-shape contract from strict-enum-on-server to loose-JSON + downstream validation)
- Severity Mode: **NORMAL**
- Topology: Sequential **Gemini → integrate → Codex on integrated v2 → APPROVE** (the framework's default for AGENT BEHAVIOR @ MERGE; loop ended at v2 because Codex APPROVED outright with SDK-source-grounded verification — no further rounds required per the topology rule "one reviewer verifies the LATEST direction")

**Author:** Claude Opus 4.7 [1m] | **Reviewers:** Gemini 3 Pro Preview, OpenAI GPT-5-Codex | **Date:** 2026-06-01 UTC

---

## What each reviewer saw

| Reviewer | Pass | Scope provided |
|---|---|---|
| Gemini round 1 | v1 sandbox | Diff (live→v1) + MRPF classification + S75/S77 prior-round context + `isSchema400` regex anchor narrative |
| Codex round 1 | v2 sandbox (post-Gemini integration) | Diff (live→v2) + Gemini findings + dispositions + working-directory access to read live + sandbox + `agent/node_modules/openai/**` SDK source |

---

## Round 1 — Gemini on v1 sandbox

| ID | Severity | Category | Disposition | Notes |
|---|---|---|---|---|
| G-MAJ-1 | MAJOR | openai-api-contract | **ACCEPTED → integrated v2** | `chatReqLoose` was reconstructed from scratch with only `model`/`messages`/`response_format`. If future code adds `temperature` / `max_tokens` / `seed` to `chatReqStrict`, the fallback would silently drop them. v2 changed to `{...chatReqStrict, response_format: { type: "json_object" }}` so future config inherits automatically. Test guard added: asserts `model` + `messages` parity between captured strict + fallback requests. Cost: 1 line; behavioral-equivalence today, forward-compatible. |
| G-MIN-1 | MINOR | logging | **ACCEPTED → integrated v2** | `console.error` log used `(err as Error)?.message ?? String(err)` which printed `[object Object]` against the SDK's nested `err.error.message` shape (observed in test output before the fix). v2 unwraps `err.error.message` first, then falls back to outer message / String. Operator visibility win on the exact rejection reason. |
| G-MIN-2 | MINOR | code-health | **REJECTED with reasoning** | Surfaced `isSchema400` inline-duplication drift risk between `plan-transports.ts` and `plan-reviewer.ts`. Counter-argument: the duplication is **deliberate and documented** with an explicit cross-reference comment + drift-mitigation language. Extracting to a shared module is **refactor creep beyond the C-MAJ-3 single-file scope** (would push the bundle past pre-auth scope). The cross-reference comment is the contract. Codex round 1 independently endorsed this disposition. Carry-forward consideration: if either site's regex needs to change AND the change applies to both, extract at that point. |

**Gemini verdict on v1:** REQUEST_CHANGES → integrated to v2.

---

## Round 2 — Codex on v2 sandbox (post-Gemini integration)

**Verdict: APPROVE.** No findings of any severity.

Code-grounded SDK verification:

- `chat.completions.parse()` wraps `.create()` and only populates `message.parsed` for `response_format.type === "json_schema"` — confirmed at `openai/resources/chat/completions/completions.js:102` + `openai/lib/parser.js:120`.
- `responses.parse()` mirrors the pattern for `text.format.type === "json_schema"` — confirmed at `openai/resources/responses/responses.js:64` + `openai/lib/ResponsesParser.js:89`.
- Plain `.create()` accepts `json_object` per generated types (`completions.d.ts:1387`, `responses.d.ts:2143`), validating the fallback path's request shape.
- SDK 400s surface as `BadRequestError` with `.status`, `.error`, `.message`, and `.type` (`client.js:449`, `core/error.js:9`) — the mocked error shape `{status:400, error:{type:"invalid_request_error", message:"..."}}` is faithful to the SDK's exposed fields used by `isSchema400`.

Codex endorsement of G-MIN-2 disposition: *"the duplicated `isSchema400` is byte-for-byte aligned with `plan-reviewer.ts` behavior and the cross-reference comment is enough for this scoped transport fallback."*

**Loop ends at v2.** Per MRPF topology table ("MERGE gate, fresh code → Sequential: Gemini first → revise → Codex final on revised version") — sequential round is complete. No v3 needed.

---

## Test summary

Pre-promote verification (post-Codex APPROVE, v2 sandbox swapped into live):

- `pnpm test` (storage-paths antipattern grep + `tsc --noEmit` on agent + `tsc --noEmit` on frontend): **PASS**
- `node --import tsx --test test/plan-transports.test.ts`: **35/35 pass** (29 pre-existing + 6 new + 0 regressions; one stale assertion updated)

New tests landed in this MERGE:

| Test | Branch covered |
|---|---|
| S77 v4: responses.parse() preferred over .create() (receiver-bound) | Responses `.parse() ?? .create()` + receiver capture asserts `this === responses` |
| S77 v4: chat.completions.parse() preferred over .create() (receiver-bound) | chat.completions `.parse() ?? .create()` + receiver capture asserts `this === chat.completions` |
| S77 G-MIN-3: string-shaped preParsedFromSdk falls through to parseReviewerJson | typeof-object guard + fence-stripping fallback path |
| S78 C-MAJ-3: chat.completions schema-400 from .parse() falls back to json_object via .create() | Try/catch + G-MAJ-1 spread-inheritance guard (model+messages parity) |
| S78 C-MAJ-3: chat.completions schema-400 from .create() falls back to json_object via .create() | Same fallback when `.parse()` absent in SDK |
| S78 C-MAJ-3: non-schema-400 chat.completions error propagates without fallback | 429 rate-limit doesn't trigger json_object retry |
| S78 C-MAJ-3: schema-400 with no response_format anchor → propagates | isSchema400 returns false for 400s missing schema anchors (regression guard against masking unrelated 400s) |

Plus updated assertion in the pre-existing "uses Responses API with text.format JSON shape (Codex CRITICAL-2)" test — now asserts the S75 `json_schema` shape (`type`, `name`, `strict`, `schema` typeof object) instead of the stale `json_object` shape that pre-dated S75.

---

## Cost summary

| Round | Reviewer | Approx cost |
|---|---|---|
| 1 | Gemini 3 Pro Preview | ~$0.10 |
| 2 | Codex (gpt-5-codex via ChatGPT subscription) | ~$0.05 (137,991 tokens) |
| **Total MRPF** | — | **~$0.15** |

Well below S78 pre-auth $0.80 early-warning + $1.00 hard ceiling.

---

## Carry-forwards remaining

After S78 promote, S75/S77 plan-review MERGE-gate carry-forward queue is drained except for:

- **G-MIN-1 (S77 deferred)**: `persona_depth_score` nullability — semantic expansion, ~1-2 hours. Separate MERGE-gate when picked up.

Other long-standing carry-forwards (Bug 53b, buildPlanReviewEmail TEMPLATE, MEMORY.md compaction, /pre-work-context-check dogfood feedback collection) are unaffected by this MERGE.
