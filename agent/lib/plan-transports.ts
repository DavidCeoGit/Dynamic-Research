/**
 * S58.5 — Real transport implementations for the plan-review gate.
 *
 * Provides three factories matching the transport interfaces in
 * plan-synthesizer.ts + plan-reviewer.ts:
 *   - makeGeminiReviewerTransport()       → ReviewerTransport
 *   - makeOpenAIReviewerTransport()       → ReviewerTransport
 *   - makeClaudeIntegrationTransport()    → IntegrationTransport
 *   - makeClaudeSynthesisTransport()      → SynthesisTransport
 *
 * Plus a unified factory:
 *   - makePlanReviewTransports()          → { gemini?, codex?, integration, synthesizer }
 *
 * **Dynamic-import pattern.** SDK deps (@google/genai, openai,
 * @anthropic-ai/sdk) are loaded LAZILY on first call so this module compiles
 * + type-checks today WITHOUT the deps installed. Missing deps surface as a
 * clear runtime error the first time a transport is invoked, instructing the
 * operator to run `pnpm -C agent add ...`. The synthesizer + reviewer modules
 * themselves remain dep-free; this file is the only place SDK imports happen.
 *
 * Per Codex MAJOR-7: all env-var reads use `.trim()` per
 * [[feedback_vercel_env_add_stdin_trailing_newline]].
 *
 * Model IDs are read from env (with sensible defaults from
 * [[reference_ai_models_latest]]) so a rotation doesn't require a deploy.
 */

import {
  type SynthesisTransport,
  type SynthesisTransportInput,
  type SynthesisTransportOutput,
} from "./plan-synthesizer.js";
import {
  type ReviewerTransport,
  type ReviewerTransportInput,
  type ReviewerTransportOutput,
  type IntegrationTransport,
  type IntegrationTransportInput,
  type IntegrationTransportOutput,
  buildReviewerPromptBody,
  buildIntegrationPromptBody,
} from "./plan-reviewer.js";
import {
  type ResearchPlan,
  type ReviewFinding,
  type ReviewerVerdict,
  ORIGINS,
  REVIEWER_VERDICTS,
  SEVERITIES,
  validateResearchPlan,
  isValidFinding,
} from "./plan-types.js";

// ── Env helpers ─────────────────────────────────────────────────────

/**
 * Read an env var and trim trailing whitespace (per Codex MAJOR-7 /
 * [[feedback_vercel_env_add_stdin_trailing_newline]]). Returns undefined for
 * missing or empty-after-trim. Callers decide whether to error or fall back.
 */
function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 ? v : undefined;
}

