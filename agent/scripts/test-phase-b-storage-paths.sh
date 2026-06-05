#!/usr/bin/env bash
# Phase B / S50 — CI guard against resurrection of legacy flat-layout
# storage paths. Per v3 plan §2.5.3 (test W2 in §6.4).
#
# After the Phase B-1 helper + 4 call-site refactor, every storage operation
# on the research-projects bucket constructs its path via scopedStoragePath()
# from lib/storage-paths. The legacy antipattern looked like:
#
#     sb.storage.from(BUCKET).upload(`${slug}/${remoteName}`, …)
#
# That hard-codes the flat layout and writes outside the tenant's org-prefixed
# directory — a quiet cross-tenant leak risk. This guard catches the literal
# template-literal antipattern on any line in agent/ or frontend/.
#
# Limitations:
#   - Single-line grep only. Multi-line `.upload(` calls where the template
#     literal lives on a different physical line will not be caught. The
#     MERGE-gate review covers that case manually for now; a follow-up could
#     promote this to a multiline ripgrep/PCRE2 check.
#   - Variables whose name does NOT end in `slug`/`Slug` are not matched. The
#     refactor pre-S50 only ever used those names — if a future caller picks
#     a different variable name, the guard misses it. Documented trade-off:
#     a name-based heuristic keeps the regex stable across edits.
#
# Exit codes: 0 PASS, 1 FAIL (antipattern found).

set -euo pipefail

# Script lives at agent/scripts/<this>.sh; project root is two parents up.
cd "$(dirname "$0")/../.."

ANTIPATTERN='`\$\{[a-zA-Z_][a-zA-Z0-9_]*([Ss]lug|Slug)\}/'

BAD=$(grep -rEn "$ANTIPATTERN" \
  agent frontend \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v "scopedStoragePath(" \
  | grep -v "test-phase-b-storage-paths" \
  | grep -v "node_modules/" \
  | grep -v "agent/sandbox/" \
  || true)

if [ -n "$BAD" ]; then
  echo "FAIL: flat-layout storage path antipattern detected:"
  echo "$BAD"
  echo
  echo "Construct paths via scopedStoragePath() from lib/storage-paths."
  echo "(Multi-line antipatterns where the .upload(/.list(/.download(/"
  echo " .createSignedUrl( call spans physical lines may not be caught —"
  echo " review storage call sites manually too.)"
  exit 1
fi

echo "PASS: no flat-layout storage path antipatterns detected."
exit 0
