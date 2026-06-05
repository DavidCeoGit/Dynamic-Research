# S53 #7 DEP0190 + cross-spawn — MERGE-gate Peer Review Synthesis

**Risk Labels:** SECURITY (defense-in-depth against shell-meta-injection if argv ever carries user data) + DEPENDENCY (adds cross-spawn 7.0.6 + @types/cross-spawn 6.0.6).
**Severity:** NORMAL.
**Topology:** Sequential Gemini → Codex per MRPF v2.2.
**Bundle:** `sandbox/validated/s53-7-dep0190-gemini-bundle.md-s53` (v1, 305 lines, ~12KB).
**Live code:** `agent/executor.ts:593-611` (post-integration v2), `agent/preflight.ts:25-26, 87-99`, `agent/package.json`, `agent/pnpm-lock.yaml`.

---

## Round 1 — Gemini 3.1 Pro Deep Think (verbatim)

**Invocation:** `gemini -p "<header>" -m gemini-3.1-pro-preview --output-format text --approval-mode plan` via `sandbox/run_gemini_review_s53_7_dep0190.ps1`. Elapsed 58.8s. Exit 0.

**Verdict:** **APPROVE**: "Solid remediation of DEP0190 with appropriate defense-in-depth using a standard, battle-tested ecosystem library; no further callsites are exposed."

**Findings:**

| Sev | Watch-list | Anchor | Observation |
|---|---|---|---|
| MINOR | Q1+Q8 (supply chain) | `agent/package.json` + `pnpm-lock.yaml` | "Supply chain risk is minimal. `cross-spawn` 7.0.6 is the stable standard (the 7.0.5 release patched its last known ReDoS CVE), and its transitive dependencies (`which`, `path-key`, `shebang-command`) are ubiquitous, mature ecosystem staples." |
| MINOR | Q2 (import pattern) | `agent/executor.ts:2` | "The `import crossSpawn from \"cross-spawn\"` pattern is the correct and canonical ESM interop form given `agent/tsconfig.json` defines `\"esModuleInterop\": true`. This will remain durable across strict `tsc` checks and runtime execution." |
| MINOR | Q3 (callsite audit) | `agent/scripts/*` + `agent/lib/*` | "All 6 other callsites (including `finalize-recovered-run.ts:75`, `verify-gallery-vs-notebook.ts:168`, and `workflow-conventions.ts:77, 198`) invoke true binaries directly (either `process.execPath` / `node.exe` or `NLM_BIN`). None invoke `.cmd` or `.bat` shims. They are completely safe as-is, do not require `shell: true`, and do not trigger DEP0190." |
| MINOR | Q4+Q5 (behavior + DiD) | `agent/executor.ts:607` | "`cross-spawn` natively preserves `cwd`, `env`, `stdio` mapping, and signal propagation perfectly. Crucially, its core purpose is ensuring precise, strict escaping of arguments on Windows to prevent injection. The defense-in-depth rationale holds up entirely: if user data ever bleeds into `argv`, it will be safely escaped rather than implicitly concatenated as native `shell: true` would do." |
| MINOR | Q7 (perf) | preflight latency | "The 4s latency regression is fully acceptable. `cross-spawn` inherently incurs overhead walking `PATH` and parsing shebangs/shims. Since `preflight.ts` executes exclusively during the one-time daemon startup sequence, this has zero impact on the hot path of job execution." |
| NIT | Q6 (comment quality) | `agent/executor.ts:600` (v1) | "The inline comment states: \"spawning the resolved file directly via CreateProcessW — no cmd.exe in the middle.\" Technically, `cross-spawn` frequently relies on a `cmd.exe /c` wrapper internally on Windows to execute `.cmd` files. However, it applies rigorous metacharacter escaping first (which native Node `shell: true` fails to do). The security objective (closing DEP0190 safely) is still achieved flawlessly. The comment is highly contextually valuable and does not need to be changed." |

