# Mission Control — Agents & Live Feed

Mission Control now has three tabs:

| Tab | Path | Purpose |
|---|---|---|
| **Tasks** | `/mission-control` | Existing task list with the drawer for approve/requeue/cancel/reopen |
| **Agents** | `/mission-control/agents` | Roster of gateways + specialist profiles + chat panel for addressable gateways |
| **Live** | `/mission-control/feed` | Real-time activity feed (SSE) of task transitions and chat sends |

## What the Agents page shows

The Agents page introspects the running Hermes infrastructure on this machine:

- **Worker cron card** at the top — shows whether the HQ task-claimer is active, with running / review / queued counts and the timestamp of the last heartbeat / claim.
- **Gateways** (live `hermes gateway run` processes) — one card per process, with:
  - Model + provider
  - Live / stopped indicator
  - PID, uptime, Telegram handle
  - "Open chat" button (only if a Telegram bot token is configured for that profile)
- **Specialist profiles** (6 of them: `coder`, `scout`, `glm51`, `qwen35`, `reasoner`, `reviewer`) — read-only cards showing the model and stopped status. These are **not addressable**: clicking them does nothing. They're configurations Johnny5 spawns via the `specialist-routing` skill, not separate agents with their own chat.

The roster auto-refreshes every 15 seconds.

## Addressability

Only **gateways with a Telegram bot configured** can be messaged from Mission Control. The reason: Telegram is the only chat channel that gateways actually have. A "specialist profile" is just a model config — there's no separate Telegram bot, no separate process to talk to.

The chat panel first checks HQ env vars, then reuses the existing Hermes gateway env files without copying secrets:

- default gateway: `$HOME/.hermes/.env`
- minimax gateway: `$HOME/.hermes/profiles/minimax/.env`

So if Byron already configured `TELEGRAM_BOT_TOKEN` + `TELEGRAM_HOME_CHANNEL` for the gateways, Mission Control can send without duplicating secrets into `server/.env`. Explicit HQ vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, or per-profile overrides) still win if set. The default handles are hardcoded for `default` (`@john5wizbot`) and `minimax` (`@john5minimaxbot`); override via `TELEGRAM_BOT_HANDLE_DEFAULT` / `TELEGRAM_BOT_HANDLE_MINIMAX` if needed.


## Tasks page — July 2026 evidence-first controls

The Tasks tab now borrows the best ideas from the latest Hermes Agent releases:

- **Done contracts in the New Task form.** The form has an explicit acceptance-criteria textarea. Each non-empty line is sent as `acceptance_criteria[]`, so the worker has concrete evidence checks before it can ask Byron for approval.
- **Starter templates.** Verification contract, parallel research/audit, and reusable-learning templates prefill a self-contained prompt plus done criteria. They are deliberately editable; they are launch pads, not magic spells.
- **Operator-focus panel.** The top-right card counts filtered tasks that need a decision, tasks currently in flight, and review/blocked tasks missing an `evidence_path`. The goal is to make the next action obvious instead of making Byron read every row like a log archaeologist.
- **Search and source filters.** Client-side filtering over the currently loaded task list covers title, uid, source, result summary, and evidence path; the source dropdown is built from the loaded rows.
- **Quick approve.** A `review` row can be approved directly from the table when the checklist/evidence is already obvious. `blocked` still points Byron into the drawer, because a requeue/cancel note matters there.

These are UI-only improvements; no schema migration was required.

## API surface

```
GET    /api/agents                        # full roster (gateways + profiles + worker_cron)
GET    /api/agents/:id                    # single agent detail
GET    /api/agents/:id/messages           # recent chat history (Telegram getUpdates, last 20)
POST   /api/agents/:id/messages           # send a message to the agent's Telegram bot
GET    /api/activity/stream               # SSE feed of all task transitions + chat sends
GET    /api/activity/recent?limit=N       # non-streaming ring buffer (max 200 events)
```

### POST /api/agents/:id/messages

```json
// request
{ "text": "Hey Johnny5, can you summarize the latest dtbc evidence?" }

// response (200)
{
  "ok": true,
  "message_id": 12345,
  "chat_id": 987654321,
  "sent_at": "2026-06-18T20:15:30.000Z"
}

// response (502 — Telegram not configured)
{ "error": "TELEGRAM_BOT_TOKEN not configured" }
```

