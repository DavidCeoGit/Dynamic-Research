# Sweep-hardening trio — MERGE-gate peer review synthesis (S111, 2026-06-11)

**Change:** `agent/lib/staging-sweep.ts` + `agent/test/staging-sweep.test.ts` —
three coupled robustness fixes to the S106 staging-TTL sweep (the GC backstop
that deletes abandoned attachment-upload drafts from Supabase Storage).

**Branch:** `fix/sweep-hardening` (off `dev`). **Suite:** 424 (359 agent + 65
frontend), `tsc --noEmit` clean, EXIT 0.

## MRPF classification

- **Event Gate:** MERGE.
- **Risk Labels:** **DATA** (the module deletes storage objects; destructive
  op). The destructive CORE is unchanged by this PR — expiry predicate
  (`stampMs < cutoffMs`), the `<uuid>/uploads/<uuid>/` UUID-shape scope guard,
  dry-run, and bulk-delete batching are identical to S106. The changes are to
  CADENCE and COVERAGE-COMPLETENESS. Both reviewers independently confirmed no
  path deletes a non-expired file or a file outside the staging scope.
- **Severity Mode:** NORMAL.
- **Topology:** Sequential — Gemini (holistic-adversarial) → integrate → Codex
  (grounded-adversarial) → integrate → Codex QA (fidelity) → integrate → Codex
  re-QA → PASS. Both reviewers prompted to try-to-BLOCK within their lens.
- **Automated test coverage (required answer for a DATA-labeled change):** yes
  — 18 unit tests in `agent/test/staging-sweep.test.ts` pin every behavior,
  including each reviewer finding's fix. (`node --test`, not vitest.)

## What each reviewer saw

- **Gemini 3.1 Pro (holistic-adversarial):** full text of the v1 `staging-sweep.ts`
  + the v1 test file, embedded in the prompt; module/system context; no repo
  browse.
- **Codex (grounded-adversarial, `codex exec -s read-only`, ChatGPT auth):** read
  the integrated **v2** working-tree files directly (`staging-sweep.ts`,
  `staging-sweep.test.ts`) + worker.ts, cleanup CLI, conventions.json. Could not
  run tests (sandbox policy blocks exec) — source-grounded counterexamples.
- **Codex QA / re-QA:** read the integrated **v3** then **v4** working-tree files;
  fidelity verification of each prior finding's fix.

## Findings and resolution

### Gemini (on v1)
1. **BLOCKING — hierarchical pagination permanently drops child cursors.** An
   empty-by-default `nextCursors` dropped saved cursors for nested prefixes
   skipped when an ANCESTOR paginated past them → deep tails starved forever.
   **FIXED (v2):** seed `nextCursors = { ...inCursors }`; a 3-state list outcome
   drives `record()` — truncated→set, exhausted→clear, error→leave; unvisited→
   inherited. Test: "inherited cursor under a TRUNCATED parent is preserved."
2. **MAJOR — "per-sweep work still capped" claim false (unbounded fan-out).**
   See deferred #4 below (same issue Codex re-raised).
3. **MINOR — offset-shift transient skip on deletions.** Gemini confirmed it is
   transient-then-wraps, not permanent. **DOC (v2):** comment at the offset
   computation.
4. **NIT — disk-broken + crash-loop double-fault.** Gemini: acceptable residual.
5. **NIT — pre-write crash idempotency.** Gemini: logic sound (confirms item 2).

### Codex (grounded, on v2)
1. **BLOCKING — marker-write failure still fails open after PID rotation.** The
   in-memory backoff resets on cron respawn, so a persistently failed marker
   write re-swept once per respawn. **FIXED (v3):** `writeMarker()` returns a
   boolean; the durable marker is CLAIMED before the sweep, and a failed claim
   **FAILS CLOSED** (skip + log; a GC backstop can wait for a healthy disk). The
   in-memory backoff still paces a single process so a broken disk doesn't
   re-attempt every 30s tick. Test: "marker write failure FAILS CLOSED."
2. **MAJOR — inherited child cursor leaks forever after the child folder is
   deleted.** My v2 "self-heals" comment was false (the parent never re-lists a
   gone child). **FIXED (v3→v4):** `pruneOrphans()` deletes orphaned descendant
   cursors when a parent listing EXHAUSTS — guarded to **offset-0 (complete)
   passes only** (see QA below). Tests: "orphaned cursor under a COMPLETE
   EXHAUSTED parent is pruned" + the resumed-no-prune QA test.
3. **MAJOR — 24h clock not restarted at completion.** A >24h sweep was
   immediately due again. **FIXED (v3):** stamp a `finishedAt` (via an
   injectable `clockFn`) into the post-sweep marker + backoff. Test:
   "post-sweep marker stamps COMPLETION time, not start."
4. **MAJOR — unbounded total fan-out blocks job polling.** Both reviewers
   flagged this (Gemini #2). MAX_PAGES caps per-PREFIX listing, not total sweep
   work, and the worker awaits the sweep on its idle tick. **DEFERRED by the
   human owner** to a dedicated follow-up PR (a per-sweep request budget with
   tree-position resume). Rationale: drafts cap at `ATTACHMENT_MAX_FILES` files;
   jobs run 30–50 min so a sub-minute pickup delay is immaterial; the sweep runs
   only on idle ticks; marker-before-sweep already prevents a runaway sweep from
   crash-looping the worker; and a naive budget that aborts mid-tree WITHOUT
   position resume would reintroduce the tail starvation item 3 just fixed.
   Documented as a `KNOWN LIMITATION` block in the module docstring + an inline
   comment (not a silent cap). **Owed: follow-up PR.**

### Codex QA (on v3) → fixed in v4
- **NEW BLOCKING — prune ran on a resumed-then-exhausted parent.** `listPrefix`
  can return `"exhausted"` after starting from a nonzero resume offset, having
  seen only the tail; pruning then dropped cursors for children before the
  resume offset → reintroduced starvation. **FIXED (v4):** `pruneOrphans` is
  gated on `status === "exhausted" && startOffset === 0` (a genuine complete
  pass) at both the root and uploads levels. The deleted-child leak still closes
  on the next full offset-0 pass after the cursor wraps. Test: "a RESUMED-then-
  exhausted parent does NOT prune sibling cursors."
- **Test gap — completion-time not pinned.** **FIXED (v4):** the `clockFn`
  advancing-clock test (above).

### Codex re-QA (on v4)
- **PASS** — prune guard VERIFIED (both call sites), completion-time test
  VERIFIED, no new regression. QA-BLOCKING-CLOSED: yes.

## Disagreements
None unresolved. #4 (fan-out) is a both-reviewer MAJOR deferred by the human
owner with recorded rationale + a tracked follow-up; all other findings were
fixed and verified.

## Residual / follow-up
- **Per-sweep request budget with tree-position resume** (closes Gemini #2 /
  Codex #4). Its own focused PR + MERGE gate.
- Negligible marker leak: an `<org>/uploads` cursor for an org deleted while a
  truncated parent never re-does a full pass persists until the next offset-0
  pass — bounded, self-healing, ~bytes.
