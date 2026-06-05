#!/usr/bin/env node
/**
 * Sprint 3 rollback-verification test — A2 (S72).
 *
 * Filename retains the "a1" suffix (historical) but covers A1 + A2 policies.
 * Future phases may rename to drop the phase suffix.
 *
 * A1 carry-forward (1-7): proxy boots cwd-independent, MCP handshake,
 * tools/list, tools/call passthrough, SIGTERM shutdown, argv guards.
 *
 * A2 NEW (8-13):
 *  (8) proxy boots with perplexity argv (opt-in via RUN_PERPLEXITY_TEST=1)
 *  (9) proxy boots with Chrome_DevTools_MCP argv (opt-in via RUN_CHROME_TEST=1)
 * (10) L3-static trim under PROXY_L3_MAX_CHARS=400
 * (11) SDK CallToolResultSchema STRIPS cache_control regression guard
 *      (pins the empirical finding from S72 that drove dropping L5 from A2)
 * (12) L10-static dedupe ENABLED for default echo upstream (cached)
 * (13) L10 SKIPPED for non-idempotent upstream (Codex C-1 fix):
 *      stateful_echo upstream is flagged idempotent:false in upstreams.json,
 *      so the proxy must override L10_ENABLED to false regardless of env.
 *      Test calls echo_with_counter twice via stateful_echo argv and asserts
 *      counter advances both times (proves upstream was called both times,
 *      L10 was NOT cached). Defends against the Chrome_DevTools_MCP click/
 *      press_key/navigate stale-state hazard identified in Codex Round 2.
 *
 * Usage:
 *   node agent/scripts/sprint3-a1-rollback-test.mjs
 *   RUN_PERPLEXITY_TEST=1 RUN_CHROME_TEST=1 node agent/scripts/sprint3-a1-rollback-test.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PROXY_PATH = process.env.PROXY_PATH || "C:/Users/ceo/Documents/AI Training/Anti Gravity/Dynamic Research/agent/mcp-proxy/index.ts";
// C-1 (S71 v3): cwd is INTENTIONALLY c:/tmp (NOT agent/). The real executor
// at agent/executor.ts:888 spawns claude with cwd=per-job workDir (under
// Projects/<slug>/), which has no tsx in its node_modules chain. If the
// proxy bootstrap depends on cwd-resolution of tsx, this test must fail.
const TEST_CWD = "c:/tmp";

const TSX_LOADER = "file:///C:/Users/ceo/Documents/AI%20Training/Anti%20Gravity/Dynamic%20Research/agent/node_modules/tsx/dist/esm/index.mjs";

function spawnProxy(extraArgs = ["echo"], extraEnv = {}) {
  return spawn("node", ["--import", TSX_LOADER, PROXY_PATH, ...extraArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: TEST_CWD,
    env: { ...process.env, ...extraEnv },
  });
}

function sendRequest(child, request) {
  child.stdin.write(JSON.stringify(request) + "\n");
}

async function readResponse(reader, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  while (Date.now() < deadline) {
    const chunk = reader.next();
    if (chunk) {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        return JSON.parse(line);
      }
    }
    await sleep(50);
  }
  throw new Error(`Timeout reading response after ${timeoutMs}ms; buffer="${buffer.slice(0, 200)}"`);
}

function makeReader(stream) {
  const queue = [];
  stream.on("data", (chunk) => queue.push(chunk.toString()));
  return {
    next() {
      return queue.shift();
    },
  };
}

async function initAndDrain(child, reader) {
  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rollback-test", version: "0.1.0" },
    },
  });
  await readResponse(reader, 5000);
  sendRequest(child, { jsonrpc: "2.0", method: "notifications/initialized" });
}

const tests = [];
function test(name, fn, opts = {}) {
  tests.push({ name, fn, skip: opts.skip ?? false, skipReason: opts.skipReason });
}

// ─────────────────── A1 carry-forward tests 1-7 ───────────────────

test("(1) proxy boots from non-agent cwd (cwd-independence; C-1 fix)", async () => {
  const child = spawnProxy();
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(2000);
  if (child.exitCode !== null) {
    throw new Error(`proxy exited prematurely with code ${child.exitCode}; stderr:\n${stderr}`);
  }
  if (stderr.trim()) {
    child.kill("SIGTERM");
    throw new Error(`unexpected stderr during boot:\n${stderr}`);
  }
  child.kill("SIGTERM");
  await sleep(200);
});

test("(2) proxy responds to MCP initialize handshake (serverInfo.name=mcp-proxy-echo)", async () => {
  const child = spawnProxy();
  const reader = makeReader(child.stdout);
  child.stderr.on("data", () => {});
  await sleep(1200);

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rollback-test", version: "0.1.0" },
    },
  });

  const response = await readResponse(reader, 5000);
  if (response.id !== 1) throw new Error(`expected id=1, got ${response.id}`);
  if (!response.result) throw new Error(`no result field; got ${JSON.stringify(response).slice(0, 300)}`);
  if (response.result.serverInfo?.name !== "mcp-proxy-echo") {
    throw new Error(`expected serverInfo.name=mcp-proxy-echo, got ${response.result.serverInfo?.name}`);
  }
  child.kill("SIGTERM");
  await sleep(200);
});

test("(3) proxy tools/list returns echo_text from upstream (C-2 fix)", async () => {
  const child = spawnProxy();
  const reader = makeReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(1200);

  await initAndDrain(child, reader);

  sendRequest(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const response = await readResponse(reader, 8000);

  if (response.id !== 2) throw new Error(`expected id=2, got ${response.id}`);
  if (!response.result) throw new Error(`no result field; got ${JSON.stringify(response).slice(0, 300)}`);
  if (!Array.isArray(response.result.tools)) {
    throw new Error(`expected result.tools array, got ${typeof response.result.tools}`);
  }
  const echoTool = response.result.tools.find((t) => t.name === "echo_text");
  if (!echoTool) {
    throw new Error(`expected echo_text in tools/list; got ${JSON.stringify(response.result.tools)}; stderr:\n${stderr}`);
  }
  child.kill("SIGTERM");
  await sleep(200);
});

test("(4) proxy tools/call echo_text returns passthrough content (C-2 fix)", async () => {
  const child = spawnProxy();
  const reader = makeReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(1200);

  await initAndDrain(child, reader);

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "echo_text", arguments: { text: "hello-mcp-proxy" } },
  });
  const response = await readResponse(reader, 8000);

  if (response.id !== 2) throw new Error(`expected id=2, got ${response.id}`);
  if (!response.result) throw new Error(`no result; got ${JSON.stringify(response).slice(0, 300)}; stderr:\n${stderr}`);
  const content = response.result.content?.[0];
  if (!content || content.type !== "text" || content.text !== "echo: hello-mcp-proxy") {
    throw new Error(`unexpected passthrough content: ${JSON.stringify(response.result)}`);
  }
  child.kill("SIGTERM");
  await sleep(200);
});

test("(5) SIGTERM stops the proxy", async () => {
  const child = spawnProxy();
  child.stderr.on("data", () => {});
  await sleep(1200);
  child.kill("SIGTERM");
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      return;
    }
    await sleep(100);
  }
  throw new Error("proxy did not exit within 3s of SIGTERM");
});

test("(6) proxy exits non-zero without upstream-key argv", async () => {
  const child = spawnProxy([]);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    throw new Error(`proxy did not exit when launched without argv`);
  }
  if (child.exitCode === 0) {
    throw new Error(`expected non-zero exit; got 0; stderr:\n${stderr}`);
  }
  if (!stderr.includes("upstream key required")) {
    throw new Error(`expected 'upstream key required' in stderr; got:\n${stderr.slice(0, 300)}`);
  }
});

test("(7) proxy exits non-zero on UNKNOWN upstream-key", async () => {
  const child = spawnProxy(["nonexistent_upstream_xyz"]);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    throw new Error(`proxy did not exit on unknown upstream`);
  }
  if (child.exitCode === 0) {
    throw new Error(`expected non-zero exit; got 0; stderr:\n${stderr}`);
  }
  if (!stderr.includes("unknown upstream key")) {
    throw new Error(`expected 'unknown upstream key' in stderr; got:\n${stderr.slice(0, 300)}`);
  }
});

// ─────────────────── A2 NEW tests 8-12 ───────────────────

test(
  "(8) proxy boots with perplexity argv (real upstream initialize)",
  async () => {
    const child = spawnProxy(["perplexity"]);
    const reader = makeReader(child.stdout);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // Allow extra time for first-run npx fetch + perplexity-mcp boot.
    await sleep(8000);
    if (child.exitCode !== null) {
      throw new Error(`perplexity proxy exited prematurely with code ${child.exitCode}; stderr:\n${stderr.slice(0, 500)}`);
    }
    sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rollback-test", version: "0.1.0" },
      },
    });
    const response = await readResponse(reader, 20000);
    if (response.result?.serverInfo?.name !== "mcp-proxy-perplexity") {
      throw new Error(`expected serverInfo.name=mcp-proxy-perplexity, got ${JSON.stringify(response).slice(0, 300)}`);
    }
    child.kill("SIGTERM");
    await sleep(500);
  },
  { skip: process.env.RUN_PERPLEXITY_TEST !== "1", skipReason: "set RUN_PERPLEXITY_TEST=1 to run (network + ~5-20s npx fetch + valid PERPLEXITY_API_KEY)" }
);

test(
  "(9) proxy boots with Chrome_DevTools_MCP argv (real upstream initialize)",
  async () => {
    const child = spawnProxy(["Chrome_DevTools_MCP"]);
    const reader = makeReader(child.stdout);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    await sleep(10000);
    if (child.exitCode !== null) {
      throw new Error(`Chrome_DevTools_MCP proxy exited prematurely with code ${child.exitCode}; stderr:\n${stderr.slice(0, 500)}`);
    }
    sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rollback-test", version: "0.1.0" },
      },
    });
    const response = await readResponse(reader, 30000);
    if (response.result?.serverInfo?.name !== "mcp-proxy-Chrome_DevTools_MCP") {
      throw new Error(`expected serverInfo.name=mcp-proxy-Chrome_DevTools_MCP, got ${JSON.stringify(response).slice(0, 300)}`);
    }
    child.kill("SIGTERM");
    await sleep(1500);
  },
  { skip: process.env.RUN_CHROME_TEST !== "1", skipReason: "set RUN_CHROME_TEST=1 to run (~5-15s, opens browser window)" }
);

test("(10) L3-static trim: echo_big_text(20) with PROXY_L3_MAX_CHARS=400 truncates", async () => {
  const child = spawnProxy(["echo"], { PROXY_L3_MAX_CHARS: "400" });
  const reader = makeReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(1200);

  await initAndDrain(child, reader);

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "echo_big_text", arguments: { lines: 20 } },
  });
  const response = await readResponse(reader, 8000);
  if (!response.result?.content?.[0]) {
    throw new Error(`no content[0]; got ${JSON.stringify(response).slice(0, 300)}; stderr:\n${stderr}`);
  }
  const text = response.result.content[0].text;
  if (typeof text !== "string") throw new Error(`expected text content, got ${typeof text}`);
  if (!text.includes("[...trimmed ") || !text.includes("chars by mcp-proxy L3-static]")) {
    throw new Error(`expected L3 trim suffix; got tail "${text.slice(-200)}"`);
  }
  // Text body (pre-suffix) should be exactly 400 chars per PROXY_L3_MAX_CHARS.
  const bodyEnd = text.indexOf("\n[...trimmed ");
  const body = text.slice(0, bodyEnd);
  if (body.length !== 400) {
    throw new Error(`expected body=400 chars, got ${body.length}`);
  }
  child.kill("SIGTERM");
  await sleep(200);
});

test("(11) SDK CallToolResultSchema STRIPS cache_control (regression guard for L5-deferred finding)", async () => {
  // S72 finding: @modelcontextprotocol/sdk@1.29.0's CallToolResultSchema
  // strict-mode silently strips `cache_control` from content blocks before
  // wire-emit (agent/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:138).
  // This was discovered during A2 swap-test when a proxy-injected cache_control
  // disappeared from the JSON-RPC response. L5 (cache_control inject) was
  // dropped from A2 as a result; OQ#11 spike's reported cache_read growth
  // is suspected to be Claude Code auto-cache rather than user-attached
  // cache_control passthrough. Pinning this empirically so an SDK upgrade
  // that changes the schema will surface here.
  const { CallToolResultSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const sample = {
    content: [
      {
        type: "text",
        text: "hello world",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  };
  const result = CallToolResultSchema.safeParse(sample);
  if (!result.success) {
    throw new Error(`schema rejected sample outright (unexpected): ${String(result.error)}`);
  }
  const block = result.data.content[0];
  if (block.cache_control) {
    throw new Error(
      `REGRESSION: SDK no longer strips cache_control. Got: ${JSON.stringify(block)}. Revisit L5 — it may now be implementable directly. See Documentation/sprint3-a2-merge-gate.md §"L5 finding".`
    );
  }
  if (block.text !== "hello world" || block.type !== "text") {
    throw new Error(`unexpected SDK validation: ${JSON.stringify(block)}`);
  }
});

test("(12) L10-static dedupe: echo_with_counter same args twice = byte-identical; different args advances counter", async () => {
  const child = spawnProxy();
  const reader = makeReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(1200);

  await initAndDrain(child, reader);

  async function call(id, label) {
    sendRequest(child, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo_with_counter", arguments: { label } },
    });
    return readResponse(reader, 8000);
  }

  const r1 = await call(2, "X");
  const r2 = await call(3, "X");
  const r3 = await call(4, "Y");

  const t1 = r1.result?.content?.[0]?.text;
  const t2 = r2.result?.content?.[0]?.text;
  const t3 = r3.result?.content?.[0]?.text;
  if (typeof t1 !== "string" || typeof t2 !== "string" || typeof t3 !== "string") {
    throw new Error(`missing text content; t1=${t1} t2=${t2} t3=${t3}; stderr:\n${stderr}`);
  }
  if (t1 !== "call #1: X") throw new Error(`expected t1="call #1: X"; got "${t1}"`);
  if (t2 !== t1) {
    throw new Error(`expected L10 cache hit (t2 byte-identical to t1); got t2="${t2}", t1="${t1}"`);
  }
  if (t3 !== "call #2: Y") {
    throw new Error(`expected t3="call #2: Y" (counter advanced to 2, NOT 3, proving t2 was cached); got "${t3}"`);
  }

  child.kill("SIGTERM");
  await sleep(200);
});

test("(13) L10 SKIPPED for non-idempotent upstream (Codex C-1 fix; stateful_echo with idempotent:false)", async () => {
  // upstreams.json marks 'stateful_echo' with idempotent:false. The proxy's
  // POLICY.L10_ENABLED is the AND of env (PROXY_L10_ENABLED) and spec.idempotent;
  // when spec.idempotent===false, L10 is skipped for this proxy instance
  // regardless of the env. Test calls echo_with_counter twice with the same
  // args; if L10 were active, t2 would equal t1 (cached). With L10 skipped,
  // the upstream is called both times and the per-process counter advances.
  // Defends against the Chrome_DevTools_MCP click/press_key stale-state hazard
  // identified in Codex Round 2.
  const child = spawnProxy(["stateful_echo"]);
  const reader = makeReader(child.stdout);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  await sleep(1200);

  sendRequest(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rollback-test", version: "0.1.0" },
    },
  });
  await readResponse(reader, 5000);
  sendRequest(child, { jsonrpc: "2.0", method: "notifications/initialized" });

  async function call(id, label) {
    sendRequest(child, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "echo_with_counter", arguments: { label } },
    });
    return readResponse(reader, 8000);
  }

  const r1 = await call(2, "Z");
  const r2 = await call(3, "Z");

  const t1 = r1.result?.content?.[0]?.text;
  const t2 = r2.result?.content?.[0]?.text;
  if (typeof t1 !== "string" || typeof t2 !== "string") {
    throw new Error(`missing text; t1=${t1} t2=${t2}; stderr:\n${stderr}`);
  }
  if (t1 !== "call #1: Z") throw new Error(`expected t1="call #1: Z"; got "${t1}"`);
  if (t2 === t1) {
    throw new Error(`REGRESSION: L10 fired despite idempotent:false. t1==t2=="${t1}". Codex C-1 fix broken.`);
  }
  if (t2 !== "call #2: Z") {
    throw new Error(`expected t2="call #2: Z" (counter advanced to 2 = upstream was called again, NOT cached); got "${t2}"`);
  }

  child.kill("SIGTERM");
  await sleep(200);
});

// ─────────────────── Run + report ───────────────────

let pass = 0, fail = 0, skipped = 0;
for (const { name, fn, skip, skipReason } of tests) {
  if (skip) {
    console.log(`SKIP  ${name}`);
    if (skipReason) console.log(`      ${skipReason}`);
    skipped++;
    continue;
  }
  try {
    await fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    fail++;
  }
}
const ran = pass + fail;
console.log(`\n=== ${pass}/${ran} passed${skipped > 0 ? ` (${skipped} skipped)` : ""} ===`);
process.exit(fail > 0 ? 1 : 0);
