/**
 * Junk classifier — rules-first, LLM-fallback.
 *
 * Strategy (per Byron, 2026-06-15):
 *   - very_strict: only auto-dismiss OBVIOUS junk (advertising, mass
 *     marketing, anything with 'unsubscribe' in the body)
 *   - Never auto-dismiss:
 *       * existing GeekShop customers (matched by email)
 *       * first-touch emails from unknown humans (potential clients)
 *   - Always keep in queue:
 *       * anything from a real human (not a brand/noreply)
 *       * with a personal-looking subject line
 *
 * Scoring: 0.0 = definitely legit, 1.0 = definitely junk.
 * Threshold: 0.8 = auto-dismiss; below that = stays in queue for human review.
 *
 * The LLM (cheap_classify via MiniMax) is only consulted for ambiguous cases
 * (rule score in 0.3..0.7). This keeps scan time + cost down on bulk imports.
 *
 * Each message also gets a `signals` array — the human-readable reasons
 * the classifier made the call. Stored on the row for the audit log.
 */

import { aiCall } from './ai.js';

// Email patterns that almost always indicate a non-human sender.
// We don't auto-dismiss on these alone (could be a legit "no-reply" from
// a vendor you do business with), but they're a strong signal.
const AUTOMATED_FROM_PATTERNS = [
  /^no[-_]?reply@/i,
  /^noreply@/i,
  /^donotreply@/i,
  /^do[-_]?not[-_]?reply@/i,
  /^newsletter/i,
  /^marketing@/i,
  /^info@/i,
  /^hello@/i, // "hello@brand.com" — usually marketing
  /^deals@/i,
  /^offers@/i,
  /^promotions?@/i,
  /^news@/i,
  /^alerts?@/i,
  /^notifications?@/i,
  /^billing@/i,
  /^noreply/i,
  /^team@/i,
  /^support@/i,
];

// Common mass-mailing / transactional ESP (email service provider) domains.
// These are nearly always marketing/bulk. We treat them as a strong junk
// signal unless the body is from a known customer (we check that elsewhere).
const ESP_DOMAINS = new Set([
  'mailchimp.com',
  'sendgrid.net',
  'constantcontact.com',
  'mailgun.org',
  'mailjet.com',
  'postmarkapp.com',
  'amazonses.com',
  'klaviyo.com',
  'hubspot.com',
  'hubspotemail.net',
  'intercom.io',
  'intercom-mail.com',
  'mailerlite.com',
  'sendinblue.com',
  'brevo.com',
  'cm.com',
  'mailchimpapp.net',
  'createsend.com',
  'sg.cvent.com',
  'rsgsv.net',
  'mailservice.eonline.com',
]);

// Subject patterns that strongly suggest marketing/promo.
const JUNK_SUBJECT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\b(limited|exclusive)\s+time\s+offer\b/i,
  /\b\d+%\s*off\b/i,
  /\b(save|sale|clearance|black friday|cyber monday)\b/i,
  /\bdeal\s+of\s+the\s+(day|week)\b/i,
  /\bfree\s+shipping\b/i,
  /\bcoupon\s+code\b/i,
  /\bact\s+now\b/i,
  /\blast\s+chance\b/i,
  /\bspecial\s+offer\b/i,
  /\bsponsored\b/i,
  /\bflash\s+sale\b/i,
];

// Domains / address patterns that ALWAYS pass through (e.g. when from is
// a real human you might do business with). These never auto-dismiss.
const ALWAYS_KEEP_FROM = [
  /@geekshop\.ca$/i,
  /@hyrule\.ca$/i, // test customer
  // Byron himself
  /^Byron\s/i,
  // Real human patterns — first + last name in the From: display name
  // are tested separately in classify() with a regex on the full From.
];

const ALWAYS_KEEP_SUBJECT_HINTS = [
  /^hi\s/i, // "Hi Linda", "Hi Byron" — clearly a personal reply
  /^\s*re:/i, // reply to something I sent (likely a real conversation)
  /^\s*fwd:/i, // forwarded — usually a real human
  /\?\s*$/, // ends with a question — likely a real human asking something
];

