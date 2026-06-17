-- Add source_message_id to ticket_messages.
--
-- The reply matcher (lib/replies.js) appends Gmail messages to existing
-- ticket threads and tags them with the Gmail Message-ID header so a
-- future re-scan can detect duplicates. We have gmail_message_id for
-- idempotency (unique index, migration 013); source_message_id is the
-- related header that says "this message is a reply to <that one>" —
-- useful for future audit + for cross-referencing the message back to
-- the original thread starter.
--
-- Nullable because the column doesn't apply to admin-written replies.
ALTER TABLE ticket_messages ADD COLUMN source_message_id TEXT;

CREATE INDEX idx_ticket_messages_source_msgid
  ON ticket_messages(source_message_id)
  WHERE source_message_id IS NOT NULL;
