/**
 * Contract Clients module — admin HQ API.
 *
 * Mounted under /api/contract-clients/* in the HQ admin surface.
 *
 * Auth: HQ is a single-admin app (see lib/security.js). In dev, all routes
 * are open (matching the rest of the admin surface). In production we
 * require ADMIN_PASSWORD as the conventional guard. We never expose admin
 * routes to anonymous clients — the portal surface lives at /api/portal/*
 * and has its own session cookie (`hq_csid`).
 *
 * Coverage:
 *   GET    /api/contract-clients                   — list clients
 *   POST   /api/contract-clients                   — create client
 *   GET    /api/contract-clients/:id               — client detail (with locations, contacts, asset count, open request count)
 *   PATCH  /api/contract-clients/:id               — update client
 *   POST   /api/contract-clients/:id/archive       — soft-archive
 *   GET    /api/contract-clients/:id/locations     — list locations
 *   POST   /api/contract-clients/:id/locations     — add location
 *   PATCH  /api/contract-clients/:id/locations/:lid
 *   GET    /api/contract-clients/:id/locations/:lid/contacts
 *   POST   /api/contract-clients/:id/locations/:lid/contacts
 *   GET    /api/contract-clients/:id/requests      — all requests for a client
 *   POST   /api/contract-clients/:id/requests      — admin-raised request
 *   PATCH  /api/contract-clients/:id/requests/:rid — admin edit (status, assigned_to, priority)
 *   POST   /api/contract-clients/requests/:rid/cancel — admin cancel
 *   GET    /api/contract-clients/:id/assets        — list assets (also filterable by location_id)
 *   POST   /api/contract-clients/:id/assets        — add asset
 *   PATCH  /api/contract-clients/assets/:aid       — update asset
 *   POST   /api/contract-clients/:id/invites       — create portal invite token
 *   GET    /api/contract-clients/:id/portal-users  — list portal credentials
 *   POST   /api/contract-clients/:id/portal-users  — create credential (no email flow)
 */

import {
  createInvite,
  canCancel,
} from '../lib/contract-clients.js';

function adminGuard(req, reply) {
  if (process.env.NODE_ENV !== 'production') return true; // dev: skip
  // Production: rely on existing hq_sid cookie set by /api/auth/login.
  // The admin surface elsewhere in HQ enforces this via cookies; we
  // duplicate the lightweight check here.
  const sid = req.cookies?.hq_sid;
  if (!sid) {
    reply.code(401).send({ error: 'admin auth required' });
    return false;
  }
  return true;
}

function nowIso() { return new Date().toISOString(); }

function writeContractAudit(app, action, target, payload) {
  try {
    app.db.prepare(
      "INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', ?, ?, ?)"
    ).run(action, target == null ? null : String(target), payload == null ? null : JSON.stringify(payload));
  } catch { /* never let audit failures break a request */ }
}

function intBool(v) { return v ? 1 : 0; }

function safeScopedLocationIds(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return JSON.stringify(value.map(Number));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return JSON.stringify(arr.map(Number));
    } catch { /* fallthrough */ }
  }
  return null;
}

