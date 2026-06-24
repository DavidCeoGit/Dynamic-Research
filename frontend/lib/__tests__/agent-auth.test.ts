/**
 * Agent-auth (X-Agent-Key) constant-time compare + startup validation tests (S167).
 *
 * Guards the worker-auth boundary: a regression is either a lockout (the worker
 * cannot claim/update jobs) or — worse — an auth bypass (an empty/absent secret
 * matched by an empty presented key). Timing-safety itself is structural (HMAC +
 * timingSafeEqual) and not reliably unit-testable; these tests pin the FUNCTIONAL
 * contract: exact accept/reject, no throw on length mismatch, lazy env read, and
 * fail-closed on a missing secret/key.
 *
 * Run: pnpm -C agent exec node --import=tsx --test "../frontend/lib/__tests__/agent-auth.test.ts"
 * (wired into the root `pnpm test` script alongside the other frontend suites)
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isValidAgentKey, assertAgentSecretConfigured } from "../agent-auth";

const ORIGINAL = process.env.AGENT_SECRET_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AGENT_SECRET_KEY;
  else process.env.AGENT_SECRET_KEY = ORIGINAL;
});

// ── isValidAgentKey: happy path ─────────────────────────────────────

test("isValidAgentKey: the exact configured secret is accepted", () => {
  process.env.AGENT_SECRET_KEY = "s3cr3t-agent-key-value";
  assert.equal(isValidAgentKey("s3cr3t-agent-key-value"), true);
});

test("isValidAgentKey: reads AGENT_SECRET_KEY lazily (per call, not snapshotted)", () => {
  process.env.AGENT_SECRET_KEY = "first";
  assert.equal(isValidAgentKey("first"), true);
  process.env.AGENT_SECRET_KEY = "second";
  assert.equal(isValidAgentKey("first"), false); // old key no longer valid
  assert.equal(isValidAgentKey("second"), true); // rotated key takes effect
});

// ── isValidAgentKey: rejects (non-vacuous) ──────────────────────────

test("isValidAgentKey: a wrong key of the SAME length is rejected", () => {
  process.env.AGENT_SECRET_KEY = "abcdefghij"; // 10 chars
  assert.equal(isValidAgentKey("abcdefghiX"), false); // differs in last byte
  assert.equal(isValidAgentKey("Xbcdefghij"), false); // differs in first byte
});

test("isValidAgentKey: a wrong key of a DIFFERENT length is rejected WITHOUT throwing", () => {
  process.env.AGENT_SECRET_KEY = "short";
  // A naive timingSafeEqual(Buffer(a), Buffer(b)) throws RangeError on unequal
  // lengths; the HMAC normalization must turn this into a clean `false`.
  assert.doesNotThrow(() => isValidAgentKey("a-much-longer-wrong-key"));
  assert.equal(isValidAgentKey("a-much-longer-wrong-key"), false);
  assert.equal(isValidAgentKey("s"), false);
});

// ── isValidAgentKey: fail-closed on missing inputs ──────────────────

test("isValidAgentKey: null / undefined / empty presented key is rejected", () => {
  process.env.AGENT_SECRET_KEY = "configured";
  assert.equal(isValidAgentKey(null), false);
  assert.equal(isValidAgentKey(undefined), false);
  assert.equal(isValidAgentKey(""), false);
});

test("isValidAgentKey: rejects everything when AGENT_SECRET_KEY is UNSET (fail closed)", () => {
  delete process.env.AGENT_SECRET_KEY;
  assert.equal(isValidAgentKey("any-key"), false);
  assert.equal(isValidAgentKey(""), false); // critical: empty must NOT match empty/absent
  assert.equal(isValidAgentKey(null), false);
});

test("isValidAgentKey: rejects everything when AGENT_SECRET_KEY is the EMPTY string (fail closed)", () => {
  process.env.AGENT_SECRET_KEY = "";
  assert.equal(isValidAgentKey(""), false);
  assert.equal(isValidAgentKey("any-key"), false);
});

// ── assertAgentSecretConfigured ─────────────────────────────────────

test("assertAgentSecretConfigured: true and no error log when the secret is set", () => {
  process.env.AGENT_SECRET_KEY = "configured";
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args);
  };
  try {
    assert.equal(assertAgentSecretConfigured(), true);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 0);
});

test("assertAgentSecretConfigured: false and logs a loud error when unset", () => {
  delete process.env.AGENT_SECRET_KEY;
  const errs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args);
  };
  try {
    assert.equal(assertAgentSecretConfigured(), false);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 1);
  assert.match(String(errs[0][0]), /AGENT_SECRET_KEY is not set/);
});
