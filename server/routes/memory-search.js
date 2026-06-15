/**
 * Global memory search (the cmd+k feature).
 */

export async function memorySearchRoutes(app) {
  app.get('/api/memory/search', async (req) => {
    const { q } = req.query;
    if (!q || q.length < 2) return [];
    const pattern = `%${q}%`;
    return app.db.prepare(`
      SELECT m.id, m.category, m.key, m.value, m.confidence, m.source,
             c.id as customer_id, c.name as customer_name
      FROM customer_memory m
      JOIN customers c ON m.customer_id = c.id
      WHERE m.value LIKE ? OR m.key LIKE ? OR c.name LIKE ?
      ORDER BY c.name, m.category
      LIMIT 50
    `).all(pattern, pattern, pattern);
  });
}