function envIntOrDefault(name: string, fallback: number): number {
  const v = envStr(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Reads an env var that must match one of the allowed string values; falls
// back if absent/invalid. Used for the Gemini thinkingLevel knob.
function envEnum<T extends string>(
  name: string,
  fallback: T,
  values: readonly T[],
): T {
  const v = envStr(name);
  if (!v) return fallback;
  return (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

function envFloatClamped(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = envStr(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// ── Default model IDs (overridable via env) ─────────────────────────

// S59 live smoke test (2026-05-27): `gemini-3-pro-preview` returns 404 "no
// longer available" from the API even though the model list endpoint still
// includes it. `gemini-3.1-pro-preview` is the canonical replacement and
// works against live keys.
const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_OPENAI_MODEL = "gpt-5";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";

// S62 Bug 52 fix (v3, Codex MRPF v2 MAJOR-1 + MAJOR-2 corrections applied):
// gemini-3.1-pro-preview defaulted to no system framing -> rubber-stamped
// APPROVE with 0 findings on plans Codex flagged with 7-9 findings (n=2
// telemetry on da75bcdc + 86d198fc Tesla replays, 2026-05-27). These knobs
// add strict-reviewer framing + low temperature for deterministic judgment +
// explicit reasoning depth via `thinkingLevel` (the Gemini 3.x knob; the
// model cannot disable reasoning anyway, so this only controls depth).
// Reasoning tokens land in `thoughtsTokenCount` separate from
// `candidatesTokenCount`; we sum both into output_tokens for accurate
// cost-cap accounting. Historical context on the prior-knob migration:
// see `Documentation/bug-52-merge-gate-peer-review.md` (S62).
const DEFAULT_GEMINI_THINKING_LEVEL: "low" | "medium" | "high" = "high";
const DEFAULT_GEMINI_TEMPERATURE = 0.3;
// Per Gemini MRPF v1 MAJOR-1: the earlier "MUST produce findings" framing
// risked hallucinated compliance (model fabricates findings to satisfy the
// prompt). This v2 wording focuses on the QUALITY of findings rather than
// mandating their existence — encourages concrete, plan-vs-manifest gaps
// and explicitly licenses an empty findings array when the plan genuinely
// aligns. Vague/pedantic findings are discouraged.
const DEFAULT_GEMINI_SYSTEM_INSTRUCTION =
  "You are a skeptical peer reviewer for research plans. Your job is to " +
  "surface actionable, specific gaps between the plan and the manifest: " +
  "scope drift, internal inconsistencies, unstated assumptions, and depth " +
  "mismatches against the persona's stated decision context. Findings " +
  "must be concrete — cite specific plan or manifest text. Vague or " +
  "pedantic findings are NOT useful and should be omitted. An empty " +
  "findings array is correct when the plan demonstrably aligns with the " +
  "manifest across all fields.";

// ── Pricing fallback (when API doesn't return cost in $) ────────────
//
// Per-million-token rates as of 2026-05 from public pricing pages. These are
// LOOSE estimates — the SDKs are the source of truth when they return cost
// metadata. Used only as a fallback for cost-cap accounting when the SDK
// doesn't surface a dollar figure (which Gemini and OpenAI both do; this is
// purely defensive).
// Codex v2 MAJOR-1 update: values revised against live docs (May 2026).
// Several caveats apply — see the per-entry notes. Final cost-cap accuracy
// depends on the SDK returning real dollar cost (most do; this is the
// active fallback when they don't, and is the load-bearing accounting path
// for the MAX_REVIEW_COST_CENTS circuit breaker).
//
// IMPORTANT (Codex MAJOR-1): re-verify against the live pricing console
// for each provider on each deploy. APIs revise pricing more often than
// agent code revises; this table is the floor of "best effort".
//
// Gemini's pricing tiers by input-token volume: a >200k threshold doubles
// per-token cost. We track the SUB-200k tier here as the typical case;
// the active worker is bounded under the cost cap so the >200k tier is
// unlikely to be hit in practice. If it is, we under-estimate by 2x —
// cost-cap circuit would trip LATER than intended (false-negative on the
// cap). Add a `_over200k` variant of the model id if/when relevant.
const FALLBACK_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Gemini 3 + 3.1 Pro Preview (Google docs May 2026): $2/$12 under 200k
  // tokens, $4/$18 above 200k. We use the sub-200k tier as default. 3.1 is
  // the current live-API model (3 returns 404 "no longer available").
  "gemini-3-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  // OpenAI GPT-5 family — short-context standard tier
  "gpt-5": { input: 2.5, output: 10.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
  // Anthropic Claude (May 2026 standard tier; batch is 50% off).
  // Codex v2 flagged opus-4-7 as $5/$25 standard. Anthropic's published
  // Opus 4 family per-token pricing has historically been $15/$75 standard;
  // either Codex resolved a newer pricing revision or it conflated tiers.
  // Set to Codex's value but flag for verification at deploy.
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
};

function fallbackCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = FALLBACK_PRICING_PER_MTOK[modelId];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ── Output schema (what reviewers return) ───────────────────────────

/**
 * JSON shape we instruct Gemini/OpenAI to return. Kept tight so a small
 * structured-output schema validates it on the SDK side.
 */
interface ReviewerJsonOutput {
  verdict: ReviewerVerdict;
  /**
   * S79 G-MIN-1 (S75 carry-forward): nullable so a reviewer can punt
   * rather than hallucinate a score when it cannot legitimately assign
   * one. The schema's `type: ["integer", "null"]` widening is paired with
   * this. Null falls through to looksLikeHedgeBet() in
   * ensurePersonaDepthFinding — same downstream semantics as the
   * pre-S79 missing-field path.
   */
  persona_depth_score: number | null;
  findings: Array<{
    severity: "CRITICAL" | "MAJOR" | "MINOR";
    origin: string;
    message: string;
  }>;
}

/**
 * S75 schema-mismatch fix (root cause of S67-S74 "codex unreachable" failures).
 *
 * Closes the failure class where OpenAI returns valid JSON but findings[].origin
 * uses values that fail downstream isValidFinding() validation (concrete
 * `answer-N` not normalized, surprise origin labels, etc.). By passing the
 * schema to the API via `text.format.json_schema` + `strict: true`, OpenAI
 * constrains the model output server-side; invalid responses become OpenAI
 * API errors (surfaced via S74 logging fix at plan-reviewer.ts:325-334)
 * instead of silent downstream rejection by parseReviewerJson().
 *
 * **Gemini CRITICAL-1 (S75 MRPF, 2026-05-31):** OpenAI's Structured Outputs
 * strict mode explicitly does NOT support these JSON Schema keywords:
 * `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format`,
 * `default`, and most `oneOf`/`anyOf`/`allOf` compositions. Including any of
 * them causes a 400 Bad Request on every call. So this schema enforces only
 * what strict mode supports (`type`, `enum`, `items`, `properties`,
 * `required`, `additionalProperties`); range/length/format constraints stay
 * downstream in parseReviewerJson() + isValidFinding(), which both ran fine
 * pre-S75 against models that already returned valid shape.
 *
 * The `answer-N` template in ORIGINS is expanded to a finite literal enum
 * `answer-0` through `answer-${ANSWER_N_MAX}` so the strict-mode enum accepts
 * every concrete form the downstream isValidFinding regex `/^answer-\d+$/`
 * would also accept (including zero-indexed and large N). Bump ANSWER_N_MAX
 * if a manifest ever holds more than ${ANSWER_N_MAX + 1} Phase-0 answers;
 * the downstream regex does NOT cap, so a bump-and-redeploy resolves any
 * future overflow cleanly. Bound is generous (Codex S75 MRPF MAJOR-1: avoid
 * silently rejecting >20-answer plans + zero-indexed form).
 *
 * Built dynamically from plan-types.ts so future ORIGINS/SEVERITIES additions
 * stay in sync without touching this file.
 *
 * **S77 (C-CRIT-2 carry-forward, 2026-05-31):** the OpenAI transport now
 * prefers SDK-pre-parsed payloads (`output_parsed` / `message.parsed`)
 * over re-parsing `output_text` / `message.content`. Achieved by invoking
 * `responses.parse()` / `chat.completions.parse()` (the openai 6.x SDK
 * helpers that wrap `create()` + JSON-parse the schema-validated output)
 * when present; falling back to `create()` for older SDK builds. The
 * text-parsing path in `parseReviewerJson` remains the safety net.
 *
 * Codex S77 MRPF MAJOR-1 caught the v2 first-pass: the bare `create()`
 * methods do NOT populate output_parsed — only the helper `.parse()`
 * does (it wraps create() + parseResponse()). v3 switches to the helper
 * when available; v2's defensive fallback would otherwise be dead code.
 */
const ANSWER_N_MAX = 50;
const NON_TEMPLATE_ORIGINS = ORIGINS.filter((o) => o !== "answer-N");
const ANSWER_ORIGIN_LITERALS = Array.from(
  { length: ANSWER_N_MAX + 1 },
  (_, i) => `answer-${i}`,
);
const OPENAI_ORIGIN_ENUM = [...NON_TEMPLATE_ORIGINS, ...ANSWER_ORIGIN_LITERALS];

const OPENAI_REVIEWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "persona_depth_score", "findings"],
  properties: {
    verdict: { type: "string", enum: [...REVIEWER_VERDICTS] },
    // bounds (0-4) enforced downstream in parseReviewerJson — strict mode
    // forbids `minimum`/`maximum`. See Gemini CRITICAL-1 in the header block.
    // S79 G-MIN-1 (S75 carry-forward): nullable type array `["integer",
    // "null"]` lets the reviewer return null instead of hallucinating a
    // score when it cannot legitimately assign one. Strict-mode JSON
    // Schema explicitly supports type arrays for nullability (the standard
    // OpenAI structured-outputs pattern for optional fields).
    persona_depth_score: { type: ["integer", "null"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "origin", "message"],
        properties: {
          severity: { type: "string", enum: [...SEVERITIES] },
          origin: { type: "string", enum: [...OPENAI_ORIGIN_ENUM] },
          // non-empty enforced downstream in isValidFinding — strict mode
          // forbids `minLength`. See Gemini CRITICAL-1 in the header block.
          message: { type: "string" },
        },
      },
    },
  },
} as const;

function reviewerJsonInstruction(): string {
  return [
    "Return ONLY a JSON object with this exact shape:",
    "{",
    '  "verdict": "APPROVE" | "APPROVE_WITH_CHANGES" | "REQUEST_CHANGES" | "BLOCK",',
    '  "persona_depth_score": 0|1|2|3|4|null,',
    '  "findings": [',
    '    { "severity": "CRITICAL"|"MAJOR"|"MINOR", "origin": "topic|persona|answer-N|studio-selection|decision-context|plan-ambition|scoring-rubric|source-strategy|vendor-evaluation", "message": "..." }',
    "  ]",
    "}",
    "",
    "Empty findings array is valid for APPROVE. answer-N uses the 1-indexed concrete form (e.g. answer-3).",
    "Use null for persona_depth_score ONLY when the rubric cannot be applied to the plan at all (e.g., the plan is so malformed it does not address the 0-4 criteria). If you are merely uncertain between two adjacent tiers, pick the closer integer rather than defaulting to null — null is a last resort, not a hedge.",
    "Do NOT include prose outside the JSON object.",
  ].join("\n");
}

type ReviewerParseResult =
  | { ok: true; value: ReviewerJsonOutput }
  | { ok: false; errors: string[] };

/**
 * Validate an already-JSON-parsed reviewer payload against the
 * ReviewerJsonOutput shape (verdict enum, persona_depth_score bounds, findings
 * array via isValidFinding). Returns the typed value on success.
 *
 * S77 (C-CRIT-2 carry-forward): extracted so the OpenAI transport can prefer
 * SDK-pre-parsed payloads (`output_parsed` / `message.parsed` populated by
 * strict json_schema mode in newer openai SDK builds) over re-parsing
 * `output_text` / `message.content`. parseReviewerJson() remains the text-path
 * entry that wraps this with JSON.parse + fence-stripping.
 */
function validateReviewerJsonShape(parsed: unknown): ReviewerParseResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ["response is not a JSON object"] };
  }
  const p = parsed as Record<string, unknown>;
  const errors: string[] = [];
  if (!REVIEWER_VERDICTS.includes(p.verdict as ReviewerVerdict)) {
    errors.push(`bad verdict: ${JSON.stringify(p.verdict)}`);
  }
  // S79 G-MIN-1 (S75 carry-forward): accept explicit null as a legitimate
  // "reviewer punted" signal (paired with schema type `["integer", "null"]`
  // and prompt-side guidance). The field is still REQUIRED in the schema —
  // undefined / missing remains a validation error so we distinguish
  // "reviewer answered null deliberately" from "reviewer omitted the field
  // entirely". The downstream null path is the same as the missing-field
  // path (looksLikeHedgeBet fallback in ensurePersonaDepthFinding).
  if (!("persona_depth_score" in p)) {
    errors.push("persona_depth_score is required (use null to punt)");
  } else if (
    p.persona_depth_score !== null &&
    (typeof p.persona_depth_score !== "number" ||
      p.persona_depth_score < 0 ||
      p.persona_depth_score > 4 ||
      !Number.isInteger(p.persona_depth_score))
  ) {
    errors.push(
      `bad persona_depth_score: ${JSON.stringify(p.persona_depth_score)}`,
    );
  }
  if (!Array.isArray(p.findings)) {
    errors.push("findings must be an array");
  } else if (!p.findings.every(isValidFinding)) {
    errors.push("one or more findings failed isValidFinding()");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: parsed as ReviewerJsonOutput };
}

