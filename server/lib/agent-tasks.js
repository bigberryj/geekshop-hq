/**
 * agent-tasks.js — queue primitives for the Mission Control feature.
 *
 * The actual work (calling delegate_task, self-review, Telegram ping) lives
 * outside the API server and is owned by a separate cron job
 * (`agent-task-worker`) so the server stays simple and the worker can take
 * its time without blocking HTTP requests.
 *
 * What this module owns:
 *   - Schema-safe inserts / reads
 *   - Atomic claim (no two workers can ever grab the same row)
 *   - Status transitions guarded by the current state, so we never silently
 *     overwrite a row that has already been approved or sent back
 *   - Stuck-detector (running for too long without a heartbeat)
 *   - Safe projection for the API (no raw prompt leaked when caller only
 *     needs the summary)
 *
 * Conventions:
 *   - All times stored as ISO 8601 strings. SQLite stores them as TEXT.
 *   - JSON columns (`acceptance_criteria`, `review_checklist`) are parsed
 *     defensively — bad JSON is treated as "missing" and never thrown.
 */

import { randomBytes } from 'node:crypto';

/**
 * Activity broadcast hook. Wired up by the route layer in server/index.js
 * (or routes/agents.js) so this lib stays free of HTTP concerns. Falls
 * back to a no-op so the lib remains usable from CLI contexts (e.g.
 * `agent-task-cli.js`) where no app is present.
 */
let _activitySink = null;
export function setActivitySink(fn) { _activitySink = fn; }

function emit(event) {
  if (!_activitySink) return;
  try { _activitySink(event); } catch { /* never let a broadcast failure break a task transition */ }
}

const SAFE_STATUSES = new Set([
  'queued', 'running', 'review', 'blocked', 'failed', 'done', 'cancelled',
]);
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** Generate a short, URL-safe task handle, e.g. "T-AB12CD". */
export function newTaskUid() {
  return 'T-' + randomBytes(3).toString('hex').toUpperCase();
}

