-- Add pause/resume support for active ticket timers.
-- duration_seconds is used as accumulated elapsed seconds while paused/running,
-- and as final elapsed seconds after stop.

ALTER TABLE time_entries ADD COLUMN paused_at TEXT;
CREATE INDEX idx_time_active ON time_entries(ticket_id, stopped_at, paused_at);
