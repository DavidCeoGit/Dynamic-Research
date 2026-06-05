/**
 * S82: buildClaudeSpawnEnv unit tests.
 *
 * Pure-function tests pinning the env-transform contract that prevents
 * the recurring API-account-billing-shadow credit-out failure mode
 * (see feedback_anthropic_api_key_shadows_subscription_in_executor.md).
 *
 * The function MUST:
 *   1. Strip ANTHROPIC_API_KEY (S82 root-cause fix — claude -p falls
 *      through to OAuth subscription)
 *   2. Strip ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (S82 Gemini round
 *      1 [ADDITIONAL-ANTHROPIC-VARS]: prevent endpoint-redirect or
 *      alternate-auth from defeating the API key strip)
 *   2b. Strip provider-routing vars CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/
 *      ANTHROPIC_AWS, AWS_BEARER_TOKEN_BEDROCK, ANTHROPIC_FOUNDRY_API_KEY,
 *      ANTHROPIC_AWS_API_KEY, ANTHROPIC_BEDROCK_BASE_URL,
 *      ANTHROPIC_VERTEX_BASE_URL (S82 Codex round 1
 *      [PROVIDER-ENV-SHADOWS]: source https://code.claude.com/docs/en/env-vars)
 *   3. Strip parent-session CLAUDE_* markers (preserves pre-S82 behavior)
 *   4. Set CLAUDE_CODE_ENTRYPOINT="worker" (preserves pre-S82 behavior)
 *   5. Preserve all other vars
 *   6. Not mutate the input env
 *   7. Strip case-insensitively (S82 Gemini round 1
 *      [ENV-CASE-INSENSITIVITY]: Windows process.env is case-insensitive
 *      proxy, but spread loses that — bulletproof against non-canonical
 *      casing accidents in .env files)
 */

import { test } from "node:test";
import assert from "node:assert";
import { buildClaudeSpawnEnv } from "../executor.js";

test("buildClaudeSpawnEnv strips ANTHROPIC_API_KEY (S82 root-cause fix)", () => {
  const out = buildClaudeSpawnEnv({
    ANTHROPIC_API_KEY: "sk-ant-test-value",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.ANTHROPIC_API_KEY, undefined,
    "ANTHROPIC_API_KEY must be stripped so claude -p uses Max sub");
  assert.strictEqual(out.OTHER_VAR, "preserved",
    "non-target vars must pass through");
});

test("buildClaudeSpawnEnv strips parent-session CLAUDE_* markers", () => {
  const out = buildClaudeSpawnEnv({
    CLAUDECODE: "1",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_CODE_SESSION_ID: "abc-123",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.CLAUDECODE, undefined);
  assert.strictEqual(out.CLAUDE_CODE_SSE_PORT, undefined);
  assert.strictEqual(out.CLAUDE_CODE_SESSION_ID, undefined);
  assert.strictEqual(out.OTHER_VAR, "preserved");
});

test("buildClaudeSpawnEnv sets CLAUDE_CODE_ENTRYPOINT=worker", () => {
  const out = buildClaudeSpawnEnv({});
  assert.strictEqual(out.CLAUDE_CODE_ENTRYPOINT, "worker");
});

test("buildClaudeSpawnEnv CLAUDE_CODE_ENTRYPOINT overrides any inherited value", () => {
  const out = buildClaudeSpawnEnv({ CLAUDE_CODE_ENTRYPOINT: "interactive" });
  assert.strictEqual(out.CLAUDE_CODE_ENTRYPOINT, "worker");
});

test("buildClaudeSpawnEnv does NOT mutate the input env", () => {
  const parent: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDECODE: "1",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_CODE_SESSION_ID: "abc",
  };
  buildClaudeSpawnEnv(parent);
  assert.strictEqual(parent.ANTHROPIC_API_KEY, "sk-ant-test",
    "input env must not be mutated");
  assert.strictEqual(parent.CLAUDECODE, "1");
  assert.strictEqual(parent.CLAUDE_CODE_SSE_PORT, "1234");
  assert.strictEqual(parent.CLAUDE_CODE_SESSION_ID, "abc");
});

test("buildClaudeSpawnEnv preserves PATH, HOME, and unrelated env", () => {
  const out = buildClaudeSpawnEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    USER: "alice",
    NODE_ENV: "production",
  });
  assert.strictEqual(out.PATH, "/usr/bin:/bin");
  assert.strictEqual(out.HOME, "/home/user");
  assert.strictEqual(out.USER, "alice");
  assert.strictEqual(out.NODE_ENV, "production");
});