/**
 * Parse + validate a reviewer's JSON response. Returns null with errors-array
 * if parsing/validation fails — caller decides whether to retry or treat as
 * UNAVAILABLE.
 */
function parseReviewerJson(text: string): ReviewerParseResult {
  let parsed: unknown;
  try {
    // Strip optional ```json fences just in case.
    const t = text.trim();
    const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    parsed = JSON.parse(fence ? fence[1]! : t);
  } catch (err) {
    return { ok: false, errors: [`JSON.parse failed: ${(err as Error).message}`] };
  }
  return validateReviewerJsonShape(parsed);
}

// ── Dynamic-import helpers (lazy SDK load) ──────────────────────────
//
// Codex v2 MAJOR-2 fix: SDK loaders are overridable for tests via
// __overrideSdkImports() — production paths call the real `import()`
// statement; unit tests inject fake module exports to exercise the
// downstream shape-handling logic without needing the real SDKs installed.

interface SdkOverrides {
  google?: () => Promise<{
    GoogleGenAI: new (init: { apiKey: string }) => unknown;
  }>;
  openai?: () => Promise<{
    default: new (init: { apiKey: string }) => unknown;
  }>;
  anthropic?: () => Promise<{
    default: new (init: { apiKey: string }) => unknown;
  }>;
}

