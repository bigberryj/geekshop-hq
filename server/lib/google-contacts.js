/**
 * Google Contacts enrichment — looks up a sender in Google Contacts
 * and returns the fields we'd suggest auto-populating on the customer
 * record (phone, company, address, etc.). Never overwrites the DB.
 *
 * Auth: reuses Byron's existing OAuth token at ~/.hermes/google_token.json
 * (the byron-google-workspace skill manages it; contacts.readonly scope
 * is already granted as of 2026-06-15).
 *
 * Match strategy (per Byron's preference, 2026-06-15):
 *   - Email match wins, name match is a fuzzy fallback
 *   - On email match, only fill in BLANK fields (don't overwrite name)
 *
 * Falls back gracefully:
 *   - Token missing → return { ok: false, reason: 'not_authenticated' }
 *   - No match → return { ok: false, reason: 'no_match' }
 *   - API error → return { ok: false, reason: 'api_error', error }
 *   Never throws — the inbox import must not fail because of a contact lookup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileP = promisify(execFile);

// Path to Byron's OAuth token. Set GOOGLE_TOKEN_PATH to override for tests
// or in production if the token lives elsewhere.
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || join(homedir(), '.hermes', 'google_token.json');

/**
 * Direct People API search via inline Python (per the byron-google-workspace
 * skill's guidance — "use a one-liner inline" when the CLI can't do it).
 * Supports free-text query, email, and name.
 */
async function searchContactsRaw(query) {
  const inline = `
import json
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
creds = Credentials.from_authorized_user_file(${JSON.stringify(TOKEN_PATH)})
svc = build('people', 'v1', credentials=creds, cache_discovery=False)
res = svc.people().searchContacts(
    query=${JSON.stringify(query)},
    readMask='names,emailAddresses,phoneNumbers,organizations,addresses',
    pageSize=5,
).execute()
out = []
for h in res.get('results', []):
  p = h.get('person', {})
  out.append({
    'resourceName': p.get('resourceName'),
    'names': p.get('names', []),
    'emails': [e.get('value') for e in p.get('emailAddresses', []) if e.get('value')],
    'phones': [ph.get('value') for ph in p.get('phoneNumbers', []) if ph.get('value')],
    'organizations': [{'name': o.get('name'), 'title': o.get('title')} for o in p.get('organizations', []) if o.get('name') or o.get('title')],
    'addresses': [a.get('formattedValue') for a in p.get('addresses', []) if a.get('formattedValue')],
  })
print(json.dumps(out))
`.trim();
  try {
    const { stdout } = await execFileP('python3', ['-c', inline], { timeout: 8000 });
    return JSON.parse(stdout);
  } catch (e) {
    console.warn('[contacts] inline search failed:', e.message);
    return null; // null = API error, not "no match"
  }
}

/**
 * Pick the best contact from a list of search results. Preference:
 *   1. Exact email match (case-insensitive)
 *   2. Name match where displayName equals (case-insensitive, trimmed)
 *   3. First result as a fuzzy fallback
 *
 * Returns the normalized enrichment candidate or null.
 */
export function pickBest(hits, { email, name }) {
  if (!hits || hits.length === 0) return null;
  const emailLower = (email || '').toLowerCase().trim();
  const nameLower = (name || '').toLowerCase().trim();
  // 1) Email match
  if (emailLower) {
    for (const h of hits) {
      if (h.emails && h.emails.some((e) => e.toLowerCase() === emailLower)) {
        return normalize(h);
      }
    }
  }
  // 2) Name match
  if (nameLower) {
    for (const h of hits) {
      if (h.names && h.names.some((n) => (n.displayName || '').toLowerCase().trim() === nameLower)) {
        return normalize(h);
      }
    }
  }
  // 3) Fuzzy: first hit whose name contains the search name as a substring
  if (nameLower) {
    for (const h of hits) {
      const dn = h.names?.[0]?.displayName?.toLowerCase() || '';
      if (dn.includes(nameLower) || nameLower.includes(dn)) return normalize(h);
    }
  }
  return null;
}