test("buildClaudeSpawnEnv works with empty env input", () => {
  const out = buildClaudeSpawnEnv({});
  assert.strictEqual(out.CLAUDE_CODE_ENTRYPOINT, "worker");
  assert.strictEqual(out.ANTHROPIC_API_KEY, undefined);
});

test("buildClaudeSpawnEnv strips ANTHROPIC_BASE_URL (Gemini round 1 [ADDITIONAL-ANTHROPIC-VARS])", () => {
  const out = buildClaudeSpawnEnv({
    ANTHROPIC_BASE_URL: "https://my-gateway.example.com",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.ANTHROPIC_BASE_URL, undefined,
    "ANTHROPIC_BASE_URL must be stripped to prevent endpoint redirect after API key strip");
  assert.strictEqual(out.OTHER_VAR, "preserved");
});

test("buildClaudeSpawnEnv strips ANTHROPIC_AUTH_TOKEN (Gemini round 1 [ADDITIONAL-ANTHROPIC-VARS])", () => {
  const out = buildClaudeSpawnEnv({
    ANTHROPIC_AUTH_TOKEN: "alt-auth-value",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.ANTHROPIC_AUTH_TOKEN, undefined,
    "ANTHROPIC_AUTH_TOKEN must be stripped to prevent alternate-auth from defeating the API key strip");
  assert.strictEqual(out.OTHER_VAR, "preserved");
});

test("buildClaudeSpawnEnv strips case-insensitively (Gemini round 1 [ENV-CASE-INSENSITIVITY])", () => {
  // On Windows, process.env is a case-insensitive proxy. After spread,
  // a key like "Anthropic_API_Key" lands verbatim in the plain object.
  // A case-naive `delete env.ANTHROPIC_API_KEY` would miss it; the OS's
  // CreateProcess would then merge it back to ANTHROPIC_API_KEY on spawn.
  const out = buildClaudeSpawnEnv({
    Anthropic_API_Key: "sk-ant-mixed-case",
    anthropic_base_url: "https://lower.example.com",
    ANTHROPIC_AUTH_TOKEN: "upper-case",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.Anthropic_API_Key, undefined);
  assert.strictEqual(out.anthropic_base_url, undefined);
  assert.strictEqual(out.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.strictEqual(out.OTHER_VAR, "preserved");
  // Also verify the canonical-cased keys aren't present (no resurrection)
  assert.strictEqual(out.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(out.ANTHROPIC_BASE_URL, undefined);
});

test("buildClaudeSpawnEnv ANTHROPIC_API_KEY mixed case explicit (regression)", () => {
  // Tight regression test for the exact case-insensitivity bug path:
  // the ONLY env var present has mixed casing; ensure it gets stripped.
  const out = buildClaudeSpawnEnv({ "anthropic_api_key": "sk-ant-lower" });
  assert.strictEqual(out["anthropic_api_key"], undefined);
  assert.strictEqual(out.ANTHROPIC_API_KEY, undefined);
});

test("buildClaudeSpawnEnv strips provider-routing vars (Codex round 1 [PROVIDER-ENV-SHADOWS])", () => {
  // Without stripping these, an inherited routing override would send
  // the child claude -p to Bedrock / Vertex / Foundry / AWS instead of
  // the claude.ai Max OAuth subscription, defeating the fix.
  const out = buildClaudeSpawnEnv({
    CLAUDE_CODE_USE_BEDROCK: "true",
    CLAUDE_CODE_USE_VERTEX: "true",
    CLAUDE_CODE_USE_FOUNDRY: "true",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "true",
    AWS_BEARER_TOKEN_BEDROCK: "aws-token",
    ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
    ANTHROPIC_AWS_API_KEY: "aws-key",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
    ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example.com",
    OTHER_VAR: "preserved",
  });
  assert.strictEqual(out.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.strictEqual(out.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.strictEqual(out.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.strictEqual(out.CLAUDE_CODE_USE_ANTHROPIC_AWS, undefined);
  assert.strictEqual(out.AWS_BEARER_TOKEN_BEDROCK, undefined);
  assert.strictEqual(out.ANTHROPIC_FOUNDRY_API_KEY, undefined);
  assert.strictEqual(out.ANTHROPIC_AWS_API_KEY, undefined);
  assert.strictEqual(out.ANTHROPIC_BEDROCK_BASE_URL, undefined);
  assert.strictEqual(out.ANTHROPIC_VERTEX_BASE_URL, undefined);
  assert.strictEqual(out.OTHER_VAR, "preserved");
});
