/**
 * S52 #3 v3 — Prompt-injection fence helpers for the agent (worker daemon)
 * side, paired with frontend/lib/untrusted-input.ts.
 *
 * The agent spawns `claude -p` subprocesses with Bash, Read, Write,
 * WebSearch, WebFetch, and Perplexity/Chrome MCP tools allowed. This
 * makes prompt-injection here higher-risk than the frontend (which only
 * does structured generateObject calls) — a successful injection could
 * trigger actual code execution. The fence helpers here MUST stay in
 * lockstep with their frontend twin.
 *
 * Three layers of defense (same as the frontend):
 *   1. JSON.stringify — escapes quotes, backticks, newlines, control chars.
 *   2. .replace(/</g, '<').replace(/>/g, '>') — Unicode-escape
 *      angle brackets so a payload containing literal `</untrusted_input>`
 *      cannot present as a structural close-tag. JSON spec does NOT
 *      mandate escaping `<` / `>`, so JSON.stringify alone is insufficient
 *      (Gemini Deep Think C1 finding, S52 #3 v1 review).
 *   3. The caller MUST wrap fenced text in <untrusted_input> ... tags
 *      AND the prompt MUST contain the CRITICAL directive instructing
 *      Claude not to follow directives from fenced content.
 *
 * **Pair-edit rule:** any change to the escape semantics here MUST be
 * mirrored in frontend/lib/untrusted-input.ts. Codify by reading both
 * files in any future MERGE that touches either.
 */

/**
 * Internal: JSON.stringify a value, then Unicode-escape any `<` / `>`
 * so the result cannot present structural close-tag tokens to an LLM.
 *
 * @param value  any JSON-serializable value
 * @returns      JSON-encoded string with angle brackets escaped
 */
function jsonAndEscape(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/**
 * Encode a piece of untrusted text for safe interpolation inside an
 * <untrusted_input> fence. Frontend-twin API; takes a string.
 *
 * @param text  the raw user-supplied string
 * @returns     a JSON-quoted string with angle brackets Unicode-escaped
 */
export function fenceUserText(text: string): string {
  return jsonAndEscape(text);
}

/**
 * Encode an arbitrary JSON-serializable value AND wrap it in an
 * <untrusted_input type="..."> ... </untrusted_input> envelope ready
 * for direct interpolation into a Claude CLI prompt.
 *
 * Used by agent/executor.ts:buildPrompt to fence every user-supplied
 * field (topic, domainKnowledge[], constraints[], vendor strings,
 * customizations objects, etc.) consistently.
 *
 * @param label  XML type attribute (e.g. "topic", "domainKnowledge")
 * @param value  any JSON-serializable value
 * @returns      complete fenced XML element ready for prompt interpolation
 */
export function fenceValue(label: string, value: unknown): string {
  return `<untrusted_input type="${label}">\n${jsonAndEscape(value)}\n</untrusted_input>`;
}
