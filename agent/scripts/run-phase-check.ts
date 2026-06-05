/**
 * CLI wrapper for workflow-conventions PhaseCheck calls.
 *
 * Usage:
 *   node --import=tsx scripts/run-phase-check.ts <phase-name> [--<key> <value>...]
 *
 * Example:
 *   node --import=tsx scripts/run-phase-check.ts phase-7-lint-gate \
 *     --workDir /c/tmp/research-compare/some-slug
 *
 * Exit codes:
 *   0 = ok (check passed)
 *   1 = check failed — see remediation output
 *   2 = usage error (unknown phase, missing args)
 *
 * Output: human-readable status block to stdout; structured JSON tail to
 * the same stream prefixed with "JSON:" so a caller can parse it.
 */

import {
  PHASE_CHECKS,
  type PipelineContext,
  type PhaseCheckResult,
} from "../lib/workflow-conventions.js";

function usage(extra?: string): never {
  if (extra) console.error(extra);
  console.error("usage: run-phase-check.ts <phase-name> [--<key> <value>...]");
  console.error(`available phases: ${Object.keys(PHASE_CHECKS).join(", ")}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const phase = argv[0];
if (!phase) usage();

const check = PHASE_CHECKS[phase];
if (!check) usage(`unknown phase: ${phase}`);

// Parse --key value pairs. Values stay strings; the check is responsible for
// converting (parseInt etc.) when it needs numeric/boolean.
const ctx: PipelineContext = {};
for (let i = 1; i < argv.length; i += 2) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (!flag?.startsWith("--")) usage(`expected --<key>, got: ${flag}`);
  if (value === undefined) usage(`missing value for ${flag}`);
  ctx[flag.slice(2)] = value;
}

function printResult(r: PhaseCheckResult): void {
  console.log(`Phase:  ${r.phase}`);
  console.log(`Status: ${r.ok ? "✓ OK" : "✗ FAILED"}`);

  if (r.remediation.length > 0) {
    console.log("\nRemediation:");
    for (const line of r.remediation) console.log(`  ${line}`);
  }
  if (r.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const line of r.warnings) console.log(`  ${line}`);
  }
  if (r.context && Object.keys(r.context).length > 0) {
    console.log("\nContext keys:", Object.keys(r.context).join(", "));
  }

  // Structured tail for programmatic callers.
  console.log("\nJSON:" + JSON.stringify({
    ok: r.ok,
    phase: r.phase,
    remediation: r.remediation,
    warnings: r.warnings,
    context: r.context ?? {},
  }));
}

const result = await check(ctx);
printResult(result);
process.exit(result.ok ? 0 : 1);