/** Coerce JSON text columns safely. Bad / null JSON -> default. */
function safeJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Stringify for storage; never store `undefined`. */
function jsonOrNull(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

/**
 * Insert a new task. Returns the inserted row.
 * `input` may include: title, prompt, source, source_ref, priority,
 *   acceptance_criteria (array of { req, kind }).
 */
export function createTask(db, input) {
  const title = (input.title || '').trim();
  const prompt = (input.prompt || '').trim();
  if (!title) throw new Error('title is required');
  if (!prompt) throw new Error('prompt is required');

  const source = input.source || 'hq_ui';
  const priority = Number.isFinite(input.priority) ? Number(input.priority) : 0;
  const max_attempts = Number.isFinite(input.max_attempts) ? Number(input.max_attempts) : 3;

  const result = db.prepare(`
    INSERT INTO agent_tasks
      (uid, title, prompt, source, source_ref, priority, max_attempts, acceptance_criteria)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newTaskUid(),
    title,
    prompt,
    source,
    input.source_ref || null,
    priority,
    max_attempts,
    jsonOrNull(input.acceptance_criteria || null),
  );
  return getTask(db, result.lastInsertRowid);
}

/** Read one task by id (numeric pk). Returns undefined if not found. */
export function getTask(db, id) {
  return db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id);
}

/** Read one task by uid handle. */
export function getTaskByUid(db, uid) {
  return db.prepare('SELECT * FROM agent_tasks WHERE uid = ?').get(uid);
}

/**
 * Atomic claim: pick the next queued (or requeued) task and flip it to
 * `running` in a single transaction. Returns the claimed row, or null
 * when the queue is empty.
 *
 * Sort order: highest priority first, then oldest.
 *
 * The transaction guard is what makes this safe for multiple workers
 * (or a misbehaving clock that lets two ticks overlap). The UPDATE is
 * gated on the row's current status, so a second concurrent claim sees
 * 0 affected rows and the transaction rolls back harmlessly.
 */
export function claimNextTask(db, { now = new Date().toISOString() } = {}) {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE status IN ('queued', 'requeued')
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get();
    if (!row) return null;
    const updated = db.prepare(`
      UPDATE agent_tasks
         SET status       = 'running',
             started_at   = COALESCE(started_at, ?),
             last_heartbeat_at = ?,
             attempts     = attempts + 1
       WHERE id = ?
         AND status IN ('queued', 'requeued')
    `).run(now, now, row.id);
    if (updated.changes === 0) return null; // someone else claimed it
    const task = getTask(db, row.id);
    emit({ kind: 'task_claimed', task });
    return task;
  })();
}

/** Worker heartbeat — called periodically while a task is in flight.
 * Optional progress reporting: progress_pct (0-100) and progress_message
 * are written only if provided, so older workers keep working unchanged. */
export function heartbeat(db, id, { now = new Date().toISOString(), progress_pct = undefined, progress_message = undefined } = {}) {
  const sets = ['last_heartbeat_at = ?'];
  const args = [now];
  if (progress_pct !== undefined) {
    const n = Math.max(0, Math.min(100, Math.round(Number(progress_pct) || 0)));
    sets.push('progress_pct = ?');
    args.push(n);
  }
  if (progress_message !== undefined) {
    sets.push('progress_message = ?');
    args.push(String(progress_message).slice(0, 500));
  }
  args.push(id);
  db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ? AND status = 'running'`).run(...args);
}

/**
 * Terminal status update from the worker. Writes the result summary,
 * evidence path, review checklist, and final status.
 *
 * `decision` is only set here when the worker self-rejects (e.g. the
 * self-review surfaced an unmet criterion that the worker can't fix in
 * one pass). For `done`, decision stays null until Byron approves.
 */
export function finishTask(db, id, patch) {
  const allowed = ['review', 'blocked', 'failed', 'done'];
  if (!allowed.includes(patch.status)) {
    throw new Error(`finishTask: status must be one of ${allowed.join(', ')}`);
  }
  const now = new Date().toISOString();
  const finished = ['blocked', 'failed', 'done'].includes(patch.status);
  const result = db.prepare(`
    UPDATE agent_tasks
       SET status           = ?,
           result_summary   = COALESCE(?, result_summary),
           evidence_path    = COALESCE(?, evidence_path),
           worker_run_id    = COALESCE(?, worker_run_id),
           review_checklist = COALESCE(?, review_checklist),
           last_error       = COALESCE(?, last_error),
           decision         = COALESCE(?, decision),
           decided_by       = COALESCE(?, decided_by),
           decision_note    = COALESCE(?, decision_note),
           decided_at       = COALESCE(?, decided_at),
           finished_at      = CASE WHEN ? THEN ? ELSE finished_at END
     WHERE id = ?
       AND status = 'running'
  `).run(
    patch.status,
    patch.result_summary ?? null,
    patch.evidence_path ?? null,
    patch.worker_run_id ?? null,
    jsonOrNull(patch.review_checklist ?? null),
    patch.last_error ?? null,
    patch.decision ?? null,
    patch.decided_by ?? null,
    patch.decision_note ?? null,
    patch.decided_at ?? null,
    finished ? 1 : 0,
    now,
    id,
  );
  // Fire-and-forget notification. We re-fetch the row so the email body
  // reflects the final committed state (decision, finished_at, etc.).
  // IMPORTANT: open a fresh DB connection here — the caller's connection
  // may already be closed by the time setImmediate runs (especially in
  // the CLI script, which closes its connection right after finishTask
  // returns). Errors are swallowed inside notify.js; nothing here should
  // ever throw.
  if (result.changes > 0) {
    setImmediate(async () => {
      try {
        const { notifyTaskTerminal, notifyTaskForApproval } = await import('./notify.js');
        // Re-open a fresh connection for the post-commit read.
        const Database = (await import('better-sqlite3')).default;
        const { getTask } = await import('./agent-tasks.js');
        const path = process.env.HQ_DB_PATH || '/home/byron/projects/geekshop-hq/data/hq.db';
        const freshDb = new Database(path);
        try {
          const fresh = getTask(freshDb, id);
          if (fresh) {
            // Send email notification for all terminal statuses
            await notifyTaskTerminal(fresh);

            // Send Telegram notification with buttons for review status
            if (fresh.status === 'review') {
              await notifyTaskForApproval(fresh);
            }
          }
        } finally {
          freshDb.close();
        }
      } catch (err) {
        console.error(`[notify] finishTask hook for #${id} crashed: ${err.message}`);
      }
    });
  }
  if (result.changes > 0) {
    emit({ kind: 'task_finished', task: getTask(db, id), status: patch.status });
  }
  return result.changes > 0;
}

/**
 * Byron's decision on a task that's in `review` (or `blocked` if he
 * wants to override). Allowed transitions:
 *   review|blocked -> done      (approve)
 *   review|blocked -> queued    (requeue, with optional note)
 *   review|blocked -> cancelled (cancel)
 *
 * Returns the updated row, or null if the transition was rejected
 * (e.g. task is already in a terminal state).
 */
export function decideTask(db, id, { action, note, decided_by = 'byron' } = {}) {
  if (!['approve', 'requeue', 'cancel'].includes(action)) {
    throw new Error(`decideTask: action must be approve|requeue|cancel`);
  }
  const now = new Date().toISOString();
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) return null;
    if (TERMINAL_STATUSES.has(task.status)) return null; // already done/cancelled
    if (!['review', 'blocked'].includes(task.status)) return null; // wrong state

    let nextStatus;
    let decision;
    if (action === 'approve') {
      nextStatus = 'done';
      decision = 'approve';
    } else if (action === 'requeue') {
      nextStatus = 'queued';
      decision = 'requeue';
    } else {
      nextStatus = 'cancelled';
      decision = 'cancel';
    }

    db.prepare(`
      UPDATE agent_tasks
         SET status         = ?,
             decision       = ?,
             decided_by     = ?,
             decision_note  = ?,
             decided_at     = ?,
             finished_at    = CASE WHEN ? THEN ? ELSE finished_at END
       WHERE id = ?
         AND status IN ('review', 'blocked')
    `).run(
      nextStatus,
      decision,
      decided_by,
      note || null,
      now,
      nextStatus === 'done' || nextStatus === 'cancelled' ? 1 : 0,
      now,
      id,
    );
    const updated = getTask(db, id);
    // Fire-and-forget notification for decide transitions that produce a
    // terminal or near-terminal status (done/cancelled are terminal; requeue
    // lands back in queued so we don't notify on that one).
    // Same fresh-connection pattern as finishTask — caller's db may be gone.
    if (updated && (updated.status === 'done' || updated.status === 'cancelled')) {
      setImmediate(async () => {
        try {
          const { notifyTaskTerminal } = await import('./notify.js');
          await notifyTaskTerminal(updated);
        } catch (err) {
          console.error(`[notify] decideTask hook for #${id} crashed: ${err.message}`);
        }
      });
    }
    if (updated) emit({ kind: 'task_decided', task: updated, action });
    return updated;
  })();
}