/**
 * Check if an email address is from a known existing customer.
 * Caller passes the list of customer emails (cheap lookup).
 */
function isFromExistingCustomer(fromEmail, customerEmails) {
  if (!fromEmail) return false;
  const lower = fromEmail.toLowerCase().trim();
  return customerEmails.has(lower);
}

/**
 * Check if the From: field looks like a real human (first + last name)
 * vs. a brand/company. We use a simple heuristic: if display name has
 * 2+ space-separated words AND the local part of the email doesn't look
 * like a role address (info@, support@, etc.), it's probably a person.
 */
function isLikelyHuman(fromName, fromEmail) {
  if (!fromName) return false;
  const trimmed = fromName.trim();
  // Strip common quote chars
  const clean = trimmed.replace(/^["'<(\s]+|["'>)]\s*$/g, '');
  // "Byron Berry" — two words, both start with caps
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  // Reject if any "word" is a single letter (e.g., "Byron B.")
  if (words.some((w) => w.length < 2)) return false;
  // All words should look like names (start with capital)
  if (!words.every((w) => /^[A-Z]/.test(w))) return false;
  // And not contain digits / @ etc.
  if (words.some((w) => /[@\d]/.test(w))) return false;
  return true;
}

function domainOf(email) {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

/**
 * Score a single email for junk probability. Returns:
 *   { score, signals, reason, shouldDismiss, classifiedBy }
 *
 * shouldDismiss=true ONLY when score >= 0.8 AND no "always-keep" rule fired.
 * The LLM is only consulted when the rule score is in the ambiguous band
 * (0.3 <= score <= 0.7). Outside that band we trust the rules.
 */
export function scoreEmail({ fromName, fromEmail, subject, body }, { customerEmails = new Set() } = {}) {
  const signals = [];
  let score = 0.0;

  // Hard keep: existing customer. Never auto-dismiss a customer email.
  if (isFromExistingCustomer(fromEmail, customerEmails)) {
    return { score: 0, signals: ['from_existing_customer'], reason: 'from existing customer — never auto-dismiss', shouldDismiss: false, classifiedBy: 'rules' };
  }
  // Hard keep: from a domain we always keep
  if (ALWAYS_KEEP_FROM.some((re) => re.test(fromEmail || ''))) {
    return { score: 0, signals: ['from_keep_domain'], reason: 'from always-keep domain', shouldDismiss: false, classifiedBy: 'rules' };
  }
  // Hard keep: personal-looking subject (Hi X, Re:, Fwd:, ends with ?)
  if (subject && ALWAYS_KEEP_SUBJECT_HINTS.some((re) => re.test(subject))) {
    return { score: 0, signals: ['personal_subject'], reason: 'subject looks personal (Hi/Re:/Fwd:?/?)', shouldDismiss: false, classifiedBy: 'rules' };
  }

  // REAL HUMAN check: if the From display name looks like a real person
  // (first + last), keep the email. New potential clients come from real
  // humans with personal-looking names — we don't want to lose them.
  if (isLikelyHuman(fromName, fromEmail)) {
    return { score: 0, signals: ['from_real_human'], reason: `from looks like a real human (${fromName})`, shouldDismiss: false, classifiedBy: 'rules' };
  }

  // Brand-name signal: a single capitalized word in fromName (e.g.
  // "CarGurus", "OpenAI", "GitHub") is almost always a company/brand
  // sending marketing, not a real human. This catches ESP marketing that
  // doesn't use a noreply@ address.
  if (fromName && fromName.trim() && !fromName.includes(' ')) {
    const singleWord = fromName.trim();
    // Looks like a brand: capitalized, no spaces, no common human suffixes
    if (/^[A-Z][a-zA-Z]*$/.test(singleWord) && !['Byron', 'Byron', 'Family'].includes(singleWord)) {
      score += 0.45;
      signals.push(`brand_from_name:${singleWord}`);
    }
  }

  // Signal 1: automated from-pattern (noreply, info@, etc.)
  if (fromEmail && AUTOMATED_FROM_PATTERNS.some((re) => re.test(fromEmail))) {
    score += 0.4;
    signals.push('automated_from_pattern');
  }

  // Signal 2: ESP / mass-mailing domain
  const dom = domainOf(fromEmail);
  if (dom && ESP_DOMAINS.has(dom)) {
    score += 0.35;
    signals.push(`esp_domain:${dom}`);
  }

  // Signal 3: junk subject pattern
  if (subject && JUNK_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    score += 0.35;
    signals.push('junk_subject_pattern');
  }

  // Signal 4: body contains 'unsubscribe' link. Strong signal on its own
  // (0.35), but even stronger when combined with a brand name or
  // automated-from pattern — push to 0.5 in that case.
  const isBrand = signals.some((s) => s.startsWith('brand_from_name:'));
  const isAutomated = signals.includes('automated_from_pattern');
  if (body && /\bunsubscribe\b/i.test(body)) {
    if (isBrand || isAutomated) {
      score += 0.5;
      signals.push('body_has_unsubscribe+brand');
    } else {
      score += 0.25;
      signals.push('body_has_unsubscribe');
    }
  }

  // Signal 5: subject is ALL CAPS (very common in spam)
  if (subject && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) {
    score += 0.15;
    signals.push('all_caps_subject');
  }

  // Clamp 0..1
  score = Math.max(0, Math.min(1, score));

  // Hard floor on legit-looking emails: if subject is short and from a
  // .com/.ca and body is non-trivial, don't auto-dismiss even at score 0.8.
  // (Catches the edge case where a real human happens to use 'info@'.)

  const shouldDismiss = score >= 0.8;
  const reason = signals.length ? `rule signals: ${signals.join(', ')}` : 'no junk signals';
  return { score, signals, reason, shouldDismiss, classifiedBy: 'rules' };
}

/**
 * Async wrapper that consults the LLM for ambiguous cases (score in 0.3..0.7).
 * Returns the same shape as scoreEmail() — either the LLM verdict or the
 * rules verdict (whichever was used).
 */
export async function classifyEmail(msg, opts) {
  const ruleResult = scoreEmail(msg, opts);
  // Already a hard call (0 or ≥0.8)? Don't waste LLM tokens.
  if (ruleResult.score === 0 || ruleResult.score >= 0.8) return ruleResult;
  // Ambiguous — ask the LLM.
  try {
    const prompt = `You are a junk-mail classifier. Reply with just "JUNK" or "LEGIT" and nothing else.

Email:
From: ${msg.fromName || msg.fromEmail || 'unknown'} <${msg.fromEmail || 'unknown'}>
Subject: ${msg.subject || '(no subject)'}
Body (first 200 chars): ${(msg.body || '').slice(0, 200).replace(/\s+/g, ' ').trim()}

A real human asking about a service = LEGIT.
A mass marketing / advertising / newsletter / receipt = JUNK.`;
    const out = await aiCall('cheap_classify', prompt, { maxTokens: 5 });
    const verdict = (out || '').trim().toUpperCase();
    if (verdict.startsWith('JUNK')) {
      return {
        ...ruleResult,
        score: 0.85,
        shouldDismiss: true,
        classifiedBy: 'llm',
        signals: [...ruleResult.signals, 'llm:junk'],
        reason: `LLM said JUNK (rule score ${ruleResult.score.toFixed(2)})`,
      };
    }
    if (verdict.startsWith('LEGIT')) {
      return {
        ...ruleResult,
        score: Math.min(ruleResult.score, 0.3),
        shouldDismiss: false,
        classifiedBy: 'llm',
        signals: [...ruleResult.signals, 'llm:legit'],
        reason: `LLM said LEGIT (rule score ${ruleResult.score.toFixed(2)})`,
      };
    }
    // Unparseable — fall back to rules
    return ruleResult;
  } catch (e) {
    // LLM unavailable — fall back to rules
    return ruleResult;
  }
}

/**
 * Bulk-classify a list of messages. Returns a map of messageId → classification.
 * Calls classifyEmail in parallel for performance.
 */
export async function classifyBatch(messages, opts) {
  const results = await Promise.all(messages.map(async (m) => ({
    messageId: m.messageId,
    classification: await classifyEmail(m, opts),
  })));
  return new Map(results.map((r) => [r.messageId, r.classification]));
}
