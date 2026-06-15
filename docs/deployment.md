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

URLs:

- Dashboard: `http://100.96.13.84:5173`
- API health: `http://100.96.13.84:5050/api/health`
- Public booking: `http://100.96.13.84:5173/book/general`

## Secrets

Local secrets live in git-ignored files:

- `server/.env`
- `~/.hermes/.env`

MiniMax is configured via `MINIMAX_API_KEY` and `MINIMAX_MODEL=MiniMax-M3`.
