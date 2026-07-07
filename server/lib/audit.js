/**
 * Audit log helpers.
 *
 * Centralizes the audit_log INSERT so that:
 *   1. There's one correct place to update if the schema changes.
 *   2. Audit failures never break the user-facing request — they're
 *      logged loudly but swallowed. (The audit row is nice-to-have;
 *      the customer-facing state change is the contract.)
 *   3. We can stash a structured `payload` JSON next to the existing
 *      `target` column without misbinding parameter counts.
 *
 * `audit_log` schema (see server/db/migrations/001_initial.sql):
 *   id INTEGER, actor TEXT, action TEXT, target TEXT,
 *   payload TEXT, created_at TEXT.
 */

export function logAudit(db, action, target, payload) {
  if (!db) return;
  try {
    if (payload === undefined || payload === null) {
      db.prepare(
        "INSERT INTO audit_log (actor, action, target) VALUES ('admin', ?, ?)"
      ).run(action, target == null ? null : String(target));
    } else {
      db.prepare(
        "INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', ?, ?, ?)"
      ).run(action, target == null ? null : String(target), JSON.stringify(payload));
    }
  } catch (err) {
    // Audit must never break a request that already succeeded.
    // Log via stderr so the server log surfaces the warning without
    // requiring pino elsewhere to be configured.
    // eslint-disable-next-line no-console
    console.warn(`[audit] failed to log action=${action}: ${err.message}`);
  }
}
