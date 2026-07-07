/**
 * Contract Client Portal — public-facing API for office managers.
 *
 * Mounted under /api/portal/*. Cookie name is `hq_csid`. Each cookie value
 * resolves via resolveSession() → client_portal_credentials + scope.
 *
 * Scope rules:
 *   • A credential may only read/write data belonging to its own client_id.
 *   • For location_manager scope, additional location_id filters are applied
 *     via locationScopeFragment() in lib/contract-clients.js.
 *   • Submitting a contract_request binds it to the session's contact_id
 *     (chosen from the contacts the credential can see).
 *
 * Endpoints:
 *   POST  /api/portal/login            — email + password → cookie
 *   POST  /api/portal/logout
 *   GET   /api/portal/me               — current session summary
 *   GET   /api/portal/locations        — visible locations
 *   GET   /api/portal/contacts         — visible contacts (for picking submitter)
 *   GET   /api/portal/assets?location_id=
 *   GET   /api/portal/requests         — visible requests
 *   POST  /api/portal/requests         — submit request (validates scope)
 *   GET   /api/portal/requests/:rid    — request detail (with events)
 *   POST  /api/portal/requests/:rid/cancel — cancel-eligible check + cancellation
 *   GET   /api/portal/redeem/:token    — peek invite (returns client label + email)
 *   POST  /api/portal/redeem/:token    — set password + create credential
 */

import {
  verifyPassword,
  createPortalSession,
  resolveSession,
  consumeInvite,
  markInviteConsumed,
  hashPassword,
  locationScopeFragment,
  canCancel,
  logPortalAudit,
} from '../lib/contract-clients.js';

function nowIso() { return new Date().toISOString(); }

function ipOf(req) {
  // Fastify with trustProxy puts client IP in req.ip.
  return req.ip || null;
}

async function getSession(req, app) {
  const sid = req.cookies?.hq_csid;
  if (!sid) return null;
  return resolveSession(app.db, sid);
}

function unauthorized(reply) {
  return reply.code(401).send({ error: 'portal_login_required' });
}

function shouldUseSecurePortalCookie(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase();
  return process.env.NODE_ENV === 'production'
    || process.env.PORTAL_COOKIE_SECURE === 'true'
    || forwardedProto === 'https';
}

function forbidden(reply, reason) {
  return reply.code(403).send({ error: 'forbidden', reason });
}

