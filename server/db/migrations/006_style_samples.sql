-- Style samples: real messages written by Byron that we mine for voice signals.
-- Seeded from the 3 admin messages already in ticket_messages plus any future
-- admin messages we capture as feedback on AI drafts.
CREATE TABLE style_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                  -- 'admin_message' | 'telegram' | 'feedback_edit' | 'manual_seed'
  text TEXT NOT NULL,                    -- the raw message body
  context TEXT,                          -- e.g. 'reply to Wi-Fi drop ticket' (optional)
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_style_samples_source ON style_samples(source);

-- Style feedback: each time Byron edits an AI draft before sending, we log
-- the (original draft, final text) pair. Used to refine the style profile.
-- ticket_id is a soft reference (no FK) so feedback survives ticket deletion
-- and so we can record feedback from a draft that never had a ticket.
CREATE TABLE style_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER,
  draft_text TEXT NOT NULL,
  final_text TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_style_feedback_ticket ON style_feedback(ticket_id);
