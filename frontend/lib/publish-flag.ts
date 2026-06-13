/**
 * Frontend mirror of agent/lib/publish-gate.ts `isPublishFlagSet` (S120
 * coercion harmonization).
 *
 * The frontend cannot import from agent/ (separate tsconfig roots) — mirroring
 * is an established, already-reviewed project pattern (storage-paths.ts,
 * untrusted-input.ts pairs). Behavioral parity against the real agent export
 * is enforced by test/publish-flag-parity.test.ts, which imports BOTH live
 * functions and runs the same value matrix.
 *
 * Keep this file pure (no imports) so the cross-root parity test and any
 * consumer can pull it without dragging in agent/frontend module graphs.
 */

/**
 * Canonical STRICT publish-flag predicate. Accepts ONLY `true` and `"true"`
 * (case/space-insensitive). Deliberately does NOT accept `"on"` / `"1"` /
 * `"yes"` — a raw-HTML-checkbox path normalizes its `"on"` at its own endpoint,
 * keeping this predicate free of producer quirks. Accepting the string `"true"`
 * makes the downstream gate fire MORE often (the fail-closed direction); a
 * string silently reading as false would be the fail-open this closes.
 */
export function isPublishFlagSet(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/**
 * Clone/replay prefill decision (S120 Defect C — Codex C1). A Clone & Edit of a
 * publish-bound parent must default the new run's checkbox CHECKED, never
 * silently downgrade out of the MRPF PUBLISH gate. The S118 fix read a SINGLE
 * source (`state.userContext.publishRequired`) that the worker never writes —
 * a no-op against real runstate. The correct fix ORs every available source
 * through the strict predicate:
 *   - `queueRowUserContext.publishRequired` — the authoritative DB jsonb (set
 *     at submit; matches the replay route's precedent). Absent for legacy
 *     storage-only runs with no queue row.
 *   - `statePublishRequired` — the pipeline-declared top-level state flag; the
 *     fallback for legacy no-row runs (DB-only would downgrade them).
 *   - `stateUserContextPublishRequired` — the legacy state.userContext echo;
 *     included for completeness (state-only is insufficient on its own because
 *     the worker can write publish_required:false for a DB string "true").
 *
 * The function enumerates its sources explicitly so the source-selection bug
 * (reading the wrong field) is structurally pinned by its tests, not just the
 * boolean coercion.
 */
export function resolveClonePublishRequired(args: {
  queueRowUserContext?: { publishRequired?: unknown } | null;
  statePublishRequired?: unknown;
  stateUserContextPublishRequired?: unknown;
}): boolean {
  return (
    isPublishFlagSet(args.queueRowUserContext?.publishRequired) ||
    isPublishFlagSet(args.statePublishRequired) ||
    isPublishFlagSet(args.stateUserContextPublishRequired)
  );
}
