#!/bin/bash
# preflight.sh — runs at the start of every worker tick.
#
# 1. Sweep stuck tasks (bounce stale heartbeats back to queued / failed).
# 2. Check the rate-limit cooldown stamp. If we're still cooling down,
#    exit 0 with stdout "RATE_LIMITED" so the worker prompt knows to
#    say [SILENT] and stop.
# 3. Otherwise exit 0 with stdout "OK" so the worker can proceed.
#
# This is a no-op as far as the worker is concerned — it just gives the
# prompt a clean decision point.

set -euo pipefail
COOLDOWN_FILE="/home/byron/.hermes/state/agent-task-worker/rate_limited_until"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HQ_SCRIPT="/home/byron/projects/geekshop-hq/server/scripts/agent-task-worker/agent-task-cli.js"

# 1. Stuck-requeue sweep. Errors here shouldn't block the worker; if the
# DB is wedged, the next command will fail loudly anyway.
node "$HQ_SCRIPT" stuck-requeue --ms=600000 >/dev/null 2>&1 || true

# 2. Cooldown check.
if [ -f "$COOLDOWN_FILE" ]; then
  UNTIL=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  NOW=$(date -u +%s)
  if [ -n "$UNTIL" ] && [ "$NOW" -lt "$UNTIL" ] 2>/dev/null; then
    echo "RATE_LIMITED"
    exit 0
  fi
  # Stale stamp; clean it up.
  rm -f "$COOLDOWN_FILE"
fi

echo "OK"
