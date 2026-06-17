/**
 * Mission Control API — the "real-time back-end view" Byron asked for.
 *
 * Endpoints:
 *   GET    /api/agent-tasks                       list (paged + filtered)
 *   POST   /api/agent-tasks                       enqueue a new task
 *   GET    /api/agent-tasks/summary               cheap counts for the dashboard widget
 *   GET    /api/agent-tasks/:id                   full task (incl. prompt + review)
 *   POST   /api/agent-tasks/:id/decision          approve / requeue / cancel
 *   POST   /api/agent-tasks/:id/requeue           explicit requeue with note
 *
 * Auth: same model as the rest of the HQ API. Until the auth middleware
 * is wired, this surface is treated as admin-only (loopback / LAN /
 * Tailscale) by the existing `server/index.js` CORS + UFW posture.
 *
 * Security:
 *   - `prompt` length capped at 32 KiB to keep one user from blowing up
 *     the worker with a 1MB blob.
 *   - `title` capped at 240 chars (UI table column).
 *   - Status transitions go through `decideTask`, never raw SQL.
 *   - `result_summary` and `evidence_path` are returned as-is; the
 *     review-checklist JSON is parsed but not echoed when the task is
 *     in a terminal state where the human no longer needs to see it.
 */

import {
  createTask,
  getTask,
  getTaskForReview,
  listTasks,
  decideTask,
  summarizeTasks,
} from '../lib/agent-tasks.js';

const PROMPT_MAX = 32 * 1024;
const TITLE_MAX = 240;
const ALLOWED_SOURCES = new Set(['hq_ui', 'telegram', 'email', 'voice', 'seed']);

function badRequest(reply, message) {
  return reply.code(400).send({ error: message });
}

export async function agentTaskRoutes(app) {
  /** GET /api/agent-tasks */
  app.get('/api/agent-tasks', async (req, reply) => {
    const status = (req.query.status || 'all').toString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return listTasks(app.db, { status, limit, offset });
  });

  /** GET /api/agent-tasks/summary */
  app.get('/api/agent-tasks/summary', async () => {
    return summarizeTasks(app.db);
  });

  /** POST /api/agent-tasks */
  app.post('/api/agent-tasks', async (req, reply) => {
    const body = req.body || {};
    const title = (body.title || '').toString().trim();
    const prompt = (body.prompt || '').toString().trim();
    if (!title) return badRequest(reply, 'title is required');
    if (!prompt) return badRequest(reply, 'prompt is required');
    if (title.length > TITLE_MAX) return badRequest(reply, `title exceeds ${TITLE_MAX} chars`);
    if (prompt.length > PROMPT_MAX) return badRequest(reply, `prompt exceeds ${PROMPT_MAX} bytes`);

    const source = (body.source || 'hq_ui').toString();
    if (!ALLOWED_SOURCES.has(source)) {
      return badRequest(reply, `source must be one of: ${[...ALLOWED_SOURCES].join(', ')}`);
    }
    const priority = Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0;
    const max_attempts = Number.isFinite(Number(body.max_attempts)) ? Number(body.max_attempts) : 3;

    let criteria = body.acceptance_criteria;
    if (criteria != null) {
      if (!Array.isArray(criteria)) return badRequest(reply, 'acceptance_criteria must be an array');
      criteria = criteria.map((c) => ({
        req: String(c.req || '').trim(),
        kind: c.kind ? String(c.kind) : undefined,
      })).filter((c) => c.req);
      if (criteria.length === 0) criteria = null;
    }

    const task = createTask(app.db, {
      title,
      prompt,
      source,
      source_ref: body.source_ref || null,
      priority,
      max_attempts,
      acceptance_criteria: criteria,
    });
    return reply.code(201).send(getTaskForReview(app.db, task.id));
  });

  /** GET /api/agent-tasks/:id */
  app.get('/api/agent-tasks/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(reply, 'invalid id');
    const t = getTaskForReview(app.db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return t;
  });

  /** POST /api/agent-tasks/:id/decision */
  app.post('/api/agent-tasks/:id/decision', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(reply, 'invalid id');
    const { action, note } = req.body || {};
    if (!['approve', 'requeue', 'cancel'].includes(action)) {
      return badRequest(reply, 'action must be approve, requeue, or cancel');
    }
    const updated = decideTask(app.db, id, { action, note });
    if (!updated) {
      return reply.code(409).send({
        error: 'task is not in a decidable state (review or blocked)',
      });
    }
    return getTaskForReview(app.db, id);
  });

  /** POST /api/agent-tasks/:id/requeue — alias for requeue decision */
  app.post('/api/agent-tasks/:id/requeue', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(reply, 'invalid id');
    const { note } = req.body || {};
    const updated = decideTask(app.db, id, { action: 'requeue', note });
    if (!updated) {
      return reply.code(409).send({ error: 'task is not in a decidable state' });
    }
    return getTaskForReview(app.db, id);
  });

  /**
   * POST /api/agent-tasks/callback
   *
   * Lightweight endpoint designed for Telegram inline-button callbacks
   * (and any other push-style clients). The gateway can't easily pass
   * JSON bodies through an inline-button callback, so the request is
   * shaped as query params + a short token in the path.
   *
   *   POST /api/agent-tasks/callback?action=approve&id=<n>&token=<t>
   *
   * The token is just the task's uid; it's not a secret (the task uid
   * is already exposed in the row) but it gives us a sanity check that
   * the callback is for the row the button was attached to. Returns
   * the updated task on success, 4xx on transition conflict.
   *
   * The endpoint exists so a future gateway patch can wire Approve /
   * Send-back / Cancel inline buttons to it without needing a new
   * server change.
   */
  app.post('/api/agent-tasks/callback', async (req, reply) => {
    const { action, id, token } = { ...req.query, ...(req.body || {}) };
    if (!['approve', 'requeue', 'cancel'].includes(action)) {
      return badRequest(reply, 'action must be approve, requeue, or cancel');
    }
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return badRequest(reply, 'invalid id');
    const task = getTask(app.db, numId);
    if (!task) return reply.code(404).send({ error: 'not found' });
    if (token && task.uid !== token) return reply.code(400).send({ error: 'token mismatch' });
    const updated = decideTask(app.db, numId, { action, note: '(from Telegram callback)' });
    if (!updated) return reply.code(409).send({ error: 'task is not in a decidable state' });
    return getTaskForReview(app.db, numId);
  });
}
