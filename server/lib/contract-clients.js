/**
 * contract-clients.js — Server-side helpers for the Contract Clients module.
 *
 * Responsibilities (all additive; never mutates `customers` / `tickets`):
 *   • password hashing (scrypt — Node built-in, no native deps)
 *   • session token + invite token generation
 *   • scope checks: which contract_locations and contract_clients a given
 *     portal credential can see/submit against
 *   • cancel-eligibility rules for contract_requests
 *   • uid minting for request_uid (CR-NNNNNN, monotonically increasing)
 *   • audit helpers that write to `client_portal_audit` (client-visible log)
 *
 * Auth model for the portal:
 *   • credentials live in `client_portal_credentials`
 *   • sessions live in `client_portal_sessions`, cookie name is `hq_csid`
 *   • magic-link invites in `client_invites` — redeem endpoint creates the
 *     credential row with the user-supplied password
 *
 * Scope model:
 *   scope_type = 'client_manager'   → all locations under that client
 *   scope_type = 'location_manager' → only locations listed in scoped_location_ids
 *
 * Cancel rules (exported via `canCancel(credentialRow, requestRow)`):
 *   • admin can always cancel a non-terminal request
 *   • submitting contact can cancel while status ∈ {open, in_progress} AND
 *     assigned_to IS NULL (admin hasn't picked it up yet)
 *   • once `assigned_to` is set, only admin can cancel
 *   • terminal states (resolved, cancelled) cannot be cancelled
 *
 * Future-edit seam (schema reserves `contract_requests.editable_until`, but
 * no route exposure in v1):
 *   • if `editable_until IS NOT NULL AND now < editable_until` AND
 *     status = 'open', caller may PATCH the request body
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_DAYS = 14;
const INVITE_TTL_DAYS = 7;

// ---------- token + uid helpers ----------------------------------------

export function newSessionId() {
  return randomBytes(24).toString('hex'); // 48 hex chars
}

export function newInviteToken() {
  return randomBytes(16).toString('hex'); // 32 hex chars
}

/**
 * Mint a human-friendly request uid like `CR-000123`. Caller is responsible
 * for collision-safe insert; we re-roll on UNIQUE failure.
 */
export function nextRequestUid(db) {
  // Look at the highest existing integer suffix; if none, start at 1.
  const row = db.prepare(
    "SELECT request_uid FROM contract_requests ORDER BY id DESC LIMIT 1"
  ).get();
  let n = 1;
  if (row && row.request_uid) {
    const m = /CR-(\d+)/.exec(row.request_uid);
    if (m) n = Number(m[1]) + 1;
  }
  return `CR-${String(n).padStart(6, '0')}`;
}

