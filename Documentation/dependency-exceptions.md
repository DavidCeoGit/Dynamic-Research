# Dependency Exceptions Register

Formal entries for known CVEs that have been intentionally deferred (not closed) with explicit risk acceptance + revisit conditions. Updated whenever a new exception is granted or an existing one is retired.

Compliance scanners (Dependabot, Snyk, GitHub Advanced Security) should treat entries here as **acknowledged-and-deferred**, not unaddressed. Each entry includes the package, the advisory, the exploit-surface analysis that justified deferral, the expected resolution path, and the revisit date.

Process: deferrals must be re-evaluated whenever (a) the package is bumped, (b) the resolution path becomes available, or (c) the revisit date arrives — whichever first.

---

## Active exceptions

_(none — the postcss exception was closed and retired in S97, see below.)_

---

## Retired exceptions

### `postcss` XSS via `</style>` unescaping (GHSA-qx2v-qp2m-jg93) — RETIRED S97 (2026-06-05)

**Closure:** Forced `postcss` to `^8.5.15` (resolved 8.5.15, ≥ patched 8.5.10) via a `pnpm.overrides` block in `frontend/package.json`. Both vulnerable instances now resolve to 8.5.15; zero `postcss < 8.5.10` edges remain in `frontend/pnpm-lock.yaml`.

**Why the override (not a Next bump):** The original resolution path (a) — "wait for Next 16.2.7+ to ship a postcss bump" — turned out to be **dead**. Verified against the npm registry that `next@16.2.7` exists but still declares `dependencies.postcss = 8.4.31`, identical to 16.2.6. Next did not bump postcss. So resolution path (b), the `pnpm.overrides` block, was taken. Pre-change the lockfile carried TWO vulnerable instances: `postcss@8.4.31` (pulled by `next`, pinned exactly) and `postcss@8.5.9` (pulled by `@tailwindcss/postcss@4.2.2`, range `^8.5.6`). The override lifts both to 8.5.15.

**Verification:** `pnpm install` consolidated postcss (`+1 -3`); lockfile grep confirms only `postcss@8.5.15`; `next@16.2.6` and `@tailwindcss/postcss@4.2.2` both resolve to 8.5.15 (latter's `^8.5.6` range satisfied); `pnpm test` GREEN (264 tests + dual `tsc`); `pnpm build` (real `next build`) GREEN through the Tailwind 4 + postcss pipeline. Stale local `node_modules` hoist (an April-14 8.5.9 leftover) cleaned via re-hoist — committed lockfile was always clean.

**MERGE-gate review (MERGE × DEPENDENCY, NORMAL — sequential Gemini → Codex per CLAUDE.md §11):**
- **Gemini 3.1 Pro:** APPROVE, 0 blocking. `pnpm.overrides` enforces resolution globally (transitive/peer/optional included); 8.4.31→8.5.15 is an API-stable minor; `next build` confirms compatibility; lockfile pins CI so no drift.
- **Codex (gpt-5.5, read-only sandbox, filesystem-grounded):** APPROVE, 0 blocking. Confirmed on disk: only `postcss@8.5.15` in lockfile; `next@16.2.6` resolves to it despite its exact pin (intended override behavior); tailwind range satisfied; GHSA fixed at 8.5.10 per OSV so `^8.5.15` cannot resolve vulnerable.

**Carry-forward debt (low):** The override is forward-looking debt — it would block a future legitimate `postcss@9` adoption and should be removed once `next` natively ships a patched postcss dependency. Both reviewers flagged this; keep the `pnpm.overrides` block until then, and keep the storage-paths grep guard / `pnpm test` as the regression net.

| Field | Value |
|---|---|
| Package | `postcss` |
| Affected versions | `< 8.5.10` |
| Patched versions | `>= 8.5.10` |
| Advisory | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) |
| Severity | moderate (CVSS 6.1) |
| Original deferral | Claude Opus (S52 #2 MERGE-gate, 2026-05-24) — Gemini Deep Think + Codex GPT-5.5 xhigh both APPROVED the deferral judgment (no runtime postcss pipeline; Tailwind 4 build-time only; exploit surface ≈ 0). |
| Closed by | Claude Opus 4.8 (S97 MERGE-gate, 2026-06-05) — `pnpm.overrides` → `postcss@^8.5.15`; Gemini 3.1 Pro + Codex gpt-5.5 both APPROVE. |
| Resolution mechanism | `pnpm.overrides` (resolution path (b)); resolution path (a) "Next ships a postcss bump" confirmed dead — 16.2.7 still pins 8.4.31. |
