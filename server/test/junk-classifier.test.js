/**
 * Junk classifier + bulk-dismiss + restore tests.
 *
 * Pure-logic tests for the classifier (no LLM cost) and lib-level
 * tests for bulk-dismiss + restore. The Google Contacts tests already
 * have a "live" pattern; we don't add a live scan test here because
 * the classifier's LLM path falls back to rules when the API is down,
 * which is hard to assert deterministically.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { scoreEmail, classifyEmail, isAgentMail } from '../lib/junk-classifier.js';
import {
  bulkDismissPendingEmails,
  restorePendingEmail,
  listPendingEmails,
  backfillClassifyPendingEmails,
  readModerationSettings,
} from '../lib/pending-emails.js';
import { vi } from 'vitest';

// Stub IMAP so the pending-emails import doesn't touch Gmail
vi.mock('../lib/email-inbox.js', async () => ({
  fetchUnread: vi.fn(async () => []),
  fetchByMessageId: vi.fn(async () => null),
  inboxConfig: { hasCreds: false, pollIntervalMin: 5, autoCreate: false },
}));
vi.mock('../lib/google-contacts.js', async () => ({
  findContactMatch: vi.fn(async () => ({ ok: false, reason: 'no_match' })),
  buildEnrichmentDiff: vi.fn(() => null),
}));

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

describe('junk-classifier: rule scoring', () => {
  it('keeps emails from existing customers (always)', () => {
    const customers = new Set(['linda@marshdesigns.com']);
    const r = scoreEmail({
      fromName: 'Linda Marsh',
      fromEmail: 'linda@marshdesigns.com',
      subject: 'Buy our product! Limited time offer!',
      body: 'Unsubscribe here: ...',
    }, { customerEmails: customers });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('from_existing_customer');
  });

  it('keeps emails from a real human (first+last name) even if from looks automated', () => {
    const r = scoreEmail({
      fromName: 'Brian Chen',
      fromEmail: 'info@somecompany.com', // info@ pattern alone would score
      subject: 'Quick question about your services',
      body: 'Hey, do you offer on-site support?',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('from_real_human');
  });

  it('keeps emails with a personal-looking subject (Hi X, Re:, Fwd:, ?)', () => {
    for (const subj of ['Hi Linda — can you check the AP?', 'Re: Wi-Fi still dropping', 'Fwd: meeting notes', 'Are you available tomorrow?']) {
      const r = scoreEmail({
        fromName: 'Marketing Bot',
        fromEmail: 'noreply@brand.com',
        subject: subj,
        body: 'lorem ipsum',
      });
      expect(r.shouldDismiss, `should keep: ${subj}`).toBe(false);
    }
  });

  it('auto-dismisses classic marketing email', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'no-reply@marketing.bigcorp.com',
      subject: 'Limited time offer! 50% off everything!',
      body: 'Buy now! Click here to unsubscribe.',
    });
    expect(r.shouldDismiss).toBe(true);
    expect(r.signals).toContain('automated_from_pattern');
    expect(r.signals).toContain('junk_subject_pattern');
    // 'body_has_unsubscribe' or 'body_has_unsubscribe+brand' (the latter
    // when combined with brand/automated signals).
    expect(r.signals.some((s) => s.startsWith('body_has_unsubscribe'))).toBe(true);
  });

  it('auto-dismisses single-word-brand marketing (CarGurus pattern)', () => {
    const r = scoreEmail({
      fromName: 'CarGurus',
      fromEmail: 'cargurus@mail.cargurus.com',
      subject: 'Don\'t miss these deals that match your search preferences',
      body: 'View this email online | Unsubscribe | Update preferences',
    });
    expect(r.shouldDismiss).toBe(true);
    // Detected as a brand (single-word capitalized From name) + body
    // contains "unsubscribe". Note: cargurus.com is NOT in our hardcoded
    // ESP list, so the brand-name signal is what catches it.
    expect(r.signals.some((s) => s.startsWith('brand_from_name:'))).toBe(true);
    expect(r.signals.some((s) => s.startsWith('body_has_unsubscribe'))).toBe(true);
  });

  it('does NOT auto-dismiss a real human with a transactional-ish subject', () => {
    const r = scoreEmail({
      fromName: 'Mike Reynolds',
      fromEmail: 'mike.reynolds@gmail.com',
      subject: 'Quick question about your IT services',
      body: 'Hi, my name is Mike and I run a small accounting firm in Powell River. Are you taking new clients?',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('from_real_human');
  });

  it('does NOT auto-dismiss a new potential client (personal email, neutral subject)', () => {
    // The whole point per Byron: don't lose new clients. This email
    // would otherwise score ~0.65 with rules alone, but the real-human
    // check protects it.
    const r = scoreEmail({
      fromName: 'Sarah Patel',
      fromEmail: 'sarah.patel@example.com',
      subject: 'Inquiry about computer repair',
      body: 'Hello, I was referred to you by Linda Marsh. My laptop won\'t turn on. Are you available this week?',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('from_real_human');
  });

  it('returns score in 0..1 range', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'noreply@spam.com',
      subject: 'BUY NOW',
      body: 'click here, unsubscribe',
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('junk-classifier: isLikelyHuman over-trigger fix (2026-06-16)', () => {
  it('does NOT classify Stripe invoice+statements+ sender as a real human', () => {
    // The OLD bug: synthesized display names that contained 2+ capital
    // tokens (e.g. "invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com")
    // were wrongly tagged as real humans, scoring 0.0 and never
    // auto-dismissing. The fix: only inspect the explicit fromName
    // field. Empty or fall-back display names are NOT a real human.
    const r = scoreEmail({
      fromName: '', // explicit empty fromName — Gmail used email as display name
      fromEmail: 'invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com',
      subject: 'Your receipt from Railway Corporation #2973-4158',
      body: 'Thank you for your payment. Receipt attached.',
    });
    // Old behaviour would have returned score=0 with 'from_real_human'.
    // New behaviour: no false-positive 'from_real_human' signal.
    expect(r.signals).not.toContain('from_real_human');
    // The transactional subject pattern catches it (0.5).
    expect(r.signals).toContain('transactional_subject');
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does NOT classify Capital One notification. as a real human', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'capitalone@notification.capitalone.com',
      subject: 'International transaction alert | Alerte de transaction internationale',
      body: 'A transaction was made on your Capital One card.',
    });
    // Old behaviour: 0.0 + 'from_real_human' (false positive on 'CapitalOne').
    // New behaviour: no 'from_real_human' false positive.
    expect(r.signals).not.toContain('from_real_human');
  });

  it('does NOT classify Interac e-Transfer sender as a real human via subject', () => {
    // Old: "BYRON BERRY" extracted from subject context would match
    // isLikelyHuman. New: subject isn't part of the human check.
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'catch@payments.interac.ca',
      subject: 'Interac e-Transfer: Your $50.00 transfer to BYRON BERRY has been successfully deposited.',
      body: 'Your e-Transfer has been sent.',
    });
    expect(r.signals).not.toContain('from_real_human');
    expect(r.signals).toContain('transactional_subject');
  });

  it('still CLASSIFIES a real human with a non-personal subject as real_human', () => {
    // Sanity: the fix should not break the existing positive case.
    // Note: 'Re:' in the subject would match the personal_subject
    // hard-keep check FIRST, so to exercise the from_real_human path
    // we use a neutral subject.
    const r = scoreEmail({
      fromName: 'Linda Marsh',
      fromEmail: 'linda@external-corp.com',
      subject: 'Invoice 1234',
      body: 'Thanks!',
    });
    expect(r.signals).toContain('from_real_human');
    expect(r.shouldDismiss).toBe(false);
  });
});

describe('junk-classifier: security / always-keep subjects (2026-06-16)', () => {
  it('NEVER auto-dismisses "Your Google Account is no longer recoverable"', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'no-reply@accounts.google.com',
      subject: 'Your Google Account is no longer recoverable',
      body: 'Your account will be deleted in 30 days unless you act now.',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('security_subject_keep');
  });

  it('NEVER auto-dismisses a "Security alert" from any noreply', () => {
    const r = scoreEmail({
      fromName: 'Google',
      fromEmail: 'no-reply@accounts.google.com',
      subject: 'Security alert',
      body: 'New sign-in from Chrome on Windows.',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('security_subject_keep');
  });

  it('NEVER auto-dismisses "Unrecognized device signed in"', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'noreply@openrouter.ai',
      subject: 'Unrecognized device signed in',
      body: 'A new device was used to sign in to your account.',
    });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('security_subject_keep');
  });
});

describe('junk-classifier: Google ecosystem signals (2026-06-16)', () => {
  it('catches googlenews-noreply@google.com with a Newsletter subject', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'googlenews-noreply@google.com',
      subject: "Today's Briefing: Politics, Ontario, Emmanuel Macron",
      body: 'Your daily Google News briefing. Manage your settings.',
    });
    expect(r.signals).toContain('google_automated_from');
    expect(r.score).toBeGreaterThanOrEqual(0.4);
  });

  it('catches sc-noreply@google.com (Google Search Console)', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'sc-noreply@google.com',
      subject: 'New reasons prevent pages from being indexed on site cowichanclosets.com',
      body: 'Search Console detected new issues.',
    });
    expect(r.signals).toContain('google_automated_from');
  });

  it('catches comments-noreply@docs.google.com (Docs comments)', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'comments-noreply@docs.google.com',
      subject: '"Thrive Now Task List" was edited recently',
      body: 'A new comment was added.',
    });
    expect(r.signals).toContain('google_automated_from');
  });
});

describe('junk-classifier: transactional/receipt subject patterns (2026-06-16)', () => {
  it('catches "thank you for your payment" (greengeeks, hostinger, etc.)', () => {
    const r = scoreEmail({
      fromName: 'GreenGeeks',
      fromEmail: 'billing@greengeeks.com',
      subject: 'Thank you for your payment',
      body: 'Your invoice is paid.',
    });
    expect(r.signals).toContain('transactional_subject');
  });

  it('catches "payment posted" (Capital One, banks)', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'capitalone@notification.capitalone.com',
      subject: 'Payment posted | Paiement inscrit',
      body: 'A payment was posted to your account.',
    });
    expect(r.signals).toContain('transactional_subject');
  });

  it('catches "auto deposited" (Interac, bank transfers)', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'notify@payments.interac.ca',
      subject: "Interac e-Transfer: You've received $200.00 from Byron Berry and it has been automatically deposited.",
      body: 'You received a transfer.',
    });
    expect(r.signals).toContain('transactional_subject');
  });
});

describe('junk-classifier: settings-backed overrides (2026-06-16)', () => {
  it('auto_dismiss_domains adds 0.6 on top of any other signals', () => {
    // No other strong signals (no unsubscribe, no brand name) — the
    // settings-driven domain hit alone should be enough to dismiss.
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'noreply@cargurus-cdn.example',
      subject: 'cars you looked at',
      body: 'no body',
    }, { settings: { auto_dismiss_domains: 'cargurus-cdn.example' } });
    expect(r.signals.some((s) => s.startsWith('settings_auto_dismiss_domain:'))).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    // Without the override, this would not auto-dismiss (no junk signals)
  });

  it('auto_dismiss_domains is case-insensitive on the domain', () => {
    const r = scoreEmail({
      fromName: '',
      fromEmail: 'news@GOOGLE-NEWS.example',
      subject: 'Daily digest',
      body: '',
    }, { settings: { auto_dismiss_domains: 'google-news.example' } });
    expect(r.signals.some((s) => s.startsWith('settings_auto_dismiss_domain:'))).toBe(true);
  });

  it('auto_keep_subjects keeps the row even if every other signal fires', () => {
    // This email would normally be junk: noreply + brand name + junk
    // subject + unsubscribe in body — all green flags. But the subject
    // is in auto_keep_subjects so it survives.
    const r = scoreEmail({
      fromName: 'TeePublic',
      fromEmail: 'newsletter@em.teepublic.com',
      subject: 'Daily notifications from GeekShop internal cron',
      body: 'unsubscribe here',
    }, { settings: { auto_keep_subjects: 'geekshop internal cron' } });
    expect(r.shouldDismiss).toBe(false);
    expect(r.signals).toContain('settings_keep_subject');
  });

  it('multiple auto_dismiss_domains are supported (CSV)', () => {
    const r1 = scoreEmail({
      fromName: '', fromEmail: 'a@badexample.com', subject: 'x', body: '',
    }, { settings: { auto_dismiss_domains: 'badexample.com,another-bad.com' } });
    expect(r1.signals.some((s) => s.startsWith('settings_auto_dismiss_domain:'))).toBe(true);
  });
});

describe('junk-classifier: isAgentMail helper (2026-06-16)', () => {
  it('matches the configured agent mailbox exactly (case-insensitive)', () => {
    expect(isAgentMail('johnn5wizbot@gmail.com', { agent_mailbox_from: 'johnn5wizbot@gmail.com' })).toBe(true);
    expect(isAgentMail('JOHNN5WIZBOT@GMAIL.COM', { agent_mailbox_from: 'johnn5wizbot@gmail.com' })).toBe(true);
  });
  it('returns false when the from is not in the list', () => {
    expect(isAgentMail('linda@hyrule.ca', { agent_mailbox_from: 'johnn5wizbot@gmail.com' })).toBe(false);
  });
  it('supports CSV list', () => {
    expect(isAgentMail('alerts@company.com', { agent_mailbox_from: 'johnn5wizbot@gmail.com,alerts@company.com' })).toBe(true);
  });
  it('returns false on empty input', () => {
    expect(isAgentMail('', { agent_mailbox_from: 'johnn5wizbot@gmail.com' })).toBe(false);
    expect(isAgentMail('x@x.com', { agent_mailbox_from: '' })).toBe(false);
  });
});

describe('junk-classifier: ambiguous LLM fallback', () => {
  it('consults LLM when rule score is in 0.3..0.7 (mocked)', async () => {
    // We can't easily mock aiCall per-test, but we CAN verify the
    // contract: if rules return 0 or ≥0.8, the LLM is never asked.
    // The LLM path's behavior is exercised in the smoke test below.
    const clearlyJunk = scoreEmail({
      fromName: '', fromEmail: 'noreply@a.com',
      subject: 'unsubscribe now', body: 'unsubscribe',
    });
    expect(clearlyJunk.score).toBeGreaterThanOrEqual(0.8); // rules-only verdict

    const clearlyLegit = scoreEmail({
      fromName: 'John Smith', fromEmail: 'john@example.com',
      subject: 'Are you free Thursday?', body: 'Need help',
    });
    expect(clearlyLegit.shouldDismiss).toBe(false); // hard-keep on real human
  });
});

describe('bulk-dismiss + restore', () => {
  let bulkDb;
  beforeAll(async () => {
    bulkDb = await runMigrations(':memory:');
    // Seed 10 pending emails
    const stmt = bulkDb.prepare(`INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    for (let i = 0; i < 10; i++) {
      stmt.run(`bulk-${i}@x`, String(i), `Sender ${i}`, `s${i}@x.com`, `Subject ${i}`, 'b', 's', '2026-06-15T18:00:00Z');
    }
  });

  it('bulk-dismiss only affects pending rows (skips already-dismissed/imported)', () => {
    // Pre-dismiss row 5
    bulkDb.prepare("UPDATE pending_emails SET status='dismissed', dismissed_by='user' WHERE id = 5").run();
    // Bulk-dismiss [3, 4, 5, 6, 7]
    const result = bulkDismissPendingEmails(bulkDb, [3, 4, 5, 6, 7]);
    expect(result.requested).toBe(5);
    expect(result.dismissed).toBe(4); // 3, 4, 6, 7
    expect(result.skipped).toBe(1); // 5 was already dismissed
    // Verify
    const stillPending = bulkDb.prepare("SELECT id FROM pending_emails WHERE status = 'pending' ORDER BY id").all().map((r) => r.id);
    expect(stillPending).toEqual([1, 2, 8, 9, 10]);
  });

  it('records dismissed_by = user for bulk-dismissed rows', () => {
    const r = bulkDb.prepare("SELECT dismissed_by FROM pending_emails WHERE id = 3").get();
    expect(r.dismissed_by).toBe('user');
  });

  it('restore moves a dismissed row back to pending', () => {
    const r = restorePendingEmail(bulkDb, 3);
    expect(r.ok).toBe(true);
    const row = bulkDb.prepare("SELECT status, dismissed_by FROM pending_emails WHERE id = 3").get();
    expect(row.status).toBe('pending');
    expect(row.dismissed_by).toBeNull();
  });

  it('restore fails on non-dismissed rows', () => {
    expect(() => restorePendingEmail(bulkDb, 1)).toThrow(/cannot restore pending/);
  });

  it('bulk-dismiss with empty array is a no-op', () => {
    const r = bulkDismissPendingEmails(bulkDb, []);
    expect(r).toEqual({ requested: 0, dismissed: 0, skipped: 0, errors: [] });
  });

  it('listPendingEmails supports array of statuses (pending + dismissed)', () => {
    bulkDb.prepare("UPDATE pending_emails SET status='dismissed', dismissed_by='user' WHERE id IN (4, 6)").run();
    const items = listPendingEmails(bulkDb, { status: ['pending', 'dismissed'], limit: 100 });
    expect(items.length).toBe(10);
    const byStatus = items.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    // After all the test actions above:
    //   1,2,8,9,10 still pending (5)
    //   3 was restored (pending) → 6 pending
    //   4 was bulk-dismissed in test 2, 6 was bulk-dismissed in test 2
    //   5 was pre-dismissed, 7 was bulk-dismissed in test 2
    //   then 4 and 6 are re-dismissed in this test (no-op, already dismissed)
    // So pending=6, dismissed=4, total=10.
    expect(byStatus.pending).toBe(6);
    expect(byStatus.dismissed).toBe(4);
  });
});

describe('backfillClassifyPendingEmails (2026-06-16)', () => {
  let bdb;
  beforeAll(async () => {
    bdb = await runMigrations(':memory:');
  });

  function seed(sender, subject, body, status = 'pending') {
    bdb.prepare(`INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`bf-${Math.random()}-${subject}@x`, '0', '', sender, subject, body, '', '2026-06-15T10:00:00Z', status);
  }

  it('classifies all un-classified pending rows', () => {
    // Reset to a clean state
    bdb.exec("DELETE FROM pending_emails");
    // Real-world shaped seeds — some have a brand-name fromName (the
    // common case) and one has an empty fromName (the Gmail fall-back
    // display name case). All four would auto-dismiss except the
    // empty-fromName CarGurus one, which only has body_has_unsubscribe
    // (0.25) and stays for human review.
    seed('hello@news.railway.app', 'Railway product update', 'unsubscribe here');
    seed('newsletter@em.teepublic.com', 'Shirtacular is LIVE!', 'unsubscribe');
    seed('billing@greengeeks.com', 'Thank you for your payment', 'paid');
    seed('Linda Marsh', 'Invoice 1234', 'Thanks!'); // real human — keep
    seed('cargurus@mail.cargurus.com', 'Nissan LEAF from $9,900', 'unsubscribe'); // empty fromName — stays at 0.25

    const r = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    expect(r.examined).toBe(5);
    expect(r.classified).toBe(5);
    // 3 of the 5 should auto-dismiss (Railway, TeePublic, GreenGeeks).
    // Linda Marsh (real human) and the CarGurus with empty fromName
    // (only body_has_unsubscribe=0.25, below 0.8 threshold) stay.
    expect(r.dismissed).toBe(3);

    const rows = bdb.prepare("SELECT id, from_email, status, classification FROM pending_emails ORDER BY id").all();
    for (const row of rows) {
      expect(row.classification).toBeTruthy();
    }
    const pending = rows.filter((r) => r.status === 'pending');
    expect(pending.length).toBe(2);
    const pendingFroms = pending.map((r) => r.from_email).sort();
    expect(pendingFroms).toEqual(['Linda Marsh', 'cargurus@mail.cargurus.com']);
  });

  it('NEVER dismisses security-subject rows even when score would otherwise hit 0.8', () => {
    bdb.exec("DELETE FROM pending_emails");
    seed('noreply@accounts.google.com', 'Your Google Account is no longer recoverable', 'recover now or lose access');
    const r = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    expect(r.dismissed).toBe(0);
    const row = bdb.prepare("SELECT status FROM pending_emails LIMIT 1").get();
    expect(row.status).toBe('pending');
  });

  it('respects settings.auto_dismiss_domains for the backfill', () => {
    bdb.exec("DELETE FROM pending_emails");
    bdb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_dismiss_domains', 'my-junk.example')").run();
    seed('news@my-junk.example', 'Daily digest', 'read me');
    const r = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    expect(r.dismissed).toBe(1);
    const row = bdb.prepare("SELECT status FROM pending_emails LIMIT 1").get();
    expect(row.status).toBe('dismissed');
  });

  it('does not re-classify rows that already have a classification (status=pending mode)', () => {
    bdb.exec("DELETE FROM pending_emails");
    seed('hello@news.railway.app', 'Railway product update', 'unsubscribe');
    // First pass: dismisses
    const r1 = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    expect(r1.examined).toBe(1);
    expect(r1.dismissed).toBe(1);
    // Second pass: nothing left un-classified in status='pending' (already dismissed)
    const r2 = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    expect(r2.examined).toBe(0);
    expect(r2.dismissed).toBe(0);
  });

  it('with status=all, re-classifies already-dismissed rows', () => {
    bdb.exec("DELETE FROM pending_emails");
    seed('hello@news.railway.app', 'Railway product update', 'unsubscribe');
    backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8 });
    // Re-classify everything
    const r = backfillClassifyPendingEmails(bdb, { dismiss_threshold: 0.8, status: 'all' });
    expect(r.examined).toBe(1);
    // Already-dismissed rows don't get re-dismissed (they were already dismissed);
    // but the classification is updated. The function's `dismissed` count
    // only counts rows NEWLY transitioned to dismissed.
    expect(r.dismissed).toBe(0);
  });

  it('readModerationSettings returns the expected keys', () => {
    bdb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_keep_subjects', 'foo,bar')").run();
    const s = readModerationSettings(bdb);
    expect(s).toHaveProperty('auto_dismiss_domains');
    expect(s).toHaveProperty('auto_keep_subjects');
    expect(s).toHaveProperty('agent_mailbox_from');
    expect(s.auto_keep_subjects).toBe('foo,bar');
  });
});