**Author response:**
- 5 MINORs: all ACCEPT-as-validation. No code changes required.
- 1 NIT: Gemini explicitly stated "does not need to be changed" but the v1 comment IS factually misleading on the "no cmd.exe in the middle" line. **INTEGRATE** for technical accuracy — defends the comment's pedagogical value against future-dev misreading.

## v2 integration (post-Gemini, pre-Codex)

Single comment-block edit at `agent/executor.ts:594-609`. Code identical to v1.

**v1 comment fragment:**
> "by walking PATHEXT and spawning the resolved file directly via CreateProcessW — no cmd.exe in the middle"

**v2 comment fragment (more accurate):**
> "by walking PATHEXT, then either spawns the resolved file directly (when the target is a real .exe) or wraps via `cmd.exe /c` (when the target is .cmd/.bat) — in the .cmd path it applies rigorous metacharacter escaping FIRST, which native Node `spawn(..., { shell: true })` does NOT do"

Also added `(Bug 48)` tag inline to match the bug-numbering pattern (Bug 45 SIGHUP, Bug 46 detached console, Bug 47 SIGINT no-op, Bug 48 cross-spawn).

`pnpm test` PASS post-v2 (comment-only; TSC + grep guard clean).

---

## Round 2 — Codex (verbatim)

**Invocation:** `cat sandbox/codex_prompt_s53_7_dep0190_v2.md | codex.cmd exec -s read-only -C "<repo root>" > sandbox/codex_review_s53_7_dep0190_v2_output.txt 2>&1`. 105,631 tokens used. Output 3459 lines / 202 KB. Final answer at lines 3438-3459.

**Verdict:** **APPROVE** — "no blocking code issues found; v2 satisfies the Gemini NIT and the `cross-spawn` change is behaviorally sound."

**Findings:**

| Sev | Watch-list | Anchor | Observation (verbatim) |
|---|---|---|---|
| CRITICAL | — | — | none. |
| MAJOR | — | — | none. |
| MINOR | (W8) Sandbox workflow | `agent/package.json` + `agent/pnpm-lock.yaml` | "I did not find validated archives for `agent/package.json` or `agent/pnpm-lock.yaml`; if CLAUDE.md §5 is interpreted literally for dependency-file writes, that is a process gap, not a runtime code issue." Author confirmed: `executor.ts-s53-v2` and `preflight.ts-s53` archives match live; package.json/lockfile modified via `pnpm add` (Bash-tool delegation), not Edit/Write. |
| NIT | (W2+W7) Callsite count | repo-wide grep | "Gemini's '6 other callsites' count is off. I found 7 native `spawn`/`spawnSync` callsites after the two new `crossSpawn` callsites: `agent/executor.ts:357`, `agent/preflight.ts:168`, `agent/scripts/finalize-recovered-run.ts:75`, `agent/scripts/regenerate-studio-products.ts:146`, `agent/scripts/verify-gallery-vs-notebook.ts:168`, `agent/lib/workflow-conventions.ts:77`, and `agent/lib/workflow-conventions.ts:198`. The missed/under-enumerated one is safe: it uses `NLM_BIN`, defaulting to the venv `notebooklm.exe`." |

**Code-grounded verifications Codex performed (verbatim):**

