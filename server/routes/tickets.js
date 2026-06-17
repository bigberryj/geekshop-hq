/**
 * Ticket CRUD + AI endpoints.
 */

import { aiCall } from '../lib/ai.js';
import { buildStyleProfile, recordStyleFeedback } from '../lib/style.js';
import { sendEmail } from '../lib/email.js';
import { markThreadDone } from '../lib/email-inbox.js';
import { readAttachmentBuffer } from '../lib/attachments.js';
import { appendSignature } from '../lib/signature.js';

function nextTicketUid(db) {
  const last = db.prepare("SELECT ticket_uid FROM tickets ORDER BY id DESC LIMIT 1").get();
  const n = last ? Number(last.ticket_uid.split('-')[1]) + 1 : 1;
  return `G-${String(n).padStart(6, '0')}`;
}

export async function ticketRoutes(app) {
  // List
  // `status` can be a single value ("open") or a comma list
  // ("open,pending"). Empty/missing means "all statuses".
  app.get('/api/tickets', async (req) => {
    const { status, customer_id } = req.query;
    let sql = `
      SELECT t.*, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE 1=1
    `;
    const args = [];
    if (status) {
      const parts = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 1) {
        sql += ' AND t.status = ?';
        args.push(parts[0]);
      } else if (parts.length > 1) {
        sql += ` AND t.status IN (${parts.map(() => '?').join(',')})`;
        args.push(...parts);
      }
    }
    if (customer_id) { sql += ' AND t.customer_id = ?'; args.push(customer_id); }
    sql += ' ORDER BY t.last_message_at DESC, t.id DESC LIMIT 200';
    return app.db.prepare(sql).all(...args);
  });

  // Create
  app.post('/api/tickets', async (req, reply) => {
    const { customer_id, subject, body, priority } = req.body || {};
    if (!customer_id || !subject) return reply.code(400).send({ error: 'customer_id and subject required' });
    const uid = nextTicketUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO tickets (ticket_uid, customer_id, subject, priority, last_message_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(uid, customer_id, subject, priority || 'normal');
    if (body) {
      app.db.prepare(`
        INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)
      `).run(info.lastInsertRowid, body);
    }
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.create', ?)").run(String(info.lastInsertRowid));
    return { id: info.lastInsertRowid, ticket_uid: uid };
  });

  // Detail
  app.get('/api/tickets/:id', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.name as customer_name, c.email as customer_email, c.id as customer_id
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare(`
      SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC
    `).all(req.params.id);
    // Attach each message's attachments. Inlined into the response so
    // the frontend can render images in <EmailBody /> and list files
    // without a second round-trip per message.
    for (const m of messages) {
      m.attachments = app.db.prepare(`
        SELECT id, filename, mime_type, size_bytes, content_id, disposition
        FROM ticket_message_attachments
        WHERE ticket_message_id = ?
        ORDER BY id ASC
      `).all(m.id);
    }
    const memory = app.db.prepare(`
      SELECT * FROM customer_memory WHERE customer_id = ? AND confidence >= 0.6
      ORDER BY category, created_at
    `).all(t.customer_id);
    return { ...t, messages, customer_memory: memory };
  });

  // Reply
  app.post('/api/tickets/:id/messages', async (req, reply) => {
    const { body, ai_draft } = req.body || {};
    if (!body) return reply.code(400).send({ error: 'body required' });
    const t = app.db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    app.db.prepare(`
      INSERT INTO ticket_messages (ticket_id, sender, body, ai_draft) VALUES (?, 'admin', ?, ?)
    `).run(req.params.id, body, ai_draft ? 1 : 0);
    app.db.prepare('UPDATE tickets SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // AI draft. Reads the latest customer message and inspects its
  // attachments. If the latest message has an image (any mime type
  // starting with image/), we read the bytes and send them to the
  // vision-capable model so the draft actually addresses the
  // screenshot / photo the customer sent. Capped to 5MB per image
  // and 4 images per call to keep the prompt size sane.
  app.post('/api/tickets/:id/ai-draft', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.name as customer_name, c.email as customer_email
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    const memory = app.db.prepare(`
      SELECT category, key, value, confidence FROM customer_memory WHERE customer_id = ? AND confidence >= 0.6
    `).all(t.customer_id);

    const memoryBlock = memory.length
      ? memory.map((m) => `- ${m.category}: ${m.key ? m.key + ': ' : ''}${m.value}`).join('\n')
      : '(no customer memory yet)';

    // For the plain-text conversation summary we use the body column
    // (always present), but we ALSO build a "with-images" version
    // for the most recent customer message so vision can see them.
    const convo = messages.map((m) => `[${m.sender}] ${m.body}`).join('\n\n');

    // Find the most recent customer message and pull its image
    // attachments. We use the latest customer message because the
    // admin is replying to whatever the customer just sent.
    const lastCustomer = [...messages].reverse().find((m) => m.sender === 'customer');
    let imageParts = []; // { type, mime, base64 } for the LLM call
    let imageNotes = '';  // human-readable description for the prompt
    if (lastCustomer) {
      const attaches = app.db.prepare(`
        SELECT id, filename, mime_type, size_bytes, content_id, disposition
        FROM ticket_message_attachments WHERE ticket_message_id = ?
        ORDER BY id ASC
      `).all(lastCustomer.id);
      const MAX_PER_IMG = 5 * 1024 * 1024;
      const MAX_IMAGES = 4;
      for (const a of attaches) {
        if (imageParts.length >= MAX_IMAGES) break;
        if (!a.mime_type || !/^image\//i.test(a.mime_type)) continue;
        if (a.size_bytes > MAX_PER_IMG) {
          imageNotes += `\n- (skipped ${a.filename}: ${a.mime_type}, ${a.size_bytes} bytes > 5MB cap)`;
          continue;
        }
        const buf = readAttachmentBuffer(a.storage_path);
        if (!buf) {
          imageNotes += `\n- (failed to read ${a.filename} from disk)`;
          continue;
        }
        imageParts.push({
          type: 'image_url',
          mime: a.mime_type,
          url: `data:${a.mime_type};base64,${buf.toString('base64')}`,
        });
        imageNotes += `\n- attached image: ${a.filename} (${a.mime_type})`;
      }
    }

    const basePrompt = `Draft a short (3-5 sentence) professional reply to a support ticket.

Customer: ${t.customer_name}
Ticket subject: ${t.subject}
Customer memory (use this to sound like a real human who knows them):
${memoryBlock}

Conversation so far:
${convo || '(no messages yet)'}${imageNotes}

If the customer attached an image (see below), describe what you see and address it specifically in your reply. The image is the customer's most recent message — your reply should be a direct response to it.
Reply with just the draft text, no preamble.`;

    // Build Byron's voice profile (style rules + sample lines) and prepend
    // to the system prompt. Falls back to a generic prompt if we don't
    // have enough samples yet.
    const profile = await buildStyleProfile(app.db);
    const system = profile.ok
      ? 'You are Byron\'s AI reply assistant. Drafts are sent under Byron\'s name to real customers.\n' +
        'Be warm, direct, specific. Reference known equipment/preferences. No upsell. ' +
        'No "I hope this email finds you well."\n' + profile.prompt
      : 'You are Byron\'s AI reply assistant. Drafts are sent under Byron\'s name. ' +
        'Be warm, direct, specific. Reference known equipment/preferences. No upsell. ' +
        'No "I hope this email finds you well."';

    // When the customer attached an image, hand it to the model as
    // part of a multi-content user message. Otherwise plain text is fine.
    // `parkKey` lets the queue hook record a 429 so the cron tick can
    // resume the draft automatically when the rate limit lifts.
    const parkKey = `ghq-ai-draft-${req.params.id}`;
    const aiOpts = { system, maxTokens: 400, parkKey, parkNote: `AI draft for ticket G-${req.params.id}` };
    const result = imageParts.length
      ? await aiCall('high_reasoning', [
          { type: 'text', text: basePrompt },
          ...imageParts,
        ], aiOpts)
      : await aiCall('high_reasoning', basePrompt, aiOpts);
    return {
      draft: result.output,
      provider: result.provider,
      styleSamples: profile.sampleCount,
      imagesAnalyzed: imageParts.length,
    };
  });

  // Inspect the current style profile (so admins can see what the AI
  // is learning about their voice). Useful for debugging "why does the
  // draft sound formal?".
  app.get('/api/style/profile', async () => {
    const profile = await buildStyleProfile(app.db);
    const counts = app.db.prepare(`
      SELECT source, COUNT(*) as n FROM style_samples GROUP BY source
    `).all();
    return { ...profile, samplesBySource: counts };
  });

  // Capture a style feedback: Byron edited an AI draft before sending.
  // Used to refine the style profile over time.
  app.post('/api/tickets/:id/ai-draft/feedback', async (req, reply) => {
    const { draft_text, final_text } = req.body || {};
    if (!draft_text || !final_text) {
      return reply.code(400).send({ error: 'draft_text and final_text required' });
    }
    if (draft_text === final_text) {
      return reply.code(400).send({ error: 'draft and final are identical — no edit to learn from' });
    }
    const id = recordStyleFeedback(app.db, {
      ticketId: Number(req.params.id),
      draftText: draft_text,
      finalText: final_text,
    });
    return { ok: true, feedback_id: id };
  });

  // AI summary
  app.post('/api/tickets/:id/ai-summary', async (req, reply) => {
    const t = app.db.prepare('SELECT subject FROM tickets WHERE id = ?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare('SELECT sender, body FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    const convo = messages.map((m) => `[${m.sender}] ${m.body}`).join('\n');
    const prompt = `Summarize this support ticket in 1-2 sentences.\n\nSubject: ${t.subject}\n\n${convo}`;
    const result = await aiCall('high_reasoning', prompt, { maxTokens: 200 });
    app.db.prepare('UPDATE tickets SET ai_summary = ?, ai_processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.output, req.params.id);
    return { summary: result.output, provider: result.provider };
  });

  // Resolve
  app.post('/api/tickets/:id/resolve', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.email as customer_email, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    app.db.prepare("UPDATE tickets SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.resolve', ?)").run(req.params.id);

    // Try to send resolution email (no ticket UID, no "ticket" wording — customer-facing)
    if (t.customer_email) {
      const body = `Hi ${t.customer_name},\n\nJust confirming we've wrapped up your request about "${t.subject}". Reply to this email if you need anything else.`;
      await sendEmail({ to: t.customer_email, subject: `Re: ${t.subject}`, text: body });
    }

    // Best-effort: mark the original Gmail thread read + apply GeekShop/Done label + archive
    let gmail = null;
    if (t.source === 'email' && t.source_message_id) {
      gmail = await markThreadDone(t.source_message_id);
      if (gmail.ok) {
        app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'gmail.thread.archived', ?)").run(req.params.id);
      }
    }

    return { ok: true, gmail };
  });
  // Just send the current reply/draft to the customer as an email (no resolve)
  app.post('/api/tickets/:id/email-reply', async (req, reply) => {
    const { body } = req.body || {};
    if (!body || !body.trim()) return reply.code(400).send({ error: 'body required' });
    const t = app.db.prepare(`
      SELECT t.*, c.email as customer_email, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (!t.customer_email) return reply.code(400).send({ error: 'customer has no email' });

    const { text, html } = appendSignature(app.db, body.trim());
    const result = await sendEmail({
      to: t.customer_email,
      subject: `Re: ${t.subject}`,
      text,
      html,
    });
    if (!result.sent) return reply.code(502).send({ error: 'send failed', detail: result });

    // Save the outbound message to the conversation
    app.db.prepare(
      'INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)'
    ).run(req.params.id, 'admin', body.trim());
    app.db.prepare('UPDATE tickets SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.email_reply', ?)")
      .run(req.params.id, JSON.stringify({ sent: true, sent_to: t.customer_email, had_signature: Boolean(html) }));

    return { ok: true, sent: true, sent_to: t.customer_email };
  });

  // Resolve with a custom admin-written reply (the "mark done + send reply" button)
  // Body: { reply_body: string }
  // - Sends admin's text as the customer email (Re: <subject>)
  // - Marks ticket resolved
  // - Archives the Gmail thread (if source was email)
  // - Records everything in ticket_messages + audit_log
  app.post('/api/tickets/:id/resolve-with-reply', async (req, reply) => {
    const { reply_body } = req.body || {};
    if (!reply_body || !reply_body.trim()) {
      return reply.code(400).send({ error: 'reply_body required' });
    }
    const t = app.db.prepare(`
      SELECT t.*, c.email as customer_email, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (!t.customer_email) return reply.code(400).send({ error: 'customer has no email' });

    // 1. Save the admin's reply to the conversation
    app.db.prepare(
      'INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, ?, ?)'
    ).run(req.params.id, 'admin', reply_body.trim());

    // 2. Send the email (subject is just "Re: <subject>" so it threads with the customer's original)
    const { text, html } = appendSignature(app.db, reply_body.trim());
    const emailResult = await sendEmail({
      to: t.customer_email,
      subject: `Re: ${t.subject}`,
      text,
      html,
    });
    if (!emailResult.sent) {
      return reply.code(502).send({ error: 'send failed', detail: emailResult });
    }

    // 3. Mark ticket resolved
    app.db.prepare(
      "UPDATE tickets SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(req.params.id);
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.resolve_with_reply', ?)")
      .run(req.params.id, JSON.stringify({ sent: true, sent_to: t.customer_email, had_signature: Boolean(html) }));
    // 4. Best-effort: archive the Gmail thread
    let gmail = null;
    if (t.source === 'email' && t.source_message_id) {
      gmail = await markThreadDone(t.source_message_id);
      if (gmail.ok) {
        app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'gmail.thread.archived', ?)").run(req.params.id);
      }
    }

    return { ok: true, gmail, sent_to: t.customer_email };
  });
}
