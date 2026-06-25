/**
 * S168 totality tests for evaluatePublishGate over UNTRUSTED parsed state.
 * (Codex MERGE-gate CRITICAL.) state.json is JSON.parsed, so a publish_verification
 * field may be a JSON-representable non-coercible object like {"toString":null}
 * that throws "Cannot convert object to primitive value" on String(). The
 * recovery path (executor site 1) AND the normal path forward such a state into
 * evaluatePublishGate; before the fix, String(pv.verification_status) — and the
 * sibling verdict / sourceQualityClass / claims_extraction_status coercions —
 * threw on the SYNC path → caught at worker.ts:278 → ORPHANED the claimed job.
 * The coercion-safe `truncate` must make the gate TOTAL: never throw, always fail
 * CLOSED (ok:false) for a poisoned field, and surface a readable reason.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "test/publish-gate-coercion.test.ts"
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { evaluatePublishGate } from "../lib/publish-gate.js";
import type { PipelineState, PublishVerification, VerifiedClaim } from "../types.js";

const validClaim = (o: Partial<VerifiedClaim> = {}): VerifiedClaim => ({
  text: "The global market was $38.4B in 2025",
  asOfDate: "2026-06-10",
  sourceUrls: ["https://example.com/a", "https://other.example.org/b"],
  sourceDates: ["2026-01-15 (published)", "2026-06-10 (accessed)"],
  sourceQualityClass: "reputable-secondary",
  upstreamIndependenceBasis: "different upstreams: survey data vs registry filings",
  verdict: "verified",
  counterEvidenceNotes: "none found",
  ...o,
});

const validManifest = (): PublishVerification => ({
  verification_status: "passed",
  claims_extraction_status: "populated",
  vendor_legs: {
    perplexity: { status: "ok", detail: "ok" },
    notebooklm: { status: "ok", detail: "ok" },
    claude: { status: "ok", detail: "ok" },
  },
  claims: [validClaim()],
});

// Override one or more manifest fields with arbitrary (possibly poisoned) values.
const poisonedManifest = (o: Record<string, unknown>): PublishVerification =>
  ({ ...validManifest(), ...o }) as unknown as PublishVerification;

const stateWith = (pv: unknown): PipelineState =>
  ({ publish_required: true, publish_verification: pv }) as unknown as PipelineState;

// JSON-representable but non-coercible: String(POISON) / `${POISON}` throw.
const POISON = { toString: null };

describe("evaluatePublishGate — green baseline (behavior preserved by the truncate change)", () => {
  test("a fully-valid manifest still passes", () => {
    const r = evaluatePublishGate(stateWith(validManifest()));
    assert.equal(r.ok, true);
    assert.equal(r.reasons.length, 0);
  });
});

describe("evaluatePublishGate — TOTAL over poisoned untrusted fields (S168 Codex CRITICAL)", () => {
  test("verification_status = non-coercible object → no throw, ok:false (Codex repro)", () => {
    const state = stateWith(poisonedManifest({ verification_status: POISON }));
    assert.doesNotThrow(() => evaluatePublishGate(state));
    const r = evaluatePublishGate(state);
    assert.equal(r.ok, false);
    assert.ok(
      r.reasons.some((x) => x.includes("verification_status")),
      "verification_status reason present",
    );
  });

  test("claims_extraction_status = non-coercible object → no throw, ok:false", () => {
    const state = stateWith(poisonedManifest({ claims_extraction_status: POISON }));
    assert.doesNotThrow(() => evaluatePublishGate(state));
    assert.equal(evaluatePublishGate(state).ok, false);
  });

  test("claim verdict = non-coercible object → no throw, ok:false", () => {
    const state = stateWith(poisonedManifest({ claims: [validClaim({ verdict: POISON as unknown as VerifiedClaim["verdict"] })] }));
    assert.doesNotThrow(() => evaluatePublishGate(state));
    assert.equal(evaluatePublishGate(state).ok, false);
  });

  test("claim sourceQualityClass = non-coercible object → no throw, ok:false", () => {
    const state = stateWith(poisonedManifest({ claims: [validClaim({ sourceQualityClass: POISON as unknown as VerifiedClaim["sourceQualityClass"] })] }));
    assert.doesNotThrow(() => evaluatePublishGate(state));
    assert.equal(evaluatePublishGate(state).ok, false);
  });

  test("array-valued verification_status → no throw, ok:false", () => {
    const state = stateWith(poisonedManifest({ verification_status: [] }));
    assert.doesNotThrow(() => evaluatePublishGate(state));
    assert.equal(evaluatePublishGate(state).ok, false);
  });

  test("non-vacuous: a poisoned object's serialized JSON appears in the reason (coerceDisplay works, not just no-throw)", () => {
    const state = stateWith(poisonedManifest({ verification_status: { weird: 1 } }));
    const r = evaluatePublishGate(state);
    assert.equal(r.ok, false);
    assert.ok(
      r.reasons.some((x) => x.includes('{"weird":1}')),
      "serialized object should appear in the reason",
    );
  });

  test("behavior preserved: a poisoned-but-STRING verification_status still fails closed with the string shown", () => {
    const state = stateWith(poisonedManifest({ verification_status: "definitely-not-passed" }));
    const r = evaluatePublishGate(state);
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => x.includes("definitely-not-passed")));
  });
});
