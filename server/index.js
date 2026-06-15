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
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { runMigrations } from './db/migrate.js';
import { registerRoutes } from './routes/index.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { aiCall } from './lib/ai.js';
import { maskSensitive } from './lib/security.js';
import { verifySmtp } from './lib/email.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

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
