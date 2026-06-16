/**
 * Google Contacts enrichment tests.
 *
 * Two parts:
 *   1. Pure-logic tests: pickBest() and buildEnrichmentDiff() — no network.
 *   2. Live test (skipped if no OAuth token present): findContactMatch()
 *      actually hits the People API. Marked as `it.live` so vitest's
 *      normal run skips it, and a separate `npm run test:live` picks it up.
 *
 * The pure tests catch the 90% case (logic bugs, wrong-field selection,
 * overwriting existing data) without needing Google OAuth.
 */

import { describe, it, expect } from 'vitest';
import { pickBest, buildEnrichmentDiff, findContactMatch } from '../lib/google-contacts.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || join(homedir(), '.hermes', 'google_token.json');

describe('pickBest: match strategy', () => {
  const linda = {
    resourceName: 'people/c1',
    names: [{ displayName: 'Linda Marsh' }],
    emails: ['linda@marshdesigns.com'],
    phones: ['+1 250 555 1234'],
    organizations: [{ name: 'Marsh Designs' }],
    addresses: ['123 Pine St, Powell River BC'],
  };
  const otherLinda = {
    resourceName: 'people/c2',
    names: [{ displayName: 'Linda Elkjar' }],
    emails: ['linda.elkjar@streetcapital.ca'],
    phones: [],
    organizations: [],
    addresses: [],
  };
  const brian = {
    resourceName: 'people/c3',
    names: [{ displayName: 'Brian Chen' }],
    emails: ['brian@example.com'],
    phones: ['+1 250 555 0102'],
    organizations: [],
    addresses: [],
  };

  it('picks exact email match over name match', () => {
    const best = pickBest([otherLinda, linda], { email: 'linda@marshdesigns.com', name: 'Linda Marsh' });
    expect(best.resourceName).toBe('people/c1');
  });

  it('falls back to name match when email has no hit', () => {
    const best = pickBest([otherLinda, brian], { email: 'unknown@x.com', name: 'Brian Chen' });
    expect(best.resourceName).toBe('people/c3');
  });

  it('returns null on no hits', () => {
    expect(pickBest([], { email: 'a', name: 'b' })).toBe(null);
  });

  it('returns null when neither email nor name match anything', () => {
    const best = pickBest([brian], { email: 'unknown@x.com', name: 'Zelda Hyrule' });
    expect(best).toBe(null);
  });

  it('normalizes the hit into a clean shape', () => {
    const best = pickBest([linda], { email: 'linda@marshdesigns.com' });
    expect(best).toMatchObject({
      name: 'Linda Marsh',
      org: 'Marsh Designs',
      phone: '+1 250 555 1234',
      primaryEmail: 'linda@marshdesigns.com',
      address: '123 Pine St, Powell River BC',
    });
  });
});

describe('buildEnrichmentDiff: only fill blanks, never overwrite', () => {
  const candidate = {
    name: 'Linda Marsh',
    org: 'Marsh Designs',
    phone: '+1 250 555 1234',
    primaryEmail: 'linda@marshdesigns.com',
    title: 'CEO',
    address: '123 Pine St, Powell River BC',
  };

  it('proposes all fields when the customer is brand new (null)', () => {
    const diff = buildEnrichmentDiff(null, candidate);
    expect(diff.proposed).toMatchObject({
      name: 'Linda Marsh',
      company: 'Marsh Designs',
      phone: '+1 250 555 1234',
      email: 'linda@marshdesigns.com',
    });
    // notes are concatenated from non-mappable fields
    expect(diff.proposed.notes).toContain('Title: CEO');
    expect(diff.proposed.notes).toContain('Address: 123 Pine St');
    expect(diff.skipped).toEqual([]);
  });

  it('proposes only blank fields on an existing customer', () => {
    const existing = { name: 'Linda M.', company: '', phone: null, email: 'linda@marshdesigns.com', notes: '' };
    const diff = buildEnrichmentDiff(existing, candidate);
    // Name is already set to something different → skipped (do not overwrite)
    expect(diff.proposed.name).toBeUndefined();
    expect(diff.skipped.some((s) => s.key === 'name' && s.reason === 'already_set')).toBe(true);
    // Company is empty → proposed
    expect(diff.proposed.company).toBe('Marsh Designs');
    // Phone is null → proposed
    expect(diff.proposed.phone).toBe('+1 250 555 1234');
    // Email is set → skipped
    expect(diff.proposed.email).toBeUndefined();
  });

  it('returns null when candidate is null (no match)', () => {
    expect(buildEnrichmentDiff({ name: 'X' }, null)).toBe(null);
  });

  it('handles missing optional fields in the candidate gracefully', () => {
    const sparseCandidate = { name: 'Bob', emails: [], phones: [], organizations: [], addresses: [] };
    const diff = buildEnrichmentDiff(null, sparseCandidate);
    expect(diff.proposed.name).toBe('Bob');
    expect(diff.proposed.notes).toBeUndefined();
  });
});

describe('findContactMatch: live (skipped without OAuth token)', () => {
  const hasToken = existsSync(TOKEN_PATH);

  it.skipIf(!hasToken)('returns a match for a real contact in Byron\'s Google Contacts', async () => {
    // This is the only live test — it actually hits Google's People API.
    // We use "Byron Berry" as the search term because we know it's a hit.
    const result = await findContactMatch({
      email: 'byron@geekshop.ca',
      name: 'Byron Berry',
      existingCustomer: null,
    });
    expect(result.ok).toBe(true);
    expect(result.match).toBeTruthy();
    expect(result.match.name).toMatch(/byron/i);
    expect(result.match.primaryEmail).toBe('byron@geekshop.ca');
    expect(result.diff).toBeTruthy();
  }, 15000);

  it.skipIf(!hasToken)('returns no_match for an email that\'s not in contacts', async () => {
    const result = await findContactMatch({
      email: 'totally-fake-and-unique-12345@nowhere.invalid',
      name: 'Nobody Real',
      existingCustomer: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_match');
  }, 15000);

  it.skipIf(!hasToken)('returns not_authenticated when the token is missing or scope is absent', async () => {
    // Temporarily point to a non-existent file
    const origPath = process.env.GOOGLE_TOKEN_PATH;
    process.env.GOOGLE_TOKEN_PATH = '/tmp/not-a-real-token-' + Date.now() + '.json';
    try {
      // Re-import to pick up the new env var (modules are cached, so use a hack)
      const mod = await import('../lib/google-contacts.js?bust=' + Date.now());
      const result = await mod.findContactMatch({ email: 'x@x.com', name: 'X' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('not_authenticated');
    } finally {
      if (origPath) process.env.GOOGLE_TOKEN_PATH = origPath;
      else delete process.env.GOOGLE_TOKEN_PATH;
    }
  }, 5000);
});
