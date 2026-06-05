#!/usr/bin/env node
/**
 * MCP Proxy — per-upstream passthrough + A2 policies (Sprint 3 Phase A2 v1).
 *
 * Each invocation handles ONE upstream MCP server (named by argv[2]).
 * This matches Claude Code's tool-prefix model: server name in mcp-config.json
 * mcpServers `<key>` -> tool exposed as `mcp__<key>__<toolname>`. By spawning
 * one proxy instance per upstream with the upstream's name as the mcp-config
 * key, tools surface to Claude as `mcp__<upstreamKey>__<tool>` — matching the
 * existing executor.ts `--allowedTools` allowlist (mcp__perplexity__*,
 * mcp__Chrome_DevTools_MCP__*).
 *
 * Usage (per mcp-config.json entry): node --import=tsx index.ts <upstreamKey>
 *
 * A1 (S70-71) = NO POLICY. Pure passthrough.
 * A2 (S72) ADDS two static policies inside CallToolRequestSchema handler:
 *   - L3-static: size-cap trim each text block (default 80,000 chars).
 *   - L10-static: SHA-256 dedupe map keyed on (toolName + sorted-keys-args).
 *         Scope = per-proxy-instance lifetime (one claude -p × one upstream).
 *         A3 will back this in Supabase for cross-invocation L9.
 *
 * L5 (cache_control inject) DROPPED from A2 — see merge-gate doc §"L5 finding":
 * S72 swap-test discovered the MCP SDK's CallToolResultSchema strict-mode
 * SILENTLY STRIPS `cache_control` from content blocks before wire-emit
 * (agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:138).
 * OQ#11 spike's reported cache_read growth was therefore NOT user-attached
 * cache_control passthrough — likely Claude Code's auto-cache heuristic on
 * large MCP tool_results. L5 deferred to a follow-up spike that explicitly
 * compares with/without user-attached cache_control to settle the mechanism.
 * Sprint 3 ROI math needs revision: L5's projected savings may be illusory.
 *
 * Policy ordering inside the handler:
 *   1. L10 lookup (hash key → cache map). HIT → return cached. MISS → continue.
 *   2. Upstream call.
 *   3. L3 trim (mutates content[i].text where >MAX_CHARS).
 *   4. L10 store the trimmed result for subsequent same-key calls.
 *
 * Policy is configurable via env (forward-compat with A3):
 *   PROXY_L3_MAX_CHARS    (default 80000; set 0 to disable L3)
 *   PROXY_L10_ENABLED     (default "true"; set "false" to disable L10)
 *
 * Per Sprint 3 DESIGN gate v3 + A1 MERGE-gate v3 FINAL (S71):
 * - Architecture A (locked by OQ#11 spike YES verdict, 2026-05-30) — but the
 *   verdict's mechanism needs follow-up empirical confirmation (see above).
 * - One proxy instance per upstream (Gemini G-1 fix from A1).
 * - Disconnect handler clears cached client on transport close (Gemini G-3 fix).
 * - Env inheritance UNCONDITIONAL (Codex C-3 fix from A1).
 * - cwd-independent tsx loader (Codex C-1 fix from A1, in mcp-config.json).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface UpstreamSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  // Codex Round 2 C-1 fix: per-upstream L10 opt-out. Stateful upstreams whose
  // tools mutate external state (e.g. Chrome_DevTools_MCP's click/press_key/
  // navigate_page) MUST set idempotent=false. L10 dedup-cache would otherwise
  // return stale results from a prior identical call, skipping the mutation
  // and breaking the agent's mental model of page state. Default true =
  // safe-for-perplexity (search/research tools are idempotent for cache TTL).
  idempotent?: boolean;
}

interface UpstreamsConfig {
  upstreams: Record<string, UpstreamSpec>;
}

const upstreamKey = process.argv[2];
if (!upstreamKey) {
  process.stderr.write("[mcp-proxy] FATAL: upstream key required (argv[2])\n");
  process.exit(1);
}

const configPath = join(__dirname, "upstreams.json");
const config: UpstreamsConfig = JSON.parse(readFileSync(configPath, "utf-8"));

const spec = config.upstreams[upstreamKey];
if (!spec) {
  process.stderr.write(
    `[mcp-proxy] FATAL: unknown upstream key '${upstreamKey}'; available: ${Object.keys(config.upstreams).join(", ")}\n`,
  );
  process.exit(1);
}

// ───────────────────────── Policy configuration ─────────────────────────
// L10_ENABLED is the AND of (env master switch) AND (per-upstream idempotent
// flag from upstreams.json). Either being off → L10 skipped for this proxy
// instance. Codex Round 2 C-1 fix: per-upstream layer added to prevent
// caching stateful Chrome_DevTools_MCP actions like click/press_key/etc.
const POLICY = {
  L3_MAX_TEXT_CHARS: parseNonNegativeInt(process.env.PROXY_L3_MAX_CHARS, 80_000),
  L10_ENABLED:
    process.env.PROXY_L10_ENABLED !== "false" && spec.idempotent !== false,
};

// Gemini Round 1 G-2: renamed from parsePositiveInt — function accepts 0 (which
// is intended; "set 0 to disable L3"), so "non-negative" is the correct label.
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// ───────────────────────── Upstream client (cached) ─────────────────────
let cachedClient: Promise<Client> | null = null;

function getUpstreamClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const promise = (async () => {
    // C-3 (S71 v3): env inheritance is UNCONDITIONAL. Spread process.env first
    // so PATH, API keys, and other inherited env vars ALWAYS reach the upstream
    // subprocess, then overlay spec.env if present.
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
    });
    // G-3 (S71 v2): clear cached client on transport close so subsequent calls
    // reconnect cleanly. Without this, a crashed upstream would be cached as a
    // dead promise for the rest of the claude -p lifetime.
    transport.onclose = () => {
      if (cachedClient === promise) cachedClient = null;
    };
    const client = new Client(
      { name: `mcp-proxy-upstream-${upstreamKey}`, version: "0.2.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();
  cachedClient = promise;
  return promise;
}

// ───────────────────────── L3 — size-cap trim ───────────────────────────
type ContentBlock = {
  type?: string;
  text?: string;
  [k: string]: unknown;
};

function l3Trim(content: ContentBlock[]): ContentBlock[] {
  if (POLICY.L3_MAX_TEXT_CHARS === 0) return content;
  return content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    if (block.text.length <= POLICY.L3_MAX_TEXT_CHARS) return block;
    const trimmed = block.text.slice(0, POLICY.L3_MAX_TEXT_CHARS);
    const droppedChars = block.text.length - POLICY.L3_MAX_TEXT_CHARS;
    return {
      ...block,
      text: `${trimmed}\n[...trimmed ${droppedChars} chars by mcp-proxy L3-static]`,
    };
  });
}

// L5 (cache_control inject) is DROPPED — see file-header comment.

// ───────────────────────── L10 — input-sig dedupe ───────────────────────
const l10Cache = new Map<string, unknown>();

function l10Key(toolName: string, args: unknown): string {
  // SHA-256 keys keep memory bounded even with very large arg strings.
  // Stringify uses sorted-key-order via JSON.stringify with a replacer that
  // sorts object keys; this avoids non-deterministic hits across calls that
  // differ only in argument-key order.
  const stable = JSON.stringify(args, sortedKeysReplacer);
  return createHash("sha256").update(`${toolName}|${stable}`).digest("hex");
}

function sortedKeysReplacer(_k: string, v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  // Codex Round 2 C-3 fix: accumulator is a null-prototype object so an own
  // enumerable "__proto__" key in the input cannot reach Object.prototype.
  // Property assignment via defineProperty avoids the same hazard on the
  // direct path (just-in-case defense if a future runtime treats __proto__
  // specially on null-prototype objects).
  const acc = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    Object.defineProperty(acc, k, {
      value: (v as Record<string, unknown>)[k],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return acc;
}

// ───────────────────────── MCP server handlers ──────────────────────────
const server = new Server(
  { name: `mcp-proxy-${upstreamKey}`, version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const client = await getUpstreamClient();
    const { tools } = await client.listTools();
    return { tools: tools as Tool[] };
  } catch (err) {
    process.stderr.write(
      `[mcp-proxy:${upstreamKey}] listTools failed: ${(err as Error).message}\n`,
    );
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments;

  // L10 lookup BEFORE upstream call.
  let cacheKey: string | null = null;
  if (POLICY.L10_ENABLED) {
    cacheKey = l10Key(toolName, args);
    const cached = l10Cache.get(cacheKey);
    if (cached !== undefined) {
      return cached as Awaited<ReturnType<Client["callTool"]>>;
    }
  }

  const client = await getUpstreamClient();
  const upstreamResult = await client.callTool({
    name: toolName,
    arguments: args,
  });

  // L3 mutation on content[]. L5 dropped (see file-header comment).
  const rawContent = (upstreamResult as { content?: ContentBlock[] }).content;
  if (Array.isArray(rawContent)) {
    let content: ContentBlock[] = rawContent;
    content = l3Trim(content);
    (upstreamResult as { content?: ContentBlock[] }).content = content;
  }

  if (cacheKey !== null) {
    l10Cache.set(cacheKey, upstreamResult);
  }

  return upstreamResult as Awaited<ReturnType<typeof client.callTool>>;
});

// ───────────────────────── Shutdown ─────────────────────────────────────
async function shutdown(): Promise<void> {
  if (cachedClient) {
    try {
      const client = await cachedClient;
      await client.close();
    } catch {
      // swallow
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

const transport = new StdioServerTransport();
await server.connect(transport);
