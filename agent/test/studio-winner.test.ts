/**
 * Unit tests for the pure studio-deliverable winner selection (S89).
 * Extracted from verify-gallery-vs-notebook.ts so the version/variant
 * tiebreak + non-studio filtering can be asserted without the script's
 * top-level main() / NLM-CLI / Supabase side effects.
 *
 * Run: pnpm -C agent exec node --import=tsx --test test/studio-winner.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinners } from "../lib/studio-winner.js";

const TS = "20260604-101010";
const f = (s: string) => ({ name: s });

test("v1 (no -vN suffix) parses as version 1", () => {
  const w = pickWinners([f(`my-topic-${TS}-report.md`)]);
  assert.equal(w.report.version, 1);
  assert.equal(w.report.variant, "");
  assert.equal(w.report.titleSlug, "my-topic");
  assert.equal(w.report.filename, `my-topic-${TS}-report.md`);
});

test("higher version wins regardless of input order", () => {
  const w = pickWinners([
    f(`t-${TS}-video-v3.mp4`),
    f(`t-${TS}-video.mp4`), // v1
    f(`t-${TS}-video-v2.mp4`),
  ]);
  assert.equal(w.video.version, 3);
});

test("same-version variant tiebreak: later letter wins (v5d > v5a > v5)", () => {
  const w = pickWinners([
    f(`t-${TS}-video-v5.mp4`), // variant ""
    f(`t-${TS}-video-v5a.mp4`),
    f(`t-${TS}-video-v5d.mp4`),
    f(`t-${TS}-video-v5b.mp4`),
  ]);
  assert.equal(w.video.version, 5);
  assert.equal(w.video.variant, "d");
});

test("a higher version beats a later variant of a lower version", () => {
  const w = pickWinners([
    f(`t-${TS}-audio-v5d.mp3`),
    f(`t-${TS}-audio-v6.mp3`),
  ]);
  assert.equal(w.audio.version, 6);
  assert.equal(w.audio.variant, "");
});

test("non-studio-shaped names are ignored", () => {
  const w = pickWinners([
    f("brief.md"),
    f(`t-${TS}-comparison.md`), // 'comparison' not in STUDIO_PRODUCTS
    f("research-status.json"),
    f("persona.txt"),
  ]);
  assert.deepEqual(w, {});
});

test("unknown product segment is ignored", () => {
  const w = pickWinners([f(`t-${TS}-quiz.md`)]); // quiz not in STUDIO_PRODUCTS
  assert.equal(w.quiz, undefined);
});

test("multiple distinct products each get their own winner", () => {
  const w = pickWinners([
    f(`t-${TS}-audio.mp3`),
    f(`t-${TS}-video-v2.mp4`),
    f(`t-${TS}-slides.pdf`),
    f(`t-${TS}-report.md`),
    f(`t-${TS}-infographic.png`),
  ]);
  assert.deepEqual(Object.keys(w).sort(), [
    "audio",
    "infographic",
    "report",
    "slides",
    "video",
  ]);
  assert.equal(w.video.version, 2);
});

test("empty input yields no winners", () => {
  assert.deepEqual(pickWinners([]), {});
});
