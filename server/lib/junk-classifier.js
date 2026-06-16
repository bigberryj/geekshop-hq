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
 *
 * Byron-iter (2026-06-16):
 *   - Fix: isLikelyHuman only inspects the explicit fromName field, not
 *     a synthesized display name from the email. Many transactional
 *     senders (Stripe invoice+statements+..., Capital One notification.,
 *     etc.) put the full email into fromName when no display name is set,
 *     and that was causing them to be wrongly classified as real humans.
 *   - Add: explicit always-keep subject patterns for security/account
 *     notifications. We never want to auto-dismiss "Your Google Account
 *     is no longer recoverable" or "Security alert".
 *   - Add: Google ecosystem (noreply@*.google.com, docs.google.com,
 *     accounts.google.com, workspace-noreply@google.com, sc-noreply@) as
 *     an automated-from signal at 0.4 — these are 80% of the noise.
 *   - Add: transactional/receipt subject patterns (Interac e-Transfer,
 *     payment posted, your receipt, invoice has been generated, etc.)
 *     score 0.5 — they're not junk, but they're auto-handled.
 *   - Add: settings-backed overrides:
 *       * auto_dismiss_domains  — comma-separated list of exact-match
 *         domains that are always junk (added at 0.6 score on top of
 *         anything else)
 *       * auto_keep_subjects    — comma-separated substring list of
 *         subjects that are NEVER auto-dismissed (overrides everything
 *         except customer email)
 *       * agent_mailbox_from    — comma-separated list of from_email
 *         values that are operational mail (still kept in queue by
 *         default, hidden in UI when "Hide agent mail" is on)
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
  // Added 2026-06-16 — Byron-tuned:
  'm.shopifyemail.com', // Shopify transactional/store email
]);

// Google ecosystem — 80% of Byron's pending queue noise. Noreply from any
// google.com subdomain, plus the well-known service addresses. Score 0.4.
const GOOGLE_AUTOMATED_FROM = [
  /noreply@[^@]*google\.com$/i,
  /no[-_]reply@[^@]*google\.com$/i,
  /^sc[-_]noreply@google\.com$/i,
  /^workspace[-_]noreply@google\.com$/i,
  /^comments[-_]noreply@docs\.google\.com$/i,
  /^storage[-_]noreply@google\.com$/i,
  /^play@[^@]*google\.com$/i,
];

