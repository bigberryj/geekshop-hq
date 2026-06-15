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

const MINIMAX_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const MINIMAX_VERSION = '2023-06-01';

function getMinimaxKey() { return process.env.MINIMAX_API_KEY; }
function hasMinimaxKey() { return Boolean(getMinimaxKey()); }

function getOpenaiKey() { return process.env.OPENAI_API_KEY; }
function hasOpenaiKey() { return Boolean(getOpenaiKey()); }

/**
 * Public entrypoint. Returns { provider, output } or throws.
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
    }
  }
  throw new Error(`All AI providers failed for task=${taskClass}: ${errors.join(' | ')}`);
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
 */
async function callMinimax(prompt, opts, taskClass) {
  const key = getMinimaxKey();
  if (!key) throw new Error('MINIMAX_API_KEY not set');

  // Tier-specific defaults
  const isHigh = taskClass === 'high_reasoning';
  const maxTokens = opts.maxTokens ?? (isHigh ? 800 : 60);
  const systemPrompt = opts.system ?? (isHigh
    ? 'You are a helpful, precise assistant. Be concise and specific.'
    : 'You are a classifier. Reply with the minimum answer required, exactly as instructed. No preamble.');

  const url = `${MINIMAX_BASE}/v1/messages`;
  const body = {
    model: MINIMAX_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
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
 * Only used if OPENAI_API_KEY is set.
 */
async function callOpenAI(prompt, opts) {
  const key = getOpenaiKey();
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const model = opts.model || 'gpt-4o-mini';
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
        { role: 'user', content: prompt },
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
