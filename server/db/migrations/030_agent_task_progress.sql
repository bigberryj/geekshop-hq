-- 030_agent_task_progress.sql
-- Adds progress_pct (0-100) and progress_message to agent_tasks so the
-- worker can report fine-grained progress while a task is running.
-- Nullable: only running tasks are expected to set these, terminal tasks
-- leave them null and the UI falls back to elapsed-time heuristics.
--
-- Forward + reversible. Idempotent guard via NOT EXISTS on the column.
ALTER TABLE agent_tasks ADD COLUMN progress_pct INTEGER;
ALTER TABLE agent_tasks ADD COLUMN progress_message TEXT;
