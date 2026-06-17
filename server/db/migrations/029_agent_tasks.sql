-- 029_agent_tasks.sql
--
-- Durable queue for tasks Byron asks J5 to do. Driven by:
--   1. The Mission Control UI  (POST /api/agent-tasks, decision endpoint)
--   2. A Telegram bridge       (Telegram DMs / inline button callbacks)
--   3. (Future) Email bridge
--
-- A worker cron ticks every 2 min, atomically claims the next queued task,
-- runs it through a subagent, self-reviews against acceptance_criteria, and
-- transitions status to:
--   - 'review'      (all criteria pass, waiting for Byron's approve)
--   - 'blocked'     (some criterion failed; gap list in review_checklist)
--   - 'failed'      (worker exception, see last_error)
--
-- Status flow:
--   queued -> running -> { review | blocked | failed }
--   { review | blocked } -> { done | requeued | cancelled }
--
-- Why a separate table (and not in pending_emails):
--   pending_emails is the Gmail scan staging area; an "ask J5" is not a Gmail
--   message. Different lifecycle, different source, different UI.
--
-- Why JSON columns for the rubric:
--   acceptance_criteria and review_checklist are evaluated by the LLM, not
--   by SQL. We don't want to over-normalize a structure the worker is free
--   to reshape as it learns what "done" means for a given task.

CREATE TABLE agent_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                 TEXT NOT NULL UNIQUE,            -- short stable handle, e.g. T-AB12CD
  title               TEXT NOT NULL,                   -- one-line summary, shown in HQ table
  prompt              TEXT NOT NULL,                   -- full ask, may be long
  source              TEXT NOT NULL DEFAULT 'hq_ui',   -- 'hq_ui' | 'telegram' | 'email' | 'voice' | 'seed'
  source_ref          TEXT,                            -- telegram msg id, gmail id, etc.
  priority            INTEGER NOT NULL DEFAULT 0,      -- higher = picked first
  status              TEXT NOT NULL DEFAULT 'queued',  -- queued|running|review|blocked|failed|done|cancelled
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at          TEXT,                            -- set when claimed
  finished_at         TEXT,                            -- set on terminal transition
  last_heartbeat_at   TEXT,                            -- worker writes while running; "stuck" detector
  last_error          TEXT,                            -- exception message on failure
  result_summary      TEXT,                            -- 1-3 sentence outcome
  evidence_path       TEXT,                            -- filesystem path to evidence (screenshot, log)
  worker_run_id       TEXT,                            -- hermes run id that handled it (for audit)
  acceptance_criteria TEXT,                            -- JSON: [{ req, kind }]
  review_checklist    TEXT,                            -- JSON: [{ req, pass, note }]
  decision            TEXT,                            -- 'approve' | 'send_back' | 'requeue' | 'cancel'
  decided_by          TEXT,                            -- 'byron' | 'auto' (auto = worker self-rejected)
  decision_note       TEXT,                            -- free text from human/auto
  decided_at          TEXT
);

-- Worker hot path: "give me the next queued task"
CREATE INDEX idx_agent_tasks_status_priority
  ON agent_tasks(status, priority DESC, created_at ASC)
  WHERE status IN ('queued', 'requeued');

-- HQ "currently running" view, plus the heartbeat-based stuck-detector.
CREATE INDEX idx_agent_tasks_running
  ON agent_tasks(status, last_heartbeat_at)
  WHERE status = 'running';

-- HQ mission control default sort
CREATE INDEX idx_agent_tasks_created_desc
  ON agent_tasks(created_at DESC, id DESC);

-- History view filter
CREATE INDEX idx_agent_tasks_status_created
  ON agent_tasks(status, created_at DESC);