function normalize(hit) {
  const name = hit.names?.[0]?.displayName || null;
  const givenName = hit.names?.[0]?.givenName || null;
  const familyName = hit.names?.[0]?.familyName || null;
  const org = hit.organizations?.[0]?.name || null;
  const title = hit.organizations?.[0]?.title || null;
  // Prefer mobile phones, fall back to first phone.
  const mobile = hit.phones?.find((p) => p && /mobile|cell/i.test(p)) || hit.phones?.[0] || null;
  const phone = hit.phones?.[0] || null;
  const primaryEmail = hit.emails?.[0] || null;
  const address = hit.addresses?.[0] || null;
  return {
    resourceName: hit.resourceName,
    name,
    givenName,
    familyName,
    org,
    title,
    phone,
    mobilePhone: mobile,
    primaryEmail,
    address,
    raw: hit, // for the modal preview
  };
}

/**
 * Build the proposed diff: which fields to apply, with current DB values
 * for comparison. The frontend modal uses this to show the user what's
 * changing. We never overwrite non-empty fields (per Byron's preference).
 */
export function buildEnrichmentDiff(existingCustomer, candidate) {
  if (!candidate) return null;
  const proposed = {};
  const currentValues = {};
  const skipped = [];

  function consider(key, candidateValue) {
    if (!candidateValue) return;
    const current = existingCustomer?.[key] || '';
    // Skip if current is non-empty AND different from candidate. If they
    // match exactly, we treat it as already-set (no-op, not a "change").
    if (current && current !== candidateValue) {
      skipped.push({ key, reason: 'already_set', current, proposed: candidateValue });
    } else if (!current) {
      proposed[key] = candidateValue;
    }
    // else: current === candidateValue → nothing to do, don't even log
  }

  consider('name', candidate.name);
  consider('company', candidate.org);
  consider('phone', candidate.phone);
  consider('email', candidate.primaryEmail);
  // notes: we concatenate Google data that doesn't have a home elsewhere
  const noteBits = [];
  if (candidate.title) noteBits.push(`Title: ${candidate.title}`);
  if (candidate.address) noteBits.push(`Address: ${candidate.address}`);
  if (noteBits.length) {
    const proposedNotes = noteBits.join('\n');
    if (!existingCustomer?.notes) proposed.notes = proposedNotes;
    else skipped.push({ key: 'notes', reason: 'already_set', current: existingCustomer.notes, proposed: proposedNotes });
  }

  return {
    candidate,
    proposed,
    skipped,
    currentValues: existingCustomer || {},
  };
}

/**
 * Main entry point. Given a sender's email + name, return either:
 *   { ok: true, match, diff }           — contact found, diff computed against existingCustomer
 *   { ok: false, reason: 'not_authenticated' }
 *   { ok: false, reason: 'no_match' }
 *   { ok: false, reason: 'api_error', error }
 */
export async function findContactMatch({ email, name, existingCustomer }) {
  if (!existsSync(TOKEN_PATH)) return { ok: false, reason: 'not_authenticated' };
  try {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    if (!token.scopes || !token.scopes.some((s) => s.includes('contacts'))) {
      return { ok: false, reason: 'not_authenticated' };
    }
  } catch {
    return { ok: false, reason: 'not_authenticated' };
  }

  // Try email first (most precise), then name. Each query returns the
  // top 5 hits; pickBest() picks the best one.
  const query = email || name;
  if (!query) return { ok: false, reason: 'no_query' };

  const hits = await searchContactsRaw(query);
  if (hits === null) return { ok: false, reason: 'api_error', error: 'People API call failed' };

  const match = pickBest(hits, { email, name });
  if (!match) return { ok: false, reason: 'no_match', hitCount: hits.length };

  const diff = buildEnrichmentDiff(existingCustomer, match);
  return { ok: true, match, diff };
}