The response also fires an SSE event (`kind: "agent_message_sent"`) so the Live feed updates without polling.

### SSE event kinds

| Kind | When | Payload |
|---|---|---|
| `task_claimed` | worker picked up a queued task | `{ task: {id, uid, title, ...} }` |
| `task_finished` | worker marked a task `done` / `failed` / `review` / `blocked` | `{ task, status }` |
| `task_decided` | you approved / requeued / cancelled a task | `{ task, action }` |
| `task_reopened` | you reopened a terminal task | `{ task }` |
| `agent_message_sent` | you sent a message to an agent | `{ agent_id, message_id, text_preview }` |
| `task_snapshot` | SSE initial connect — running/review/queued tasks | `{ task }` |

## Inline approval buttons (Telegram)

When a worker transitions a task to `review`, HQ sends a Telegram ping to the
home channel **with three inline buttons**: ✅ Approve · 🔄 Requeue · ❌ Cancel.
Tapping a button calls the existing `/api/agent-tasks/callback` endpoint with
`action`, `id`, and `token` (the task's `uid`) — the same endpoint the gateway
already supports as a `POST` so JSON bodies aren't required over a button tap.

```
action=approve&id=42&token=T-AB12CD
```

The callback path enforces the same state guards as the UI decision endpoint:
the task has to be in `review` (or `blocked`), the token has to match the
row's uid, the action has to be `approve|requeue|cancel`. Mismatches return
`400` / `404` / `409`. Inline buttons are deliberately *sober* — they do not
include payload content (no prompt snippets, no checklist text) to keep the
Telegram message short and the callback URL under the 64-byte Telegram limit.

Failed or skipped deliveries do not block the worker's task-finish path; the
email notification already covers the case where Telegram is unavailable.

## Environment variables

```bash
# Optional. Token used for all gateways unless overridden per-profile.
# If unset, HQ falls back to the existing Hermes gateway env files.
# TELEGRAM_BOT_TOKEN=123456...

# Chat ID / home channel. If unset, HQ falls back to TELEGRAM_HOME_CHANNEL
# in the existing Hermes gateway env files.
# TELEGRAM_CHAT_ID=987654321

# Per-profile overrides. Useful if you want a different bot for each gateway.
# TELEGRAM_BOT_TOKEN_DEFAULT=...
# TELEGRAM_BOT_TOKEN_MINIMAX=...
# TELEGRAM_CHAT_ID_DEFAULT=...
# TELEGRAM_CHAT_ID_MINIMAX=...

# Display handles (cosmetic — what the UI shows).
# TELEGRAM_BOT_HANDLE_DEFAULT=@john5wizbot
# TELEGRAM_BOT_HANDLE_MINIMAX=@john5minimaxbot
```

If these are unset, the chat panel still renders but the **Send** button returns `502 TELEGRAM_BOT_TOKEN not configured`. The rest of Mission Control works without Telegram credentials.

## Local-only addresses

The Mission Control API (including `/api/agents/:id/messages`) is admin-only:
- bound to `HOST=0.0.0.0` but
- only callable from `127.0.0.1`, the LAN (`192.168.x.x`), or Tailscale (`100.x.x.x`)
- not exposed publicly

Telegram itself is a third-party service, so the chat feature transitively reaches `api.telegram.org` from bigbai. That's the same path your existing Codex / MiniMax gateways already use.

## Open followups

- **Bulk actions** on the task list (multi-select reopen / cancel) — not built. Add to MissionControl.jsx with checkbox + a "Bulk action" button when N items selected.
- **Reply streaming.** Right now the chat panel polls `getUpdates` every 3s and shows up to 20 messages. Better UX: subscribe to a webhook on the bot and push incoming messages to the open panel via the SSE feed.
- **Direct miniMax + j5minimaxbot typing indicators** in the panel — minor polish.
- **Filter chips** on the task list (source: telegram/hq_ui/email/voice/seed, agent: minimax/default, priority) — useful when the queue grows.
