# Deployment / Local Ops

## Local dev

```bash
bash start.sh
```

- Backend: `0.0.0.0:5050`
- Frontend: `0.0.0.0:5173`
- Tailscale address on `bigbai`: `100.96.13.84`

## Tailscale / UFW

Verified 2026-06-15:

- `5173/tcp on tailscale0` allowed — GeekShop HQ Vite frontend
- `5050/tcp on tailscale0` allowed — GeekShop HQ API backend
- LAN rules for `192.168.1.0/24` also exist for both ports
- `8443/tcp on tailscale0` allowed — GeekShop HQ HTTPS frontend (webcam)

URLs:

- Dashboard (HTTP): `http://100.96.13.84:5173`
- Dashboard (HTTPS): `https://bigbai.tail136908.ts.net:8443` — **required for webcam capture**
- API health: `http://100.96.13.84:5050/api/health`
- Public booking: `http://100.96.13.84:5173/book/general`

## HTTPS for webcam capture (Phase 4)

**Why this exists:** modern browsers only grant `navigator.mediaDevices.getUserMedia()`
(used by the receipt-capture webcam path on Accounting → Expenses) from a *secure context*
(HTTPS, or loopback hostnames). The plain `http://100.96.13.84:5173` Tailscale URL is a
non-secure context — the page loads, but `Use webcam` is greyed out and the amber banner
explains the issue. Tailscale's `tailscale serve` HTTPS provisioning is not enabled on
this tailnet (admin-gated), so we run Caddy locally as an HTTPS terminator on `:8443`.

**Run with TLS:**

```bash
bash start-with-tls.sh
```

This starts backend (`:5050`), Vite (`:5173`), and Caddy (`:8443` HTTPS, `:8181` HTTP
fallback). Caddy terminates TLS using a self-signed CA + leaf cert from `tls/` and
reverse-proxies `/api/*` to the backend and everything else to Vite.

**One-time setup on Byron's Windows laptop** (so the browser trusts the CA):

```powershell
scp bigbai:projects/geekshop-hq/tls/hq-ca.crt $env:USERPROFILE\Downloads\
# Double-click hq-ca.crt -> Install Certificate -> Local Machine
#   -> Trusted Root Certification Authorities -> Finish
# Restart Chrome / Edge so they re-read the trust store.
# Firefox: Settings -> Privacy & Security -> Certificates -> View Certificates
#   -> Authorities -> Import -> hq-ca.crt -> Trust this CA to identify websites.
```

After that, `https://bigbai.tail136908.ts.net:8443/` opens without a warning. The
*Use webcam* button on Accounting → Expenses is now enabled and the permission prompt
appears. (Headless Chromium has no camera, so this only works in Byron's real
browser.)

See `tls/README.md` for the full trust model, regenerating certs, and Firefox notes.

## Secrets

Local secrets live in git-ignored files:

- `server/.env`
- `~/.hermes/.env`

MiniMax is configured via `MINIMAX_API_KEY` and `MINIMAX_MODEL=MiniMax-M3`.

TLS private keys live in `tls/hq-*.key` (git-ignored). The CA cert and leaf cert
are committed so anyone who clones can reproduce the trust model after running
`tls/generate-certs.sh`.