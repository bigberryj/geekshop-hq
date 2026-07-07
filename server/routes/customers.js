/**
 * Customer CRUD + health score.
 */

export async function customerRoutes(app) {
  // List (with health score)
  app.get('/api/customers', async (req, reply) => {
    const { search, status } = req.query;

    // Validate status parameter
    if (status && !['active', 'archived'].includes(status)) {
      return reply.code(400).send({ error: 'status must be active or archived' });
    }

    let sql = `
      SELECT c.id, c.name, c.company, c.email, c.phone, c.notes, c.created_at, c.status,
             (SELECT MAX(m.created_at) FROM ticket_messages m JOIN tickets t ON m.ticket_id = t.id WHERE t.customer_id = c.id) as last_contact,
             (SELECT COUNT(*) FROM tickets WHERE customer_id = c.id) as total_tickets,
             (SELECT COUNT(*) FROM tickets WHERE customer_id = c.id AND status = 'resolved') as resolved_tickets,
             (SELECT COUNT(*) FROM customer_memory WHERE customer_id = c.id) as memory_count,
             (SELECT COUNT(*) FROM invoices WHERE customer_id = c.id AND status IN ('sent','overdue')) as open_invoices
      FROM customers c
      WHERE 1=1
    `;
    const args = [];

    // Add search filter
    if (search) {
      // Trim search term
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        sql += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.notes LIKE ?)';
        const s = `%${trimmedSearch}%`;
        args.push(s, s, s, s, s);
      }
    }

    // Add status filter
    if (status) {
      sql += ' AND c.status = ?';
      args.push(status);
    }

    sql += ' ORDER BY c.name ASC LIMIT 200';

    const rows = app.db.prepare(sql).all(...args);
    // Compute health score inline
    return rows.map((c) => {
      const last = c.last_contact ? new Date(c.last_contact) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : 999;
      const recency = Math.max(0, 100 - days * 3);
      const volume = Math.max(0, 100 - c.total_tickets * 4);
      const balance = Math.max(0, 100 - c.open_invoices * 30);
      const score = Math.round((recency * 0.4 + volume * 0.2 + balance * 0.4));
      const band = score > 70 ? 'green' : score >= 40 ? 'yellow' : 'red';
      return { ...c, health_score: score, health_band: band };
    });
  });

  // Create
  app.post('/api/customers', async (req, reply) => {
    const { name, company, email, phone, notes, billing_address, shipping_address, tax_number, status } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const cleanStatus = status == null || status === '' ? 'active' : String(status);
    if (!['active', 'archived'].includes(cleanStatus)) {
      return reply.code(400).send({ error: 'status must be active or archived' });
    }
    const info = app.db.prepare(`
      INSERT INTO customers (name, company, email, phone, notes,
                             billing_address, shipping_address, tax_number, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      company || null,
      email || null,
      phone || null,
      notes || null,
      billing_address || null,
      shipping_address || null,
      tax_number || null,
      cleanStatus,
    );
    app.db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'customer.create', ?, ?)")
      .run(String(info.lastInsertRowid), JSON.stringify({ name, company, email }));
    return { id: info.lastInsertRowid };
  });

  // Detail
  app.get('/api/customers/:id', async (req, reply) => {
    const c = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    const tickets = app.db.prepare('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
    const memory = app.db.prepare('SELECT * FROM customer_memory WHERE customer_id = ? ORDER BY category, created_at').all(req.params.id);
    const time_total = app.db.prepare(`
      SELECT COALESCE(SUM(te.duration_seconds), 0) as total_seconds
      FROM time_entries te JOIN tickets t ON te.ticket_id = t.id
      WHERE t.customer_id = ? AND te.duration_seconds IS NOT NULL
    `).get(req.params.id);
    const invoices = app.db.prepare('SELECT id, invoice_uid, status, total_cents, sent_at, due_at, paid_at FROM invoices WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
    return { ...c, tickets, memory, total_time_seconds: time_total.total_seconds, invoices };
  });

  // Update — partial-update endpoint. Whitelists columns so a caller can't
  // overwrite `id`, `created_at`, or any other protected field. Empty
  // string → NULL for nullable fields so the UI can clear values.
  const UPDATABLE = ['name', 'company', 'email', 'phone', 'notes',
                     'billing_address', 'shipping_address', 'tax_number', 'status'];
  const updateHandler = async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const existing = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};
    // Name is NOT NULL; reject clearing it.
    if (Object.prototype.hasOwnProperty.call(body, 'name') && !String(body.name).trim()) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    // Status is enum-validated; reject unknown values explicitly so a typo
    // doesn't get silently coerced to "active" via the column default.
    if (Object.prototype.hasOwnProperty.call(body, 'status') && !['active', 'archived'].includes(String(body.status))) {
      return reply.code(400).send({ error: 'status must be active or archived' });
    }
    const updates = [];
    const params = [];
    for (const k of UPDATABLE) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        const v = body[k];
        updates.push(`${k} = ?`);
        params.push(v === '' ? null : v);
      }
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'no fields to update' });
    params.push(id);
    app.db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    // Audit log payload uses the SAME keys that were actually updated.
    // Map the SQL fragments ("name = ?") back to the field name ("name")
    // so the audit row tells you which fields changed and to what value.
    const changedFields = {};
    for (const frag of updates) {
      const key = frag.split(' = ')[0].trim();
      changedFields[key] = body[key];
    }
    app.db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'customer.update', ?, ?)")
      .run(String(id), JSON.stringify(changedFields));
    return app.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  };
  app.put('/api/customers/:id', updateHandler);
  app.patch('/api/customers/:id', updateHandler);

  // ─────────────────────────────────────────────────────────────────────
  // Customer 360 timeline (Phase 2 of billing/accounting roadmap)
  //
  // Returns a normalized, time-ordered feed of everything HQ knows about
  // a customer. Six event kinds, all from existing tables:
  //   ticket_created   — a new ticket was opened
  //   ticket_resolved  — ticket moved to resolved state
  //   ticket_message   — new message in a ticket thread
  //   appointment      — booking from public /book page
  //   time_entry       — timer start/stop/billable stop
  //   invoice          — invoice created/sent/paid
  //   payment          — payment received (only shown once invoice is in
  //                      the picture)
  //   memory           — manual or AI-extracted customer memory entry
  //
  // Response shape: `{ events: [...], counts: {...}, generated_at }`.
  // Each event has `{ id, kind, at, title, summary, href, meta }` so the UI
  // can render a unified feed without per-kind branches on the server.
  //
  // Privacy — explicitly do NOT expose:
  //   - raw Gmail Message-ID / In-Reply-To headers (audit only)
  //   - Stripe `payment_intent.id` / `charge.id` (audit only)
  //   - ticket_messages.body_html (sanitized HTML, may contain PII)
  //   - long bodies are truncated client-render-side too, but the
  //     server also caps `summary` at 240 chars so log scrubs stay safe
  //
  // Filters:
  //   ?kinds=ticket,ticket_message   comma-separated allow-list
  //   ?from=ISO8601                   inclusive lower bound
  //   ?to=ISO8601                     exclusive upper bound
  //   ?limit=N                        default 200, clamped [1, 1000]
  // ─────────────────────────────────────────────────────────────────────
  const TIMELINE_KINDS = new Set([
    'ticket_created', 'ticket_resolved', 'ticket_message',
    'appointment', 'time_entry',
    'invoice', 'payment', 'memory',
  ]);

  app.get('/api/customers/:id/timeline', async (req, reply) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId)) return reply.code(400).send({ error: 'invalid customer id' });

    const customer = app.db.prepare('SELECT id, name, email, status FROM customers WHERE id = ?').get(customerId);
    if (!customer) return reply.code(404).send({ error: 'customer not found' });

    // Parse filters defensively. Invalid values produce empty results
    // rather than 400s, because the UI never sends them invalid; we want
    // a noisy response to surface upstream bugs, not break the page.
    const kindsParam = String(req.query.kinds || '').trim();
    const kindsAllowed = kindsParam
      ? new Set(kindsParam.split(',').map((k) => k.trim()).filter((k) => TIMELINE_KINDS.has(k)))
      : TIMELINE_KINDS;

    const from = String(req.query.from || '').trim() || null;
    const to = String(req.query.to || '').trim() || null;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    if (limit > 1000) limit = 1000;

    const events = [];

    // Helper to truncate bodies so we never ship a 10kB plain-text blob
    // through the timeline endpoint. Customer messages are far shorter in
    // practice but defence-in-depth — and the response is JSON logged by
    // some operations scripts.
    const trunc = (s, n = 240) => {
      if (s == null) return '';
      const str = String(s);
      return str.length > n ? str.slice(0, n).trimEnd() + '…' : str;
    };

    // 1. Ticket lifecycle: created + resolved. Distinct kinds so the UI
    // can badge them differently from a regular ticket_message.
    // Soft-deleted tickets are excluded — the operator shouldn't see
    // history noise for tickets they've cleaned up.
    if (kindsAllowed.has('ticket_created')) {
      const rows = app.db.prepare(`
        SELECT id, ticket_uid, subject, status, priority, created_at
        FROM tickets
        WHERE customer_id = ? AND deleted_at IS NULL
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at < ?)
        ORDER BY created_at DESC
      `).all(customerId, from, from, to, to);
      for (const r of rows) {
        events.push({
          id: `ticket_created:${r.id}`,
          kind: 'ticket_created',
          at: r.created_at,
          title: `Ticket opened: ${r.subject}`,
          summary: `${r.ticket_uid} · priority ${r.priority}`,
          href: `/tickets/${r.id}`,
          meta: { ticket_id: r.id, ticket_uid: r.ticket_uid, priority: r.priority, status: r.status },
        });
      }
    }

    if (kindsAllowed.has('ticket_resolved')) {
      const rows = app.db.prepare(`
        SELECT id, ticket_uid, subject, resolved_at
        FROM tickets
        WHERE customer_id = ? AND resolved_at IS NOT NULL AND deleted_at IS NULL
          AND (? IS NULL OR resolved_at >= ?)
          AND (? IS NULL OR resolved_at < ?)
        ORDER BY resolved_at DESC
      `).all(customerId, from, from, to, to);
      for (const r of rows) {
        events.push({
          id: `ticket_resolved:${r.id}`,
          kind: 'ticket_resolved',
          at: r.resolved_at,
          title: `Ticket resolved: ${r.subject}`,
          summary: r.ticket_uid,
          href: `/tickets/${r.id}`,
          meta: { ticket_id: r.id, ticket_uid: r.ticket_uid },
        });
      }
    }

    // 2. Messages. Customer-facing only — `sender` is one of {admin, customer, system}.
    //    `body_html` and `gmail_message_id` are deliberately not projected.
    //    Soft-deleted tickets are excluded so the timeline stops showing
    //    message traffic for tickets the operator has cleaned up.
    if (kindsAllowed.has('ticket_message')) {
      const rows = app.db.prepare(`
        SELECT m.id, m.ticket_id, m.sender, m.body, m.ai_draft, m.created_at,
               m.body_html IS NOT NULL AS has_html,
               t.ticket_uid
        FROM ticket_messages m
        JOIN tickets t ON m.ticket_id = t.id
        WHERE t.customer_id = ? AND t.deleted_at IS NULL
          AND (? IS NULL OR m.created_at >= ?)
          AND (? IS NULL OR m.created_at < ?)
        ORDER BY m.created_at DESC
      `).all(customerId, from, from, to, to);
      for (const m of rows) {
        events.push({
          id: `ticket_message:${m.id}`,
          kind: 'ticket_message',
          at: m.created_at,
          title: m.sender === 'customer'
            ? `Customer reply on ${m.ticket_uid}`
            : m.sender === 'admin'
              ? `${m.ai_draft ? 'AI-drafted reply' : 'Reply'} on ${m.ticket_uid}`
              : `System note on ${m.ticket_uid}`,
          summary: trunc(m.body, 240),
          href: `/tickets/${m.ticket_id}`,
          meta: {
            ticket_id: m.ticket_id,
            ticket_uid: m.ticket_uid,
            sender: m.sender,
            ai_draft: !!m.ai_draft,
            has_html: !!m.has_html,
          },
        });
      }
    }

    // 3. Appointments. Match either by `customer_id` OR by email fallback
    //    (legacy public bookings created a customer_email but no
    //    customer_id until later import). Email fallback is case-folded
    //    and uses the customer's stored email.
    if (kindsAllowed.has('appointment')) {
      const emailMatch = customer.email ? customer.email.toLowerCase() : null;
      const rows = app.db.prepare(`
        SELECT id, customer_name, customer_email, starts_at, ends_at, status, notes, booking_slug
        FROM appointments
        WHERE (
              customer_id = ?
              OR ( ? IS NOT NULL AND LOWER(IFNULL(customer_email, '')) = ? )
            )
          AND (? IS NULL OR starts_at >= ?)
          AND (? IS NULL OR starts_at < ?)
        ORDER BY starts_at DESC
      `).all(customerId, emailMatch, emailMatch, from, from, to, to);
      for (const a of rows) {
        events.push({
          id: `appointment:${a.id}`,
          kind: 'appointment',
          at: a.starts_at,
          title: `Appointment: ${a.booking_slug || 'general'}`,
          summary: trunc(a.notes, 240),
          href: `/appointments`,
          meta: {
            appointment_id: a.id,
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            status: a.status,
            booking_slug: a.booking_slug,
          },
        });
      }
    }

    // 4. Time entries. Use `stopped_at` for completed timers, fall back
    //    to `started_at` so in-progress timers show up too. value_cents
    //    isn't computed here (leakage endpoint already owns that); we
    //    just surface the duration so the timeline shows "what work
    //    happened on this customer, when".
    if (kindsAllowed.has('time_entry')) {
      const rows = app.db.prepare(`
        SELECT te.id, te.ticket_id, te.started_at, te.stopped_at, te.duration_seconds, te.note, te.invoiced_at,
               t.ticket_uid
        FROM time_entries te
        JOIN tickets t ON te.ticket_id = t.id
        WHERE t.customer_id = ?
          AND (? IS NULL OR COALESCE(te.stopped_at, te.started_at) >= ?)
          AND (? IS NULL OR COALESCE(te.stopped_at, te.started_at) < ?)
        ORDER BY COALESCE(te.stopped_at, te.started_at) DESC
      `).all(customerId, from, from, to, to);
      for (const te of rows) {
        const running = !te.stopped_at;
        events.push({
          id: `time_entry:${te.id}`,
          kind: 'time_entry',
          at: te.stopped_at || te.started_at,
          title: running ? `Time entry started on ${te.ticket_uid}` : `Time entry stopped on ${te.ticket_uid}`,
          summary: te.note ? trunc(te.note, 240) : `${te.duration_seconds || 0}s`,
          href: `/tickets/${te.ticket_id}`,
          meta: {
            time_entry_id: te.id,
            ticket_id: te.ticket_id,
            ticket_uid: te.ticket_uid,
            duration_seconds: te.duration_seconds || 0,
            running,
            invoiced: !!te.invoiced_at,
          },
        });
      }
    }

    // 5. Invoices. Only safe columns: status, totals, dates. line_items
    //    JSON is omitted from timeline view (heavier than necessary; the
    //    invoice detail endpoint serves that).
    if (kindsAllowed.has('invoice')) {
      const rows = app.db.prepare(`
        SELECT id, invoice_uid, status, subtotal_cents, tax_cents, total_cents,
               created_at, sent_at, due_at, paid_at
        FROM invoices
        WHERE customer_id = ?
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at < ?)
        ORDER BY created_at DESC
      `).all(customerId, from, from, to, to);
      for (const inv of rows) {
        // Synthesize an `at` per state change so an invoice that was
        // created, sent, and paid shows up as separate timeline dots in
        // the right order.
        const states = [];
        states.push({ at: inv.created_at, sub: 'created' });
        if (inv.sent_at) states.push({ at: inv.sent_at, sub: 'sent' });
        if (inv.paid_at) states.push({ at: inv.paid_at, sub: 'paid' });
        for (const s of states) {
          if (from && s.at < from) continue;
          if (to && s.at >= to) continue;
          events.push({
            id: `invoice:${inv.id}:${s.sub}`,
            kind: 'invoice',
            at: s.at,
            title: `Invoice ${inv.invoice_uid} ${s.sub} ($${(inv.total_cents / 100).toFixed(2)})`,
            summary: `Status: ${inv.status}`,
            href: `/invoices`,
            meta: {
              invoice_id: inv.id,
              invoice_uid: inv.invoice_uid,
              status: inv.status,
              state: s.sub,
              subtotal_cents: inv.subtotal_cents,
              tax_cents: inv.tax_cents,
              total_cents: inv.total_cents,
            },
          });
        }
      }
    }

    // 6. Payments. `stripe_payment_intent_id` and `stripe_charge_id` are
    //    deliberately not projected — those are Stripe audit keys; the UI
    //    only ever needs `method`, `amount`, and `status`.
    if (kindsAllowed.has('payment')) {
      const rows = app.db.prepare(`
        SELECT p.id, p.invoice_id, p.amount_cents, p.method, p.status, p.received_at, p.notes,
               i.invoice_uid
        FROM payments p
        JOIN invoices i ON p.invoice_id = i.id
        WHERE i.customer_id = ?
          AND (? IS NULL OR p.received_at >= ?)
          AND (? IS NULL OR p.received_at < ?)
        ORDER BY p.received_at DESC
      `).all(customerId, from, from, to, to);
      for (const p of rows) {
        events.push({
          id: `payment:${p.id}`,
          kind: 'payment',
          at: p.received_at,
          title: `Payment received (${p.method}) on ${p.invoice_uid}`,
          summary: p.notes ? trunc(p.notes, 240) : `$${(p.amount_cents / 100).toFixed(2)}`,
          href: `/invoices`,
          meta: {
            payment_id: p.id,
            invoice_id: p.invoice_id,
            invoice_uid: p.invoice_uid,
            amount_cents: p.amount_cents,
            method: p.method,
            status: p.status,
          },
        });
      }
    }

    // 7. Customer memory entries. These are admin-curated, so they're
    //    safe to render as-is. `confidence` is a float kept on meta so the
    //    UI can show a low-confidence badge when source='ai'.
    if (kindsAllowed.has('memory')) {
      const rows = app.db.prepare(`
        SELECT id, category, key, value, source, confidence, created_at
        FROM customer_memory
        WHERE customer_id = ?
          AND (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at < ?)
        ORDER BY created_at DESC
      `).all(customerId, from, from, to, to);
      for (const m of rows) {
        events.push({
          id: `memory:${m.id}`,
          kind: 'memory',
          at: m.created_at,
          title: `Memory · ${m.category}${m.key ? ` · ${m.key}` : ''}`,
          summary: trunc(m.value, 240),
          href: null,
          meta: {
            memory_id: m.id,
            category: m.category,
            key: m.key,
            source: m.source,
            confidence: m.confidence,
          },
        });
      }
    }

    // Sort newest first, then apply limit. Sorting then limiting (vs SQL
    // UNION ALL) keeps the SQL simple — 6 subqueries is easy to audit;
    // a UNION ALL with custom ordering would not be.
    events.sort((a, b) => {
      if (a.at === b.at) return 0;
      // SQLite returns ISO-ish strings; lexicographic compare matches
      // chronological order for the same shape. If one is null we let it
      // sink to the bottom.
      if (!a.at) return 1;
      if (!b.at) return -1;
      return a.at < b.at ? 1 : -1;
    });
    const limited = events.slice(0, limit);

    // Counts per kind — useful for filter chips in the UI without
    // re-querying. Single pass over the (already capped) full result so
    // the numbers reflect what was eligible for this filter set.
    const counts = {};
    for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;

    return {
      events: limited,
      counts,
      generated_at: new Date().toISOString(),
      customer: { id: customer.id, name: customer.name, email: customer.email, status: customer.status },
    };
  });
}