let _sdkOverrides: SdkOverrides = {};

/**
 * TEST-ONLY: override the SDK loader functions so tests can inject mocked
 * module exports without installing the real packages. Reset with
 * {@link __resetSdkOverridesForTesting}. Calling this also clears any
 * memoized loader-promise state so the next loader call uses the override.
 */
export function __overrideSdkLoadersForTesting(overrides: SdkOverrides): void {
  _sdkOverrides = overrides;
  _googleSdkPromise = null;
  _openaiSdkPromise = null;
  _anthropicSdkPromise = null;
}

/** TEST-ONLY: reset all SDK loader overrides + memoized state. */
export function __resetSdkOverridesForTesting(): void {
  _sdkOverrides = {};
  _googleSdkPromise = null;
  _openaiSdkPromise = null;
  _anthropicSdkPromise = null;
}

// String-variable indirection on the dynamic-import specifier so tsc doesn't
// try to statically resolve the package types at compile time (the SDKs are
// NOT installed in the agent stack until S59 user-present `pnpm add`). At
// runtime Node's ESM loader resolves the variable value just fine.
const dynamicImport = (specifier: string): Promise<unknown> =>
  import(specifier);

let _googleSdkPromise: Promise<unknown> | null = null;
async function loadGoogleGenAI(): Promise<{
  GoogleGenAI: new (init: { apiKey: string }) => unknown;
}> {
  if (!_googleSdkPromise) {
    _googleSdkPromise = (async () => {
      if (_sdkOverrides.google) return _sdkOverrides.google();
      try {
        return await dynamicImport("@google/genai");
      } catch (err) {
        throw new Error(
          `@google/genai not installed. Run: pnpm -C agent add @google/genai. Underlying: ${(err as Error).message}`,
        );
      }
    })();
  }
  return _googleSdkPromise as Promise<{
    GoogleGenAI: new (init: { apiKey: string }) => unknown;
  }>;
}

let _openaiSdkPromise: Promise<unknown> | null = null;
async function loadOpenAI(): Promise<{
  default: new (init: { apiKey: string }) => unknown;
}> {
  if (!_openaiSdkPromise) {
    _openaiSdkPromise = (async () => {
      if (_sdkOverrides.openai) return _sdkOverrides.openai();
      try {
        return await dynamicImport("openai");
      } catch (err) {
        throw new Error(
          `openai not installed. Run: pnpm -C agent add openai. Underlying: ${(err as Error).message}`,
        );
      }
    })();
  }
  return _openaiSdkPromise as Promise<{
    default: new (init: { apiKey: string }) => unknown;
  }>;
}

let _anthropicSdkPromise: Promise<unknown> | null = null;
async function loadAnthropic(): Promise<{
  default: new (init: { apiKey: string }) => unknown;
}> {
  if (!_anthropicSdkPromise) {
    _anthropicSdkPromise = (async () => {
      if (_sdkOverrides.anthropic) return _sdkOverrides.anthropic();
      try {
        return await dynamicImport("@anthropic-ai/sdk");
      } catch (err) {
        throw new Error(
          `@anthropic-ai/sdk not installed. Run: pnpm -C agent add @anthropic-ai/sdk. Underlying: ${(err as Error).message}`,
        );
      }
    })();
  }
  return _anthropicSdkPromise as Promise<{
    default: new (init: { apiKey: string }) => unknown;
  }>;
}

