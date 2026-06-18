/**
 * GeekShop HQ — Server Entry Point
 *
 * Boot order:
 *   1. Load env
 *   2. Run DB migrations
 *   3. Register routes
 *   4. Start the scheduler (EOD summary, appointment reminders, follow-up nudges)
 *   5. Listen
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { runMigrations } from './db/migrate.js';
import { registerRoutes } from './routes/index.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { aiCall } from './lib/ai.js';
import { maskSensitive } from './lib/security.js';
import { verifySmtp } from './lib/email.js';
import { startPoller, inboxConfig } from './lib/email-inbox.js';
import { scanPendingEmails } from './lib/pending-emails.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Load .env FIRST (before any module reads process.env at import time)
try {
  const envPath = resolve(rootDir, 'server/.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch { /* ignore */ }

/**
 * Build a Fastify app with all routes, DB, plugins wired up.
 * Options:
 *   - dbPath: override the SQLite path (used by tests to use :memory: or tmp)
 *   - logger: false to silence logs (tests do this)
 *   - skipScheduler: don't start background jobs (tests)
 *   - skipPoller: don't start the Gmail poller (tests, no creds anyway)
 */
export async function buildServer(opts = {}) {
  const dbPath = opts.dbPath || resolve(rootDir, 'data/hq.db');
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.NODE_ENV === 'production' ? 'info' : 'warn' },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: process.env.APP_URL ? [process.env.APP_URL, 'http://localhost:5173'] : true,
    credentials: true,
  });

  const db = await runMigrations(dbPath);
  app.decorate('db', db);

  // Wire the agent-tasks lib to broadcast activity through the SSE
  // channel (or no-op if no listeners are attached). Also keep a small
  // ring buffer for /api/activity/recent.
  app.decorate('_sseSubscribers', new Map());
  app.decorate('_activityBuffer', []);
  app.decorate('broadcastActivity', (event) => {
    const tagged = { ...event, at: event.at || new Date().toISOString() };
    if (app._activityBuffer.length >= 200) app._activityBuffer.shift();
    app._activityBuffer.push(tagged);
    for (const [, res] of app._sseSubscribers) {
      try { res.write(`data: ${JSON.stringify(tagged)}\n\n`); } catch { /* connection closed */ }
    }
  });
  const { setActivitySink } = await import('./lib/agent-tasks.js');
  setActivitySink((event) => app.broadcastActivity(event));

  await registerRoutes(app, { rootDir });

  // Best-effort SMTP verify; never block boot
  if (!opts.skipSmtp) {
    verifySmtp().then((ok) => {
      if (ok) app.log.info('SMTP verified');
      else app.log.warn('SMTP not configured (emails will queue as nudges)');
    });
  }

  // Optional: Gmail poller. Off by default in tests (no creds or skipPoller).
  if (!opts.skipPoller && inboxConfig.hasCreds) {
    startPoller({
      intervalMin: inboxConfig.pollIntervalMin,
      onNewMessage: async (msg) => {
        app.log.info({ from: msg.fromEmail, subject: msg.subject }, 'inbox: new message');
        try {
          // Byron-iter 2026-06-16: try to auto-append the message to an
          // existing ticket thread before parking it in the pending
          // queue. This is the path that makes customer replies show
          // up in the ticket conversation without a manual re-import.
          const { matchReplyToTicket, markImportedRead } = await import('./lib/replies.js');
          const matched = await matchReplyToTicket(app.db, msg);
          if (matched && !matched.already_appended) {
            app.log.info({ ticket_id: matched.ticket_id, source: matched.source }, 'inbox: reply appended to existing ticket');
            const r = await markImportedRead(msg.messageId);
            app.log.info({ ok: r.ok }, 'inbox: marked reply read');
            return;
          }
          if (matched && matched.already_appended) {
            app.log.info({ ticket_id: matched.ticket_id }, 'inbox: reply already appended (idempotent)');
            return;
          }
        } catch (e) {
          app.log.warn({ err: e.message }, 'inbox: reply matcher error; falling back to queue');
        }
        try {
          const result = await scanPendingEmails(app.db, { limit: 1 });
          app.log.info({ inserted: result.inserted, skipped: result.skipped_existing }, 'inbox: queued for review');
        } catch (e) {
          app.log.warn({ err: e.message }, 'inbox: queue failed');
        }
      },
    });
    app.log.info({ intervalMin: inboxConfig.pollIntervalMin, mode: 'pending_queue' }, 'Gmail poller started');
  }

  return app;
}

// --- Main (run directly): build + listen + start scheduler ---
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5050);

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: HOST, port: PORT });
    startScheduler(app);
    app.log.info(`GeekShop HQ backend listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    stopScheduler();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run main() only when this file is the entrypoint. When imported (e.g. by
// tests), the export `buildServer` is used and main() is skipped.
const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main();
}
