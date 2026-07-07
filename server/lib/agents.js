#!/usr/bin/env node
/**
 * agents.js — roster of Hermes-related processes and profiles for
 * Geekshop HQ Mission Control.
 *
 * Three categories:
 *   - gateway:  long-running `hermes gateway run` process per profile.
 *               Each has a Telegram bot (if configured) and is addressable
 *               from Mission Control via the chat panel.
 *   - profile:  static specialist configuration (coder, scout, glm51, …).
 *               Not running; used on-demand by Johnny5 via the
 *               specialist-routing skill. Not addressable.
 *   - cron:     background worker that claims tasks on a tick. The HQ
 *               worker cron lives at server/scripts/agent-task-worker/.
 *               Not addressable; its activity is the "Live" feed.
 *
 * We probe liveness with `pgrep` and `ps` (read-only), so this never
 * mutates anything. The route layer is responsible for any side-effect
 * (sending a Telegram message, claiming a task, etc.).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read a profile's config.yaml without importing the hermes CLI. Used
 * to surface model + provider + display name for the roster.
 */
async function readProfileConfig(homeDir, profileName) {
  // Hermes stores config at $HOME/.hermes/. The "default" profile is
  // the root config.yaml, not a subdir; specialist profiles live under
  // $HOME/.hermes/profiles/<name>/config.yaml.
  // We only need model.provider/default/api_mode, so avoid adding a YAML
  // dependency to HQ for this tiny read-only probe.
  const baseDir = path.join(homeDir, '.hermes');
  const candidates = profileName === 'default'
    ? [path.join(baseDir, 'config.yaml')]
    : [path.join(baseDir, 'profiles', profileName, 'config.yaml')];
  for (const filePath of candidates) {
    try {
      const text = await readFile(filePath, 'utf8');
      const model = {};
      let inModel = false;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '');
        if (!line.trim()) continue;
        if (/^model:\s*$/.test(line)) { inModel = true; continue; }
        if (inModel && /^\S/.test(line)) break;
        if (!inModel) continue;
        const m = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!m) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        model[m[1]] = value;
      }
      return { model };
    } catch { /* try next */ }
  }
  return {};
}

