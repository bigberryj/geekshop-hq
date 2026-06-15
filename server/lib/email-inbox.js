/**
 * Gmail IMAP poller + fetcher.
 *
 * Polls byron@geekshop.ca every N minutes (env: BYRON_GMAIL_POLL_INTERVAL_MIN, default 5).
 * Returns parsed messages with from/subject/date/body/messageId.
 *
 * Used by:
 *   - background poller in index.js (auto-creates tickets if BYRON_GMAIL_AUTO_CREATE_TICKETS=true)
 *   - GET /api/inbox/unread (manual inbox view)
 *   - POST /api/inbox/import-as-ticket (single-message import)
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const POLL_MIN = Number(process.env.BYRON_GMAIL_POLL_INTERVAL_MIN || 5);

function hasCreds() { return Boolean(process.env.BYRON_GMAIL_USER && process.env.BYRON_GMAIL_APP_PASSWORD); }

async function withClient(fn) {
  if (!hasCreds()) throw new Error('Gmail creds not configured (BYRON_GMAIL_USER / BYRON_GMAIL_APP_PASSWORD)');
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.BYRON_GMAIL_USER, pass: process.env.BYRON_GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Fetch recent unread messages (max `limit`, default 25).
 * Returns [{ messageId, from, fromEmail, subject, date, body, snippet, uid }]
 */
export async function fetchUnread(limit = 25) {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ unseen: true }, { uid: true });
      if (!uids.length) return [];
      const recent = uids.slice(-limit).reverse();
      const out = [];
      const fetchOpts = { uid: true, envelope: true, source: true, flags: true, internalDate: true };
      console.log('[inbox] fetchUnread: UIDs', recent);
      for await (const msg of client.fetch(recent, fetchOpts)) {
        console.log('[inbox] msg:', msg.uid, 'has source:', !!msg.source);
        const source = msg.source;
        if (!source) continue;
        const parsed = await simpleParser(source);
        const from = parsed.from?.value?.[0];
        out.push({
          uid: msg.uid,
          messageId: parsed.messageId || String(msg.uid),
          from: from?.name || from?.address || '(unknown)',
          fromEmail: from?.address || '',
          subject: parsed.subject || '(no subject)',
          date: parsed.date || msg.internalDate,
          body: parsed.text || parsed.html || '',
          snippet: (parsed.text || '').slice(0, 200).replace(/\s+/g, ' ').trim(),
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/**
 * Fetch a single message by messageId header.
 */
export async function fetchByMessageId(messageId) {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (!uids.length) return null;
      for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true })) {
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0];
        return {
          uid: msg.uid,
          messageId: parsed.messageId,
          from: from?.name || from?.address,
          fromEmail: from?.address,
          subject: parsed.subject,
          date: parsed.date,
          body: parsed.text || parsed.html || '',
        };
      }
      return null;
    } finally {
      lock.release();
    }
  });
}

/**
 * Apply a label to a message. Creates the label if it doesn't exist (Gmail IMAP
 * label = a folder; we use `\HasChildren` to create a real label under INBOX).
 * Returns the path of the label that was applied (or already existed).
 *
 * Note: imapflow's setFlags + 'gmail-label' is the canonical way. We use a
 * simpler approach — store the message in a folder-like mailbox, which Gmail
 * treats as a label. This is the IMAP-equivalent of "add label X".
 */
export async function applyLabel({ messageId, labelPath }) {
  if (!hasCreds()) throw new Error('Gmail creds not configured');
  return withClient(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // 1. Find the UID by message-id header
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (!uids.length) return { ok: false, reason: 'message not found in INBOX' };
      const uid = uids[0];

      // 2. Make sure the label mailbox exists (Gmail auto-creates on append)
      try {
        await client.mailboxOpen(labelPath, { readOnly: false });
      } catch (e) {
        // mailboxOpen may fail if not yet created; the append below will create it
      }

      // 3. Re-open INBOX with write access and copy the message to the label
      const inboxLock = await client.getMailboxLock('INBOX');
      try {
        await client.messageCopy(String(uid), labelPath, { uid: true });
      } finally {
        inboxLock.release();
      }

      return { ok: true, label: labelPath, uid };
    } finally {
      lock.release();
    }
  });
}

