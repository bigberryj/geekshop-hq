-- Byron-iter 2026-06-16: email attachments + body_html.
-- The Gmail review queue + ticket import both need:
--   1. Attachments stored on disk (path tracked here) so the admin can
--      preview them and the ticket page can show them inline.
--   2. HTML body for ticket messages, so a customer's Gmail email
--      renders the same way in the ticket view as it did in Gmail
--      (with inline images, formatting, layout).
--
-- `pending_email_attachments` is the staging area while the email is
-- still in the inbox queue. On import we copy the files into the
-- `ticket_message_attachments` location and record them there, so the
-- inbox row can be deleted without losing the attachments.

CREATE TABLE pending_email_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_email_id INTEGER NOT NULL REFERENCES pending_emails(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,                       -- cid: references in body_html
  disposition TEXT NOT NULL DEFAULT 'attachment',  -- 'attachment' | 'inline'
  storage_path TEXT NOT NULL,            -- relative to data/attachments/
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pending_attach_pending ON pending_email_attachments(pending_email_id);

-- Same shape, post-import. ticket_message_id references the customer
-- message that brought the attachment in.
CREATE TABLE ticket_message_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_message_id INTEGER NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  disposition TEXT NOT NULL DEFAULT 'attachment',
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ticket_attach_message ON ticket_message_attachments(ticket_message_id);

-- The HTML body of a ticket message. We keep the original `body` column
-- as the plain-text fallback (so search, text export, and email
-- delivery still work). `body_html` is shown in the ticket UI via a
-- sandboxed iframe.
ALTER TABLE ticket_messages ADD COLUMN body_html TEXT;
