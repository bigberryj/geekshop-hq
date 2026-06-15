-- Queue of fetched Gmail messages awaiting admin review.
-- Replaces the silent "auto-create ticket" path with a visible moderation step.
CREATE TABLE pending_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  uid TEXT,
  from_name TEXT,
  from_email TEXT,
  subject TEXT,
  body TEXT,
  snippet TEXT,
  received_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'imported' | 'dismissed'
  imported_ticket_id INTEGER,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE INDEX idx_pending_emails_status ON pending_emails(status, fetched_at DESC);
CREATE UNIQUE INDEX idx_pending_emails_msgid ON pending_emails(message_id);