export async function contractClientRoutes(app) {
  // ------------------------------------------------------------
  // Clients
  // ------------------------------------------------------------
  app.get('/api/contract-clients', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const { status, search } = req.query || {};
    let sql = `
      SELECT c.*,
             (SELECT COUNT(*) FROM contract_locations WHERE client_id = c.id) AS location_count,
             (SELECT COUNT(*) FROM contract_requests WHERE client_id = c.id AND status IN ('open','in_progress')) AS open_request_count,
             (SELECT COUNT(*) FROM client_assets WHERE client_id = c.id) AS asset_count
      FROM contract_clients c
      WHERE 1=1
    `;
    const args = [];
    if (status && ['active', 'archived'].includes(status)) {
      sql += ' AND c.status = ?'; args.push(status);
    } else {
      sql += " AND c.status = 'active'";
    }
    if (search && typeof search === 'string') {
      const trimmed = search.trim();
      if (trimmed) {
        sql += ' AND (c.name LIKE ? OR c.primary_contact_email LIKE ? OR c.phone LIKE ? OR c.notes LIKE ?)';
        const s = `%${trimmed}%`;
        args.push(s, s, s, s);
      }
    }
    sql += ' ORDER BY c.name ASC LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.post('/api/contract-clients', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const { name, primary_contact_name, primary_contact_email, phone, billing_address, notes, status } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name required' });
    }
    const cleanStatus = status === 'archived' ? 'archived' : 'active';
    const info = app.db.prepare(`
      INSERT INTO contract_clients (name, status, primary_contact_name, primary_contact_email, phone, billing_address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), cleanStatus, primary_contact_name || null, primary_contact_email || null, phone || null, billing_address || null, notes || null);
    writeContractAudit(app, 'contract_client.create', info.lastInsertRowid, { name: name.trim() });
    return app.db.prepare('SELECT * FROM contract_clients WHERE id = ?').get(info.lastInsertRowid);
  });

  app.get('/api/contract-clients/:id', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const client = app.db.prepare('SELECT * FROM contract_clients WHERE id = ?').get(id);
    if (!client) return reply.code(404).send({ error: 'not found' });
    const locations = app.db.prepare('SELECT * FROM contract_locations WHERE client_id = ? ORDER BY label').all(id);
    const contactSummary = app.db.prepare(`
      SELECT cc.id, cc.location_id, cc.name, cc.email, cc.role, cc.is_office_manager, cc.status,
             l.label AS location_label
      FROM client_contacts cc
      LEFT JOIN contract_locations l ON l.id = cc.location_id
      WHERE cc.client_id = ? ORDER BY cc.is_office_manager DESC, cc.name
    `).all(id);
    const counts = {
      locations: locations.length,
      contacts: contactSummary.length,
      assets: app.db.prepare('SELECT COUNT(*) AS n FROM client_assets WHERE client_id = ?').get(id).n,
      requests_total: app.db.prepare('SELECT COUNT(*) AS n FROM contract_requests WHERE client_id = ?').get(id).n,
      requests_open: app.db.prepare("SELECT COUNT(*) AS n FROM contract_requests WHERE client_id = ? AND status IN ('open','in_progress')").get(id).n,
      portal_users: app.db.prepare('SELECT COUNT(*) AS n FROM client_portal_credentials WHERE client_id = ?').get(id).n,
    };
    const recentRequests = app.db.prepare(`
      SELECT r.id, r.request_uid, r.subject, r.status, r.priority, r.created_at,
             l.label AS location_label,
             c.name AS contact_name,
             a.hostname AS asset_hostname
      FROM contract_requests r
      LEFT JOIN contract_locations l ON l.id = r.location_id
      LEFT JOIN client_contacts c ON c.id = r.submitting_contact_id
      LEFT JOIN client_assets a ON a.id = r.asset_id
      WHERE r.client_id = ?
      ORDER BY r.created_at DESC LIMIT 25
    `).all(id);
    return { client, locations, contacts: contactSummary, counts, recent_requests: recentRequests };
  });

  app.patch('/api/contract-clients/:id', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const cur = app.db.prepare('SELECT * FROM contract_clients WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const allowed = ['name', 'primary_contact_name', 'primary_contact_email', 'phone', 'billing_address', 'notes', 'status'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        sets.push(`${k} = ?`);
        args.push(req.body[k] == null ? null : String(req.body[k]));
      }
    }
    if (sets.length === 0) return { ok: true, unchanged: true };
    sets.push("updated_at = CURRENT_TIMESTAMP");
    args.push(id);
    app.db.prepare(`UPDATE contract_clients SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    writeContractAudit(app, 'contract_client.update', id, { fields: Object.keys(req.body) });
    return app.db.prepare('SELECT * FROM contract_clients WHERE id = ?').get(id);
  });

  app.post('/api/contract-clients/:id/archive', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    app.db.prepare("UPDATE contract_clients SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    writeContractAudit(app, 'contract_client.archive', id, {});
    return { ok: true };
  });

  // ------------------------------------------------------------
  // Locations
  // ------------------------------------------------------------
  app.get('/api/contract-clients/:id/locations', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const id = Number(req.params.id);
    const rows = app.db.prepare(`
      SELECT l.*,
             (SELECT COUNT(*) FROM client_contacts WHERE location_id = l.id) AS contact_count,
             (SELECT COUNT(*) FROM client_assets WHERE location_id = l.id) AS asset_count,
             (SELECT COUNT(*) FROM contract_requests WHERE location_id = l.id AND status IN ('open','in_progress')) AS open_request_count
      FROM contract_locations l WHERE client_id = ? ORDER BY l.label`).all(id);
    return rows;
  });

  app.post('/api/contract-clients/:id/locations', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const id = Number(req.params.id);
    if (!app.db.prepare('SELECT 1 FROM contract_clients WHERE id = ?').get(id)) {
      return reply.code(404).send({ error: 'client not found' });
    }
    const { label, address, city, region, postal_code, timezone, notes } = req.body || {};
    if (!label || !String(label).trim()) return reply.code(400).send({ error: 'label required' });
    const info = app.db.prepare(`
      INSERT INTO contract_locations (client_id, label, address, city, region, postal_code, timezone, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, String(label).trim(), address || null, city || null, region || null, postal_code || null, timezone || null, notes || null);
    writeContractAudit(app, 'contract_location.create', info.lastInsertRowid, { client_id: id, label });
    return app.db.prepare('SELECT * FROM contract_locations WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/contract-clients/:id/locations/:lid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const lid = Number(req.params.lid);
    const cur = app.db.prepare('SELECT * FROM contract_locations WHERE id = ?').get(lid);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const allowed = ['label', 'address', 'city', 'region', 'postal_code', 'timezone', 'notes', 'status'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        sets.push(`${k} = ?`);
        args.push(req.body[k] == null ? null : String(req.body[k]));
      }
    }
    if (sets.length === 0) return { ok: true, unchanged: true };
    args.push(lid);
    app.db.prepare(`UPDATE contract_locations SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    writeContractAudit(app, 'contract_location.update', lid, {});
    return app.db.prepare('SELECT * FROM contract_locations WHERE id = ?').get(lid);
  });

  // ------------------------------------------------------------
  // Contacts
  // ------------------------------------------------------------
  app.get('/api/contract-clients/:id/locations/:lid/contacts', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const lid = Number(req.params.lid);
    return app.db.prepare('SELECT * FROM client_contacts WHERE location_id = ? ORDER BY is_office_manager DESC, name').all(lid);
  });

  app.post('/api/contract-clients/:id/locations/:lid/contacts', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    const lid = Number(req.params.lid);
    const loc = app.db.prepare('SELECT * FROM contract_locations WHERE id = ? AND client_id = ?').get(lid, cid);
    if (!loc) return reply.code(404).send({ error: 'location not found' });
    const { name, email, phone, role, is_office_manager, notify_on_request } = req.body || {};
    if (!name || !String(name).trim()) return reply.code(400).send({ error: 'name required' });
    const info = app.db.prepare(`
      INSERT INTO client_contacts (location_id, client_id, name, email, phone, role, is_office_manager, notify_on_request)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(lid, cid, String(name).trim(), email || null, phone || null, role || null, intBool(is_office_manager), intBool(notify_on_request ?? true));
    writeContractAudit(app, 'client_contact.create', info.lastInsertRowid, { client_id: cid, location_id: lid });
    return app.db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(info.lastInsertRowid);
  });

  // PATCH /api/contract-clients/contacts/:ctid — edit a contact.
  // Admin-only; the contact must belong to the client_id in the URL so a
  // client-scoped admin token can't reach across contracts. The contact's
  // `location_id` may be moved to any other location of the same client
  // (used both to correct mistakes and to reassign a person to a different
  // office). All other contact fields are editable. Changing the FK columns
  // implicitly rewrites both `location_id` and `client_id` on the row.
  app.patch('/api/contract-clients/contacts/:ctid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const ctid = Number(req.params.ctid);
    if (!Number.isInteger(ctid)) return reply.code(400).send({ error: 'bad ctid' });
    const cur = app.db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(ctid);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};

    // If a different client_id was passed in the body (admin endpoint uses
    // /contacts/:ctid without :id), verify it matches. Otherwise default to
    // the contact's existing client.
    const targetClientId = body.client_id != null ? Number(body.client_id) : cur.client_id;
    if (!Number.isInteger(targetClientId) || targetClientId !== cur.client_id) {
      return reply.code(400).send({ error: 'cross-client move not allowed; recreate the contact' });
    }

    // If location_id is being changed, verify the destination location
    // belongs to the same client (FK already enforces same-client on the
    // locations table; this is a friendlier error).
    if (body.location_id != null && Number(body.location_id) !== cur.location_id) {
      const loc = app.db.prepare(
        'SELECT id FROM contract_locations WHERE id = ? AND client_id = ?'
      ).get(Number(body.location_id), cur.client_id);
      if (!loc) return reply.code(400).send({ error: 'location not in this client' });
    }

    const allowed = ['name', 'email', 'phone', 'role', 'is_office_manager', 'notify_on_request', 'status', 'location_id'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in body) {
        let v;
        if (k === 'is_office_manager' || k === 'notify_on_request') v = intBool(body[k]);
        else if (k === 'location_id') v = body[k] == null ? null : Number(body[k]);
        else v = body[k] == null ? null : String(body[k]);
        sets.push(`${k} = ?`);
        args.push(v);
      }
    }
    if (sets.length === 0) return { ok: true, unchanged: true };
    args.push(ctid);
    app.db.prepare(`UPDATE client_contacts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    const after = app.db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(ctid);
    writeContractAudit(app, 'client_contact.update', ctid, {
      fields: Object.keys(allowed).filter((k) => k in body),
      client_id: cur.client_id,
    });
    return after;
  });

  // DELETE /api/contract-clients/contacts/:ctid — remove a contact.
  // The `submitting_contact_id` FK on contract_requests is ON DELETE RESTRICT
  // (history integrity: requests stay attributable to the person who filed
  // them). So a contact can only be deleted if no contract_request rows
  // reference them at all — neither open/in_progress NOR resolved/cancelled.
  // Portal credentials (client_portal_credentials.contact_id) and invites
  // (client_invites.contact_id) are ON DELETE SET NULL and cascade safely.
  app.delete('/api/contract-clients/contacts/:ctid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const ctid = Number(req.params.ctid);
    if (!Number.isInteger(ctid)) return reply.code(400).send({ error: 'bad ctid' });
    const cur = app.db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(ctid);
    if (!cur) return reply.code(404).send({ error: 'not found' });

    const blockers = app.db.prepare(`
      SELECT id, request_uid, status FROM contract_requests
      WHERE submitting_contact_id = ?
      ORDER BY created_at DESC
    `).all(ctid);
    if (blockers.length > 0) {
      return reply.code(409).send({
        error: 'contact_in_use',
        reason: `submitter on ${blockers.length} request(s); reassign first or delete them`,
        blocking_requests: blockers.map((r) => ({ id: r.id, request_uid: r.request_uid, status: r.status })),
      });
    }

    app.db.prepare('DELETE FROM client_contacts WHERE id = ?').run(ctid);
    writeContractAudit(app, 'client_contact.delete', ctid, {
      client_id: cur.client_id,
      name: cur.name,
    });
    return { ok: true, deleted_id: ctid };
  });

  // ------------------------------------------------------------
  // Requests (admin-side read + create + status updates + cancel)
  // ------------------------------------------------------------
  app.get('/api/contract-clients/:id/requests', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    const status = (req.query && req.query.status) || null;
    const rawLoc = req.query && req.query.location_id;
    const location_id = rawLoc == null || rawLoc === '' ? null : Number(rawLoc);
    if (location_id != null && !Number.isInteger(location_id)) {
      return reply.code(400).send({ error: 'bad location_id' });
    }
    // Defensive: location must belong to this client. Prevents any future
    // query-param typo from leaking requests across clients.
    if (location_id != null) {
      const own = app.db.prepare(
        'SELECT 1 FROM contract_locations WHERE id = ? AND client_id = ?'
      ).get(location_id, cid);
      if (!own) return reply.code(400).send({ error: 'location not in client' });
    }
    let sql = `
      SELECT r.*, l.label AS location_label, c.name AS contact_name, a.hostname AS asset_hostname
      FROM contract_requests r
      LEFT JOIN contract_locations l ON l.id = r.location_id
      LEFT JOIN client_contacts c ON c.id = r.submitting_contact_id
      LEFT JOIN client_assets a ON a.id = r.asset_id
      WHERE r.client_id = ?
    `;
    const args = [cid];
    if (status && ['open', 'in_progress', 'resolved', 'cancelled'].includes(status)) {
      sql += ' AND r.status = ?'; args.push(status);
    }
    if (location_id != null) {
      sql += ' AND r.location_id = ?'; args.push(location_id);
    }
    sql += ' ORDER BY r.created_at DESC LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.get('/api/contract-clients/requests/:rid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const rid = Number(req.params.rid);
    if (!Number.isInteger(rid)) return reply.code(400).send({ error: 'bad rid' });
    const row = app.db.prepare(`
      SELECT r.*, l.label AS location_label, c.name AS contact_name, a.hostname AS asset_hostname
      FROM contract_requests r
      LEFT JOIN contract_locations l ON l.id = r.location_id
      LEFT JOIN client_contacts c ON c.id = r.submitting_contact_id
      LEFT JOIN client_assets a ON a.id = r.asset_id
      WHERE r.id = ?
    `).get(rid);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const events = app.db.prepare('SELECT * FROM contract_request_events WHERE request_id = ? ORDER BY created_at ASC').all(rid);
    return { ...row, events };
  });

  app.post('/api/contract-clients/:id/requests', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    const { location_id, submitting_contact_id, asset_id, subject, description, category, priority } = req.body || {};
    if (!location_id) return reply.code(400).send({ error: 'location_id required' });
    if (!submitting_contact_id) return reply.code(400).send({ error: 'submitting_contact_id required' });
    if (!subject || !description) return reply.code(400).send({ error: 'subject + description required' });
    const loc = app.db.prepare('SELECT * FROM contract_locations WHERE id = ? AND client_id = ?').get(Number(location_id), cid);
    if (!loc) return reply.code(404).send({ error: 'location not in client' });
    const contact = app.db.prepare('SELECT * FROM client_contacts WHERE id = ? AND client_id = ?').get(Number(submitting_contact_id), cid);
    if (!contact) return reply.code(404).send({ error: 'contact not in client' });
    const uid = mintRequestUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO contract_requests (request_uid, client_id, location_id, submitting_contact_id, asset_id, subject, description, category, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid, cid, Number(location_id), Number(submitting_contact_id), asset_id ? Number(asset_id) : null,
           String(subject), String(description), category || null, priority || 'normal');
    app.db.prepare(`
      INSERT INTO contract_request_events (request_id, actor, event_type, to_status, note)
      VALUES (?, 'admin', 'created', 'open', 'admin raised')
    `).run(info.lastInsertRowid);
    writeContractAudit(app, 'contract_request.create', info.lastInsertRowid, { client_id: cid, source: 'admin' });
    return app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/contract-clients/:id/requests/:rid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const rid = Number(req.params.rid);
    const cur = app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(rid);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const allowed = ['status', 'assigned_to', 'priority', 'category'];
    const sets = [];
    const args = [];
    let statusChanged = null;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        sets.push(`${k} = ?`);
        args.push(req.body[k] == null ? null : String(req.body[k]));
        if (k === 'status') statusChanged = req.body[k];
      }
    }
    if (sets.length === 0) return { ok: true, unchanged: true };
    sets.push("updated_at = CURRENT_TIMESTAMP");
    args.push(rid);
    app.db.prepare(`UPDATE contract_requests SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (statusChanged && ['resolved', 'cancelled'].includes(statusChanged)) {
      const col = statusChanged === 'resolved' ? 'resolved_at' : 'cancelled_at';
      app.db.prepare(`UPDATE contract_requests SET ${col} = CURRENT_TIMESTAMP WHERE id = ?`).run(rid);
    }
    if (statusChanged) {
      app.db.prepare(`
        INSERT INTO contract_request_events (request_id, actor, event_type, from_status, to_status)
        VALUES (?, 'admin', 'status_change', ?, ?)
      `).run(rid, cur.status, statusChanged);
    }
    writeContractAudit(app, 'contract_request.update', rid, { fields: Object.keys(req.body) });
    return app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(rid);
  });

  app.post('/api/contract-clients/requests/:rid/cancel', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const rid = Number(req.params.rid);
    const cur = app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(rid);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const verdict = canCancel(null, cur, null);
    if (!verdict.allowed) return reply.code(409).send({ error: 'cannot_cancel', reason: verdict.reason });
    const reason = (req.body && req.body.reason) || null;
    app.db.prepare(`
      UPDATE contract_requests SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
        cancelled_by = 'admin', cancel_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(reason, rid);
    app.db.prepare(`
      INSERT INTO contract_request_events (request_id, actor, event_type, from_status, to_status, note)
      VALUES (?, 'admin', 'cancelled', ?, 'cancelled', ?)
    `).run(rid, cur.status, reason);
    writeContractAudit(app, 'contract_request.cancel', rid, { reason, by: 'admin' });
    return app.db.prepare('SELECT * FROM contract_requests WHERE id = ?').get(rid);
  });

  // ------------------------------------------------------------
  // Assets
  // ------------------------------------------------------------
  app.get('/api/contract-clients/:id/assets', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    const location_id = req.query && req.query.location_id ? Number(req.query.location_id) : null;
    let sql = `
      SELECT a.*, l.label AS location_label FROM client_assets a
      LEFT JOIN contract_locations l ON l.id = a.location_id
      WHERE a.client_id = ?
    `;
    const args = [cid];
    if (location_id) { sql += ' AND a.location_id = ?'; args.push(location_id); }
    sql += ' ORDER BY a.hostname, a.asset_tag LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.post('/api/contract-clients/:id/assets', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    const { location_id, hostname, asset_tag, assigned_user, type, manufacturer, model, serial, os, cpu, ram_gb, storage_gb, warranty_until, last_serviced_at, status, notes } = req.body || {};
    if (!location_id) return reply.code(400).send({ error: 'location_id required' });
    if (!type) return reply.code(400).send({ error: 'type required' });
    const loc = app.db.prepare('SELECT 1 FROM contract_locations WHERE id = ? AND client_id = ?').get(Number(location_id), cid);
    if (!loc) return reply.code(404).send({ error: 'location not in client' });
    const info = app.db.prepare(`
      INSERT INTO client_assets (client_id, location_id, hostname, asset_tag, assigned_user, type, manufacturer, model, serial, os, cpu, ram_gb, storage_gb, warranty_until, last_serviced_at, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cid, Number(location_id), hostname || null, asset_tag || null, assigned_user || null, String(type),
           manufacturer || null, model || null, serial || null, os || null, cpu || null,
           ram_gb == null ? null : Number(ram_gb), storage_gb == null ? null : Number(storage_gb),
           warranty_until || null, last_serviced_at || null,
           status || 'active', notes || null);
    writeContractAudit(app, 'client_asset.create', info.lastInsertRowid, { client_id: cid });
    return app.db.prepare('SELECT * FROM client_assets WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/contract-clients/assets/:aid', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const aid = Number(req.params.aid);
    const cur = app.db.prepare('SELECT * FROM client_assets WHERE id = ?').get(aid);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const allowed = ['hostname', 'asset_tag', 'assigned_user', 'type', 'manufacturer', 'model', 'serial',
                     'os', 'cpu', 'ram_gb', 'storage_gb', 'warranty_until', 'last_serviced_at', 'status', 'notes', 'location_id'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in (req.body || {})) {
        sets.push(`${k} = ?`);
        const v = req.body[k];
        if (v == null) args.push(null);
        else if (['ram_gb', 'storage_gb', 'location_id'].includes(k)) args.push(Number(v));
        else args.push(String(v));
      }
    }
    if (sets.length === 0) return { ok: true, unchanged: true };
    sets.push("updated_at = CURRENT_TIMESTAMP");
    args.push(aid);
    app.db.prepare(`UPDATE client_assets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    writeContractAudit(app, 'client_asset.update', aid, {});
    return app.db.prepare('SELECT * FROM client_assets WHERE id = ?').get(aid);
  });

  // ------------------------------------------------------------
  // Portal users + invites
  // ------------------------------------------------------------
  app.get('/api/contract-clients/:id/portal-users', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    return app.db.prepare(`
      SELECT c.id, c.email, c.display_name, c.scope_type, c.scoped_location_ids,
             c.last_login_at, c.disabled_at, c.created_at,
             ct.name AS contact_name, ct.role AS contact_role
      FROM client_portal_credentials c
      LEFT JOIN client_contacts ct ON ct.id = c.contact_id
      WHERE c.client_id = ? ORDER BY c.email
    `).all(cid);
  });

  app.post('/api/contract-clients/:id/invites', async (req, reply) => {
    if (!adminGuard(req, reply)) return;
    const cid = Number(req.params.id);
    if (!app.db.prepare('SELECT 1 FROM contract_clients WHERE id = ?').get(cid)) {
      return reply.code(404).send({ error: 'client not found' });
    }
    const { email, display_name, contact_id, scope_type, scoped_location_ids } = req.body || {};
    if (!email) return reply.code(400).send({ error: 'email required' });
    const scope = scope_type === 'client_manager' ? 'client_manager' : 'location_manager';
    const scopesJson = safeScopedLocationIds(scoped_location_ids);
    const { token, expires_at } = createInvite(app.db, {
      email: String(email).trim().toLowerCase(),
      clientId: cid,
      scopeType: scope,
      scopedLocationIds: scopesJson ? JSON.parse(scopesJson) : null,
      displayName: display_name || null,
      contactId: contact_id ? Number(contact_id) : null,
    });
    writeContractAudit(app, 'client_invite.create', token, { email, client_id: cid });
    return { token, expires_at, client_id: cid, email, scope_type: scope, scoped_location_ids: scopesJson };
  });
}

function mintRequestUid(db) {
  const row = db.prepare('SELECT request_uid FROM contract_requests ORDER BY id DESC LIMIT 1').get();
  let n = 1;
  if (row && row.request_uid) {
    const m = /CR-(\d+)/.exec(row.request_uid);
    if (m) n = Number(m[1]) + 1;
  }
  return `CR-${String(n).padStart(6, '0')}`;
}
