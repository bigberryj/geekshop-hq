/**
 * Style analyzer — reads the `style_samples` table and builds a profile
 * that can be injected as a system-prompt block to the AI draft route.
 *
 * The goal: make AI drafts sound like Byron, not like a generic
 * customer-support template. We do this with concrete signals extracted
 * from real messages, not by asking the model to "be casual".
 *
 * Signals we mine:
 *   - average sentence length (and whether they use short or long forms)
 *   - opening pattern (greeting style: "Hi X" vs "Hey X" vs none)
 *   - closing pattern (sign-off, "Reply if...", action prompts)
 *   - contraction usage (don't, you're, let's)
 *   - punctuation choices (em-dash, ellipsis, exclamation density)
 *   - capitalization (lowercase first word, title case, etc.)
 *   - explicit "do/don't" list learned from feedback edits
 *
 * This is deterministic — no LLM in the loop. The model just gets the
 * resulting profile as a system prompt.
 */

import { aiCall } from './ai.js';

const MIN_SAMPLES = 3;

function tokenizeSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

const COMMON_GREETINGS = ['hi ', 'hey ', 'hello ', 'thanks ', 'thank you'];
const COMMON_CLOSERS = ['let me know', 'reply if', 'just let me know', 'cheers', 'thanks!', 'thanks,', 'talk soon', '— byron', '— b'];

/**
 * Mine one specific stylistic signal from a list of message samples.
 * Returns a human-readable rule string the model can follow.
 */