const GOOGLE_AUTOMATED_DOMAINS = new Set([
  'accounts.google.com',
  'docs.google.com',
  'drive.google.com',
  'sites.google.com',
  'notifications.google.com',
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

// Transactional/receipt subjects. These are real (and some are money
// notifications), but they're never a customer request and never need
// admin triage. Score 0.5 — high enough to push to dismiss when combined
// with even one other weak junk signal.
const TRANSACTIONAL_SUBJECT_PATTERNS = [
  /\breceipt\b/i,
  /\bpayment\s+posted\b/i,
  /\bpayment\s+due\b/i,
  /\bauto[\s-]?deposited\b/i,
  /\bsuccessfully\s+deposited\b/i,
  /\bwas\s+successfully\s+deposited\b/i,
  /\bhas\s+been\s+(successfully\s+)?deposited\b/i,
  /\betransfer\b/i,
  /\be-?transfer\b/i,
  /\binterac\b/i,
  /\bhas\s+requested\s+\$?\d+/i,
  /\btransfer\s+to\b/i,
  /\binvoice\s+has\s+been\s+generated\b/i,
  /\bthank\s+you\s+for\s+your\s+payment\b/i,
  /\byour\s+invoice\s+from\b/i,
  /\bnew\s+receipt\b/i,
  /\bpayment\s+confirmation\b/i,
];

// SECURITY / ACCOUNT-RECOVERY subjects. NEVER auto-dismiss these, even
// if the sender is a noreply@. Per Byron 2026-06-16: "I'd rather look
// at a real security alert 100 times than miss it once.".
const SECURITY_SUBJECT_KEEP = [
  /\bsecurity\s+alert\b/i,
  /\bsecurity\s+notice\b/i,
  /\bsecurity\s+risk\b/i,
  /\bunauthorized\b/i,
  /\bverification\b/i,
  /\bverify\s+your\s+identity\b/i,
  /\bverify\s+your\s+account\b/i,
  /\breactivate\s+my\s+account\b/i,
  /\breactivate\s+your\s+account\b/i,
  /\bno\s+longer\s+recoverable\b/i,
  /\brecovery\b/i,
  /\brecovery\s+code\b/i,
  /\bnew\s+(device\s+)?sign[\s-]?in\b/i,
  /\bunrecognized\s+(device|sign)/i,
  /\bpassword\s+(reset|changed|expir)/i,
  /\bsuspicious\s+activity\b/i,
  /\bunauthorized\s+(access|login|sign)/i,
];

// Domains / address patterns that ALWAYS pass through (e.g. when from is
// a real human you might do business with). These never auto-dismiss.
const ALWAYS_KEEP_FROM = [
  /@geekshop\.ca$/i,
  /@hyrule\.ca$/i, // test customer
  // Byron himself
  /^Byron\s/i,
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
 * Check if the From: display name looks like a real human (first + last).
 *
 * FIX (2026-06-16): previously this would also check the email local part,
 * which meant a sender like `invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com`
 * with no display name set, but with a synthesized display name containing
 * 2+ capitalised tokens, was classified as a real human — causing Stripe
 * receipts, Capital One notifications, and Interac e-Transfer alerts to
 * be wrongly scored 0.0 (legit / keep) and never auto-dismissed.
 *
 * The fix: only inspect the explicit `fromName` field. If it's empty,
 * OR if it equals/contains the email address, return false. This is the
 * single biggest false-negative source in the live DB.
 */
function isLikelyHuman(fromName, fromEmail) {
  if (!fromName) return false;
  const trimmed = fromName.trim();
  // If the fromName is actually the email address (or contains it),
  // this is NOT a real human name — it's a fall-back display name
  // produced by the email client.
  if (fromEmail && trimmed.toLowerCase() === fromEmail.toLowerCase()) return false;
  if (fromEmail && trimmed.toLowerCase().includes(fromEmail.toLowerCase())) return false;
  // Strip common quote chars
  const clean = trimmed.replace(/^["'<(]+|["'>)]\s*$/g, '');
  // Require at least two "name-like" words.
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  // Reject if any "word" is a single letter (e.g., "Byron B.") or contains @/+/#/digits
  if (words.some((w) => w.length < 2)) return false;
  if (words.some((w) => /[@+#\d]/.test(w))) return false;
  // Reject if any word doesn't start with a capital — real first/last
  // names virtually always do, and `invoice+statements+acct_1HN...`
  // pieces are mixed case with digits.
  if (!words.every((w) => /^[A-Z]/.test(w))) return false;
  // The whole string must look like a name (no email-shaped substrings)
  if (/[@+]/.test(clean)) return false;
  return true;
}

function domainOf(email) {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

/**
 * Parse a comma-separated settings value into a normalized Set of
 * lowercase tokens. Used for settings-backed override lists.
 */
function parseSettingList(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseSettingSubstrings(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Score a single email for junk probability. Returns:
 *   { score, signals, reason, shouldDismiss, classifiedBy }
 *
 * shouldDismiss=true ONLY when score >= 0.8 AND no "always-keep" rule fired.
 * The LLM is only consulted when the rule score is in the ambiguous band
 * (0.3 <= score <= 0.7). Outside that band we trust the rules.
 *
 * Options:
 *   customerEmails: Set<string>            — emails of existing customers
 *   settings: {                            — settings table overrides
 *     auto_dismiss_domains?: string,        — exact-match domains
 *     auto_keep_subjects?: string,          — substring subjects (CSV)
 *     agent_mailbox_from?: string,          — from emails to tag as agent
 *   }
 */
export function scoreEmail({ fromName, fromEmail, subject, body }, { customerEmails = new Set(), settings = {} } = {}) {
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
  // Hard keep: SECURITY / ACCOUNT-RECOVERY subject. These are short
  // and obvious; better to keep 100 legit-looking ones than miss 1.
  if (subject && SECURITY_SUBJECT_KEEP.some((re) => re.test(subject))) {
    return { score: 0, signals: ['security_subject_keep'], reason: 'security/account-recovery subject — never auto-dismiss', shouldDismiss: false, classifiedBy: 'rules' };
  }
  // Hard keep: settings-backed auto_keep_subjects (CSV substrings)
  const keepSubjects = parseSettingSubstrings(settings.auto_keep_subjects);
  if (subject && keepSubjects.length && keepSubjects.some((s) => subject.toLowerCase().includes(s.toLowerCase()))) {
    return { score: 0, signals: ['settings_keep_subject'], reason: 'subject matches auto_keep_subjects setting', shouldDismiss: false, classifiedBy: 'rules' };
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

  // Signal 1b: Google ecosystem noreply patterns
  if (fromEmail && GOOGLE_AUTOMATED_FROM.some((re) => re.test(fromEmail))) {
    score += 0.4;
    signals.push('google_automated_from');
  }
  const dom = domainOf(fromEmail);
  if (dom && GOOGLE_AUTOMATED_DOMAINS.has(dom)) {
    score += 0.4;
    signals.push(`google_automated_domain:${dom}`);
  }

  // Signal 2: ESP / mass-mailing domain
  if (dom && ESP_DOMAINS.has(dom)) {
    score += 0.35;
    signals.push(`esp_domain:${dom}`);
  }

  // Signal 3: junk subject pattern
  if (subject && JUNK_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    score += 0.35;
    signals.push('junk_subject_pattern');
  }

  // Signal 3b: transactional/receipt subject pattern. Real money
  // notifications, but not customer requests and not high-priority
  // triage. Score 0.5 to push them above the 0.8 threshold when
  // combined with even one other weak signal.
  if (subject && TRANSACTIONAL_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    score += 0.5;
    signals.push('transactional_subject');
  }

  // Signal 4: body contains 'unsubscribe' link. Strong signal on its own
  // (0.35), but even stronger when combined with a brand name or
  // automated-from pattern — push to 0.5 in that case.
  const isBrand = signals.some((s) => s.startsWith('brand_from_name:'));
  const isAutomated = signals.includes('automated_from_pattern') || signals.includes('google_automated_from');
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

  // Signal 6: settings-backed auto_dismiss_domains (exact match,
  // case-insensitive). Adds 0.6 on top of anything else. This is the
  // per-domain tuning knob Byron asked for.
  const autoDomains = parseSettingList(settings.auto_dismiss_domains);
  if (dom && autoDomains.has(dom)) {
    score += 0.6;
    signals.push(`settings_auto_dismiss_domain:${dom}`);
  }

  // Clamp 0..1
  score = Math.max(0, Math.min(1, score));

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

/**
 * Test whether an email is from Byron's agent mailbox (for the
 * "Hide agent mail" UI filter). Matches by exact from_email, case-
 * insensitive. Empty / unset mailbox list returns false.
 */
export function isAgentMail(fromEmail, settings = {}) {
  if (!fromEmail) return false;
  const list = parseSettingList(settings.agent_mailbox_from);
  if (list.size === 0) return false;
  return list.has(fromEmail.toLowerCase().trim());
}
