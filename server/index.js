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
    console.log('[boot] loaded server/.env');
  }
} catch { /* ignore */ }

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5050);
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = Fastify({
  logger: {
    level: NODE_ENV === 'production' ? 'info' : 'debug',
    transport: NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
  },
  trustProxy: true,
});

// --- Plugins ---
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, {
  origin: process.env.APP_URL ? [process.env.APP_URL, 'http://localhost:5173'] : true,
  credentials: true,
});

// --- DB ---
const db = await runMigrations(resolve(rootDir, 'data/hq.db'));
app.decorate('db', db);

// --- SMTP health (don't block boot) ---
verifySmtp().then((ok) => {
  if (ok) app.log.info('SMTP verified');
  else app.log.warn('SMTP not configured (emails will queue as nudges)');
});

// --- Routes ---
await registerRoutes(app, { rootDir });

// --- Gmail inbox poller: queues new messages into pending_emails for admin review ---
if (inboxConfig.hasCreds) {
  startPoller({
    intervalMin: inboxConfig.pollIntervalMin,
    onNewMessage: async (msg) => {
      app.log.info({ from: msg.fromEmail, subject: msg.subject }, 'inbox: new message queued for review');
      try {
        const result = await scanPendingEmails(app.db, { limit: 1 });
        app.log.info({ inserted: result.inserted, skipped: result.skipped_existing }, 'inbox: queued');
      } catch (e) {
        app.log.warn({ err: e.message }, 'inbox: queue failed');
      }
    },
  });
  app.log.info({ intervalMin: inboxConfig.pollIntervalMin, mode: 'pending_queue' }, 'Gmail poller started');
}

// --- Graceful shutdown ---
const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  stopScheduler();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Listen ---
try {
  await app.listen({ host: HOST, port: PORT });
  startScheduler(app);
  app.log.info(`GeekShop HQ backend listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
