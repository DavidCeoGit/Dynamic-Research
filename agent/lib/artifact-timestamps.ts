/**
 * Timestamp / anti-stale parsing helpers for the studio-completeness gate.
 *
 * S174 Wave A: extracted VERBATIM from studio-completeness.ts. These pure
 * functions derive a run-start {compact, ms} and an artifact's created-at ms for
 * the gate's anti-stale floor (Codex MERGE CRITICAL-2: reject normalized /
 * impossible dates; never synthesize "now"). deriveRunStart / artifactCreatedAtMs
 * / safeMs are consumed by enforceStudioCompleteness; buildCompact / parseTimestamp
 * stay module-private (their sole callers moved with them).
 */

import type { pickWinners } from "./studio-winner.js";
import type { PipelineState } from "../types.js";
import type { NlmArtifactRef } from "./nlm-artifact-cli.js";

/**
 * Build a compact YYYYMMDD-HHMMSS token from epoch-style components, or null if
 * the components don't form a real calendar date/time (Codex MERGE CRITICAL-2:
 * `new Date(2026, 12, ...)` silently NORMALIZES instead of rejecting). Round-trip
 * validates so an impossible token can't masquerade as a valid run start.
 */
function buildCompact(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): { compact: string; ms: number } | null {
  const dt = new Date(y, mo - 1, d, h, mi, s);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return null;
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi ||
    dt.getSeconds() !== s
  ) {
    return null; // normalized → not a real date
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { compact: `${y}${p2(mo)}${p2(d)}-${p2(h)}${p2(mi)}${p2(s)}`, ms };
}

/**
 * Parse any timestamp form the pipeline emits into {compact, ms}, or null.
 * Accepts compact `YYYYMMDD-HHMMSS`, colon-ISO `YYYY-MM-DDTHH:MM:SS`, AND
 * hyphen-time ISO `YYYY-MM-DDTHH-mm-ss` (Codex MERGE CRITICAL-2 — a shipped
 * worker format the prior code missed and would have synthesized "now" for).
 */
function parseTimestamp(raw: string | null | undefined): { compact: string; ms: number } | null {
  if (typeof raw !== "string" || !raw) return null;
  let m = raw.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/); // compact
  if (m) return buildCompact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})[:-](\d{2})/); // colon- OR hyphen-time ISO
  if (m) return buildCompact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  return null;
}

/**
 * Derive the REAL run-start {compact, ms} for naming + the anti-stale floor.
 * Sources, in order of trust: an on-disk winner's embedded timestamp; a token
 * in any artifacts.<p>.file; state.timestamp. Returns null only when NONE is
 * derivable — in which case the floor degrades to best-effort (never a
 * synthesized "now", which Codex CRITICAL-2 showed would wrongly exclude this
 * run's real artifact).
 */
export function deriveRunStart(
  winners: ReturnType<typeof pickWinners>,
  state: PipelineState,
): { compact: string; ms: number } | null {
  const w = Object.values(winners)[0];
  const fromWinner = parseTimestamp(w?.timestamp);
  if (fromWinner) return fromWinner;

  const arts = state.artifacts as Record<string, { file?: unknown }> | undefined;
  if (arts) {
    for (const v of Object.values(arts)) {
      const fromFile = typeof v?.file === "string" ? parseTimestamp(v.file) : null;
      if (fromFile) return fromFile;
    }
  }
  return parseTimestamp(state.timestamp);
}

/** Artifact created_at → epoch ms, or null if absent/unparseable. */
export function artifactCreatedAtMs(a: NlmArtifactRef): number | null {
  if (!a.created_at) return null;
  const ms = Date.parse(a.created_at);
  return Number.isFinite(ms) ? ms : null;
}

/** Finite, non-negative ms or the fallback (Codex MERGE MAJOR-4: NaN env). */
export function safeMs(value: number, fallback: number, floor = 0): number {
  return Number.isFinite(value) && value >= floor ? value : fallback;
}