// ── Gemini reviewer ────────────────────────────────────────────────

export interface GeminiTransportOptions {
  /** Override env var GEMINI_API_KEY. */
  apiKey?: string;
  /** Override env var GEMINI_MODEL (default DEFAULT_GEMINI_MODEL). */
  modelId?: string;
  /** Override env var GEMINI_THINKING_LEVEL (default "high"). S62 Bug 52 v3. */
  thinkingLevel?: "low" | "medium" | "high";
  /** Override env var GEMINI_TEMPERATURE (default 0.3). S62 Bug 52. */
  temperature?: number;
  /** Override env var GEMINI_SYSTEM_INSTRUCTION (default strict-reviewer prompt). S62 Bug 52. */
  systemInstruction?: string;
}

/**
 * Build a ReviewerTransport for Gemini. Returns null if GEMINI_API_KEY is
 * absent (the reviewer is treated as unavailable per design §6 fallback).
 *
 * NOTE: This thin wrapper uses the modern @google/genai SDK shape
 * (`new GoogleGenAI({apiKey}).models.generateContent({model, contents,
 * config: { responseMimeType: "application/json" }})`). When wiring,
 * verify against the SDK version installed (`pnpm list @google/genai`).
 */
export function makeGeminiReviewerTransport(
  opts: GeminiTransportOptions = {},
): ReviewerTransport | null {
  const apiKey = opts.apiKey ?? envStr("GEMINI_API_KEY");
  if (!apiKey) return null;
  const modelId = opts.modelId ?? envStr("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;
  // S62 Bug 52 v3: see DEFAULT_GEMINI_* block above for the rationale.
  const thinkingLevel =
    opts.thinkingLevel ??
    envEnum(
      "GEMINI_THINKING_LEVEL",
      DEFAULT_GEMINI_THINKING_LEVEL,
      ["low", "medium", "high"] as const,
    );
  const temperature =
    opts.temperature ??
    envFloatClamped("GEMINI_TEMPERATURE", DEFAULT_GEMINI_TEMPERATURE, 0, 2);
  const systemInstruction =
    opts.systemInstruction ??
    envStr("GEMINI_SYSTEM_INSTRUCTION") ??
    DEFAULT_GEMINI_SYSTEM_INSTRUCTION;

  return async (input: ReviewerTransportInput): Promise<ReviewerTransportOutput> => {
    const start = Date.now();
    const { GoogleGenAI } = await loadGoogleGenAI();
    const ai = new GoogleGenAI({ apiKey }) as unknown as {
      models: {
        generateContent: (req: {
          model: string;
          contents: string;
          config?: {
            responseMimeType?: string;
            abortSignal?: AbortSignal;
            systemInstruction?: string;
            temperature?: number;
            thinkingConfig?: { thinkingLevel?: "low" | "medium" | "high" };
          };
        }) => Promise<{
          text?: string;
          response?: { text?: string };
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
          };
        }>;
      };
    };

    const prompt = [
      buildReviewerPromptBody(input.plan, input.manifest, input.iteration),
      "",
      reviewerJsonInstruction(),
    ].join("\n");

    const resp = await ai.models.generateContent({
      model: modelId,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        abortSignal: input.signal,
        systemInstruction,
        temperature,
        thinkingConfig: { thinkingLevel },
      },
    });

    // Normalize text extraction across SDK shape variants.
    const text = (resp.text ?? resp.response?.text ?? "").toString();
    // Per Codex MRPF v2 MAJOR-2: Gemini 3.x emits reasoning tokens in
    // `thoughtsTokenCount` separate from candidates. Without summing them in,
    // the cost cap under-counts and the Bug 52 success-criterion check
    // (output-token delta) misses the reasoning entirely.
    const inputTokens = resp.usageMetadata?.promptTokenCount ?? 0;
    const candidatesTokens = resp.usageMetadata?.candidatesTokenCount ?? 0;
    const thoughtsTokens = resp.usageMetadata?.thoughtsTokenCount ?? 0;
    const outputTokens = candidatesTokens + thoughtsTokens;
    const duration_ms = Date.now() - start;

    const parsed = parseReviewerJson(text);
    if (!parsed.ok) {
      // S75: bumped 500→4000 so the diagnostic surfaces the full failing
      // findings array (the S74 fix exposed that 500 chars truncates the
      // tail finding exactly where the schema mismatch lives).
      throw new Error(
        `gemini returned non-conformant JSON: ${parsed.errors.join("; ")} — raw text: ${text.slice(0, 4000)}`,
      );
    }
    return {
      verdict: parsed.value.verdict,
      persona_depth_score: parsed.value.persona_depth_score,
      findings: parsed.value.findings as ReviewFinding[],
      total_cost_usd: fallbackCostUsd(modelId, inputTokens, outputTokens),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms,
      model_id: modelId,
      raw_json: parsed.value,
    };
  };
}

// ── OpenAI reviewer (Codex role) ────────────────────────────────────

/**
 * Classify an OpenAI SDK error as a schema-vocabulary 400. Mirrors the
 * helper at plan-reviewer.ts:isSchema400 — same regex anchors
 * (json_schema / response_format / invalid schema / unsupported keyword)
 * and same Number() coercion for stringified statuses. Intentionally
 * duplicated rather than cross-imported: plan-reviewer.ts owns the
 * retry-policy use; plan-transports.ts owns the transport-internal
 * json_schema → json_object fallback. Keep both call sites in sync if
 * the failure surface changes.
 */
