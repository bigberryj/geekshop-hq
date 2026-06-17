#!/usr/bin/env node
/**
 * enqueue-task.js — one-liner CLI to add a task to the agent queue.
 *
 * Usage:
 *   node scripts/agent-task-worker/enqueue-task.js "title" "prompt body" [--source=telegram] [--priority=5] [--ref=msg-id]
 *   echo "prompt body" | node scripts/agent-task-worker/enqueue-task.js "title" --source=telegram
 *
 * Used by:
 *   - The Telegram bridge (called from a gateway hook or from the chat session)
 *   - The HQ UI indirectly (the UI calls the API)
 *   - Ad-hoc: "queue a quick task from the terminal"
 *
 * The CLI writes the row directly to the HQ DB so it works even when the
 * API server is down. Returns the new task as JSON on stdout.
 */

import Database from 'better-sqlite3';
import { createTask } from '../../lib/agent-tasks.js';

const DB_PATH = process.env.HQ_DB_PATH || '/home/byron/projects/geekshop-hq/data/hq.db';

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

async function readStdinIfPiped() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve(null);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (positional.length < 1) fail('usage: enqueue-task <title> [prompt] [--source=...] [--priority=...] [--ref=...]');
  const title = positional[0];
  let prompt = positional.slice(1).join(' ');
  if (!prompt) {
    const stdinData = await readStdinIfPiped();
    if (stdinData) prompt = stdinData.trim();
  }
  if (!prompt) fail('prompt is required (as arg or via stdin)');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    const task = createTask(db, {
      title,
      prompt,
      source: flags.source || 'hq_ui',
      source_ref: flags.ref || null,
      priority: Number.isFinite(Number(flags.priority)) ? Number(flags.priority) : 0,
    });
    process.stdout.write(JSON.stringify({
      id: task.id,
      uid: task.uid,
      status: task.status,
      title: task.title,
      source: task.source,
      source_ref: task.source_ref,
      priority: task.priority,
    }, null, 2) + '\n');
  } catch (e) {
    fail(e.message);
  } finally {
    db.close();
  }
}

main();
