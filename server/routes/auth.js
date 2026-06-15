/**
 * Auth — single admin, dev mode skips, prod uses password + session cookie.
 */

import { newSessionId, isProduction } from '../lib/security.js';

export async function authRoutes(app) {
  // Login
  app.post('/api/auth/login', async (req, reply) => {
    if (!isProduction()) {
      return reply.send({ ok: true, dev_skip: true, message: 'auth skipped in dev' });
    }
    const { password } = req.body || {};
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return reply.code(500).send({ error: 'ADMIN_PASSWORD not set' });
    if (password !== expected) return reply.code(401).send({ error: 'bad password' });
    const sid = newSessionId();
    app.db.prepare(`
      INSERT INTO sessions (id, admin_id, expires_at) VALUES (?, 1, datetime('now', '+30 days'))
    `).run(sid);
    reply.setCookie('hq_sid', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 });
    return { ok: true };
  });

  // Logout
  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies.hq_sid;
    if (sid) app.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    reply.clearCookie('hq_sid', { path: '/' });
    return { ok: true };
  });

  // Who am I
  app.get('/api/auth/me', async (req) => {
    if (!isProduction()) return { id: 1, name: 'Byron (dev)', dev_skip: true };
    const sid = req.cookies.hq_sid;
    if (!sid) return reply.code(401).send({ error: 'not logged in' });
    const session = app.db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(sid);
    if (!session) return reply.code(401).send({ error: 'session expired' });
    return { id: session.admin_id, name: 'Byron' };
  });
}
