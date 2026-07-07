# TLS for GeekShop HQ (webcam-friendly HTTPS)

## Why this exists

The HQ frontend is served over plain HTTP on port `5173`. When Byron
opens `http://100.96.13.84:5173` (Tailscale) from his Windows laptop,
the browser sees a **non-secure context** (`window.isSecureContext === false`)
and refuses to grant `navigator.mediaDevices.getUserMedia()` — which is
why webcam receipt capture does not work even though the code is in
place and the test suite is green.

Browser rules:
- ✅ `http://localhost`, `http://127.0.0.1`, `http://[::1]` — secure
- ❌ `http://100.96.13.84` (Tailscale IP, not loopback) — non-secure
- ✅ `https://<anything>` — secure

Tailscale offers `tailscale serve` and `tailscale cert` to provision
HTTPS automatically, **but those features are not enabled on this
tailnet** (admin-gated). The workarounds:

| Option | Effort | Trust model |
|---|---|---|
| Enable Tailscale HTTPS in the admin console | One click + `tailscale serve --bg 5173` | Public Tailscale cert, trusted everywhere |
| **This folder** (Caddy + internal CA) | One-time Windows trust install | Self-signed, trusted only on machines that installed the CA |

This folder implements option 2 — it works without touching the
Tailscale admin console, but requires Byron to install the CA cert
once on every machine that wants to access HQ over HTTPS.

## What's in here

```
tls/
├── Caddyfile            # Caddy v2 config: HTTPS on :8443, HTTP on :8080, reverse proxy to :5173/:5050
├── hq.cnf               # openssl config for leaf cert generation, including SAN list
├── hq-ca.crt            # Internal CA certificate (INSTALL THIS on Byron's Windows machine)
├── hq-ca.key            # Internal CA private key (DO NOT distribute)
├── hq-server.crt        # Leaf cert signed by the internal CA (served by Caddy)
├── hq-server.key        # Leaf private key
├── hq-server.csr        # CSR (kept for re-signing if you ever need to rotate)
├── generate-certs.sh    # Regenerate everything (CA + leaf)
└── README.md            # This file
```

The CA cert (`hq-ca.crt`) is what you install in the Windows trust
store. After that, any leaf cert signed by this CA — including the
current `hq-server.crt` and any future regenerated one — is trusted.

## First-time setup on Byron's Windows laptop

1. Pull the CA cert to your laptop:
   ```powershell
   scp bigbai:projects/geekshop-hq/tls/hq-ca.crt $env:USERPROFILE\Downloads\
   ```

2. Install it as a trusted root CA:
   - Double-click `hq-ca.crt`
   - Click **Install Certificate…**
   - Choose **Local Machine** (you'll be prompted for admin)
   - Choose **Place all certificates in the following store**
   - Click **Browse…**, select **Trusted Root Certification Authorities**
   - Click **Next**, then **Finish**
   - You should see "The import was successful."

3. Restart Chrome / Edge so they re-read the trust store
   (Firefox reads its own trust store — see below).

4. Open `https://bigbai.tail136908.ts.net:8443/` — no warning.

5. Test webcam capture: open any expense → Add expense → click
   **Use webcam**. The browser will prompt for camera permission
   once. Approve, snap a frame, **Use this photo**, save.

### Firefox note

Firefox uses its own certificate store, separate from Windows.
To trust the CA in Firefox:
1. Open **Settings → Privacy & Security → Certificates → View Certificates…**
2. **Authorities** tab → **Import…**
3. Select `hq-ca.crt` → check **Trust this CA to identify websites**
4. OK, restart Firefox.

## Running HQ with TLS

```bash
cd /home/byron/projects/geekshop-hq
bash start-with-tls.sh
```

This starts:
- Backend on `:5050` (Fastify)
- Frontend on `:5173` (Vite dev)
- Caddy on `:8443` (HTTPS) and `:8080` (HTTP fallback)

URLs:
- `https://bigbai.tail136908.ts.net:8443` — Tailscale hostname, HTTPS
- `https://100.96.13.84:8443` — Tailscale IP, HTTPS
- `https://192.168.1.168:8443` — LAN IP, HTTPS
- `https://localhost:8443` — local, HTTPS
- `http://localhost:5173` — local, HTTP (dev only)
- `http://localhost:8080` — anything Caddy proxies, no TLS

Webcam capture works on every `https://` URL above.

## Regenerating certs

If the Tailscale hostname changes (rare) or the cert is about to expire
(2+ years out, signed by a 10-year CA so this won't bite for a while):

```bash
bash tls/generate-certs.sh
```

The CA stays valid for 10 years; the leaf is good for ~27 months.
If you ever need to rotate the CA (e.g. it leaked), regenerate both
and have Byron re-run the Windows trust install with the new
`hq-ca.crt`.

## Security notes

- `hq-ca.key` is the root of trust for this scheme. Treat it like a
  password: it's in `tls/` (gitignored, see below). Anyone with the
  CA key can mint certs that browsers on every machine that trusts
  this CA will accept. **Don't commit it.**
- The CA is only useful to machines that explicitly trust it. If
  Byron's laptop is stolen and the attacker also has the CA key, they
  can't impersonate HQ to a browser that doesn't trust this CA.
- Caddy is bound to `127.0.0.1:5173` / `127.0.0.1:5050` upstream, so
  it can only proxy to local services. The HTTPS listener is on
  `:8443` (all interfaces), reachable from Tailscale and LAN.
- For production beyond Tailscale, prefer the official Tailscale
  HTTPS path (`tailscale serve --bg 5173` after enabling in the admin
  console). That gives you a public-TA-issued cert with no
  per-machine install.

## Gitignore

`tls/hq-ca.key` and `tls/hq-server.key` are private. `hq-ca.crt`,
`hq-server.crt`, and the Caddyfile are safe to commit (they're not
secret — the CA is only useful to machines that explicitly trust it).
`tls/*.csr` and `tls/*.srl` can be regenerated, included for clarity.