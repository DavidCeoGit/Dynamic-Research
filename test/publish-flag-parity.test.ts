/**
 * S120 — cross-root behavioral parity guard for the publish-flag predicate.
 *
 * The frontend cannot import from agent/ (separate tsconfig roots), so the
 * canonical strict predicate is MIRRORED: agent/lib/publish-gate.ts
 * `isPublishFlagSet` ↔ frontend/lib/publish-flag.ts `isPublishFlagSet`. A
 * silent divergence between the two (e.g. one accepting "on" and the other
 * not) would re-open the coercion-mismatch fail-open class this work closed.
 *
 * This test imports BOTH REAL exports and runs the same value matrix against
 * the actual functions — behavioral parity on the live exports, NOT a source
 * byte-grep (S120 Codex C5: byte-parity false-fails on formatting and misses
 * divergence outside the compared body). It lives at the repo root so it is
 * outside both subprojects' tsconfig (neither tsc typechecks a cross-root
 * import); tsx transpiles each module at runtime.
 *
 * Run (from repo root, via agent's tsx loader):
 *   pnpm -C agent exec node --import=tsx --test "../test/publish-flag-parity.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublishFlagSet as agentIsPublishFlagSet } from "../agent/lib/publish-gate.js";
import { isPublishFlagSet as frontendIsPublishFlagSet } from "../frontend/lib/publish-flag.js";

const MATRIX: unknown[] = [
  true,
  false,
  "true",
  "TRUE",
  " true ",
  "\tTrUe ",
  "on",
  "1",
  "yes",
  "false",
  "FALSE",
  "",
  " ",
  "0",
  "truex",
  0,
  1,
  null,
  undefined,
  {},
  [],
  { publishRequired: true },
];

test("publish-flag parity: agent and frontend isPublishFlagSet agree on every matrix value", () => {
  for (const v of MATRIX) {
    const a = agentIsPublishFlagSet(v);
    const f = frontendIsPublishFlagSet(v);
    assert.equal(
      a,
      f,
      `divergence on ${JSON.stringify(v)}: agent=${a} frontend=${f}`,
    );
  }
});

test("publish-flag parity: both accept exactly {true, 'true'-ish} and reject the rest", () => {
  // Anchor the agreed contract so parity can't be satisfied by BOTH drifting
  // the same wrong way.
  for (const v of [true, "true", "TRUE", " true "]) {
    assert.equal(agentIsPublishFlagSet(v), true, `agent should accept ${JSON.stringify(v)}`);
    assert.equal(frontendIsPublishFlagSet(v), true, `frontend should accept ${JSON.stringify(v)}`);
  }
  for (const v of ["on", "1", "yes", false, "", 1, 0, null, undefined]) {
    assert.equal(agentIsPublishFlagSet(v as unknown), false, `agent should reject ${JSON.stringify(v)}`);
    assert.equal(frontendIsPublishFlagSet(v as unknown), false, `frontend should reject ${JSON.stringify(v)}`);
  }
});
