#!/usr/bin/env node
/**
 * agent-task-cli.js — small CLI for the worker cron to talk to the HQ
 * agent_tasks table without needing to spin up the HTTP API.
 *
 * Subcommands:
 *   claim                         Claim the next queued/requeued task.
 *                                  Prints the task as JSON on stdout, or
 *                                  nothing when the queue is empty.
 *   list                          List tasks (status=all default).
 *   show <id>                     Show one task full detail.
 *   finish <id>                   Mark a running task as done/review/blocked/failed.
 *     --status=<s>                required
 *     --summary=<text>            result_summary
 *     --evidence=<path>           evidence_path
 *     --checklist=<json>          JSON array of { req, pass, note }
 *     --error=<text>              last_error
 *     --run-id=<id>               worker_run_id
 *
 *   heartbeat <id>                Update last_heartbeat_at = now
 *     --progress=<0-100>           Optional: report current progress percentage.
 *     --message=<text>            Optional: short progress message (≤500 chars).
 *   stuck-requeue                 Bounce any running task whose heartbeat is
 *                                  older than the threshold back to queued.
 *
 *   mark-review <id> --checklist=<json> --summary=<text>
 *                                Convenience: finish a task with status=review.
 *   mark-blocked <id> --checklist=<json> --summary=<text> --error=<text>
 *                                Convenience: finish a task with status=blocked.
 *
 * The DB path is read from HQ_DB_PATH (env) or defaults to
 * /home/byron/projects/geekshop-hq/data/hq.db.
 */

import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  claimNextTask,
  heartbeat,
  finishTask,
  requeueStaleTasks,
  getTaskForReview,
  listTasks,
  getTask,
} from '../../lib/agent-tasks.js';

const DB_PATH = process.env.HQ_DB_PATH || '/home/byron/projects/geekshop-hq/data/hq.db';

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function parseFlags(args) {
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function printJson(obj) {
  if (obj == null) { process.stdout.write('\n'); return; }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const rest = argv.slice(1);
  const db = openDb();

  try {
    switch (sub) {
      case 'claim': {
        const task = claimNextTask(db);
        if (!task) { process.stdout.write('NO_TASK\n'); process.exit(0); }
        printJson(getTaskForReview(db, task.id));
        return;
      }
      case 'list': {
        const flags = parseFlags(rest);
        const status = flags.status || 'all';
        const limit = Math.min(Math.max(Number(flags.limit) || 50, 1), 500);
        printJson(listTasks(db, { status, limit }));
        return;
      }
      case 'show': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) fail('show: invalid id');
        const t = getTaskForReview(db, id);
        if (!t) fail('not found', 3);
        printJson(t);
        return;
      }
      case 'heartbeat': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) fail('heartbeat: invalid id');
        const flags = parseFlags(rest.slice(1));
        const hbOpts = {};
        if (flags.progress !== undefined) hbOpts.progress_pct = Number(flags.progress);
        if (flags.message !== undefined) hbOpts.progress_message = flags.message;
        heartbeat(db, id, hbOpts);
        process.stdout.write('ok\n');
        return;
      }
      case 'stuck-requeue': {
        const flags = parseFlags(rest);
        const ms = Number(flags.ms) || 10 * 60 * 1000;
        const stuck = requeueStaleTasks(db, { staleAfterMs: ms });
        printJson({ requeued: stuck });
        return;
      }
      case 'finish': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) fail('finish: invalid id');
        const flags = parseFlags(rest.slice(1));
        if (!flags.status) fail('finish: --status is required');
        let checklist = undefined;
        if (flags.checklist) {
          try { checklist = JSON.parse(flags.checklist); }
          catch { fail('finish: --checklist is not valid JSON'); }
        }
        const ok = finishTask(db, id, {
          status: flags.status,
          result_summary: flags.summary,
          evidence_path: flags.evidence,
          review_checklist: checklist,
          last_error: flags.error,
          worker_run_id: flags['run-id'],
        });
        if (!ok) fail('finish: task was not in running state', 4);
        printJson(getTaskForReview(db, id));
        return;
      }
      case 'mark-review':
      case 'mark-blocked':
      case 'mark-failed':
      case 'mark-done': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) fail(`${sub}: invalid id`);
        const flags = parseFlags(rest.slice(1));
        const status = sub === 'mark-review' ? 'review'
                     : sub === 'mark-blocked' ? 'blocked'
                     : sub === 'mark-failed' ? 'failed'
                     : 'done';
        let checklist = undefined;
        if (flags.checklist) {
          try { checklist = JSON.parse(flags.checklist); }
          catch { fail(`${sub}: --checklist is not valid JSON`); }
        }
        const ok = finishTask(db, id, {
          status,
          result_summary: flags.summary,
          evidence_path: flags.evidence,
          review_checklist: checklist,
          last_error: flags.error,
          worker_run_id: flags['run-id'],
        });
        if (!ok) fail(`${sub}: task was not in running state`, 4);
        printJson(getTaskForReview(db, id));
        return;
      }
      default:
        fail(`unknown subcommand: ${sub}\nUsage: claim | list | show <id> | finish <id> --status=... | heartbeat <id> | stuck-requeue`);
    }
  } catch (e) {
    fail(e.message);
  } finally {
    db.close();
  }
}

main();
