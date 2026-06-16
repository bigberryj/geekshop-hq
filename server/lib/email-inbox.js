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
 * Fetch recent unread + (optionally) starred messages within a date window.
 * Returns [{ messageId, from, fromEmail, subject, date, body, snippet, uid, flagged }]
 *
 * Options:
 *   - since:     Date   earliest message date to include. Default = now - 24h.
 *   - until:     Date   latest message date to include. Default = no upper bound.
 *   - includeStarred: boolean  if true, also pull \Flagged (Gmail "starred")
 *                      messages, even if read. Default true for the manual scan.
 *   - limit:     number max messages to fetch. Hard cap 100.
 */
export async function fetchUnread({
  since,
  until,
  includeStarred = true,
  limit = 25,
} = {}) {
  if (!(since instanceof Date)) since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  // IMAP SINCE / BEFORE search keys take a JS Date.
  // "Recent first" ordering: we don't trust the server's sort so we sort
  // ourselves by internalDate after fetch.
  return withClient(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Two search keys:
      //   1) unread within window  (always)
      //   2) starred within window (if includeStarred)
      // We OR them at the IMAP level so the server filters before we fetch
      // bodies, which is the difference between ~50ms and a multi-second
      // body fetch on a big mailbox.
      const searchKey = { since, ...(until ? { before: until } : {}), or: true };
      const searches = [{ ...searchKey, unseen: true }];
      if (includeStarred) searches.push({ ...searchKey, flagged: true });

      // Collect sequence numbers across both searches, deduped.
      const seqSet = new Set();
      for (const k of searches) {
        const s = await client.search(k);
        for (const n of s) seqSet.add(n);
      }
      const allSeqs = [...seqSet];
      if (!allSeqs.length) return [];
      // Most recent first: sort by sequence number descending (highest = newest).
      allSeqs.sort((a, b) => b - a);
      const recent = allSeqs.slice(0, cappedLimit);
      const range = recent.length === 1
        ? String(recent[0])
        : `${recent[0]}:${recent[recent.length - 1]}`;
      console.log('[inbox] fetchUnread: seqs', recent.length, 'range', range, 'since', since.toISOString());
      // Fetch metadata-only first (envelope, flags) to filter cheaply, then
      // pull bodies in parallel only for messages that survive the date
      // filter. This avoids paying the body-transfer cost for 100 large
      // messages when the user only needs a handful within the window.
      const metaOpts = { envelope: true, flags: true, internalDate: true, uid: true };
      const candidates = [];
      for await (const msg of client.fetch(range, metaOpts)) {
        const d = msg.internalDate || new Date(msg.envelope?.date || 0);
        if (d.getTime() < since.getTime() - 1000) continue;
        if (until && d.getTime() > until.getTime() + 1000) continue;
        const envFrom = msg.envelope?.from?.[0];
        candidates.push({
          uid: msg.uid,
          seq: msg.seq,
          internalDate: d,
          flagged: !!(msg.flags && msg.flags.has('\\Flagged')),
          // Capture envelope metadata so bodyless rows still render properly
          fromName: envFrom?.name || null,
          fromEmail: envFrom?.address || null,
          subject: msg.envelope?.subject || null,
        });
      }
      // Now fetch bodies — but only for the most recent 25, since the
      // snippet we extract is what's shown in the queue UI and the
      // full body is only needed at import time. Older entries get
      // envelope-only metadata. IMAP fetch on a single connection is
      // serial anyway, so this is the same as parallel but clearer.
      const BODY_FETCH_LIMIT = 25;
      const out = [];
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        let parsed = null;
        if (i < BODY_FETCH_LIMIT) {
          try {
            const seqRange = String(cand.seq);
            for await (const m of client.fetch(seqRange, { source: true, uid: true })) {
              parsed = await simpleParser(m.source);
              break;
            }
          } catch (e) {
            console.warn('[inbox] body fetch failed for uid', cand.uid, e.message);
          }
        }
        const from = parsed?.from?.value?.[0] || (cand.fromEmail ? { name: cand.fromName, address: cand.fromEmail } : null);
        const subject = parsed?.subject || cand.subject || '(no subject)';
        const text = parsed?.text || parsed?.html || '';
        out.push({
          uid: cand.uid,
          messageId: parsed?.messageId || String(cand.uid),
          from: from?.name || from?.address || cand.fromName || cand.fromEmail || '(unknown)',
          fromEmail: from?.address || cand.fromEmail || '',
          subject,
          date: parsed?.date || cand.internalDate,
          body: text,
          snippet: text ? text.slice(0, 200).replace(/\s+/g, ' ').trim() : (subject || '').slice(0, 200),
          flagged: cand.flagged,
        });
      }
      // Sort by date descending — Gmail's seq order can be off for threads.
      out.sort((a, b) => (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0));
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
  // Track the last successful poll timestamp so the background poller
  // never re-pulls old starred mail. Manual scans are still allowed to
  // override the window via the API.
  let lastPollAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // The poller is constrained to "since last successful poll" to avoid
      // re-fetching the same starred messages every 5 minutes. This is a
      // tighter window than the manual scan's 24h default.
      const since = lastPollAt;
      const msgs = await fetchUnread({ since, includeStarred: true, limit: 50 });
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
      lastPollAt = new Date();
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