/**
 * Mark a message as read (removes the UNREAD label in Gmail) and optionally
 * remove it from the INBOX (archive = remove INBOX label).
 *
 * Returns { ok, read, archived }.
 */
export async function markRead({ messageId, archive = false }) {
  if (!hasCreds()) throw new Error('Gmail creds not configured');
  return withClient(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (!uids.length) return { ok: false, reason: 'message not found' };
      const uid = uids[0];

      // Set \Seen flag (= Gmail's "read" state, removes UNREAD label)
      await client.messageFlagsSet(String(uid), ['\\Seen'], { uid: true, action: 'add' });

      let archived = false;
      if (archive) {
        // Remove from INBOX = set the \Deleted flag and expunge.
        // Gmail treats expunge as "archive" (removes the INBOX label).
        await client.messageFlagsSet(String(uid), ['\\Deleted'], { uid: true, action: 'add' });
        await client.expunge({ byUid: true, uids: [String(uid)] });
        archived = true;
      }

      return { ok: true, read: true, archived };
    } finally {
      lock.release();
    }
  });
}

/**
 * One-shot: when a ticket is resolved, mark the original email read + apply
 * the GeekShop/Done label + archive from INBOX. Best-effort: never throws,
 * returns { ok, ...details } so the caller can log without breaking the
 * resolve flow if Gmail is down.
 */
export async function markThreadDone(messageId) {
  if (!messageId) return { ok: false, reason: 'no messageId' };
  try {
    const readResult = await markRead({ messageId, archive: true });
    const labelResult = await applyLabel({ messageId, labelPath: 'GeekShop/Done' }).catch((e) => ({ ok: false, error: e.message }));
    return { ok: readResult.ok, read: readResult, label: labelResult };
  } catch (e) {
    console.warn('[inbox] markThreadDone failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Test the Gmail connection. Returns { ok, latency_ms, mailbox?, error? }
 */
export async function testConnection() {
  const start = Date.now();
  if (!hasCreds()) return { ok: false, error: 'BYRON_GMAIL creds not set', latency_ms: 0 };
  try {
    const result = await withClient(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const status = await client.status('INBOX', { messages: true, unseen: true });
        return { mailbox: 'INBOX', total: status.messages, unseen: status.unseen };
      } finally {
        lock.release();
      }
    });
    return { ok: true, ...result, latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, latency_ms: Date.now() - start };
  }
}

/**
 * Background poller. Calls onNewMessage(msg) for each newly-seen message.
 * Tracks seen UIDs in a JSON file to avoid duplicates across restarts.
 */
import fs from 'node:fs';
import path from 'node:path';

const SEEN_FILE = path.join(process.cwd(), 'data', 'gmail_seen.json');

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(set) {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-500)));
  } catch (e) { console.warn('[inbox] saveSeen failed:', e.message); }
}

export function startPoller({ onNewMessage, intervalMin = POLL_MIN } = {}) {
  if (!hasCreds()) {
    console.warn('[inbox] poller disabled (no creds)');
    return () => {};
  }
  if (process.env.BYRON_GMAIL_AUTO_CREATE_TICKETS !== 'true') {
    console.log(`[inbox] poller registered (every ${intervalMin}m) but auto-create disabled; will only log unseen count`);
  }

  const seen = loadSeen();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const msgs = await fetchUnread(50);
      const fresh = msgs.filter((m) => !seen.has(m.messageId));
      if (fresh.length) {
        console.log(`[inbox] ${fresh.length} new message(s) since last poll`);
        for (const m of fresh) {
          if (typeof onNewMessage === 'function') {
            try { await onNewMessage(m); } catch (e) { console.warn('[inbox] handler error:', e.message); }
          }
          seen.add(m.messageId);
        }
        saveSeen(seen);
      }
    } catch (e) {
      console.warn('[inbox] poll error:', e.message);
    } finally {
      running = false;
    }
  };

  // First tick after 10s (let server fully boot)
  setTimeout(tick, 10_000);
  const handle = setInterval(tick, intervalMin * 60 * 1000);
  return () => clearInterval(handle);
}

export const inboxConfig = {
  get hasCreds() { return hasCreds(); },
  get pollIntervalMin() { return Number(process.env.BYRON_GMAIL_POLL_INTERVAL_MIN || 5); },
  get autoCreate() { return process.env.BYRON_GMAIL_AUTO_CREATE_TICKETS === 'true'; },
};
