/**
 * Canonical URL normalization + validation for the research form.
 *
 * S153 — single source of truth retiring three previously-divergent heuristics:
 *   - validate.ts userContextSchema.additionalUrls preprocess (submit gate)
 *   - useNewResearchForm.ts isUrlish (dynamic-question free-text split gate)
 *   - StepReview.tsx normalizeUrl (display-href only)
 *
 * SEMANTICS-PRESERVING (S153 Codex MERGE-gate MAJOR-4): the alphabetic-TLD test
 * applies ONLY to scheme-less candidates. An explicit http(s):// URL is accepted
 * iff `z.string().url().max(2000)` passes — so `http://localhost:3000/x` and
 * `https://127.0.0.1/a` (no public TLD) keep working exactly as the shipped
 * submit validator accepts them. The 2000-char cap matches the wire schema so a
 * URL that passes the UI never fails only at final submit.
 */

import { z } from "zod";

// Mirror of the wire constraint at validate.ts userContextSchema.additionalUrls
// (z.array(z.string().url().max(2000))). Keep these in lockstep.
const urlSchema = z.string().url().max(2000);

// Sentence-boundary punctuation an extractor / paste commonly leaves on the
// tail of a token (e.g. "...ca.gov." or "(https://x)"). Intentionally excludes
// "/" so a path is preserved.
const TRAILING_PUNCT = /[.,;:)\]}>"']+$/;

// Bare domain with a REAL alphabetic TLD as the final label. Rejects version
// labels ("v1.1" — final label numeric) and prose-with-a-dot. Mirrors the S152
// heuristic that this helper consolidates.
const BARE_DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i;

function tryUrl(candidate: string): string | null {
  return urlSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * Normalize a raw URL-ish token to a canonical absolute URL, or null if it is
 * not a usable URL.
 *
 *  - Already-schemed: accept as-is if valid; else retry with trailing
 *    punctuation stripped (sentence-final ".)" etc). NO TLD test applied —
 *    localhost / bare IP / intranet hosts are preserved.
 *  - Scheme-less: strip trailing punctuation, require a real alphabetic-TLD
 *    bare domain, prepend https://, then re-validate.
 */
export function normalizeUrlCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return tryUrl(trimmed) ?? tryUrl(trimmed.replace(TRAILING_PUNCT, ""));
  }

  const bare = trimmed.replace(TRAILING_PUNCT, "");
  if (!BARE_DOMAIN.test(bare)) return null;
  return tryUrl(`https://${bare}`);
}

export interface UrlItemStatus {
  ok: boolean;
  /** The canonical URL when ok; null otherwise. */
  normalized: string | null;
  /** Human-readable reason when not ok (for inline UI display). */
  message?: string;
}

/**
 * Per-item validation for the editable UI. Validates a single RAW item
 * independently so the displayed status maps 1:1 to the row the user sees
 * (closes the preprocess drop/reindex mismatch — S153 Defect 3).
 */
export function isValidUrlItem(raw: string): UrlItemStatus {
  const normalized = normalizeUrlCandidate(raw);
  if (normalized) return { ok: true, normalized };

  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, normalized: null, message: "Empty — remove or enter a URL" };
  if (trimmed.length > 2000) {
    return { ok: false, normalized: null, message: "URL exceeds the 2000-character limit" };
  }
  return {
    ok: false,
    normalized: null,
    message: "Not a valid URL — use a real domain (example.com) or an http(s):// address",
  };
}
