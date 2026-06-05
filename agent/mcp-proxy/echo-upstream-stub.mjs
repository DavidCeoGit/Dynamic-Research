#!/usr/bin/env node
/**
 * Sprint 3 Phase A2 (S72) — echo MCP upstream stub.
 *
 * Used by the rollback harness to validate end-to-end passthrough + the
 * three A2 policies (L3 trim / L5 cache_control inject / L10 dedupe).
 *
 * Tools exposed:
 *   - echo_text({text})            — A1 carry-forward; returns "echo: <text>"
 *   - echo_big_text({lines})       — A2 NEW; returns N copies of a stable
 *                                    filler line (~50 chars each) for L3 trim test
 *   - echo_with_counter({label})   — A2 NEW; per-process counter increments
 *                                    on each UPSTREAM call; response carries
 *                                    "call #${counter}: ${label}" so the
 *                                    rollback test can verify L10 cache hits
 *                                    leave the counter unchanged.
 *
 * No state across processes; counter resets when stub respawns.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-upstream-stub", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

const FILLER_LINE = "The quick brown fox jumps over the lazy dog. ".repeat(1); // ~46 chars
let counter = 0;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_text",
      description: "Echoes the provided text back as a content block. Test stub for mcp-proxy rollback validation.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to echo" },
        },
        required: ["text"],
      },
    },
    {
      name: "echo_big_text",
      description: "A2 L3-trim test: returns N copies of a stable filler line (~50 chars each). Use with PROXY_L3_MAX_CHARS env override to force a known-size truncation.",
      inputSchema: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Number of filler lines to emit" },
        },
        required: ["lines"],
      },
    },
    {
      name: "echo_with_counter",
      description: "A2 L10-dedupe test: per-process counter increments on each UPSTREAM call. Response carries 'call #N: <label>'. L10-cached calls leave counter unchanged, so identical-args repeats return byte-identical responses while distinct-args calls advance the counter.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", description: "Caller label; included verbatim in response" },
        },
        required: ["label"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "echo_text") {
    const text = (args?.text ?? "") + "";
    return { content: [{ type: "text", text: `echo: ${text}` }] };
  }

  if (name === "echo_big_text") {
    const lines = Math.max(0, Math.floor(Number(args?.lines ?? 0)));
    const body = Array.from({ length: lines }, (_, i) =>
      `Line ${String(i).padStart(4, "0")}: ${FILLER_LINE}`
    ).join("\n");
    return { content: [{ type: "text", text: body }] };
  }

  if (name === "echo_with_counter") {
    counter += 1;
    const label = (args?.label ?? "") + "";
    return { content: [{ type: "text", text: `call #${counter}: ${label}` }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
