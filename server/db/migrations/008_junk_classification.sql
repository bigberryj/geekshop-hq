-- Junk classification: every fetched email gets a verdict and a reason,
-- even if it's "legit" (so we can audit what the classifier thought).
-- dismissed_by tracks WHO dismissed it: 'user' (manual), 'auto_junk' (rule), 'auto_ai' (LLM).
-- classification is a JSON blob: { score, reason, signals[], classified_by, classified_at }.
-- dismissed_at is a separate timestamp from decided_at (which was repurposed
-- for the original import/dismiss path).
ALTER TABLE pending_emails ADD COLUMN dismissed_by TEXT;
ALTER TABLE pending_emails ADD COLUMN classification TEXT;
ALTER TABLE pending_emails ADD COLUMN dismissed_reason TEXT;
ALTER TABLE pending_emails ADD COLUMN dismissed_at TEXT;

-- Index for the "show dismissed" filter (everything with status='dismissed').
-- (We don't need a new index — the existing status index covers it.)