export async function contractPortalRoutes(app) {
  // ------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------
  app.post('/api/portal/login', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: 'email + password required' });
    const cred = app.db.prepare('SELECT * FROM client_portal_credentials WHERE email = ?').get(String(email).trim().toLowerCase());
    if (!cred || cred.disabled_at) {
      logPortalAudit(app.db, { clientId: cred?.client_id, action: 'login.failed', ip: ipOf(req) });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const ok = await verifyPassword(String(password), cred.password_hash);
    if (!ok) {
      logPortalAudit(app.db, { credentialId: cred.id, clientId: cred.client_id, action: 'login.failed', ip: ipOf(req) });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const session = createPortalSession(app.db, cred);
    reply.setCookie('hq_csid', session.id, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: shouldUseSecurePortalCookie(req),
      maxAge: 14 * 86400,
    });
    logPortalAudit(app.db, { credentialId: cred.id, clientId: cred.client_id, action: 'login.ok', ip: ipOf(req) });
    return { ok: true };
  });

  app.post('/api/portal/logout', async (req, reply) => {
    const sid = req.cookies?.hq_csid;
    if (sid) {
      app.db.prepare('DELETE FROM client_portal_sessions WHERE id = ?').run(sid);
    }
    reply.clearCookie('hq_csid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/portal/me', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    const client = app.db.prepare('SELECT id, name, status FROM contract_clients WHERE id = ?').get(session.client_id);
    // contract_locations has no `location_id` column; the location is `id`.
    const frag = locationScopeFragment(session, 'id');
    const locations = app.db.prepare(`
      SELECT l.id, l.label, l.address, l.city, l.region
      FROM contract_locations l
      WHERE ${frag.sql}
      ORDER BY l.label
    `).all(...frag.params);
    return {
      display_name: session.display_name,
      email: session.email,
      client,
      scope_type: session.scope_type,
      scoped_location_ids: session.scoped_ids,
      locations,
    };
  });

  // ------------------------------------------------------------
  // Inventory (assets) — visible to scope
  // ------------------------------------------------------------
  app.get('/api/portal/assets', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    // `a` joins to `contract_locations l`, and BOTH have a client_id column,
    // so the scope fragment must be qualified to `a`.
    const { sql: scopeSql, params: scopeParams } = locationScopeFragment(session, 'location_id', 'a');
    const filterLoc = req.query?.location_id ? Number(req.query.location_id) : null;
    let sql = `SELECT a.id, a.hostname, a.asset_tag, a.assigned_user, a.type, a.manufacturer, a.model,
                      a.serial, a.os, a.cpu, a.ram_gb, a.storage_gb, a.warranty_until, a.last_serviced_at, a.status, a.location_id,
                      l.label AS location_label
               FROM client_assets a
               JOIN contract_locations l ON l.id = a.location_id
               WHERE ${scopeSql}`;
    const args = [...scopeParams];
    if (filterLoc) {
      if (!session.scoped_ids.includes(filterLoc) && session.scope_type !== 'client_manager') {
        return forbidden(reply, 'location out of scope');
      }
      sql += ' AND a.location_id = ?';
      args.push(filterLoc);
    }
    sql += ' ORDER BY a.hostname, a.asset_tag LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  // ------------------------------------------------------------
  // Contacts — used by the portal UI to let an office manager pick a submitter
  // ------------------------------------------------------------
  app.get('/api/portal/contacts', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    // Qualify scope fragment to `cc` so the JOIN to contract_locations (which
    // also has client_id) doesn't produce "ambiguous column" errors.
    const { sql: scopeSql, params: scopeParams } = locationScopeFragment(session, 'location_id', 'cc');
    const sql = `
      SELECT cc.id, cc.name, cc.email, cc.role, cc.is_office_manager, cc.location_id, l.label AS location_label
      FROM client_contacts cc
      JOIN contract_locations l ON l.id = cc.location_id
      WHERE ${scopeSql} AND cc.status = 'active'
      ORDER BY cc.is_office_manager DESC, cc.name
    `;
    return app.db.prepare(sql).all(...scopeParams);
  });

  // ------------------------------------------------------------
  // Requests
  // ------------------------------------------------------------
  app.get('/api/portal/requests', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    // `r` is the row holding client_id/location_id for the request;
    // contract_locations also has client_id, so we must qualify to `r`.
    const { sql: scopeSql, params: scopeParams } = locationScopeFragment(session, 'location_id', 'r');
    const sql = `
      SELECT r.id, r.request_uid, r.subject, r.description, r.status, r.priority, r.category,
             r.assigned_to, r.created_at, r.location_id, r.asset_id,
             l.label AS location_label,
             c.name AS contact_name,
             a.hostname AS asset_hostname
      FROM contract_requests r
      JOIN contract_locations l ON l.id = r.location_id
      LEFT JOIN client_contacts c ON c.id = r.submitting_contact_id
      LEFT JOIN client_assets a ON a.id = r.asset_id
      WHERE ${locationScopeFragment(session, 'location_id', 'r').sql}
      ORDER BY r.created_at DESC LIMIT 500
    `;
    const params = locationScopeFragment(session, 'location_id', 'r').params;
    return app.db.prepare(sql).all(...params);
  });

  app.get('/api/portal/requests/:rid', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    const rid = Number(req.params.rid);
    if (!Number.isInteger(rid)) return reply.code(400).send({ error: 'bad rid' });
    const frag = locationScopeFragment(session, 'location_id', 'r');
    const sql = `
      SELECT r.*, l.label AS location_label, c.name AS contact_name, a.hostname AS asset_hostname
      FROM contract_requests r
      JOIN contract_locations l ON l.id = r.location_id
      LEFT JOIN client_contacts c ON c.id = r.submitting_contact_id
      LEFT JOIN client_assets a ON a.id = r.asset_id
      WHERE r.id = ? AND ${frag.sql}
    `;
    const row = app.db.prepare(sql).get(rid, ...frag.params);
    if (!row) return forbidden(reply, 'request out of scope or missing');
    const events = app.db.prepare('SELECT id, event_type, from_status, to_status, note, created_at FROM contract_request_events WHERE request_id = ? ORDER BY created_at ASC').all(rid);
    // Hide internal admin-only memo fields from the portal view.
    const safe = { ...row };
    delete safe.cancelled_by;
    return { ...safe, events };
  });

  app.post('/api/portal/requests', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    const { location_id, contact_id, asset_id, subject, description, category, priority } = req.body || {};
    if (!location_id || !contact_id || !subject || !description) {
      return reply.code(400).send({ error: 'location_id, contact_id, subject, description required' });
    }
    // Verify the contact is in scope (and not archived).
    const frag = locationScopeFragment(session, 'location_id', 'cc');
    const contactSql = `
      SELECT cc.id, cc.location_id, cc.client_id FROM client_contacts cc
      WHERE cc.id = ? AND cc.status = 'active' AND ${frag.sql}
    `;
    const contact = app.db.prepare(contactSql).get(Number(contact_id), ...frag.params);
    if (!contact) return forbidden(reply, 'contact not in scope');

    // Asset must also be in scope if provided.
    if (asset_id) {
      const assetFrag = locationScopeFragment(session, 'location_id', 'a');
      const asset = app.db.prepare(`
        SELECT id FROM client_assets a WHERE a.id = ? AND ${assetFrag.sql}
      `).get(Number(asset_id), ...assetFrag.params);
      if (!asset) return forbidden(reply, 'asset out of scope');
    }

    // Mint a fresh request_uid directly via the lib.
    const mintRow = app.db.prepare('SELECT request_uid FROM contract_requests ORDER BY id DESC LIMIT 1').get();
    let n = 1;
    if (mintRow && mintRow.request_uid) {
      const m = /CR-(\d+)/.exec(mintRow.request_uid);
      if (m) n = Number(m[1]) + 1;
    }
    const uid = `CR-${String(n).padStart(6, '0')}`;

    const info = app.db.prepare(`
      INSERT INTO contract_requests (request_uid, client_id, location_id, submitting_contact_id, asset_id, subject, description, category, priority, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(uid, session.client_id, Number(location_id), Number(contact_id),
           asset_id ? Number(asset_id) : null, String(subject), String(description),
           category || null, priority || 'normal');

    app.db.prepare(`
      INSERT INTO contract_request_events (request_id, actor, event_type, to_status, note)
      VALUES (?, ?, 'created', 'open', 'submitted via portal')
    `).run(info.lastInsertRowid, `contact:${contact_id}`);

    logPortalAudit(app.db, {
      credentialId: session.credential_id, clientId: session.client_id,
      action: 'request.create', target: `req:${info.lastInsertRowid}`, ip: ipOf(req),
    });
    return app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(info.lastInsertRowid);
  });

  app.post('/api/portal/requests/:rid/cancel', async (req, reply) => {
    const session = await getSession(req, app);
    if (!session) return unauthorized(reply);
    const rid = Number(req.params.rid);
    const frag = locationScopeFragment(session, 'location_id', 'r');
    const row = app.db.prepare(`
      SELECT r.* FROM contract_requests r WHERE r.id = ? AND ${frag.sql}
    `).get(rid, ...frag.params);
    if (!row) return forbidden(reply, 'request out of scope');
    // The portal user is associated with a contact_id (if any); fall back to
    // any contact at that client if not.
    const verdict = canCancel(session, row, row.submitting_contact_id);
    if (!verdict.allowed) {
      return reply.code(409).send({ error: 'cannot_cancel', reason: verdict.reason });
    }
    const reason = (req.body && req.body.reason) || null;
    app.db.prepare(`
      UPDATE contract_requests SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
        cancelled_by = 'contact', cancel_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(reason, rid);
    app.db.prepare(`
      INSERT INTO contract_request_events (request_id, actor, event_type, from_status, to_status, note)
      VALUES (?, ?, 'cancelled', ?, 'cancelled', ?)
    `).run(rid, `contact:${session.contact_id || 0}`, row.status, reason);
    logPortalAudit(app.db, {
      credentialId: session.credential_id, clientId: session.client_id,
      action: 'request.cancel', target: `req:${rid}`, ip: ipOf(req),
    });
    return app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(rid);
  });

  // ------------------------------------------------------------
  // Magic-link invite redeem
  // ------------------------------------------------------------
  app.get('/api/portal/redeem/:token', async (req, reply) => {
    const verdict = consumeInvite(app.db, req.params.token);
    if (!verdict.ok) return reply.code(404).send({ error: 'invalid_invite', reason: verdict.reason });
    const inv = verdict.invite;
    const client = app.db.prepare('SELECT id, name FROM contract_clients WHERE id = ?').get(inv.client_id);
    // Don't return the token; just enough info to render "set your password".
    return {
      email: inv.email,
      display_name: inv.display_name,
      client,
      scope_type: inv.scope_type,
    };
  });

  app.post('/api/portal/redeem/:token', async (req, reply) => {
    const verdict = consumeInvite(app.db, req.params.token);
    if (!verdict.ok) return reply.code(404).send({ error: 'invalid_invite', reason: verdict.reason });
    const inv = verdict.invite;
    const { password, display_name } = req.body || {};
    if (!password || typeof password !== 'string') return reply.code(400).send({ error: 'password required' });
    let hash;
    try {
      hash = await hashPassword(password);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    // Reject if a credential already exists for that email (treat as wrong token).
    const existing = app.db.prepare('SELECT id FROM client_portal_credentials WHERE email = ?').get(inv.email);
    if (existing) return reply.code(409).send({ error: 'credential_already_exists' });

    const info = app.db.prepare(`
      INSERT INTO client_portal_credentials (email, password_hash, display_name, contact_id, client_id, scope_type, scoped_location_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(inv.email, hash, display_name || inv.display_name || inv.email,
           inv.contact_id || null, inv.client_id, inv.scope_type, inv.scoped_location_ids);

    markInviteConsumed(app.db, inv.token);
    logPortalAudit(app.db, {
      credentialId: info.lastInsertRowid, clientId: inv.client_id,
      action: 'invite.redeem', target: `email:${inv.email}`, ip: ipOf(req),
    });
    const session = createPortalSession(app.db, { id: info.lastInsertRowid, client_id: inv.client_id });
    reply.setCookie('hq_csid', session.id, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: shouldUseSecurePortalCookie(req),
      maxAge: 14 * 86400,
    });
    return { ok: true };
  });
}
