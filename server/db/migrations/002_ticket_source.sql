-- 002 — Add ticket source + email message_id tracking
-- Tracks where a ticket originated (manual, email, booking, etc.) and links to the source message.

ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tickets ADD COLUMN source_message_id TEXT;  -- e.g. Gmail Message-ID
CREATE INDEX idx_tickets_source ON tickets(source);

-- Optional: messages table gets a subject line for inbox previews
ALTER TABLE ticket_messages ADD COLUMN subject TEXT;
