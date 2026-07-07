-- Byron-iter 2026-06-30: soft-delete for tickets (T-7D74B8).
-- The user wants the ability to delete tickets from the ticket area.
-- Soft-delete is the right shape here:
--   - preserves audit log + customer history (no cascade loss)
--   - reversible (operator can restore if a delete was a mistake)
--   - keeps invoice line_items that reference a ticket_uid stable
--     (those are denormalized JSON, not a live FK, but historical
--     reports still show the original ticket subject)
--
-- `deleted_at IS NULL` filters live tickets in the default list view.
-- `?include_deleted=true` exposes the trash for review/restore.
-- The companion `delete_ticket`/`restore_ticket` endpoints live in
-- `server/routes/tickets.js`.

ALTER TABLE tickets ADD COLUMN deleted_at TEXT;
ALTER TABLE tickets ADD COLUMN deleted_by TEXT;  -- 'admin' for now; reserved for future actor plumbing

-- Keep the hot list path (status filter) cheap: deleted rows go through
-- the same status filter, but the query is rewritten below to also
-- exclude `deleted_at IS NOT NULL` unless explicitly requested.
CREATE INDEX idx_tickets_deleted_at ON tickets(deleted_at) WHERE deleted_at IS NOT NULL;
