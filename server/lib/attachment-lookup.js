/**
 * Look up an attachment row (pending or ticket) by id and return the
 * storage_path, mime_type, filename + scope. Used by the
 * /api/attachments/:id/raw route.
 *
 * Returns null if the row doesn't exist.
 */
export function findAttachmentById(db, id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const pending = db.prepare(`
    SELECT id, 'pending' AS scope, pending_email_id AS row_id, filename, mime_type, storage_path, content_id, disposition
    FROM pending_email_attachments
    WHERE id = ?
  `).get(id);
  if (pending) return pending;
  const ticket = db.prepare(`
    SELECT tma.id, 'tickets' AS scope, tm.ticket_id AS row_id, tma.filename, tma.mime_type, tma.storage_path, tma.content_id, tma.disposition
    FROM ticket_message_attachments tma
    JOIN ticket_messages tm ON tm.id = tma.ticket_message_id
    WHERE tma.id = ?
  `).get(id);
  return ticket || null;
}
