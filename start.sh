#!/usr/bin/env bash
# Start both backend and frontend dev servers.
# Backend on :5050, frontend on :5173. Tailscale-accessible.
#
# Run: bash start.sh
# Stops on Ctrl-C.

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

trap 'echo ""; echo "Stopping…"; kill $(jobs -p) 2>/dev/null || true; exit 0' INT TERM

echo "=== Starting GeekShop HQ ==="
echo "Backend:  http://localhost:5050  (Tailscale: http://100.96.13.84:5050)"
echo "Frontend: http://localhost:5173  (Tailscale: http://100.96.13.84:5173)"
echo ""

# Run migrations if needed and seed if DB doesn't exist
if [ ! -f data/hq.db ]; then
  echo ">> First run: seeding sample data…"
  (cd server && node db/seed.js)
fi

# Start backend
(cd server && NODE_ENV=development node index.js) &
BPID=$!
echo ">> Backend PID $BPID"

# Give backend a moment to boot
sleep 2

# Start frontend
(cd client && npm run dev) &
FPID=$!
echo ">> Frontend PID $FPID"

echo ""
echo "Ready. Open http://localhost:5173 in a browser."
echo "Or, from another device on Tailscale: http://100.96.13.84:5173"
echo "Public booking page: http://100.96.13.84:5173/book/general"
echo ""
wait
