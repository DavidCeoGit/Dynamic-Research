# Dependency Exceptions Register

Formal entries for known CVEs that have been intentionally deferred (not closed) with explicit risk acceptance + revisit conditions. Updated whenever a new exception is granted or an existing one is retired.

Compliance scanners (Dependabot, Snyk, GitHub Advanced Security) should treat entries here as **acknowledged-and-deferred**, not unaddressed. Each entry includes the package, the advisory, the exploit-surface analysis that justified deferral, the expected resolution path, and the revisit date.

Process: deferrals must be re-evaluated whenever (a) the package is bumped, (b) the resolution path becomes available, or (c) the revisit date arrives — whichever first.

---

## Active exceptions

### `postcss` XSS via `</style>` unescaping (GHSA-qx2v-qp2m-jg93)

| Field | Value |
|---|---|
| Package | `postcss` |
| Affected versions | `< 8.5.10` |
| Patched versions | `>= 8.5.10` |
| Advisory | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) |
| Severity | moderate (CVSS 6.1) |
| Resolution path | Indirect via `next > postcss` transitive. Closing requires EITHER `next` shipping a postcss bump (Next 16.2.7+, not yet released) OR a pnpm `overrides` block forcing `postcss@>=8.5.10` in `frontend/package.json`. |
| Deferral rationale | The advisory exploits server-side runtime CSS compilation where user-controlled input flows into postcss output rendered as HTML. This codebase uses Tailwind 4 build-time compilation only. No runtime postcss pipeline. No user-supplied CSS surface. No path from user input to postcss output. Exploit surface ≈ 0. |
| Deferred by | Claude Opus (S52 #2 MERGE-gate, 2026-05-24) — Gemini Deep Think + Codex GPT-5.5 xhigh both APPROVED the deferral judgment under the multi-reviewer policy framework v2.2 |
| Revisit conditions | (a) When `next` releases 16.2.7+ — bump immediately AND verify postcss transitive resolves to `>= 8.5.10`. (b) If any code path is introduced where user-supplied content can flow into postcss processing (no current plan to). (c) Scheduled re-check: 2026-08-24 (quarterly cadence) if Next hasn't shipped sooner. |
| Tracking | S52 priority queue + `dryrun_handoff.md` + this register |

---

## Retired exceptions

_(none yet)_