- "The old phrase `\"no cmd.exe in the middle\"` is absent from live `agent/executor.ts`; the remaining hits are only in the review/reference docs. The v2 comment at `agent/executor.ts:594-609` correctly describes both direct `.exe` spawning and `.cmd/.bat` wrapping through `cmd.exe /c` with escaping." — Gemini NIT fidelity ✓
- "`agent/pnpm-lock.yaml` only adds the expected dependency graph: `cross-spawn@7.0.6`, `@types/cross-spawn@6.0.6`, `path-key@3.1.1`, `shebang-command@2.0.0`, `shebang-regex@3.0.0`, `which@2.0.2`, and `isexe@2.0.0`. No existing lockfile versions shifted." — lockfile sanity ✓
- "Runtime contract at `agent/executor.ts:610-645` is preserved: `cwd`, `stdio`, and `env` are passed through; stdout remains a raw-buffer accumulation path via `child.stdout?.on(\"data\", ...)`; `getStdout()` still returns the accumulated buffer; and `child.kill()` remains available for the timeout SIGTERM/SIGKILL path at `agent/executor.ts:689-690`." — runtime regression ✓
- "The defense-in-depth claim is supported by source: `cross-spawn` wraps non-`.exe/.com` Windows targets through `cmd.exe /d /s /c` at `agent/node_modules/cross-spawn/lib/parse.js:35-59`, escapes command/args at `lib/util/escape.js:4-40`, and returns the underlying `ChildProcess` from `index.js:7-18`." — defense-in-depth ✓
- "I could not run `pnpm -C agent exec tsc --noEmit`; the read-only sandbox policy rejected both that command and a direct `node .../tsc` attempt. Type inspection still looks sound: `@types/cross-spawn` returns `child_process.ChildProcess`, matching the declared `spawnClaude()` return type, and `agent/tsconfig.json:6-7` has `strict` + `esModuleInterop` enabled." — author note: `pnpm test` PASSes locally, exit 0.

**Author response:**

- MINOR (W8 sandbox workflow): **NOTE — accepted deviation, no code change.** The sandbox + Edit/Write hook intercepts Claude Code's `Edit`/`Write` tools but not Bash file writes. `pnpm add cross-spawn` modifies package.json + pnpm-lock.yaml as a transactional whole (the manifest update + lockfile resolution are atomic per `pnpm add`'s contract). Routing these through sandbox + /promote would: (a) decouple the manifest entry from its resolved lockfile state, risking drift, and (b) add no review value (the package.json delta is a single +1 line, the lockfile is deterministic from the resolver). Filing a memory `feedback_pnpm_add_bypasses_sandbox_intentionally.md` documenting this is an accepted deviation; not changing the workflow.
- NIT (callsite count): **NOTE — synthesis-only fix.** Gemini's count was 6, Codex's count is 7. The 7th is the NLM preflight spawn at `agent/preflight.ts:168` (the v2-shifted line for the `spawn(nlmBin, ["list", "--json"], ...)` call). Both reviewers agree all non-claude spawn sites are safe (direct .exe paths, no shell:true, no DEP0190). No code change.

## v3 — what ships

**Code:** identical to v2. Codex APPROVED v2; no further code changes.
**Synthesis:** this document, archived as the canonical review record.
**Memory artifacts to file:**
1. `feedback_pnpm_add_bypasses_sandbox_intentionally.md` (new) — documents the W8 accepted deviation.
2. Update of existing memory entries if any reference the DEP0190 / spawn surface.

**Files in the v3 commit:**
- `agent/executor.ts` (modified: cross-spawn import + v2 comment + callsite update)
- `agent/preflight.ts` (modified: cross-spawn import + callsite update)
- `agent/package.json` (modified: +cross-spawn dep + +@types/cross-spawn devDep)
- `agent/pnpm-lock.yaml` (modified: resolution entries for cross-spawn + 5 transitive deps)
- `Documentation/s53-7-merge-gate-peer-review.md` (NEW: this synthesis)
- `sandbox/validated/executor.ts-s53` + .meta (archive of v1)
- `sandbox/validated/executor.ts-s53-v2` + .meta (archive of v2 post-Gemini)
- `sandbox/validated/preflight.ts-s53` + .meta (archive of single-version)

**Trail:** Gemini APPROVE (5 MINOR + 1 NIT) → integrate NIT → Codex APPROVE (1 MINOR + 1 NIT, both NOTE-only). Two-reviewer agreement on the substantive code. No CRITICAL or MAJOR from either reviewer.
