/**
 * S142 — studio_only artifact resolution (extracted for unit testing).
 *
 * The studio_only regen path (agent/scripts/regenerate-studio-products.ts)
 * resolves each product's NEW NotebookLM artifact deterministically by EXACT
 * submit-task_id match, then downloads BY ID. This module holds the pure
 * decision logic so it can be exercised without spawning the NLM CLI or
 * self-executing the script (which parses process.argv + calls main() at import
 * time). See agent/test/studio-snapshot-diff.test.ts.
 *
 * Fail-closed is the governing principle: studio_only is NOT wrapped by the
 * S136 Layer-2 cap-kill recovery (it is its own executor exit branch), so an
 * unproven artifact must NEVER be admitted (that would reintroduce the "S31"
 * wrong-artifact bug). When the run's own artifact cannot be proven, the product
 * stays unresolved and the run fails — never a wrong download.
 *
 * Why an exact id match and not a snapshot-diff (the S141 approach):
 * studio_only runs against a SHARED parent notebook. A snapshot-diff ("the new
 * completed artifact of this type since a pre-gen snapshot") cannot distinguish
 * OUR artifact from a CONCURRENT/FOREIGN generation of the same type on that
 * shared notebook — a foreign artifact completing while ours renders is the only
 * "new" id and gets resolved as ours (Codex S141 CRITICAL + its starts-after-
 * snapshot residual). The NotebookLM `generate <type> --json` task_id IS the
 * eventual `Artifact.id` for EVERY product type (grounded-verified in the CLI
 * source: all types route through `_call_generate`; `_parse_generation_result`
 * returns `task_id = result[0][0]`; `Artifact.from_api_response` sets
 * `id = data[0]`; the full-pipeline poll loop resolves the same way). Because
 * that id is unique per generation, no foreign/concurrent artifact can ever equal
 * it, so an exact id match is immune to the entire concurrent-foreign class. When
 * the submit id is unparseable we CANNOT prove identity, so the caller fails
 * closed (never falls back to a guess).
 */

import type { NlmArtifactRef } from "./studio-completeness.js";

/** Whether a submit task_id is usable for resolution (parseable, real — not the
 * "(unparsed)" sentinel the launcher writes when generate --json had no id). */
export function hasUsableSubmitId(submitTaskId: string | null | undefined): boolean {
  return !!submitTaskId && submitTaskId !== "(unparsed)";
}

/**
 * S142 resolution — the COMPLETED artifact whose id EQUALS our generate-submit
 * task_id, or null if it has not completed yet (or no usable submit id).
 *
 * `arts` is the COMPLETED list (realListArtifacts, status_id===3), so a non-null
 * return is BOTH "this is ours" AND "it is done." A null return on a usable id
 * means our artifact is still rendering → the caller keeps waiting (it must NOT
 * substitute any other artifact — that is the concurrent-foreign trap). Strict
 * equality only — no prefix/partial matching, so a foreign id sharing a prefix
 * can never match.
 */
export function resolveBySubmitId(
  arts: NlmArtifactRef[],
  submitTaskId: string | null | undefined,
): NlmArtifactRef | null {
  if (!hasUsableSubmitId(submitTaskId)) return null;
  return arts.find((a) => a.id === submitTaskId) ?? null;
}
