/**
 * Agent roster and chat-to-agent routes for Mission Control.
 *
 * Surfaces:
 *   GET    /api/agents                       roster (gateways + profiles + cron health)
 *   GET    /api/agents/:id                   single agent detail
 *   GET    /api/agents/:id/messages          recent chat history (from Telegram, if
 *                                            the bot token is wired)
 *   POST   /api/agents/:id/messages          send a message to the agent's Telegram bot
 *   GET    /api/activity/stream              SSE feed of agent_tasks + gateway events
 *
 * Addressability is explicit: only gateways with a Telegram bot configured
 * can be sent messages. Specialist profiles (coder, scout, glm51, etc.) are
 * configurations used by Johnny5 on demand, not addressable entities.
 */
import { getRoster, sendAgentMessage, getTelegramConfig } from '../lib/agents.js';

export default async function agentRoutes(app) {
  /**
   * GET /api/agents
   * Returns the full roster: gateways (live), profiles (static), and
   * the HQ worker cron's recent activity.
   */
  app.get('/api/agents', async () => {
    const roster = await getRoster(app.db);
    return roster;
  });

  /**
   * GET /api/agents/:id
   * Detail for a single agent. :id is the profile name.
   */
  app.get('/api/agents/:id', async (req, reply) => {
    const id = String(req.params.id);
    const roster = await getRoster(app.db);
    const all = [...roster.gateways, ...roster.profiles];
    const found = all.find(a => a.id === id);
    if (!found) return reply.code(404).send({ error: `agent ${id} not found` });
    return found;
  });

  /**
   * GET /api/agents/:id/messages
   * Returns recent chat history with this agent. Source: Telegram updates
   * (only if the bot token is configured). For unsupported agents, returns
   * an empty array with a clear note.
   */
  app.get('/api/agents/:id/messages', async (req, reply) => {
    const id = String(req.params.id);
    const roster = await getRoster(app.db);
    const agent = [...roster.gateways, ...roster.profiles].find(a => a.id === id);
    if (!agent) return reply.code(404).send({ error: `agent ${id} not found` });
    if (!agent.addressable) {
      return { agent_id: id, messages: [], note: 'agent is not addressable — specialist profiles cannot be messaged directly' };
    }
    // Chat history is fetched from Telegram getUpdates on demand. Capped
    // at the last 20 messages and only those newer than `since` (ms epoch)
    // if provided.
    const since = Number(req.query.since) || 0;
    const { token } = await getTelegramConfig(id, process.env);
    if (!token) {
      return { agent_id: id, messages: [], note: 'TELEGRAM_BOT_TOKEN not configured for this agent (checked HQ env + Hermes env files)' };
    }
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?limit=20&allowed_updates=${encodeURIComponent('["message"]')}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) {
        return { agent_id: id, messages: [], note: `telegram error: ${data.description || 'unknown'}` };
      }
      const messages = (data.result || [])
        .filter(u => u.message && u.message.date * 1000 >= since)
        .map(u => ({
          message_id: u.message.message_id,
          from: u.message.from?.username || u.message.from?.first_name || 'unknown',
          text: u.message.text || '',
          date: new Date(u.message.date * 1000).toISOString(),
          direction: 'inbound',
        }));
      return { agent_id: id, messages, note: 'history from Telegram getUpdates (last 20)' };
    } catch (e) {
      return { agent_id: id, messages: [], note: `fetch failed: ${e.message}` };
    }
  });

  /**
   * POST /api/agents/:id/messages
   * Send a message to the agent's Telegram bot. Body: { text: string }.
   * Returns { ok, message_id, chat_id, sent_at } on success.
   */
  app.post('/api/agents/:id/messages', async (req, reply) => {
    const id = String(req.params.id);
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 4096) return reply.code(400).send({ error: 'text too long (>4096 chars)' });

    const result = await sendAgentMessage(id, text, process.env);
    if (!result.ok) {
      return reply.code(502).send({ error: result.error });
    }
    // Broadcast to SSE subscribers so the Live feed updates.
    if (app.broadcastActivity) {
      app.broadcastActivity({
        kind: 'agent_message_sent',
        agent_id: id,
        message_id: result.message_id,
        text_preview: text.slice(0, 80),
        at: result.sent_at,
      });
    }
    return result;
  });

  /**
   * GET /api/activity/stream
   * Server-Sent Events feed of activity across the HQ. Subscribers
   * receive:
   *   - agent_tasks transitions (queued -> running -> review -> done)
   *   - heartbeats (rate-limited to one per task per 30s)
   *   - agent message sent events (from POST /api/agents/:id/messages)
   *   - gateway health changes (probe every 30s)
   *
   * Clients connect via `new EventSource('/api/activity/stream')` and
   * receive `data: {json}\n\n` payloads. Heartbeat comments (`:ok\n\n`)
   * are sent every 15s to keep the connection alive through proxies.
   */
  app.get('/api/activity/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.writeHead(200);
    reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

    // Send current snapshot of running tasks so the client has context.
    try {
      const running = app.db.prepare(`
        SELECT id, uid, title, source, status, progress_pct, progress_message,
               last_heartbeat_at, started_at
          FROM agent_tasks
         WHERE status IN ('running', 'review', 'queued')
         ORDER BY id DESC
         LIMIT 20
      `).all();
      for (const t of running) {
        reply.raw.write(`data: ${JSON.stringify({ kind: 'task_snapshot', task: t })}\n\n`);
      }
    } catch { /* db not ready */ }

    const subscriberId = Symbol('sse');
    if (!app._sseSubscribers) app._sseSubscribers = new Map();
    app._sseSubscribers.set(subscriberId, reply.raw);

    const interval = setInterval(() => {
      try { reply.raw.write(`: keepalive ${Date.now()}\n\n`); } catch { /* connection closed */ }
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(interval);
      app._sseSubscribers?.delete(subscriberId);
    });
  });

  /**
   * GET /api/activity/recent
   * Cheap, non-streaming alternative to SSE. Returns the last N events
   * from a small in-memory ring buffer (max 200). Useful for clients
   * that want to bootstrap without an EventSource connection.
   */
  app.get('/api/activity/recent', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    if (!app._activityBuffer) return { events: [] };
    return { events: app._activityBuffer.slice(-limit) };
  });
}
