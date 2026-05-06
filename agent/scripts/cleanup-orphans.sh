#!/usr/bin/env bash
# Kill any process tree associated with /research-compare pipeline runs.
#
# Narrow scope: only matches command lines containing "claude-prompt.md" or
# "test-topic-for-live" or "research-compare" working dir paths. The user's
# own Claude Code session, regular Chrome, and unrelated tools are NOT
# matched (their command lines don't contain these strings).
#
# Usage: bash scripts/cleanup-orphans.sh
set -euo pipefail

echo "Scanning for orphaned research-compare processes..."

# Find PIDs whose command line matches our pipeline markers.
# Exclude bash.exe (this script's own ancestors) + powershell.exe (the probe).
mapfile -t PIDS < <(
  powershell -NoProfile -Command "
    Get-CimInstance Win32_Process |
      Where-Object {
        \$_.CommandLine -match 'claude-prompt\.md|research-compare\\\\[a-z0-9-]+\\\\(claude-prompt|job-manifest)' -and
        \$_.Name -notmatch '^(bash|powershell|conhost|node)\.exe$'
      } |
      Select-Object -ExpandProperty ProcessId
  " 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' || true
)

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "No orphan processes found."
  exit 0
fi

echo "Found ${#PIDS[@]} orphan PID(s): ${PIDS[*]}"
for pid in "${PIDS[@]}"; do
  echo "Killing tree at PID $pid..."
  taskkill //F //T //PID "$pid" 2>&1 | head -20 || true
done

echo "Cleanup complete."
