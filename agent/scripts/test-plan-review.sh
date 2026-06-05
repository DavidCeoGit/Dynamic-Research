#!/usr/bin/env bash
# S58 Phase 1 MVP — runner for plan-review-gate unit tests.
#
# Runs:
#   1. tsc --noEmit on agent/ (covers lib/ + new test/ files via tsconfig.json
#      include addition)
#   2. node --test on test/plan-*.test.ts (node:test + node:assert/strict)
#
# Per CLAUDE.md §2: tests use `node --test` (NOT vitest).
# Per agent/package.json: "type": "module" — tsx handles TS at runtime.
#
# Not yet wired into the root `pnpm test` command; that's a follow-on
# decision for when the user lands the executor.ts integration + decides
# the test gate posture. This script can be invoked directly via:
#   bash agent/scripts/test-plan-review.sh
#
# Exits non-zero on any failure (set -o pipefail prevents tail-mask per
# [[feedback_bash_pipe_masks_exit_use_pipefail]]).

set -euo pipefail
set -o pipefail

cd "$(dirname "$0")/.."

echo "── 1. tsc --noEmit (agent/) ─────────────────────────────────────"
pnpm exec tsc --noEmit

echo ""
echo "── 2. node --test (test/plan-*.test.ts) ─────────────────────────"
# --import=tsx loads TypeScript at runtime; --test runs node:test framework.
node --import=tsx --test test/plan-types.test.ts test/plan-synthesizer.test.ts test/plan-reviewer.test.ts

echo ""
echo "✓ All plan-review unit tests passed."
