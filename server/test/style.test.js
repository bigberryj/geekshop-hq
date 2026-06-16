/**
 * Style analyzer tests. We don't need a real LLM to verify the analyzer:
 * the signal extraction is deterministic and the test cases are concrete.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { addStyleSample, buildStyleProfile, recordStyleFeedback, _internal } from '../lib/style.js';

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

describe('analyzer: signal extraction', () => {
  const { analyzeSignals } = _internal;

  it('detects short average sentence length', () => {
    const samples = [
      'Hi Linda. Thanks for the note. I will be there Tuesday.',
      'Hi Zelda. Confirmed for 10am. See you then.',
    ];
    const s = analyzeSignals(samples);
    expect(s.avgSentenceLength).toBeLessThan(10);
  });

  it('detects em-dashes', () => {
    const samples = ['Hi Linda — sorry to hear that. Can you check the LED?'];
    const s = analyzeSignals(samples);
    expect(s.emDash).toBeGreaterThan(0);
  });

  it('detects questions', () => {
    const samples = ['Hi Linda. Is the Wi-Fi still dropping? Reply if so.'];
    const s = analyzeSignals(samples);
    expect(s.question).toBeGreaterThan(0);
  });

  it('finds dominant opening (with name replaced by {name})', () => {
    const samples = [
      'Hi Linda — short test message here for the analyzer to read.',
      'Hi Zelda — another greeting style line just to test the patterns.',
      'Hi Brian — third one to confirm the pattern is consistent.',
    ];
    const s = analyzeSignals(samples);
    expect(s.dominantOpening).toMatch(/^hi \{name\}$/i);
  });

  it('finds common closers from known set', () => {
    const samples = [
      'Hi Linda — sorry to hear that. Can you check the LED color on the AP-AC-Pro upstairs when it drops?',
      'Hi Linda, just checking in — is the Wi-Fi still dropping? Reply if you want me to come out.',
    ];
    const s = analyzeSignals(samples);
    expect(s.commonClosers).toContain('reply if');
  });

  it('handles empty / single samples without throwing', () => {
    expect(() => analyzeSignals([])).not.toThrow();
    expect(() => analyzeSignals(['x'])).not.toThrow();
  });
});

describe('analyzer: feedback diff', () => {
  const { diffDraftFeedback } = _internal;

  it('detects opening change (Hello → Hi)', () => {
    const changes = diffDraftFeedback('Hello Linda,\n\nJust confirming...', 'Hi Linda — just confirming...');
    expect(changes.some((c) => c.includes('opening'))).toBe(true);
  });

  it('detects length ratio (final much shorter than draft)', () => {
    const draft = 'Hello Linda, I hope this email finds you well. I wanted to reach out to discuss the situation with your Wi-Fi access point and provide some guidance on next steps you might consider.';
    const final = 'Hi Linda — is the AP still dropping? Can you check the LED color?';
    const changes = diffDraftFeedback(draft, final);
    expect(changes.some((c) => c.includes('shorter'))).toBe(true);
  });

  it('flags removal of AI-tell phrases', () => {
    const draft = 'Hello Linda, I hope this email finds you well. I wanted to reach out. Please feel free to reply if you have any questions or concerns about the situation.';
    const final = 'Hi Linda — AP still dropping?';
    const changes = diffDraftFeedback(draft, final);
    expect(changes.some((c) => c.includes('i hope this'))).toBe(true);
    expect(changes.some((c) => c.includes('please feel free'))).toBe(true);
  });

  it('returns no changes for trivial equal text', () => {
    const changes = diffDraftFeedback('Hi Linda', 'Hi Linda');
    expect(changes).toEqual([]);
  });
});

describe('style_samples CRUD', () => {
  it('adds a sample and reads it back via buildStyleProfile', async () => {
    db.prepare('DELETE FROM style_samples').run();
    addStyleSample(db, { source: 'admin_message', text: 'Hi Linda — sorry to hear that. Can you check the LED color on the AP-AC-Pro upstairs when it drops?', context: 'test' });
    addStyleSample(db, { source: 'admin_message', text: 'Hi Linda, just checking in — is the Wi-Fi still dropping? Reply if you want me to come out.', context: 'test' });
    addStyleSample(db, { source: 'admin_message', text: 'Hi Zelda — coming out tomorrow to assess the firewall. I have a 10am-11:30am slot open if that works.', context: 'test' });
    const profile = await buildStyleProfile(db);
    expect(profile.ok).toBe(true);
    expect(profile.sampleCount).toBe(3);
    expect(profile.prompt).toContain('BYRON');
    expect(profile.prompt).toContain('Em-dashes');
  });

  it('returns ok=false when not enough samples', async () => {
    db.prepare('DELETE FROM style_samples').run();
    addStyleSample(db, { source: 'admin_message', text: 'Hi Linda' });
    const profile = await buildStyleProfile(db);
    expect(profile.ok).toBe(false);
    expect(profile.reason).toMatch(/not enough/i);
  });

  it('captures feedback and also adds the final text as a sample', () => {
    db.prepare('DELETE FROM style_samples').run();
    db.prepare('DELETE FROM style_feedback').run();
    addStyleSample(db, { source: 'admin_message', text: 'Hi Linda — sorry to hear that. Can you check the LED color on the AP-AC-Pro upstairs when it drops?' });
    addStyleSample(db, { source: 'admin_message', text: 'Hi Linda, just checking in — is the Wi-Fi still dropping? Reply if you want me to come out.' });
    addStyleSample(db, { source: 'admin_message', text: 'Hi Zelda — coming out tomorrow to assess the firewall. I have a 10am-11:30am slot open if that works.' });
    const before = db.prepare('SELECT COUNT(*) as n FROM style_samples').get().n;
    recordStyleFeedback(db, { ticketId: 1, draftText: 'Hello Linda, I hope this finds you well. I wanted to reach out...', finalText: 'Hi Linda — is the AP still dropping?' });
    const after = db.prepare('SELECT COUNT(*) as n FROM style_samples').get().n;
    expect(after).toBe(before + 1);
    const fb = db.prepare('SELECT * FROM style_feedback ORDER BY id DESC LIMIT 1').get();
    expect(fb.draft_text).toContain('Hello');
    expect(fb.final_text).toContain('Hi Linda');
  });
});
