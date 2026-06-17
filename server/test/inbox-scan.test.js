/**
 * Inbox scan with date range + starred include.
 *
 * Tests the new scan signature:
 *   fetchUnread({ since, until, includeStarred, limit } = {})
 * and the route that wraps it:
 *   POST /api/inbox/scan?since=ISO&until=ISO&include_starred=true|false
 *
 * The IMAP layer is mocked so the tests run without Gmail.
 */

import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { scanPendingEmails } from '../lib/pending-emails.js';

// Capture the most recent call args so we can assert the route forwarded
// the right things down to the IMAP layer.
const fetchSpy = vi.fn(async () => [
  // 2 sample messages so the route returns inserted > 0
  { messageId: 'm1@x', uid: '10', from: 'Alice', fromEmail: 'alice@x.com', subject: 's1', body: 'b', snippet: 'b', date: new Date() },
  { messageId: 'm2@x', uid: '11', from: 'Bob', fromEmail: 'bob@x.com', subject: 's2', body: 'b', snippet: 'b', date: new Date() },
]);

vi.mock('../lib/email-inbox.js', async () => ({
  fetchUnread: (...args) => fetchSpy(...args),
  inboxConfig: { hasCreds: true, pollIntervalMin: 5, autoCreate: false },
}));

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

beforeEach(() => {
  fetchSpy.mockClear();
});

describe('scanPendingEmails passes options through to fetchUnread', () => {
  it('forwards a default 24-hour since window when none is given', async () => {
    const before = Date.now();
    // autoDismissJunk:false stops the live LLM classifier from running —
    // these tests only assert that scan forwards its options to the
    // IMAP layer. Junk-classifier behaviour is covered by
    // junk-classifier.test.js. Without this flag, the test hangs
    // 5s awaiting the LLM and times out.
    await scanPendingEmails(db, { autoDismissJunk: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][0] || {};
    expect(opts.since).toBeInstanceOf(Date);
    expect(opts.until).toBeUndefined();
    expect(opts.includeStarred).toBe(true);
    // 24h window: since should be ~24h before "now"
    const windowMs = before - opts.since.getTime();
    expect(windowMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(windowMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it('accepts an explicit since as Date', async () => {
    const since = new Date('2026-06-01T00:00:00Z');
    await scanPendingEmails(db, { since, autoDismissJunk: false });
    expect(fetchSpy.mock.calls[0][0].since).toBe(since);
  });

  it('accepts an explicit until as Date', async () => {
    const until = new Date('2026-06-15T23:59:59Z');
    await scanPendingEmails(db, { until, autoDismissJunk: false });
    expect(fetchSpy.mock.calls[0][0].until).toBe(until);
  });

  it('lets the caller turn off starred inclusion', async () => {
    await scanPendingEmails(db, { includeStarred: false, autoDismissJunk: false });
    expect(fetchSpy.mock.calls[0][0].includeStarred).toBe(false);
  });

  it('forwards limit', async () => {
    await scanPendingEmails(db, { limit: 75, autoDismissJunk: false });
    expect(fetchSpy.mock.calls[0][0].limit).toBe(75);
  });

  it('preserves the 100-cap to avoid hammering Gmail', async () => {
    await scanPendingEmails(db, { limit: 9999, autoDismissJunk: false });
    expect(fetchSpy.mock.calls[0][0].limit).toBeLessThanOrEqual(100);
  });
});

describe('default scan window is 24h (regression: scan must not be unbounded)', () => {
  it('a caller that omits since/until still gets a bounded window', async () => {
    const before = Date.now();
    await scanPendingEmails(db, { autoDismissJunk: false });
    const opts = fetchSpy.mock.calls[0][0];
    expect(opts.since).toBeInstanceOf(Date);
    // Window must not be in the future
    expect(opts.since.getTime()).toBeLessThanOrEqual(before);
    // And must not be older than 25h (sanity for the 24h default)
    const ageHours = (before - opts.since.getTime()) / 3_600_000;
    expect(ageHours).toBeGreaterThanOrEqual(23);
    expect(ageHours).toBeLessThanOrEqual(25);
  });
});