function isSchema400(err: unknown): boolean {
  const e = err as {
    status?: unknown;
    message?: string;
    error?: { type?: unknown; message?: string };
  };
  if (Number(e?.status) !== 400) return false;
  const parts = [
    typeof e.message === "string" ? e.message : "",
    typeof e.error?.message === "string" ? e.error.message : "",
  ];
  const combined = parts.join(" ").toLowerCase();
  return /\b(json_?schema|response_format|invalid.*schema|unsupported.*keyword)\b/.test(
    combined,
  );
}

export interface OpenAITransportOptions {
  apiKey?: string;
  modelId?: string;
}

/**
 * Build a ReviewerTransport for OpenAI (Codex role). Returns null if
 * OPENAI_API_KEY is absent.
 *
 * Uses the Responses API (`openai.responses.create({...})`) where supported
 * because it has a cleaner JSON-mode contract than chat-completions. Falls
 * back to chat.completions when responses isn't present in the SDK build.
 */
export function makeOpenAIReviewerTransport(
  opts: OpenAITransportOptions = {},
): ReviewerTransport | null {
  const apiKey = opts.apiKey ?? envStr("OPENAI_API_KEY");
  if (!apiKey) return null;
  const modelId = opts.modelId ?? envStr("OPENAI_MODEL") ?? DEFAULT_OPENAI_MODEL;

  return async (input: ReviewerTransportInput): Promise<ReviewerTransportOutput> => {
    const start = Date.now();
    const { default: OpenAI } = await loadOpenAI();
    // S77 C-CRIT-2 + Codex MRPF MAJOR-1: response shape is identical between
    // create() and parse(); only parse() populates output_parsed / message.parsed.
    // Both methods are typed so we can feature-detect parse() at the call site
    // and fall back to create() on older SDK builds without it.
    type ResponsesResult = {
      output_text?: string;
      output_parsed?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
    };
    type ChatCompletionsResult = {
      choices: Array<{
        message: {
          content: string | null;
          parsed?: unknown;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    const client = new OpenAI({ apiKey }) as unknown as {
      responses?: {
        create: (req: unknown) => Promise<ResponsesResult>;
        parse?: (req: unknown) => Promise<ResponsesResult>;
      };
      chat: {
        completions: {
          create: (req: unknown) => Promise<ChatCompletionsResult>;
          parse?: (req: unknown) => Promise<ChatCompletionsResult>;
        };
      };
    };

    const prompt = [
      buildReviewerPromptBody(input.plan, input.manifest, input.iteration),
      "",
      reviewerJsonInstruction(),
    ].join("\n");

    let text = "";
    // S77 C-CRIT-2 (+ Codex MRPF MAJOR-1 / MAJOR-2): SDK-pre-parsed payload
    // when present. Populated by `responses.parse()` / `chat.completions
    // .parse()` (the openai 6.x helpers that wrap create() + JSON-parse the
    // schema-validated output). Prefer it over re-parsing the raw text.
    let preParsedFromSdk: unknown = undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    if (client.responses?.create) {
      // Codex v2 CRITICAL-2: Responses API JSON mode lives under
      // `text.format`, NOT top-level `response_format`. The old shape
      // returns 400 against modern openai SDKs.
      //
      // S75 schema migration: `json_object` → `json_schema` with strict:true
      // forces server-side constraint enforcement on the verdict/severity/
      // origin enums + the structural shape (additionalProperties: false +
      // required fields). Range/length constraints stay downstream because
      // strict mode forbids minimum/maximum/minLength/pattern (Gemini
      // CRITICAL-1; see OPENAI_REVIEWER_JSON_SCHEMA header). Eliminates the
      // S67-S74 "codex unreachable" failure class where valid JSON shape
      // passed the SDK but a single finding's origin label failed downstream
      // isValidFinding() validation.
      const responsesReq = {
        model: modelId,
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name: "reviewer_output",
            schema: OPENAI_REVIEWER_JSON_SCHEMA,
            strict: true,
          },
        },
      };
      // S77 Codex MRPF MAJOR-1: prefer responses.parse() — it wraps create()
      // and populates output_parsed by JSON-parsing the schema-validated
      // output_text. Without this switch, the v2 preParsedFromSdk capture
      // is dead code on openai 6.x (create() leaves output_parsed undefined).
      // Body shape is identical between the two methods.
      //
      // S77 Codex MRPF MAJOR-2: invoke through the receiver (not as an
      // unbound function reference) — the SDK resource methods use
      // `this._client` internally, so extracting them via `parse ?? create`
      // and calling unbound throws at production. The conditional call
      // below preserves receiver context on both branches.
      const resp = client.responses.parse
        ? await client.responses.parse(responsesReq)
        : await client.responses.create(responsesReq);
      text = (resp.output_text ?? "").toString();
      preParsedFromSdk = resp.output_parsed;
      inputTokens = resp.usage?.input_tokens ?? 0;
      outputTokens = resp.usage?.output_tokens ?? 0;
    } else {
      // chat.completions json_schema shape differs from Responses API: the
      // schema lives under `response_format.json_schema` (not text.format).
      const chatReqStrict = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reviewer_output",
            schema: OPENAI_REVIEWER_JSON_SCHEMA,
            strict: true,
          },
        },
      };
      // S77 Codex MRPF MAJOR-1: mirror Responses-branch parse()-first pattern.
      // chat.completions.parse() populates message.parsed; create() does not.
      // Dead-code path under modern openai SDK + gpt-5 default anyway, but
      // kept symmetric with the Responses branch.
      //
      // S77 Codex MRPF MAJOR-2: invoke through the receiver (same rationale
      // as the Responses branch — SDK methods use `this._client`).
      //
      // S78 C-MAJ-3: older SDK builds (pre-strict-structured-outputs) and
      // some 3rd-party-hosted OpenAI-compatible endpoints reject the
      // json_schema response_format with a 400 schema-vocabulary error
      // (regex anchors in isSchema400 above). Catch THAT specific 400 and
      // retry with the looser `json_object` shape — strict-mode constraint
      // enforcement then moves to parseReviewerJson() + isValidFinding()
      // downstream, same safety net the pre-S75 code relied on. Non-schema
      // errors propagate untouched (auth, rate-limit, billing all surface
      // as before). The fallback uses .create() directly because .parse()
      // requires a json_schema body — it has no contract for json_object.
      let resp: ChatCompletionsResult;
      try {
        resp = client.chat.completions.parse
          ? await client.chat.completions.parse(chatReqStrict)
          : await client.chat.completions.create(chatReqStrict);
      } catch (err) {
        if (!isSchema400(err)) throw err;
        // S78 Gemini MRPF MINOR-1: unwrap the nested `error.message` first.
        // OpenAI/compat SDKs put the diagnostic schema-keyword detail in
        // `err.error.message`; the outer `err.message` is often just
        // "400 status code (no body)" or "[object Object]" if the SDK
        // didn't flatten. Falls back to outer message + String() so we
        // never lose visibility.
        const errInner = (err as { error?: { message?: unknown } })?.error?.message;
        const errMsg =
          typeof errInner === "string"
            ? errInner
            : ((err as Error)?.message ?? String(err));
        console.error(
          `[openai-reviewer] chat.completions json_schema rejected (schema-400) — retrying with json_object. underlying: ${errMsg}`,
        );
        // S78 Gemini MRPF MAJOR-1: inherit all chatReqStrict fields via
        // spread so future config (temperature, max_tokens, seed, etc.)
        // propagates to the fallback. Today the only delta is
        // response_format; the spread keeps that invariant as the strict
        // request grows.
        const chatReqLoose = {
          ...chatReqStrict,
          response_format: { type: "json_object" },
        };
        resp = await client.chat.completions.create(chatReqLoose);
      }
      text = resp.choices[0]?.message.content ?? "";
      preParsedFromSdk = resp.choices[0]?.message.parsed;
      inputTokens = resp.usage?.prompt_tokens ?? 0;
      outputTokens = resp.usage?.completion_tokens ?? 0;
    }

    const duration_ms = Date.now() - start;
    // S77 C-CRIT-2: prefer SDK-pre-parsed payload populated by the
    // responses.parse() / chat.completions.parse() helpers above. The
    // helpers JSON-parse the schema-validated output_text and surface it
    // as output_parsed / message.parsed. Saves a redundant JSON.parse and
    // bypasses fence-stripping fragility. Falls back to text parsing when
    // create() was used (older SDK without parse helpers).
    //
    // Gemini S77 MRPF MINOR-3: guard on `typeof === "object"` (not just
    // not-null/undefined) so a string-shaped preParsedFromSdk (mock SDKs,
    // future SDK quirks where parsed-field surfaces raw text with fences)
    // falls through to parseReviewerJson — which keeps fence-stripping
    // + JSON.parse active instead of returning a hard "not a JSON object"
    // failure.
    //
    // Codex S77 MRPF MAJOR-1: the parse()-first switch above ensures this
    // branch actually fires on openai 6.x (v2 left preParsedFromSdk
    // permanently undefined because create() never populates these fields).
    const parsed =
      typeof preParsedFromSdk === "object" && preParsedFromSdk !== null
        ? validateReviewerJsonShape(preParsedFromSdk)
        : parseReviewerJson(text);
    if (!parsed.ok) {
      // S75: bumped 500→4000 to match the Gemini-side bump and surface the
      // full failing payload. With strict json_schema enforcement upstream
      // this path SHOULD be unreachable for schema errors — if it still
      // fires, the model returned valid-shape output with content that
      // somehow defeats isValidFinding(), which is high-signal diagnostic.
      throw new Error(
        `openai returned non-conformant JSON: ${parsed.errors.join("; ")} — raw text: ${text.slice(0, 4000)}`,
      );
    }
    return {
      verdict: parsed.value.verdict,
      persona_depth_score: parsed.value.persona_depth_score,
      findings: parsed.value.findings as ReviewFinding[],
      total_cost_usd: fallbackCostUsd(modelId, inputTokens, outputTokens),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms,
      model_id: modelId,
      raw_json: parsed.value,
    };
  };
}