// ---------- password hashing (scrypt) ---------------------------------

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const expectedHex = parts[2];
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const derived = await scrypt(plain, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------- scope helpers ---------------------------------------------

/**
 * Returns the SQL fragment (with bind params) AND the list of bind params
 * that restrict a credential to the rows it can see.
 *
 * The optional `columnForLocation` lets callers point at whichever column
 * represents the location on the target table:
 *   - 'location_id' for tables that store a location_id column
 *   - 'id' for queries against contract_locations directly
 *
 * For client_manager: returns rows where client_id = credential.client_id.
 * For location_manager: returns rows where location column matches one of the
 * scoped ids.
 *
 * If the credential row is null or disabled, returns a fragment that
 * matches nothing.
 */
export function locationScopeFragment(credential, columnForLocation = 'location_id', tableAlias = '') {
  if (!credential || credential.disabled_at) {
    return { sql: '1 = 0', params: [] };
  }
  const clientCol = tableAlias ? `${tableAlias}.client_id` : 'client_id';
  const locCol = tableAlias ? `${tableAlias}.${columnForLocation}` : columnForLocation;
  if (credential.scope_type === 'client_manager') {
    return { sql: `${clientCol} = ?`, params: [credential.client_id] };
  }
  let ids = [];
  try {
    ids = credential.scoped_location_ids ? JSON.parse(credential.scoped_location_ids) : [];
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { sql: '1 = 0', params: [] };
  }
  const placeholders = ids.map(() => '?').join(',');
  return { sql: `${clientCol} = ? AND ${locCol} IN (${placeholders})`, params: [credential.client_id, ...ids] };
}

/**
 * True if a credential can see a specific (client_id, location_id) pair.
 */
export function credentialCanSeeLocation(credential, clientId, locationId) {
  if (!credential || credential.disabled_at) return false;
  if (credential.client_id !== Number(clientId)) return false;
  if (credential.scope_type === 'client_manager') return true;
  let ids = [];
  try {
    ids = credential.scoped_location_ids ? JSON.parse(credential.scoped_location_ids) : [];
  } catch {
    ids = [];
  }
  return ids.includes(Number(locationId));
}

// ---------- cancel rules ---------------------------------------------

const TERMINAL_STATUSES = new Set(['resolved', 'cancelled']);

/**
 * Decide if an action can cancel a contract_request.
 *
 * @param credential — admin scope: null/undefined; client portal: the credential row (or { id, kind: 'admin' })
 * @param requestRow — the request being cancelled
 * @param contactId  — the submitting contact id (when checking if a portal user is the submitter)
 * @returns { allowed: boolean, reason: string }
 */
export function canCancel(credential, requestRow, submittingContactId) {
  if (TERMINAL_STATUSES.has(requestRow.status)) {
    return { allowed: false, reason: `request is already ${requestRow.status}` };
  }
  // Admin: all non-terminal, irrespective of assignment
  if (!credential) {
    return { allowed: true, reason: 'admin' };
  }
  // Client portal user
  if (requestRow.client_id !== credential.client_id) {
    return { allowed: false, reason: 'request belongs to another client' };
  }
  if (!credentialCanSeeLocation(credential, requestRow.client_id, requestRow.location_id)) {
    return { allowed: false, reason: 'location out of scope' };
  }
  if (submittingContactId && requestRow.submitting_contact_id !== Number(submittingContactId)) {
    // Non-submitters (other office managers at same client) can cancel only
    // if the request hasn't been picked up by staff
    if (requestRow.assigned_to) {
      return { allowed: false, reason: 'request already assigned to staff' };
    }
  }
  if (requestRow.status === 'in_progress' && requestRow.assigned_to) {
    return { allowed: false, reason: 'request is in progress with assigned staff' };
  }
  return { allowed: true, reason: 'scope' };
}

// ---------- session helpers ------------------------------------------

export function createPortalSession(db, credential) {
  const id = newSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO client_portal_sessions (id, credential_id, client_id, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, credential.id, credential.client_id, expires);
  db.prepare('UPDATE client_portal_credentials SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(credential.id);
  return { id, expires };
}

/**
 * Resolve a session cookie into the credential row, or null if invalid.
 * Does NOT require the credential to exist in a particular scope; that is
 * enforced at the route layer.
 */
export function resolveSession(db, sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT s.id as sid, s.expires_at,
           c.id as credential_id, c.client_id, c.contact_id, c.scope_type,
           c.scoped_location_ids, c.disabled_at, c.display_name, c.email
    FROM client_portal_sessions s
    JOIN client_portal_credentials c ON c.id = s.credential_id
    WHERE s.id = ?
  `).get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM client_portal_sessions WHERE id = ?').run(sessionId);
    return null;
  }
  if (row.disabled_at) {
    db.prepare('DELETE FROM client_portal_sessions WHERE id = ?').run(row.sid);
    return null;
  }
  // Parse scope JSON once
  let scoped_ids = [];
  try {
    scoped_ids = row.scoped_location_ids ? JSON.parse(row.scoped_location_ids) : [];
  } catch { scoped_ids = []; }
  return {
    ...row,
    scoped_ids,
    sid: undefined,
  };
}

// ---------- invite helpers -------------------------------------------

export function createInvite(db, { email, clientId, scopeType, scopedLocationIds, displayName, contactId }) {
  const token = newInviteToken();
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
  const scopedJson = Array.isArray(scopedLocationIds) ? JSON.stringify(scopedLocationIds) : null;
  db.prepare(`
    INSERT INTO client_invites (token, email, client_id, scope_type, scoped_location_ids, display_name, contact_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, email, clientId, scopeType, scopedJson, displayName || null, contactId || null, expires);
  return { token, expires_at: expires };
}

export function consumeInvite(db, token) {
  const invite = db.prepare(`SELECT * FROM client_invites WHERE token = ?`).get(token);
  if (!invite) return { ok: false, reason: 'invalid_token' };
  if (invite.consumed_at) return { ok: false, reason: 'already_used' };
  if (new Date(invite.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, invite };
}

export function markInviteConsumed(db, token) {
  db.prepare('UPDATE client_invites SET consumed_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
}

// ---------- audit helper ---------------------------------------------

export function logPortalAudit(db, { credentialId, clientId, action, target, ip }) {
  try {
    db.prepare(
      'INSERT INTO client_portal_audit (credential_id, client_id, action, target, ip) VALUES (?, ?, ?, ?, ?)'
    ).run(credentialId || null, clientId || null, action, target || null, ip || null);
  } catch {
    // never let audit failures break a request
  }
}
