/**
 * SMTP email sender.
 *
 * If SMTP is not configured, emails are queued in the `pending_emails` table
 * (we'll add a route to surface those as nudges in v1.5). For v1, we just
 * log and return false.
 */

import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    transporter = false;
    return false;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export async function sendEmail({ to, subject, text, html, ics }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[email] SMTP not configured, would have sent to=${to} subject="${subject}"`);
    return { sent: false, reason: 'smtp_not_configured' };
  }
  try {
    const info = await t.sendMail({
      from: process.env.SMTP_FROM || `GeekShop HQ <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html: html || text,
      ...(ics ? { alternatives: [{ contentType: 'text/calendar', content: ics }] } : {}),
    });
    return { sent: true, message_id: info.messageId };
  } catch (err) {
    console.error(`[email] send failed: ${err.message}`);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

export async function verifySmtp() {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.verify();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a minimal ICS calendar attachment for an appointment.
 */
export function buildIcs({ uid, start, end, summary, description, location }) {
  const dt = (s) => s.replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GeekShop HQ//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(start)}`,
    `DTEND:${dt(end)}`,
    `SUMMARY:${summary || 'Appointment'}`,
    description ? `DESCRIPTION:${description.replace(/\n/g, '\\n')}` : '',
    location ? `LOCATION:${location}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}
