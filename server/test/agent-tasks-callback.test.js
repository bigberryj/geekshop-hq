/**
 * Phase 7 — inline Telegram button callback contract.
 *
 * The /api/agent-tasks/callback endpoint is hit when Byron taps
 * Approve / Requeue / Cancel on a Telegram message that was dispatched
 * by notifyTaskForApproval(). It accepts a query-param/body shape (so
 * it works through Telegram's inline-button POST payload) and:
 *   - rejects unknown actions
 *   - rejects non-integer ids
 *   - 404s on missing tasks
 *   - 400s on a token mismatch (the uid is the token; mismatched button → bad)
 *   - 409s if the task is not in a decidable state
 *   - returns the updated row on success
 *
 * We exercise all of these using a private Fastify app, mirroring how
 * the agentTaskRoutes route table is mounted in server/index.js. The
 * DB column shape mirrors the schema doc.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { agentTaskRoutes } from '../routes/agent-tasks.js';
import {
  claimNextTask,
  createTask,
  finishTask,
} from '../lib/agent-tasks.js';

let db;
let app;

async function startApp() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'hq_ui',
      source_ref TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      acceptance_criteria TEXT,
      review_checklist TEXT,
      result_summary TEXT,
      evidence_path TEXT,
      last_error TEXT,
      worker_run_id TEXT,
      last_heartbeat_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      progress_pct INTEGER NOT NULL DEFAULT 0,
      progress_message TEXT,
      decision TEXT,
      decision_note TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  app = Fastify();
  app.decorate('db', db);
  await app.register(agentTaskRoutes);
  await app.ready();
}

async function stopApp() {
  if (app) await app.close();
  if (db) db.close();
}

describe('POST /api/agent-tasks/callback (Phase 7 inline buttons)', () => {
  beforeAll(startApp);
  afterAll(stopApp);

  // claimNextTask always claims the oldest queued row, so each test must
  // run against an empty (or only-its-own-row) queue to avoid stealing
  // another test's task.
  beforeEach(() => {
    db.exec(`DELETE FROM agent_tasks`);
  });

  it('rejects unknown actions with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-tasks/callback?action=lol&id=1&token=T-X',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/action must be/);
  });

  it('rejects non-integer ids with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-tasks/callback?action=approve&id=abc&token=T-X',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/invalid id/);
  });

  it('returns 404 when the task row is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-tasks/callback?action=approve&id=99999&token=T-X',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects token mismatches with 400', async () => {
    const t = createTask(db, {
      title: 'token check',
      prompt: 'p',
      source: 'hq_ui',
    });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'ok' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent-tasks/callback?action=approve&id=${t.id}&token=WRONG`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('token mismatch');
  });

  it('returns 409 when the task is not in a decidable state', async () => {
    const t = createTask(db, {
      title: 'pre-worker',
      prompt: 'p',
      source: 'hq_ui',
    });
    // t is queued; callback must reject
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent-tasks/callback?action=approve&id=${t.id}&token=${t.uid}`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('approve → done on a task in review', async () => {
    const t = createTask(db, {
      title: 'approve path',
      prompt: 'p',
      source: 'hq_ui',
    });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'looks good' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent-tasks/callback?action=approve&id=${t.id}&token=${t.uid}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('done');
    expect(body.decision).toBe('approve');
    expect(body.decision_note).toBe('(from Telegram callback)');
  });

  it('requeue → queued from review', async () => {
    const t = createTask(db, {
      title: 'requeue path',
      prompt: 'p',
      source: 'hq_ui',
    });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'needs more' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent-tasks/callback?action=requeue&id=${t.id}&token=${t.uid}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('queued');
    expect(body.decision).toBe('requeue');
  });

  it('cancel → cancelled from review', async () => {
    const t = createTask(db, {
      title: 'cancel path',
      prompt: 'p',
      source: 'hq_ui',
    });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'nevermind' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent-tasks/callback?action=cancel&id=${t.id}&token=${t.uid}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('cancelled');
    expect(body.decision).toBe('cancel');
  });

  it('accepts the action/id/token in the JSON body as a fallback', async () => {
    const t = createTask(db, {
      title: 'body fallback',
      prompt: 'p',
      source: 'hq_ui',
    });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'ok' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-tasks/callback',
      payload: { action: 'approve', id: t.id, token: t.uid },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('done');
  });
});