// ── Claude integration transport ────────────────────────────────────

export interface ClaudeTransportOptions {
  apiKey?: string;
  modelId?: string;
  maxOutputTokens?: number;
}

/**
 * Build an IntegrationTransport that invokes Claude (Anthropic API) to
 * produce a revised plan in response to reviewer findings.
 *
 * Design §11 calls for "same synthesizer-Claude session with prior plan
 * context preserved." The functional equivalent (passing the full prior
 * plan + finding context per call) is implemented here. Direct Anthropic API
 * use (rather than `claude -p`) avoids the cache-priming surprise per
 * [[feedback_claude_cli_cache_priming_cost]] and gives the executor a clean
 * cost-accounting hook.
 */
export function makeClaudeIntegrationTransport(
  opts: ClaudeTransportOptions = {},
): IntegrationTransport {
  const apiKey = opts.apiKey ?? envStr("ANTHROPIC_API_KEY");
  const modelId = opts.modelId ?? envStr("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = opts.maxOutputTokens ?? envIntOrDefault("ANTHROPIC_MAX_OUTPUT_TOKENS", 8192);

  return async (input: IntegrationTransportInput): Promise<IntegrationTransportOutput> => {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY missing — integration transport cannot run. Add the key to agent/.env + Vercel envs.",
      );
    }
    const start = Date.now();
    const { default: Anthropic } = await loadAnthropic();
    const client = new Anthropic({ apiKey }) as unknown as {
      messages: {
        create: (req: {
          model: string;
          max_tokens: number;
          messages: Array<{ role: "user"; content: string }>;
        }) => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        }>;
      };
    };

    const prompt = buildIntegrationPromptBody(
      input.plan,
      input.reviewer_call,
      input.manifest,
    );
    const resp = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    const inputTokens = resp.usage?.input_tokens ?? 0;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    const duration_ms = Date.now() - start;

    // Extract JSON object (claude sometimes adds preamble even when told not to).
    let jsonText = text.trim();
    const fence = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    if (fence) jsonText = fence[1]!.trim();
    const firstBrace = jsonText.indexOf("{");
    if (firstBrace > 0) jsonText = jsonText.slice(firstBrace);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `claude integration returned non-JSON: ${(err as Error).message} — raw text: ${text.slice(0, 500)}`,
      );
    }
    const validated = validateResearchPlan(parsed);
    if (!validated.valid || !validated.value) {
      throw new Error(
        `claude integration produced invalid plan: ${validated.errors.join("; ")}`,
      );
    }

    return {
      integrated_plan: validated.value,
      total_cost_usd: fallbackCostUsd(modelId, inputTokens, outputTokens),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms,
      model_id: modelId,
      raw_json: { text },
    };
  };
}

