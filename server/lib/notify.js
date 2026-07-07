#!/usr/bin/env node
/**
 * notify.js — terminal task notifications.
 *
 * When an agent_tasks row transitions to a terminal or near-terminal state
 * (done, failed, cancelled, review), HQ emails Byron a short summary with
 * links to the project, any documentation the worker called out, and the
 * evidence path. Email is best-effort: a failure here does NOT block the
 * status transition. Errors are logged to console so systemd journal
 * captures them.
 *
 * Recipient comes from HQ_NOTIFY_TO env var (defaults to BYRON_GMAIL_USER).
 * SMTP credentials are the existing ones in server/.env (SMTP_HOST/PORT/USER/PASS/FROM).
 *
 * The email body intentionally does not include the full result_summary or
 * review_checklist verbatim — those can be 4KB+. We excerpt the first
 * ~500 chars and append a deep link to the Mission Control task page so
 * Byron can read the rest in the UI.
 */

import { sendEmail } from './email.js';
import { sendAgentMessageWithButtons } from './agents.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const NEAR_TERMINAL_STATUSES = new Set(['review']);
const NOTIFY_STATUSES = new Set([...TERMINAL_STATUSES, ...NEAR_TERMINAL_STATUSES]);

function excerpt(text, max = 500) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + '\n…[truncated, see HQ for full text]';
}

function buildSubject(task) {
  // [J5][STATUS] #id title  — short, scannable in inbox
  const t = (task.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 80);
  return `[J5][${task.status.toUpperCase()}] #${task.id} ${t}`;
}

function buildBody(task, { appUrl }) {
  const lines = [];
  lines.push(`Mission Control task update`);
  lines.push(`========================`);
  lines.push(``);
  lines.push(`Title:    ${task.title || '(untitled)'}`);
  lines.push(`Status:   ${task.status}${task.decision ? ` (decision: ${task.decision}${task.decided_by ? ` by ${task.decided_by}` : ''})` : ''}`);
  lines.push(`UID:      ${task.uid}`);
  lines.push(`Source:   ${task.source}${task.source_ref ? ` (ref=${task.source_ref})` : ''}`);
  lines.push(`Priority: ${task.priority}`);
  lines.push(`Attempts: ${task.attempts}/${task.max_attempts}`);
  if (task.started_at) lines.push(`Started:  ${task.started_at}`);
  if (task.finished_at) lines.push(`Finished: ${task.finished_at}`);
  if (task.evidence_path) lines.push(`Evidence: ${task.evidence_path}`);
  lines.push(``);

  if (task.result_summary) {
    lines.push(`Worker summary:`);
    lines.push(excerpt(task.result_summary, 800));
    lines.push(``);
  }
  if (task.last_error) {
    lines.push(`Last error:`);
    lines.push(excerpt(task.last_error, 500));
    lines.push(``);
  }
  if (task.decision_note) {
    lines.push(`Decision note: ${task.decision_note}`);
    lines.push(``);
  }

  if (appUrl) {
    lines.push(`View in Mission Control: ${appUrl}/mission-control`);
    lines.push(`(Open the task to see full summary, review checklist, and evidence.)`);
  }
  return lines.join('\n');
}

/**
 * Send a notification for a task that just transitioned. Caller is responsible
 * for invoking this AFTER the DB transaction commits. Failures are logged
 * but never thrown.
 *
 * @param {object} task — the full task row (post-transition).
 * @param {object} [opts]
 * @param {string} [opts.appUrl] — base URL for Mission Control deep links.
 *                                  Defaults to APP_URL env var or "http://localhost:5050".
 * @returns {Promise<{sent: boolean, reason?: string, error?: string, message_id?: string}>}
 */
export async function notifyTaskTerminal(task, opts = {}) {
  if (!task || !NOTIFY_STATUSES.has(task.status)) {
    return { sent: false, reason: 'non_notifiable_status' };
  }
  const to = process.env.HQ_NOTIFY_TO || process.env.BYRON_GMAIL_USER;
  if (!to) {
    console.warn(`[notify] no recipient (set HQ_NOTIFY_TO or BYRON_GMAIL_USER); skipped task #${task.id}`);
    return { sent: false, reason: 'no_recipient' };
  }
  const appUrl = opts.appUrl || process.env.APP_URL || 'http://localhost:5050';
  const subject = buildSubject(task);
  const text = buildBody(task, { appUrl });
  try {
    const result = await sendEmail({ to, subject, text });
    if (result.sent) {
      console.log(`[notify] task #${task.id} (${task.status}) emailed to ${to} (msg=${result.message_id})`);
    } else {
      console.warn(`[notify] task #${task.id} NOT emailed (${result.reason}${result.error ? `: ${result.error}` : ''})`);
    }
    return result;
  } catch (err) {
    console.error(`[notify] task #${task.id} crashed: ${err.message}`);
    return { sent: false, reason: 'exception', error: err.message };
  }
}

/**
 * Send a Telegram notification with inline buttons for task approval.
 * This is used when a task transitions to 'review' status and needs human approval.
 *
 * @param {object} task — the full task row (post-transition).
 * @param {object} [opts]
 * @param {string} [opts.appUrl] — base URL for Mission Control deep links.
 * @returns {Promise<{sent: boolean, reason?: string, error?: string, message_id?: string}>}
 */
export async function notifyTaskForApproval(task, opts = {}) {
  // Only send Telegram notifications for tasks that need approval (review status)
  if (!task || task.status !== 'review') {
    return { sent: false, reason: 'not_review_status' };
  }

  const appUrl = opts.appUrl || process.env.APP_URL || 'http://localhost:5050';

  // Build the message text
  const lines = [];
  lines.push(`[J5][REVIEW] ${task.uid}`);
  lines.push(`Title: ${task.title || '(untitled)'}`);
  lines.push(`Source: ${task.source}${task.source_ref ? ` (ref=${task.source_ref})` : ''}`);
  if (task.result_summary) {
    lines.push(`Summary: ${excerpt(task.result_summary, 300)}`);
  }

  const text = lines.join('\n');

  // Create inline buttons for approval actions
  const buttons = [
    [
      { text: '✅ Approve', callback_data: `action=approve&id=${task.id}&token=${task.uid}` },
      { text: '🔄 Requeue', callback_data: `action=requeue&id=${task.id}&token=${task.uid}` },
      { text: '❌ Cancel', callback_data: `action=cancel&id=${task.id}&token=${task.uid}` }
    ]
  ];

  try {
    // Send to the default agent (Telegram bot)
    const result = await sendAgentMessageWithButtons('default', text, buttons);
    if (result.ok) {
      console.log(`[notify] task #${task.id} sent to Telegram for approval (msg=${result.message_id})`);
    } else {
      console.warn(`[notify] task #${task.id} NOT sent to Telegram (${result.error})`);
    }
    return result;
  } catch (err) {
    console.error(`[notify] task #${task.id} Telegram notification crashed: ${err.message}`);
    return { sent: false, reason: 'exception', error: err.message };
  }
}
