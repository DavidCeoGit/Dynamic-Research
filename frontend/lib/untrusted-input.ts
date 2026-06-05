/**
 * S52 #3 — Prompt-injection fence helper for LLM-calling API routes.
 *
 * Encodes a piece of user-supplied text so it can be safely interpolated
 * inside an <untrusted_input> ... </untrusted_input> fence in an LLM
 * prompt without enabling structural-tag breakout.
 *
 * Three layers of defense:
 *   1. JSON.stringify — escapes quotes, backticks, newlines, control chars,
 *      so triple-quote / newline injection cannot escape the data envelope.
 *   2. .replace(/</g, '<').replace(/>/g, '>') — Unicode-escape
 *      angle brackets so a payload containing literal `</untrusted_input>`
 *      cannot present as a structural close-tag to the model. JSON spec
 *      does NOT mandate escaping `<` and `>`, so JSON.stringify alone is
 *      insufficient — confirmed via Gemini Deep Think MERGE-gate review
 *      (S52 #3 v1 → C1 CRITICAL finding).
 *   3. The caller MUST wrap the fenced text inside <untrusted_input> ...
 *      </untrusted_input> tags AND the system prompt MUST contain the
 *      CRITICAL directive instructing the model not to follow directives
 *      from fenced content. Per memory feedback_untrusted_input_fence_pattern.md.
 *
 * Lossless: the model still sees the original semantic content (a string
 * with `<` and `>` characters), because `<` and `>` are valid
 * JSON-encoded Unicode escapes that the model decodes naturally during
 * inference. Topics about HTML/XML/code are NOT mangled.
 *
 * Caller pattern:
 *   prompt: `<untrusted_input type="topic">\n${fenceUserText(topic)}\n</untrusted_input>`
 *
 * Pair with the CRITICAL directive in the system prompt AND a trailing
 * REMINDER sandwich anchor below the closing tag for defense-in-depth.
 */

/**
 * Encode a piece of untrusted text for safe interpolation inside an
 * <untrusted_input> fence in an LLM prompt.
 *
 * @param text  the raw user-supplied string
 * @returns     a JSON-quoted string with angle brackets Unicode-escaped
 */
export function fenceUserText(text: string): string {
  return JSON.stringify(text)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}