async function readHermesEnv(homeDir, profileName = 'default') {
  const baseDir = path.join(homeDir, '.hermes');
  const filePath = profileName === 'default'
    ? path.join(baseDir, '.env')
    : path.join(baseDir, 'profiles', profileName, '.env');
  try {
    const text = await readFile(filePath, 'utf8');
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getTelegramConfig(agentId, env = process.env) {
  const homeDir = env.HOME || '/home/byron';
  const upper = agentId.toUpperCase();
  const profileEnv = await readHermesEnv(homeDir, agentId);
  const rootEnv = agentId === 'default' ? profileEnv : await readHermesEnv(homeDir, 'default');
  const token = env[`TELEGRAM_BOT_TOKEN_${upper}`]
    || env.TELEGRAM_BOT_TOKEN
    || profileEnv.TELEGRAM_BOT_TOKEN
    || rootEnv.TELEGRAM_BOT_TOKEN;
  const chatId = env[`TELEGRAM_CHAT_ID_${upper}`]
    || env.TELEGRAM_CHAT_ID
    || env[`TELEGRAM_HOME_CHANNEL_${upper}`]
    || env.TELEGRAM_HOME_CHANNEL
    || profileEnv.TELEGRAM_CHAT_ID
    || profileEnv.TELEGRAM_HOME_CHANNEL
    || rootEnv.TELEGRAM_CHAT_ID
    || rootEnv.TELEGRAM_HOME_CHANNEL;
  const threadId = env[`TELEGRAM_THREAD_ID_${upper}`]
    || env.TELEGRAM_THREAD_ID
    || env[`TELEGRAM_HOME_CHANNEL_THREAD_ID_${upper}`]
    || env.TELEGRAM_HOME_CHANNEL_THREAD_ID
    || profileEnv.TELEGRAM_THREAD_ID
    || profileEnv.TELEGRAM_HOME_CHANNEL_THREAD_ID
    || rootEnv.TELEGRAM_THREAD_ID
    || rootEnv.TELEGRAM_HOME_CHANNEL_THREAD_ID;
  return { token, chatId, threadId };
}

/**
 * Probe running hermes gateway processes. Returns an array of
 *   { pid, profile, started_at, etime, cmdline }
 * one per live gateway. profile is null for the default gateway.
 */
export async function listLiveGateways() {
  // Match `hermes_cli.main gateway run` (with or without --profile).
  const out = [];
  try {
    const { stdout } = await pexec('pgrep', ['-af', 'hermes_cli.main.*gateway run']);
    for (const line of stdout.split('\n').filter(Boolean)) {
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdline = m[2];
      const profileMatch = cmdline.match(/--profile\s+(\S+)/);
      const profile = profileMatch ? profileMatch[1] : 'default';
      // Get etime via ps. Format: [[DD-]HH:]MM:SS
      let etime = '';
      let startedAt = null;
      try {
        const { stdout: psLine } = await pexec('ps', ['-o', 'etime=,lstart=', '-p', String(pid)]);
        const [e, lstart] = psLine.trim().split(/\s{2,}/);
        etime = e || '';
        if (lstart) {
          // ps lstart is "Tue Jun 17 21:30:00 2026"
          const d = new Date(lstart);
          if (!isNaN(d.getTime())) startedAt = d.toISOString();
        }
      } catch { /* ignore */ }
      out.push({ pid, profile, started_at: startedAt, etime, cmdline });
    }
  } catch { /* pgrep returns 1 when no match */ }
  return out;
}

/**
 * Probe the HQ worker cron. The cron itself isn't a single process; it's
 * triggered by the systemd-runner or by the worker-cron.js script. We
 * check whether the agent-task-cli.js is reachable + when the last
 * agent_tasks heartbeat was seen, as a proxy for "active recently".
 */
export async function listLiveWorkers(db) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  let lastClaim = null;
  let lastHeartbeat = null;
  let activeTasks = 0;
  let reviewQueue = 0;
  let queuedTasks = 0;
  try {
    // "Active" = anything in flight: queued + running + review.
    // Heartbeat timestamp is the strongest liveness signal — it moves
    // forward as long as a worker is actually doing work.
    const row = db.prepare(`
      SELECT MAX(started_at)          AS last_claim,
             MAX(last_heartbeat_at)   AS last_heartbeat
        FROM agent_tasks
       WHERE status IN ('queued', 'running', 'review')
    `).get();
    lastClaim = row?.last_claim || null;
    lastHeartbeat = row?.last_heartbeat || null;
    const r = db.prepare(`SELECT
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'review'  THEN 1 ELSE 0 END) AS review,
       SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) AS queued
       FROM agent_tasks`).get();
    activeTasks = r?.running || 0;
    reviewQueue = r?.review || 0;
    queuedTasks = r?.queued || 0;
  } catch { /* db not ready yet */ }
  return {
    last_claim_at: lastClaim,
    last_heartbeat_at: lastHeartbeat,
    active_tasks: activeTasks,
    review_queue: reviewQueue,
    queued_tasks: queuedTasks,
    healthy: lastHeartbeat ? lastHeartbeat > oneHourAgo : false,
  };
}

/**
 * Build the full agent roster. Two addressability classes:
 *   - addressable: true for gateways with a Telegram bot configured.
 *   - profiles:    always false. They're configurations, not agents.
 */
export async function getRoster(db, env = process.env) {
  const homeDir = process.env.HOME || '/root';
  const live = await listLiveGateways();
  const liveByProfile = new Map(live.map(g => [g.profile, g]));
  const workers = await listLiveWorkers(db);

  // Static profile list — same names as `hermes profile list` shows.
  // We read each profile's config to surface model + provider.
  const PROFILE_NAMES = [
    'default', 'minimax', 'coder', 'scout', 'glm51', 'qwen35',
    'reasoner', 'reviewer',
  ];
  const profiles = await Promise.all(PROFILE_NAMES.map(async (name) => {
    const cfg = await readProfileConfig(homeDir, name);
    const live = liveByProfile.get(name);
    const isGateway = !!live;
    // YAML structure: model.{provider, default (model id), api_mode}
    const model = cfg?.model?.default || cfg?.default_model || cfg?.model?.name || 'unknown';
    const provider = cfg?.model?.provider || 'unknown';
    const apiMode = cfg?.model?.api_mode || null;
    const telegramHandle = env[`TELEGRAM_BOT_HANDLE_${name.toUpperCase()}`]
      || env.TELEGRAM_BOT_HANDLE_DEFAULT && name === 'default' ? env.TELEGRAM_BOT_HANDLE_DEFAULT
      : name === 'default' ? '@john5wizbot'
      : name === 'minimax' ? '@john5minimaxbot'
      : null;
    return {
      id: name,
      kind: isGateway ? 'gateway' : 'profile',
      display_name: name,
      model,
      provider,
      api_mode: apiMode,
      addressable: isGateway && !!telegramHandle,
      telegram_handle: telegramHandle,
      live: !!live,
      pid: live?.pid || null,
      started_at: live?.started_at || null,
      etime: live?.etime || null,
      last_activity_at: live?.started_at || null,
    };
  }));

  return {
    generated_at: new Date().toISOString(),
    gateways: profiles.filter(p => p.kind === 'gateway'),
    profiles: profiles.filter(p => p.kind === 'profile'),
    worker_cron: workers,
  };
}

/**\n * Send a message to a gateway's Telegram bot. Requires the bot token in env.\n * Returns { ok, message_id, chat_id } or { ok: false, error }.\n *\n * Currently delegates to the Telegram Bot API directly. Future versions\n * could route through the hermes gateway's sendMessage tool.\n */
export async function sendAgentMessage(agentId, text, opts = {}, env = process.env) {
  const handle = agentId === 'default' ? '@john5wizbot' : agentId === 'minimax' ? '@john5minimaxbot' : null;
  if (!handle) return { ok: false, error: `agent ${agentId} has no Telegram handle` };
  const { token, chatId, threadId } = await getTelegramConfig(agentId, env);
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured (checked HQ env + Hermes env files)' };
  if (!chatId) return { ok: false, error: 'TELEGRAM_CHAT_ID/TELEGRAM_HOME_CHANNEL not configured (checked HQ env + Hermes env files)' };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const payload = {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      text,
      parse_mode: 'HTML',
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'Telegram API error' };
    return {
      ok: true,
      message_id: data.result?.message_id,
      chat_id: data.result?.chat?.id,
      sent_at: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Send a message with inline buttons for task approval.
 *
 * @param {string} agentId - The agent ID (default, minimax, etc.)
 * @param {string} text - The message text
 * @param {Array} buttons - Array of button objects with text and callback_data
 * @param {object} env - Environment variables
 * @returns {Promise<object>} - Result of the send operation
 */
export async function sendAgentMessageWithButtons(agentId, text, buttons, env = process.env) {
  const reply_markup = {
    inline_keyboard: buttons.map(row =>
      Array.isArray(row) ? row : [row]
    )
  };

  return sendAgentMessage(agentId, text, { reply_markup }, env);
}
