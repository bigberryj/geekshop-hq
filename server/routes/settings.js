/**
 * Settings CRUD + AI provider test.
 */

import { testProvider } from '../lib/ai.js';
import { maskSensitive, isProduction } from '../lib/security.js';

export async function settingsRoutes(app) {
  // List
  app.get('/api/settings', async () => {
    const rows = app.db.prepare('SELECT * FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return maskSensitive(out);
  });

  // Update
  app.put('/api/settings/:key', async (req, reply) => {
    const { value } = req.body || {};
    app.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(req.params.key, value);
    return { ok: true };
  });

  // Test AI provider
  app.post('/api/settings/test-ai/:provider', async (req) => {
    return await testProvider(req.params.provider);
  });
}
