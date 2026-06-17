/**
 * AI provider router — MiniMax-first (no OpenRouter, by request).
 *
 * Primary: MiniMax M3 via Anthropic-compatible endpoint
 *   https://api.minimax.io/anthropic/v1/messages
 *   Auth: x-api-key header + anthropic-version
 *   Required env: MINIMAX_API_KEY
 *
 * Optional secondary: OpenAI Platform (Codex / gpt-4o-mini)
 *   Used only for high-reasoning if OPENAI_API_KEY is set.
 *   NOTE: A ChatGPT Plus/Pro subscription does NOT provide OPENAI_API_KEY —
 *   you'd need a separate OpenAI Platform account with billing, or skip this.
 *
 * Tier mapping (byron, 2026-06-15):
 *   - 'high_reasoning' → OpenAI if available, else MiniMax M3 (max_tokens=800)
 *   - 'cheap_classify' → MiniMax M3 (max_tokens=60, terse system prompt)
 *
 * Fallback chain (for either tier):
 *   primary → secondary (OpenAI for high, MiniMax for cheap) → heuristic → throw
 *
 * Usage:
 *   import { aiCall } from './lib/ai.js';
 *   const { output, provider } = await aiCall('high_reasoning', prompt, { system, maxTokens });
 *
 * Health check:
 *   import { testProvider } from './lib/ai.js';
 *   await testProvider('high_reasoning');
 */

import { spawnSync } from 'node:child_process';

const MINIMAX_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const MINIMAX_VERSION = '2023-06-01';

function getMinimaxKey() { return process.env.MINIMAX_API_KEY; }
function hasMinimaxKey() { return Boolean(getMinimaxKey()); }

function getOpenaiKey() { return process.env.OPENAI_API_KEY; }
function hasOpenaiKey() { return Boolean(getOpenaiKey()); }

/**
 * Public entrypoint. Returns { provider, output } or throws.
 *
 * If a call returns a 429 / rate-limit error and the caller passed a
 * `parkKey`, the call is recorded in ~/.hermes/queue/queue.jsonl so a
 * cron job can retry it later. The error still propagates so the
 * caller can decide whether to show a friendly message ("we're
 * rate-limited, will keep going shortly") or a hard failure.
 */
export async function aiCall(taskClass, prompt, opts = {}) {
  const errors = [];
  const tried = new Set();

  // Tier-specific provider order:
  //   high: OpenAI (if key) → MiniMax → heuristic
  //   cheap: MiniMax → heuristic
  const order = taskClass === 'high_reasoning'
    ? ['openai', 'minimax', 'heuristic']
    : ['minimax', 'heuristic'];

  for (const provider of order) {
    if (tried.has(provider)) continue;
    tried.add(provider);
    if ((provider === 'openai' && !hasOpenaiKey()) || (provider === 'minimax' && !hasMinimaxKey())) continue;
    try {
      const result = await callProvider(provider, taskClass, prompt, opts);
      if (result) return { provider, output: result };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      errors.push(`${provider}: ${msg}`);
      console.warn(`[ai] ${provider} failed:`, msg);
      if (isRateLimitError(err) && opts.parkKey) {
        parkRateLimit({ provider, kind: `${provider}_call`, key: opts.parkKey, note: opts.parkNote, err });
      }
    }
  }
  throw new Error(`All AI providers failed for task=${taskClass}: ${errors.join(' | ')}`);
}

function isRateLimitError(e) {
  if (!e) return false;
  const msg = (e.message || '').toLowerCase();
  if (/HTTP 429\b|HTTP 529\b/i.test(msg)) return true;
  if (msg.includes('rate limit') || msg.includes('rate_limit')) return true;
  if (msg.includes('quota') || msg.includes('overloaded') || msg.includes('too many requests')) return true;
  return false;
}

function parkRateLimit({ provider, kind, key, note, err }) {
  try {
    const bin = process.env.HERMES_QUEUE_BIN
      || `${process.env.HOME || '/home/byron'}/.hermes/queue/scripts/queue.js`;
    const args = [bin, 'add', '--key', key, '--provider', provider, '--kind', kind, '--note', note || `${kind} hit rate limit`];
    // Extract Retry-After if present in the error text.
    const m = (err.message || '').match(/retry[- ]after[:= ]+(\d+)/i);
    if (m) args.push('--retry-after', `${m[1]}s`);
    const r = spawnSync('node', args, { encoding: 'utf8' });
    if (r.status === 0) {
      console.warn(`[ai] parked ${kind} retry under key=${key} (queue id in stderr)`);
    } else {
      console.warn(`[ai] failed to park retry: ${r.stderr}`);
    }
  } catch (parkErr) {
    console.warn(`[ai] park error: ${parkErr.message}`);
  }
}

