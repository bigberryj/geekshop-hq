-- Idempotency column for email replies.
-- When a Gmail message is auto-appended to an existing ticket thread we
-- need a stable, unique-by-message key so a re-scan doesn't append
-- the same reply twice. ticket_messages.body itself isn't unique
-- (Gmail may send similar text), and ticket_messages.source_message_id
-- (when set) only tracks the *first* message of the ticket.
ALTER TABLE ticket_messages ADD COLUMN gmail_message_id TEXT;
CREATE UNIQUE INDEX idx_ticket_messages_gmail_msgid
  ON ticket_messages(gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;