/**
 * Stuck-detector: tasks in `running` whose last heartbeat is older than
 * `staleAfterMs` get bounced back to `queued` (so a different tick can
 * pick them up) and have `last_error` annotated.
 *
 * We do NOT auto-fail them — a task that ran for 30 minutes might just
 * have been doing real work, and a crashed worker should not silently
 * nuke a near-complete result. Requeue keeps the work, marks it stale,
 * and lets the next worker finish it.
 */
export function requeueStaleTasks(db, { staleAfterMs = 10 * 60 * 1000, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const stuck = db.prepare(`
    SELECT id, attempts, last_heartbeat_at
      FROM agent_tasks
     WHERE status = 'running'
       AND (
         (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)
         OR
         (last_heartbeat_at IS NULL AND started_at < ?)
       )
  `).all(cutoff, cutoff);
  if (stuck.length === 0) return [];
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      db.prepare(`
        UPDATE agent_tasks
           SET status         = CASE
                                  WHEN attempts >= max_attempts THEN 'failed'
                                  ELSE 'queued'
                                END,
             last_error     = COALESCE(last_error, '') ||
                              CASE WHEN last_error IS NULL THEN '' ELSE ' | ' END ||
                              'stale: no heartbeat since ' || COALESCE(last_heartbeat_at, started_at),
             started_at     = NULL,
             last_heartbeat_at = NULL
         WHERE id = ?
           AND status = 'running'
      `).run(r.id);
    }
  });
  tx(stuck);
  return stuck.map((r) => r.id);
}

