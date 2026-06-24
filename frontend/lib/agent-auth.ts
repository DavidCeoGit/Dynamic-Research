/**
 * Agent (worker) authentication for the X-Agent-Key shared-secret routes.
 *
 * S167 hardening (audit 2026-06-24, MEDIUM — was a raw `!==` compare):
 *   1. Constant-time comparison via HMAC-SHA256 + crypto.timingSafeEqual,
 *      replacing the `agentKey !== process.env.AGENT_SECRET_KEY` string
 *      compare (which short-circuits on the first differing byte and so leaks
 *      key bytes through response timing).
 *   2. Fail-loud startup validation: assertAgentSecretConfigured() logs (does
 *      NOT throw) at module load if AGENT_SECRET_KEY is unset.
 *
 * Behaviour-preserving: the accept/reject set is IDENTICAL to the prior exact
 * `!==` compare (no trimming/normalization is introduced — the worker sends the
 * raw env value, so an exact byte match is the existing contract). Only the
 * timing side-channel and the silent-misconfiguration gap are closed.
 *
 * Shared by POST /api/queue/claim and PATCH /api/queue/[id] (the only two
 * X-Agent-Key routes) so the two sites cannot drift.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-process random HMAC key. Its only job is to (a) normalize both operands
 * to a fixed 32-byte digest so timingSafeEqual never throws RangeError on a
 * length mismatch AND never leaks the secret's length via an early length
 * compare, and (b) make the digests unpredictable. It only needs to be stable
 * WITHIN a single comparison (it is — the same key hashes both operands), so a
 * fresh per-process value is ideal; it is never persisted or shared across
 * instances.
 */
const HMAC_KEY = randomBytes(32);

function digest(value: string): Buffer {
  return createHmac("sha256", HMAC_KEY).update(value, "utf8").digest();
}

/**
 * Constant-time check of a presented X-Agent-Key against AGENT_SECRET_KEY.
 *
 * Fails CLOSED: returns false if EITHER the configured secret OR the presented
 * key is missing/empty. This emptiness guard is load-bearing, not cosmetic —
 * HMAC("") === HMAC("") is true, so without it an empty presented key would
 * match an unset/empty secret (an auth bypass on a misconfigured deployment).
 *
 * The env var is read per call (matching the routes' prior lazy behaviour and
 * keeping the function testable); Vercel env is static at runtime.
 */
export function isValidAgentKey(provided: string | null | undefined): boolean {
  const secret = process.env.AGENT_SECRET_KEY;
  if (!secret) return false; // fail closed: secret not configured
  if (!provided) return false; // fail closed: no key presented
  // Both operands hash to 32 bytes, so timingSafeEqual cannot throw on length.
  return timingSafeEqual(digest(provided), digest(secret));
}

/**
 * Startup validation. Returns whether AGENT_SECRET_KEY is configured and logs a
 * loud error if not. We LOG rather than THROW because this module is imported by
 * the user-facing GET /api/queue/[id] route too — throwing at module load would
 * take down session-scoped status polling, not just the agent path. The
 * per-request isValidAgentKey() already fails closed (401), so log + 401 is the
 * safe, availability-preserving posture.
 */
export function assertAgentSecretConfigured(): boolean {
  if (!process.env.AGENT_SECRET_KEY) {
    console.error(
      "[agent-auth] AGENT_SECRET_KEY is not set — all agent (X-Agent-Key) requests will be rejected with 401.",
    );
    return false;
  }
  return true;
}

// Fail-loud on cold start (the closest thing to "startup" in a serverless
// function): emits one error line to the Vercel function log if the secret is
// missing, instead of silently 401-ing every worker poll.
assertAgentSecretConfigured();
