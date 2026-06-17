#!/bin/bash
# claim-and-print.sh — convenience wrapper used by the worker cron.
# Returns 0 with stdout = "NO_TASK" when the queue is empty.
# Returns 0 with stdout = JSON when a task is claimed.
set -euo pipefail
cd /home/byron/projects/geekshop-hq/server
exec node scripts/agent-task-worker/agent-task-cli.js claim