async function callProvider(provider, taskClass, prompt, opts) {
  switch (provider) {
    case 'openai':
      return await callOpenAI(prompt, opts);
    case 'minimax':
      return await callMinimax(prompt, opts, taskClass);
    case 'heuristic':
      return heuristicFor(prompt, opts);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * MiniMax M3 via Anthropic-compatible endpoint.
 * Uses different system prompts / max_tokens per tier.
 *
 * `prompt` is either a plain string (rendered as a single text part)
 * or an array of content parts, e.g. [{type:'text', text:'...'},
 * {type:'image_url', url:'data:image/png;base64,...'}]. The array
 * form is used for vision — when the customer's email has a
 * screenshot we want the AI to actually see it.
 */
async function callMinimax(prompt, opts, taskClass) {
  const key = getMinimaxKey();
  if (!key) throw new Error('MINIMAX_API_KEY not set');

  const isHigh = taskClass === 'high_reasoning';
  const maxTokens = opts.maxTokens ?? (isHigh ? 800 : 60);
  const systemPrompt = opts.system ?? (isHigh
    ? 'You are a helpful, precise assistant. Be concise and specific.'
    : 'You are a classifier. Reply with the minimum answer required, exactly as instructed. No preamble.');

  // Build the user content. Anthropic's content-part format is:
  //   { type: 'text', text: '...' }
  //   { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
  // We accept our shorthand { type: 'image_url', mime, url: 'data:...' } and
  // translate it to the Anthropic format on the way out.
  let userContent;
  if (Array.isArray(prompt)) {
    userContent = prompt.map((p) => {
      if (!p || typeof p !== 'object') return { type: 'text', text: String(p) };
      if (p.type === 'text') return { type: 'text', text: String(p.text || '') };
      if (p.type === 'image_url' || p.type === 'image') {
        const url = p.url || p.data || '';
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (m) {
          return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
        }
        return { type: 'image', source: { type: 'url', url } };
      }
      return { type: 'text', text: JSON.stringify(p) };
    });
  } else {
    userContent = String(prompt);
  }

  const url = `${MINIMAX_BASE}/v1/messages`;
  const body = {
    model: MINIMAX_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'anthropic-version': MINIMAX_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`minimax HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

/**
 * OpenAI Platform API (gpt-4o-mini for cheap, gpt-4o for high).
 * Only used if OPENAI_API_KEY is set. Vision-capable models (gpt-4o,
 * gpt-4o-mini) accept image_url content parts natively.
 */
async function callOpenAI(prompt, opts) {
  const key = getOpenaiKey();
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const model = opts.model || 'gpt-4o-mini';
  // OpenAI's content-part format: text + image_url (string or {url}).
  // We pass the same {type, text, url} shape through.
  let userContent;
  if (Array.isArray(prompt)) {
    userContent = prompt.map((p) => {
      if (!p || typeof p !== 'object') return { type: 'text', text: String(p) };
      if (p.type === 'text') return { type: 'text', text: String(p.text || '') };
      if (p.type === 'image_url' || p.type === 'image') {
        return { type: 'image_url', image_url: { url: p.url || p.data || '' } };
      }
      return { type: 'text', text: JSON.stringify(p) };
    });
  } else {
    userContent = String(prompt);
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: userContent },
      ],
      max_tokens: opts.maxTokens || 800,
      temperature: opts.temperature ?? 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`openai HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Local heuristic — never throws, always returns a string.
 * Used when all AI providers fail.
 */
function heuristicFor(prompt, opts) {
  if (opts.task === 'classify_overdue') {
    return prompt.toLowerCase().includes('overdue') ? 'overdue' : 'ok';
  }
  if (opts.task === 'urgency_tag') return 'normal';
  if (opts.task === 'health_score') return '50';
  if (opts.task === 'follow_up_nudge') return 'Consider following up with this customer.';
  if (opts.task === 'extract_memory') {
    return JSON.stringify([{ category: 'note', key: 'bulk_import', value: prompt.slice(0, 200), confidence: 0.3 }]);
  }
  return '[heuristic] No AI available; please write a manual response.';
}

/**
 * Test a specific provider (used by Settings "Test" button).
 * Returns { ok, provider, latency_ms, sample }.
 */
export async function testProvider(taskClass = 'high_reasoning') {
  const start = Date.now();
  const provider = taskClass === 'high_reasoning' && hasOpenaiKey() ? 'openai' : 'minimax';
  try {
    const out = await callProvider(provider, taskClass, 'Reply with the single word: PONG', { maxTokens: 20 });
    return { ok: true, provider, task: taskClass, latency_ms: Date.now() - start, sample: out };
  } catch (err) {
    return { ok: false, provider, task: taskClass, latency_ms: Date.now() - start, error: err.message };
  }
}

/**
 * Read-only config snapshot (lazy getters so they reflect current env).
 */
export const config = {
  get minimaxModel() { return process.env.MINIMAX_MODEL || MINIMAX_MODEL; },
  get minimaxBase() { return process.env.MINIMAX_BASE_URL || MINIMAX_BASE; },
  get hasMinimaxKey() { return hasMinimaxKey(); },
  get hasOpenaiKey() { return hasOpenaiKey(); },
  get providersAvailable() {
    const out = [];
    if (hasOpenaiKey()) out.push('openai');
    if (hasMinimaxKey()) out.push('minimax');
    out.push('heuristic');
    return out;
  },
};