function analyzeSignals(samples) {
  const all = samples.join('\n\n');
  const sentences = samples.flatMap(tokenizeSentences);
  const sentenceLengths = sentences.map((s) => s.split(/\s+/).length);
  const words = all.toLowerCase().match(/\b[\w']+\b/g) || [];

  // Openings — look at the first greeting word of each sample.
  // We split on whitespace and look for a small known set of greeting
  // tokens, then capture the structure as a template ("Hi X", "Hey X").
  const greetingTokens = ['hi', 'hey', 'hello', 'thanks', 'thank you', 'morning', 'afternoon'];
  const openings = [];
  for (const s of samples) {
    const first = s.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    if (greetingTokens.some((g) => first.startsWith(g))) {
      openings.push(first);
    }
  }
  const openingCounts = {};
  for (const o of openings) openingCounts[o] = (openingCounts[o] || 0) + 1;
  // Pick the most common; format as "Hi {name}" style template.
  let dominantOpening = Object.entries(openingCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (dominantOpening) {
    // Replace the customer name with {name} placeholder so we don't
    // accidentally hard-code "Linda" into the system prompt.
    dominantOpening = dominantOpening.replace(/\b[a-z]+$/i, '{name}');
  }

  // Closers — only look at samples that are reasonably long, and only
  // capture recognizable closing patterns like "Reply if...", "Let me know",
  // etc. Last-30-chars is too noisy on short messages.
  const closers = [];
  for (const s of samples) {
    if (s.length < 60) continue;
    const lower = s.toLowerCase();
    for (const c of COMMON_CLOSERS) {
      if (lower.includes(c)) closers.push(c);
    }
  }
  const closerCounts = {};
  for (const c of closers) closerCounts[c] = (closerCounts[c] || 0) + 1;
  const commonClosers = Object.entries(closerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  // Contractions
  const contractionTokens = ["don't", "you're", "i'm", "it's", "can't", "won't", "let's", "isn't", "we're", "i'll", "didn't"];
  const contractionHits = words.filter((w) => contractionTokens.includes(w)).length;
  const contractionRate = pct(contractionHits, words.length);

  // Punctuation density
  const emDash = (all.match(/—/g) || []).length;
  const ellipsis = (all.match(/\.{3}|…/g) || []).length;
  const exclamation = (all.match(/!/g) || []).length;
  const question = (all.match(/\?/g) || []).length;

  // Capitalization: does the first word of each sentence start with capital?
  const lowerFirstWord = sentences.filter((s) => /^[a-z]/.test(s)).length;

  return {
    sampleCount: samples.length,
    avgSentenceLength: avg(sentenceLengths),
    maxSentenceLength: Math.max(...sentenceLengths, 0),
    dominantOpening,
    commonClosers,
    contractionRate,
    emDash,
    ellipsis,
    exclamation,
    question,
    lowerFirstWordPct: pct(lowerFirstWord, sentences.length),
  };
}

/**
 * Compare a draft to its edited final version, and surface what changed.
 * Used to learn from feedback (e.g. "draft said 'Hello' but Byron wrote
 * 'Hi' → don't say Hello").
 */
function diffDraftFeedback(draft, final) {
  const changes = [];
  // Opening comparison
  const draftOpen = (draft || '').trim().slice(0, 4).toLowerCase();
  const finalOpen = (final || '').trim().slice(0, 4).toLowerCase();
  if (draftOpen && finalOpen && draftOpen !== finalOpen) {
    changes.push(`opening: AI wrote "${draftOpen}" → Byron wrote "${finalOpen}"`);
  }
  // Length ratio
  const dl = (draft || '').length;
  const fl = (final || '').length;
  if (dl && fl) {
    const ratio = fl / dl;
    if (ratio < 0.5) changes.push(`final was ${Math.round((1 - ratio) * 100)}% shorter than draft`);
    else if (ratio > 1.8) changes.push(`final was ${Math.round((ratio - 1) * 100)}% longer than draft`);
  }
  // "Hello" / "I hope" / "I wanted to" — common AI tells we can flag
  const aiTells = ['i hope this', 'i wanted to', 'please feel free', 'do not hesitate', 'at your earliest'];
  for (const tell of aiTells) {
    if ((draft || '').toLowerCase().includes(tell) && !(final || '').toLowerCase().includes(tell)) {
      changes.push(`removed AI phrase: "${tell}"`);
    }
  }
  return changes;
}

/**
 * Build the system-prompt block used by the AI draft route. Returns a
 * string the caller prepends to the LLM system prompt.
 *
 * The block is short and concrete — long style docs don't help, models
 * ignore most of them. We give 3-4 rules + a couple of example snippets.
 */
export async function buildStyleProfile(db) {
  // Pull the most recent 30 samples, weighted toward feedback edits
  // (those are the most direct signal of what Byron wants).
  const samples = db.prepare(`
    SELECT text FROM style_samples
    ORDER BY CASE source
      WHEN 'feedback_edit' THEN 0
      WHEN 'admin_message' THEN 1
      WHEN 'telegram' THEN 2
      ELSE 3
    END, id DESC
    LIMIT 30
  `).all().map((r) => r.text);

  // Pull last 10 feedback diffs so we can tell the model what NOT to do.
  const feedback = db.prepare(`
    SELECT draft_text, final_text FROM style_feedback
    ORDER BY id DESC LIMIT 10
  `).all();

  if (samples.length < MIN_SAMPLES) {
    return {
      ok: false,
      sampleCount: samples.length,
      reason: 'not enough samples yet',
      prompt: '', // empty → caller falls back to default system prompt
    };
  }

  const signals = analyzeSignals(samples);
  const changes = feedback.map((f) => diffDraftFeedback(f.draft_text, f.final_text)).flat();

  // Compose the rule list. Keep it crisp and specific.
  const rules = [];
  if (signals.avgSentenceLength > 0 && signals.avgSentenceLength < 15) {
    rules.push('- Keep sentences short (avg ' + signals.avgSentenceLength + ' words). One idea per sentence.');
  } else if (signals.avgSentenceLength > 20) {
    rules.push('- Sentences can be longer when explaining something specific (avg ' + signals.avgSentenceLength + ' words).');
  }
  if (signals.dominantOpening) {
    rules.push(`- Open with "${signals.dominantOpening}" (use the customer's first name).`);
  }
  if (signals.contractionRate > 1) {
    rules.push('- Use contractions (don\'t, you\'re, I\'ll) — sounds human, not formal.');
  }
  if (signals.emDash > 0) {
    rules.push('- Em-dashes are fine for asides — don\'t strip them.');
  }
  if (signals.lowerFirstWordPct > 30) {
    rules.push('- Lowercase opening word is sometimes OK in casual replies (after a greeting).');
  }
  if (signals.commonClosers.length > 0) {
    const cleanClosers = signals.commonClosers
      .map((c) => c.replace(/[^\w\s!?,.']/g, '').trim())
      .filter((c) => c.length > 3)
      .slice(0, 2);
    if (cleanClosers.length > 0) {
      rules.push(`- Common closers: ${cleanClosers.map((c) => '"' + c + '"').join(', ')}.`);
    }
  }
  if (changes.length > 0) {
    rules.push('');
    rules.push('Things Byron has corrected in past drafts:');
    for (const c of changes.slice(0, 6)) {
      rules.push(`- ${c}`);
    }
  }

  const profile = [
    '',
    '--- BYRON\'S VOICE ---',
    'These are rules mined from Byron\'s own past customer emails. Follow them when drafting:',
    ...rules,
    'Sample lines (paraphrase, don\'t copy verbatim):',
    ...samples.slice(0, 3).map((s) => `  • ${s.replace(/\n+/g, ' ').slice(0, 140)}${s.length > 140 ? '…' : ''}`),
    '--- END BYRON\'S VOICE ---',
  ].join('\n');

  return {
    ok: true,
    sampleCount: samples.length,
    signals,
    prompt: profile,
  };
}

/**
 * Add a style sample (used by the seed migration and the feedback capture
 * endpoint). Returns the new row id.
 */
export function addStyleSample(db, { source, text, context }) {
  if (!text || !text.trim()) throw new Error('text required');
  const r = db.prepare(`INSERT INTO style_samples (source, text, context) VALUES (?, ?, ?)`)
    .run(source, text.trim(), context || null);
  return r.lastInsertRowid;
}

/**
 * Capture feedback: Byron edited an AI draft before sending.
 * Both the draft and the final text are logged, and the original
 * sender's text is also stored as a style sample (so future drafts
 * see real Byron prose, not just the AI's).
 */
export function recordStyleFeedback(db, { ticketId, draftText, finalText }) {
  if (!draftText || !finalText) throw new Error('draftText and finalText required');
  const r = db.prepare(`
    INSERT INTO style_feedback (ticket_id, draft_text, final_text) VALUES (?, ?, ?)
  `).run(ticketId || null, draftText, finalText);
  // Also add the final text as a style sample so it influences future drafts.
  addStyleSample(db, { source: 'feedback_edit', text: finalText, context: ticketId ? `ticket ${ticketId}` : null });
  return r.lastInsertRowid;
}

export const _internal = { analyzeSignals, diffDraftFeedback };
