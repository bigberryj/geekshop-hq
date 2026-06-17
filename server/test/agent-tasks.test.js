/**
 * Mission Control — durable task queue tests.
 *
 * These tests exercise the queue primitives directly against an in-memory
 * SQLite DB. The route-level integration is covered by a smaller test in
 * `smoke.test.js`-style fashion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import {
  newTaskUid,
  createTask,
  getTask,
  getTaskByUid,
  claimNextTask,
  heartbeat,
  finishTask,
  decideTask,
  requeueStaleTasks,
  listTasks,
  summarizeTasks,
} from '../lib/agent-tasks.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Migrations run synchronously against this in-memory db. The migrate
  // helper is async but for `:memory:` it's effectively sync.
  return { db };
}

async function buildDb() {
  const { db } = freshDb();
  // runMigrations expects a file path; use a temp file so the same code
  // path as production is exercised.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = path.join(os.tmpdir(), `hq-test-${Date.now()}-${Math.random().toString(36).slice(2,8)}.db`);
  const real = await runMigrations(tmp);
  fs.unlinkSync(tmp); // the open handle still works; the file gets GC'd on close
  return real;
}

beforeEach(async () => {
  // no-op; we build a fresh db per test
});

describe('agent_tasks: schema + creation', () => {
  it('creates a queued task with a uid handle', async () => {
    const db = await buildDb();
    const t = createTask(db, {
      title: 'Test task',
      prompt: 'Do the thing',
      source: 'hq_ui',
    });
    expect(t.id).toBeGreaterThan(0);
    expect(t.uid).toMatch(/^T-[0-9A-F]{6}$/);
    expect(t.status).toBe('queued');
    expect(t.attempts).toBe(0);
    expect(t.source).toBe('hq_ui');
  });

  it('rejects empty title or prompt', async () => {
    const db = await buildDb();
    expect(() => createTask(db, { title: '', prompt: 'x' })).toThrow(/title/);
    expect(() => createTask(db, { title: 'x', prompt: '' })).toThrow(/prompt/);
  });

  it('round-trips uid lookup', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 'Find me', prompt: 'ping' });
    const got = getTaskByUid(db, t.uid);
    expect(got.id).toBe(t.id);
  });
});

describe('agent_tasks: claim', () => {
  it('returns the highest-priority oldest task', async () => {
    const db = await buildDb();
    const a = createTask(db, { title: 'A low', prompt: 'a', priority: 0 });
    const b = createTask(db, { title: 'B high', prompt: 'b', priority: 5 });
    const claimed = claimNextTask(db);
    expect(claimed.id).toBe(b.id);
    expect(claimed.status).toBe('running');
    expect(claimed.attempts).toBe(1);
    expect(claimed.started_at).toBeTruthy();

    // A should still be queued
    expect(getTask(db, a.id).status).toBe('queued');
  });

  it('is atomic — second claim returns the next task, not the same one', async () => {
    const db = await buildDb();
    const a = createTask(db, { title: 'A', prompt: 'a' });
    const b = createTask(db, { title: 'B', prompt: 'b' });
    const first = claimNextTask(db);
    const second = claimNextTask(db);
    expect(first.id).not.toBe(second.id);
    expect([a.id, b.id]).toContain(first.id);
    expect([a.id, b.id]).toContain(second.id);
  });

  it('returns null when the queue is empty', async () => {
    const db = await buildDb();
    expect(claimNextTask(db)).toBeNull();
  });
});

describe('agent_tasks: finish + self-review transitions', () => {
  it('moves running -> review with a checklist', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    const claimed = claimNextTask(db);
    expect(claimed.status).toBe('running');
    const ok = finishTask(db, claimed.id, {
      status: 'review',
      result_summary: 'Done. The thing is fixed.',
      review_checklist: [
        { req: 'thing is fixed', pass: true, note: 'confirmed via grep' },
      ],
    });
    expect(ok).toBe(true);
    const after = getTask(db, claimed.id);
    expect(after.status).toBe('review');
    expect(after.result_summary).toMatch(/fixed/);
  });

  it('moves running -> blocked when a criterion fails', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    const claimed = claimNextTask(db);
    finishTask(db, claimed.id, {
      status: 'blocked',
      result_summary: 'Could not finish; missing test fixture',
      review_checklist: [
        { req: 'thing is fixed', pass: false, note: 'no test fixture' },
      ],
      last_error: 'missing fixture',
    });
    const after = getTask(db, claimed.id);
    expect(after.status).toBe('blocked');
    expect(after.last_error).toMatch(/fixture/);
  });

  it('rejects finishing a task that is not running', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    // Task is still queued; finishTask should not transition it
    const ok = finishTask(db, t.id, { status: 'review', result_summary: 'x' });
    expect(ok).toBe(false);
    expect(getTask(db, t.id).status).toBe('queued');
  });
});

describe('agent_tasks: decisions (approve / requeue / cancel)', () => {
  it('approves a review task -> done', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review', result_summary: 'ok' });
    const after = decideTask(db, t.id, { action: 'approve', note: 'lgtm' });
    expect(after.status).toBe('done');
    expect(after.decision).toBe('approve');
    expect(after.decision_note).toBe('lgtm');
  });

  it('requeues a blocked task back to queued', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'blocked' });
    const after = decideTask(db, t.id, { action: 'requeue', note: 'try again with new info' });
    expect(after.status).toBe('queued');
    expect(after.decision).toBe('requeue');
  });

  it('refuses to decide an already-done task', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    claimNextTask(db);
    finishTask(db, t.id, { status: 'review' });
    decideTask(db, t.id, { action: 'approve' });
    const second = decideTask(db, t.id, { action: 'requeue' });
    expect(second).toBeNull();
  });

  it('refuses to decide a queued task (worker hasn\'t run yet)', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    const after = decideTask(db, t.id, { action: 'approve' });
    expect(after).toBeNull();
  });
});

describe('agent_tasks: stuck detector', () => {
  it('requeues tasks whose heartbeat is too old', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    claimNextTask(db);
    // Simulate a heartbeat from 20 minutes ago
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    heartbeat(db, t.id, { now: old });
    const stuck = requeueStaleTasks(db, { staleAfterMs: 10 * 60 * 1000 });
    expect(stuck).toContain(t.id);
    const after = getTask(db, t.id);
    expect(after.status).toBe('queued');
    expect(after.last_error).toMatch(/stale/);
  });

  it('does not touch fresh heartbeats', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p' });
    claimNextTask(db);
    heartbeat(db, t.id); // now
    const stuck = requeueStaleTasks(db, { staleAfterMs: 10 * 60 * 1000 });
    expect(stuck).toEqual([]);
    expect(getTask(db, t.id).status).toBe('running');
  });

  it('fails (not requeues) a task that has burned all its attempts', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 't', prompt: 'p', max_attempts: 2 });
    // burn two attempts
    for (let i = 0; i < 2; i++) {
      claimNextTask(db);
      finishTask(db, t.id, { status: 'failed', last_error: 'boom' });
    }
    // The task is in `failed` after the second claim, so to test the
    // max-attempts requeue path we need to be in `running` with old
    // heartbeat and attempts >= max. Simulate that directly.
    db.prepare(`UPDATE agent_tasks SET status='running', attempts=2, last_heartbeat_at=NULL, started_at=? WHERE id=?`)
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), t.id);
    requeueStaleTasks(db, { staleAfterMs: 10 * 60 * 1000 });
    expect(getTask(db, t.id).status).toBe('failed');
  });
});

describe('agent_tasks: list + summary', () => {
  it('groups statuses correctly in summary', async () => {
    const db = await buildDb();
    createTask(db, { title: 'a', prompt: 'p' });
    createTask(db, { title: 'b', prompt: 'p' });
    const claimed = claimNextTask(db);
    finishTask(db, claimed.id, { status: 'review' });
    const s = summarizeTasks(db);
    expect(s.queued).toBe(1);
    expect(s.review).toBe(1);
    expect(s.running).toBe(0);
    expect(s.total).toBe(2);
  });

  it('listTasks "open" excludes done', async () => {
    const db = await buildDb();
    const t = createTask(db, { title: 'will be done', prompt: 'p' });
    const claimed = claimNextTask(db);
    finishTask(db, claimed.id, { status: 'review' });
    decideTask(db, t.id, { action: 'approve' });
    createTask(db, { title: 'still open', prompt: 'p' });
    const open = listTasks(db, { status: 'open' });
    expect(open.items.every((r) => r.status !== 'done')).toBe(true);
    expect(open.total).toBe(1);
  });

  it('listTasks orders running > review > blocked > queued', async () => {
    const db = await buildDb();
    // Create four tasks and walk each into the desired state. We claim
    // them one at a time and finish them so we have full control over
    // the final mix: 1 running, 1 review, 1 blocked, 1 queued.
    const t1 = createTask(db, { title: 'to-running', prompt: 'p' });
    const t2 = createTask(db, { title: 'to-review', prompt: 'p' });
    const t3 = createTask(db, { title: 'to-blocked', prompt: 'p' });
    const t4 = createTask(db, { title: 'stays-queued', prompt: 'p' });
    claimNextTask(db); finishTask(db, t1.id, { status: 'review' });
    claimNextTask(db); finishTask(db, t2.id, { status: 'blocked' });
    claimNextTask(db); // leaves t3 in `running` (no finish needed)
    const list = listTasks(db, { status: 'all' });
    const order = list.items.map((r) => r.status);
    expect(order.indexOf('running')).toBeLessThan(order.indexOf('review'));
    expect(order.indexOf('review')).toBeLessThan(order.indexOf('blocked'));
    expect(order.indexOf('blocked')).toBeLessThan(order.indexOf('queued'));
  });
});
