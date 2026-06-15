/**
 * Customer memory CRUD + bulk extract.
 */

import { aiCall } from '../lib/ai.js';

export async function memoryRoutes(app) {
  // Add
  app.post('/api/customers/:id/memory', async (req, reply) => {
    const { category, key, value, source, confidence } = req.body || {};
    if (!category || !value) return reply.code(400).send({ error: 'category and value required' });
    if (!['preference', 'equipment', 'history', 'relationship', 'note'].includes(category)) {
      return reply.code(400).send({ error: 'invalid category' });
    }
    const info = app.db.prepare(`
      INSERT INTO customer_memory (customer_id, category, key, value, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, category, key || null, value, source || 'manual', confidence ?? (source === 'ai' ? 0.7 : 1.0));
    return { id: info.lastInsertRowid };
  });

  // Update
  app.patch('/api/customers/:id/memory/:mid', async (req, reply) => {
    const { value, confidence } = req.body || {};
    const updates = [];
    const args = [];
    if (value !== undefined) { updates.push('value = ?'); args.push(value); }
    if (confidence !== undefined) { updates.push('confidence = ?'); args.push(confidence); }
    if (!updates.length) return reply.code(400).send({ error: 'nothing to update' });
    updates.push("updated_at = CURRENT_TIMESTAMP");
    args.push(req.params.mid, req.params.id);
    app.db.prepare(`UPDATE customer_memory SET ${updates.join(', ')} WHERE id = ? AND customer_id = ?`).run(...args);
    return { ok: true };
  });

  // Delete
  app.delete('/api/customers/:id/memory/:mid', async (req, reply) => {
    app.db.prepare('DELETE FROM customer_memory WHERE id = ? AND customer_id = ?').run(req.params.mid, req.params.id);
    return { ok: true };
  });

  // Bulk extract (Gemini via Codex high-reasoning tier)
  app.post('/api/customers/:id/memory/extract', async (req, reply) => {
    const { notes } = req.body || {};
    if (!notes) return reply.code(400).send({ error: 'notes required' });
    const customer = app.db.prepare('SELECT name FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) return reply.code(404).send({ error: 'customer not found' });

    const prompt = `Extract structured memory entries from these freeform notes about a customer named "${customer.name}".

Notes:
"""
${notes}
"""

Return a JSON array. Each item: { "category": "preference"|"equipment"|"history"|"relationship"|"note", "key": "<short key or null>", "value": "<the actual fact>" }.

Only include entries you're confident about. Skip generic pleasantries.`;
    const result = await aiCall('high_reasoning', prompt, {
      system: 'You extract structured memory entries from freeform notes. Output ONLY valid JSON.',
      maxTokens: 800,
    });

    // Try to parse the JSON; if it fails, return raw for inspection
    let entries = [];
    try {
      const m = result.output.match(/\[[\s\S]*\]/);
      entries = m ? JSON.parse(m[0]) : [];
    } catch (err) {
      return reply.code(502).send({ error: 'AI returned unparseable JSON', raw: result.output });
    }
    // Persist
    const stmt = app.db.prepare(`
      INSERT INTO customer_memory (customer_id, category, key, value, source, confidence)
      VALUES (?, ?, ?, ?, 'ai', 0.7)
    `);
    const inserted = [];
    const tx = app.db.transaction((items) => {
      for (const e of items) {
        const info = stmt.run(req.params.id, e.category, e.key || null, e.value);
        inserted.push(info.lastInsertRowid);
      }
    });
    tx(entries);
    return { inserted, count: entries.length, provider: result.provider };
  });
}
