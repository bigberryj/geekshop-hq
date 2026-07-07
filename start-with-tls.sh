#!/usr/bin/env bash
# Start GeekShop HQ backend + frontend + HTTPS reverse proxy.
#
# This is `start.sh` + an HTTPS terminator on :8443 using Caddy and a
# locally-generated self-signed CA (see tls/Caddyfile + tls/README.md).
# Why: Tailscale's HTTPS / `tailscale serve` features are not enabled
# on this tailnet, so the existing Tailscale URL (http://100.96.13.84:5173)
# is a non-secure context. Browsers refuse `getUserMedia` (and other
# modern web APIs) from non-secure contexts, which is why webcam
# receipt capture does not work from Byron's laptop even though the
# code is in place. Terminating TLS locally with a self-signed CA that
# Byron trusts once on his Windows machine gives the browser the
# `isSecureContext` flag it needs without requiring admin action on
# the Tailscale dashboard.
#
# Run: bash start-with-tls.sh
# Stops on Ctrl-C.
#
# First-time setup on Byron's Windows machine (one-time, ~30s):
#   1. Pull this file down to your laptop:
#         scp bigbai:projects/geekshop-hq/tls/hq-ca.crt ~/Downloads/
#   2. Double-click it, "Install Certificate", "Local Machine",
#      "Place all certificates in the following store",
#      "Trusted Root Certification Authorities", Finish.
#   3. Restart Chrome/Edge so they re-read the trust store.
#   4. Open https://bigbai.tail136908.ts.net:8443/ - no warning now.

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Sanity check: did we forget to generate the certs?
if [ ! -f tls/hq-server.crt ] || [ ! -f tls/hq-server.key ]; then
  echo "!! TLS certs missing. Run: bash tls/generate-certs.sh"
  exit 1
fi

# Stop on Ctrl-C
trap 'echo ""; echo "Stopping…"; kill $(jobs -p) 2>/dev/null || true; exit 0' INT TERM

echo "=== Starting GeekShop HQ (HTTP + HTTPS) ==="
echo "Backend:  http://localhost:5050   (Tailscale: http://100.96.13.84:5050)"
echo "Frontend: http://localhost:5173   (Tailscale: http://100.96.13.84:5173)"
echo "HTTPS:    https://localhost:8443  (Tailscale: https://100.96.13.84:8443)"
echo "          https://bigbai.tail136908.ts.net:8443"
echo "          https://bigbai.lan:8443"
echo "HTTP:     http://localhost:8181   (no TLS, webcam will NOT work here)"
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

# Give frontend a moment to boot
sleep 3

# Start Caddy (HTTPS terminator on :8443 + plain HTTP :8181)
caddy run --config "$ROOT/tls/Caddyfile" --adapter caddyfile 2>&1 | sed 's/^/[caddy] /' &
CPID=$!
echo ">> Caddy PID $CPID"

echo ""
echo "Ready."
echo "  Local (HTTP):     http://localhost:5173"
echo "  Tailscale (HTTP): http://100.96.13.84:5173"
echo "  Local (HTTPS):    https://localhost:8443"
echo "  Tailscale (HTTPS):https://bigbai.tail136908.ts.net:8443"
echo "  Public booking:   https://bigbai.tail136908.ts.net:8443/book/general"
echo ""
echo "Webcam capture works ONLY on the HTTPS URLs."
echo "See tls/README.md for first-time CA install instructions."
echo ""
wait