// ── Claude synthesis transport (for plan-synthesizer.ts) ────────────

/**
 * Build a SynthesisTransport that invokes Claude (Anthropic API) to produce
 * the initial ResearchPlan from a manifest. Used by executor.ts Phase 0a.
 * Same dynamic-import + cost-accounting shape as the integration transport.
 */
export function makeClaudeSynthesisTransport(
  opts: ClaudeTransportOptions = {},
): SynthesisTransport {
  const apiKey = opts.apiKey ?? envStr("ANTHROPIC_API_KEY");
  const modelId = opts.modelId ?? envStr("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = opts.maxOutputTokens ?? envIntOrDefault("ANTHROPIC_MAX_OUTPUT_TOKENS", 8192);

  return async (
    input: SynthesisTransportInput,
  ): Promise<SynthesisTransportOutput> => {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY missing — synthesis transport cannot run.",
      );
    }
    const start = Date.now();
    const { default: Anthropic } = await loadAnthropic();
    const client = new Anthropic({ apiKey }) as unknown as {
      messages: {
        create: (req: {
          model: string;
          max_tokens: number;
          messages: Array<{ role: "user"; content: string }>;
        }) => Promise<{
          content: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        }>;
      };
    };
    const resp = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: input.prompt }],
    });
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    const inputTokens = resp.usage?.input_tokens ?? 0;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    return {
      text,
      total_cost_usd: fallbackCostUsd(modelId, inputTokens, outputTokens),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: Date.now() - start,
      model_id: modelId,
    };
  };
}

// ── Unified factory (called by executor.ts) ─────────────────────────

export interface PlanReviewTransports {
  /** Null if GEMINI_API_KEY is absent. Reviewer marked unavailable in that case. */
  gemini: ReviewerTransport | null;
  /** Null if OPENAI_API_KEY is absent. Reviewer marked unavailable in that case. */
  codex: ReviewerTransport | null;
  /** Always present; throws at call time if ANTHROPIC_API_KEY is missing. */
  integration: IntegrationTransport;
  /** Always present; throws at call time if ANTHROPIC_API_KEY is missing. */
  synthesizer: SynthesisTransport;
}

/**
 * One-stop factory called by executor.ts. Reads env vars; returns transports.
 * The returned shape can be passed directly to synthesizePlan() + reviewPlan()
 * with the SAME process-level Anthropic client serving both synthesis and
 * integration (per design §11 — "same synthesizer-Claude session" semantic).
 */
export function makePlanReviewTransports(): PlanReviewTransports {
  return {
    gemini: makeGeminiReviewerTransport(),
    codex: makeOpenAIReviewerTransport(),
    integration: makeClaudeIntegrationTransport(),
    synthesizer: makeClaudeSynthesisTransport(),
  };
}
