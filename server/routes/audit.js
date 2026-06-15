/**
 * Audit log.
 */

export async function auditRoutes(app) {
  app.get('/api/audit', async (req) => {
    const { target, limit } = req.query;
    let sql = 'SELECT * FROM audit_log';
    const args = [];
    if (target) { sql += ' WHERE target = ?'; args.push(target); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    args.push(Number(limit) || 100);
    return app.db.prepare(sql).all(...args);
  });
}