/**
 * List tasks for the Mission Control UI.
 *
 * Filters:
 *   status   'all' | 'open' | 'review' | 'blocked' | 'done' | 'failed'
 *            'open' = queued|running|review|blocked (everything that needs eyes)
 *   limit, offset  pagination
 */
export function listTasks(db, { status = 'all', limit = 100, offset = 0 } = {}) {
  const openStatuses = ['queued', 'running', 'review', 'blocked'];
  let where = '';
  let args = [];
  if (status === 'open') {
    where = `status IN (${openStatuses.map(() => '?').join(',')})`;
    args = openStatuses;
  } else if (status !== 'all' && SAFE_STATUSES.has(status)) {
    where = 'status = ?';
    args = [status];
  } else if (status !== 'all') {
    return { items: [], total: 0, limit, offset };
  }
  const sql = `
    SELECT id, uid, title, source, source_ref, priority, status, attempts,
           max_attempts, created_at, started_at, finished_at,
           last_heartbeat_at, progress_pct, progress_message,
           result_summary, evidence_path, worker_run_id,
           decision, decided_by, decided_at, decision_note
      FROM agent_tasks
      ${where ? `WHERE ${where}` : ''}
      ORDER BY
        CASE status
          WHEN 'running'  THEN 0
          WHEN 'review'   THEN 1
          WHEN 'blocked'  THEN 2
          WHEN 'queued'   THEN 3
          WHEN 'failed'   THEN 4
          WHEN 'done'     THEN 5
          WHEN 'cancelled' THEN 6
          ELSE 7
        END,
        priority DESC,
        created_at ASC
      LIMIT ? OFFSET ?
  `;
  const items = db.prepare(sql).all(...args, limit, offset);
  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_tasks ${where ? `WHERE ${where}` : ''}`
  ).get(...args);
  return { items, total: totalRow.n, limit, offset };
}

/** Get the full task including prompt (only used by the worker + drawer). */
export function getTaskForReview(db, id) {
  const t = getTask(db, id);
  if (!t) return null;
  return {
    ...t,
    acceptance_criteria: safeJson(t.acceptance_criteria, []),
    review_checklist: safeJson(t.review_checklist, []),
  };
}

/**
 * Compute summary counts for the dashboard's Mission Control widget.
 * Cheap, no joins.
 */
export function summarizeTasks(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
      FROM agent_tasks
     GROUP BY status
  `).all();
  const out = { queued: 0, running: 0, review: 0, blocked: 0, failed: 0, done: 0, cancelled: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * Reopen a task that's in a terminal state (done / failed / cancelled).
 * Resets finished_at, decision*, last_error, attempts. Status moves to
 * 'queued' so the worker cron will claim it on its next tick.
 *
 * The optional `note` is appended to result_summary with a clear
 * separator so the worker's next claim sees why it was reopened.
 * `decided_by` defaults to 'byron'.
 *
 * Returns the updated row on success, null if the task isn't in a
 * terminal state (or doesn't exist).
 *
 * Notes on idempotency: this is intentionally NOT a state-machine
 * validator — it accepts any terminal status and forces the transition.
 * The route layer is responsible for refusing reopen on non-terminal
 * tasks (so we don't accidentally lose an in-flight worker).
 */
export function reopenTask(db, id, { note = '', decided_by = 'byron' } = {}) {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) return null;
    if (!['done', 'failed', 'cancelled'].includes(task.status)) return null;

    const reopen_note = note ? `\n\n[REOPENED ${new Date().toISOString()} by ${decided_by}] ${note}` : '';
    const existing_summary = task.result_summary || '';
    const new_summary = existing_summary + reopen_note;

    db.prepare(`
      UPDATE agent_tasks
         SET status        = 'queued',
             finished_at   = NULL,
             decision      = NULL,
             decided_by    = NULL,
             decided_at    = NULL,
             decision_note = NULL,
             last_error    = NULL,
             attempts      = 0,
             started_at    = NULL,
             last_heartbeat_at = NULL,
             progress_pct  = NULL,
             progress_message = NULL,
             result_summary = ?
       WHERE id = ?
    `).run(new_summary, id);

    const reopened = getTask(db, id);
    if (reopened) emit({ kind: 'task_reopened', task: reopened });
    return reopened;
  })();
}
