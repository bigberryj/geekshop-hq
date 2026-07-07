#!/usr/bin/env bash
# Regenerate the HQ internal CA and leaf cert.
#
# Run this once when you first set up TLS, and again whenever the
# Tailscale hostname or LAN IP changes. The CA cert is what Byron
# installs in his Windows trust store once - after that, any new leaf
# cert signed by this CA will be trusted automatically.
#
# Safe to re-run: overwrites existing files in tls/.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tls"

echo ">> Generating internal CA (10-year validity)"
openssl genrsa -out hq-ca.key 2048 2>/dev/null
openssl req -x509 -new -nodes -key hq-ca.key -sha256 -days 3650 \
  -out hq-ca.crt \
  -subj "/C=CA/ST=BC/O=GeekShop HQ/OU=Internal/CN=GeekShop HQ Internal CA"

echo ">> Generating leaf cert (27-month validity)"
openssl genrsa -out hq-server.key 2048 2>/dev/null
openssl req -new -key hq-server.key -out hq-server.csr -config hq.cnf 2>/dev/null
openssl x509 -req -in hq-server.csr \
  -CA hq-ca.crt -CAkey hq-ca.key -CAcreateserial \
  -out hq-server.crt -days 825 -sha256 \
  -extensions v3_req -extfile hq.cnf 2>/dev/null

echo ">> Verifying SAN list"
openssl x509 -in hq-server.crt -noout -text | grep -A 1 "Subject Alternative" | head -2

echo ""
echo "Done. Files in $(pwd):"
ls -la hq-ca.crt hq-server.crt hq-server.key hq-cn 2>/dev/null

echo ""
echo "Next step for Byron (Windows, one-time):"
echo "  scp bigbai:projects/geekshop-hq/tls/hq-ca.crt ~/Downloads/"
echo "  Double-click hq-ca.crt -> Install Certificate -> Local Machine"
echo "  -> Trusted Root Certification Authorities -> Finish"
echo "  Restart Chrome/Edge so they re-read the trust store."