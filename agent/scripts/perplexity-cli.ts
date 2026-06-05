/**
 * Standalone Perplexity API CLI — ad-hoc terminal queries + key/quota testing.
 *
 * NOT wired into the research pipeline. The pipeline reaches Perplexity through
 * the MCP proxy (agent/mcp-proxy/) for its L3/L5/L9/L10 cost-control layers;
 * this is a dev-only convenience that hits api.perplexity.ai directly. Both use
 * the same PERPLEXITY_API_KEY, so this also doubles as a quota/credit probe.
 * (S89)
 *
 * Usage (from agent/ so --env-file picks up the key):
 *   node --env-file=.env --import=tsx scripts/perplexity-cli.ts "your question"
 *   ...  --research          sonar-deep-research (slow 30s+, deep, citation-heavy)
 *   ...  --pro               sonar-pro
 *   ...  --model <id>        explicit model id (overrides --research/--pro)
 *   ...  --recency <window>  day | week | month | year
 *   ...  --max-tokens <n>    cap output (default 1024)
 *   ...  --citations         append source URLs (auto-on for --research)
 *   ...  --json              print raw API JSON instead of formatted text
 *
 * Exit codes: 0 ok · 1 API error (401 quota, etc.) · 2 usage / missing key.
 */

const MODELS = [
  "sonar",
  "sonar-pro",
  "sonar-reasoning",
  "sonar-reasoning-pro",
  "sonar-deep-research",
] as const;

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  const i = argv.indexOf(name);
  if (i >= 0) {
    argv.splice(i, 1);
    return true;
  }
  return false;
}

function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  }
  return undefined;
}

const wantJson = flag("--json");
const research = flag("--research");
const pro = flag("--pro");
let wantCitations = flag("--citations") || research;
const explicitModel = opt("--model");
const recency = opt("--recency");
const maxTokensRaw = opt("--max-tokens");

// Everything left over (no leading --) is the query.
const query = argv.filter((a) => !a.startsWith("--")).join(" ").trim();

if (!query) {
  console.error(
    'usage: perplexity-cli.ts "your question" [--research|--pro|--model <id>] [--recency day|week|month|year] [--max-tokens N] [--citations] [--json]',
  );
  process.exit(2);
}

const apiKey = process.env.PERPLEXITY_API_KEY;
if (!apiKey) {
  console.error(
    "missing PERPLEXITY_API_KEY — run from agent/ with: node --env-file=.env --import=tsx scripts/perplexity-cli.ts ...",
  );
  process.exit(2);
}

const model = explicitModel
  ? explicitModel
  : research
    ? "sonar-deep-research"
    : pro
      ? "sonar-pro"
      : "sonar";

if (!explicitModel && !(MODELS as readonly string[]).includes(model)) {
  // (only reachable if the derived model drifts from MODELS — defensive)
  console.error(`unknown model "${model}". Known: ${MODELS.join(", ")}`);
  process.exit(2);
}

const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : 1024;
if (Number.isNaN(maxTokens) || maxTokens <= 0) {
  console.error(`--max-tokens must be a positive integer (got "${maxTokensRaw}")`);
  process.exit(2);
}

const recencyMap: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};
if (recency && !recencyMap[recency]) {
  console.error(`--recency must be one of: ${Object.keys(recencyMap).join(", ")}`);
  process.exit(2);
}

interface PplxResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ title?: string; url?: string }>;
  error?: { message?: string; type?: string; code?: number | string };
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function main() {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: query }],
    max_tokens: maxTokens,
  };
  if (recency) body.search_recency_filter = recencyMap[recency];

  // sonar-deep-research can run 30s+; give it room.
  const timeoutMs = model === "sonar-deep-research" ? 180_000 : 60_000;

  let res: Response;
  try {
    res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`request failed (${model}, ${timeoutMs / 1000}s timeout): ${msg}`);
    process.exit(1);
  }

  const text = await res.text();
  let parsed: PplxResponse;
  try {
    parsed = JSON.parse(text) as PplxResponse;
  } catch {
    console.error(`HTTP ${res.status} — non-JSON response:\n${text.slice(0, 500)}`);
    process.exit(res.ok ? 0 : 1);
  }

  if (!res.ok || parsed.error) {
    const err = parsed.error;
    console.error(`HTTP ${res.status} ${err?.type ?? ""} — ${err?.message ?? text.slice(0, 300)}`);
    if (err?.type === "insufficient_quota" || res.status === 401) {
      console.error(
        "\n→ Perplexity API is out of quota. Top up at https://www.perplexity.ai/settings/api (enable auto-recharge). No restart needed — the next call (here or in the pipeline) picks it up automatically.",
      );
    }
    process.exit(1);
  }

  if (wantJson) {
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  const content = parsed.choices?.[0]?.message?.content ?? "(no content returned)";
  console.log(content.trim());

  if (wantCitations) {
    const urls =
      parsed.citations ??
      (parsed.search_results ?? [])
        .map((s) => s.url)
        .filter((u): u is string => Boolean(u));
    if (urls.length) {
      console.log("\nSources:");
      urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));
    }
  }
}
