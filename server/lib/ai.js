/**
 * AI provider router.
 *
 * Two tiers:
 *   - 'high_reasoning'  → Codex GPT-5.5 (your ChatGPT subscription)
 *   - 'cheap_classify'  → Johnny5 (MiniMax M3, via Hermes)
 *
 * Optional tertiary fallback per tier: Gemini.
 *
 * Each tier is independently configurable via env or Settings (DB).
 *
 * Usage:
 *   import { aiCall } from './lib/ai.js';
 *   const draft = await aiCall('high_reasoning', prompt, { customerMemory, conversation });
 *
 * Falls back gracefully:
 *   high fails  → cheap (MiniMax) → local heuristic → 503
 *   cheap fails → local heuristic → 503
 */

import OpenAI from 'openai';

const HIGH_PROVIDER = process.env.AI_HIGH_PROVIDER || 'codex';
const CHEAP_PROVIDER = process.env.AI_CHEAP_PROVIDER || 'minimax';

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const gemini = process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY } : null;

/**
 * Provider dispatch. Throws if all providers in the chain fail.
 * Local heuristics never throw — they return a string.
 */
export async function aiCall(taskClass, prompt, opts = {}) {
  const primary = taskClass === 'high_reasoning' ? HIGH_PROVIDER : CHEAP_PROVIDER;
  const fallbacks = taskClass === 'high_reasoning'
    ? ['minimax', 'gemini', 'heuristic']
    : ['gemini', 'heuristic'];

  const tried = new Set();

  for (const provider of [primary, ...fallbacks]) {
    if (tried.has(provider)) continue;
    tried.add(provider);
    try {
      const result = await callProvider(provider, prompt, opts);
      if (result) return { provider, output: result };
    } catch (err) {
      // Log and continue
      console.warn(`[ai] ${provider} failed:`, err.message);
    }
  }
  throw new Error(`All AI providers failed for task=${taskClass}`);
}

async function callProvider(provider, prompt, opts) {
  switch (provider) {
    case 'codex':
    case 'openai':
      if (!openai) throw new Error('OPENAI_API_KEY not set');
      return await callOpenAI(prompt, opts);
    case 'minimax':
      // Hermes-routed call: POST to a Johnny5 local endpoint
      return await callMinimax(prompt, opts);
    case 'gemini':
      if (!gemini) throw new Error('GEMINI_API_KEY not set');
      return await callGemini(prompt, opts);
    case 'heuristic':
      return heuristicFor(prompt, opts);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function callOpenAI(prompt, opts) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',  // or 'gpt-5' when available; gpt-4o-mini is the cheap Codex default
    messages: [
      { role: 'system', content: opts.system || 'You are a helpful assistant.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: opts.maxTokens || 800,
    temperature: opts.temperature ?? 0.4,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function callMinimax(prompt, opts) {
  // Hermes exposes a chat-completions-compatible endpoint.
  // For v1 dev we fall back to a small local stub so the dev server runs
  // even without Hermes running. Production sets HERMES_AI_URL.
  const url = process.env.HERMES_AI_URL;
  if (!url) {
    // Dev fallback: skip the stub if we're not configured at all
    // so the heuristic fallback can take over in tests.
    throw new Error('HERMES_AI_URL not set (dev stub disabled)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, system: opts.system, maxTokens: opts.maxTokens || 400 }),
  });
  if (!res.ok) throw new Error(`minimax HTTP ${res.status}`);
  const data = await res.json();
  return data.output || data.text || '';
}

async function callGemini(prompt, opts) {
  // Minimal Gemini Flash call (gemini-1.5-flash). Truncated for brevity.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${gemini.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: opts.maxTokens || 400, temperature: opts.temperature ?? 0.4 },
    }),
  });
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/**
 * Local heuristic fallback — never throws, returns a string.
 * Used when all AI providers are down.
 */
function heuristicFor(prompt, opts) {
  // Simple "do the minimum useful thing" pass.
  if (opts.task === 'classify_overdue') {
    return prompt.toLowerCase().includes('overdue') ? 'overdue' : 'ok';
  }
  if (opts.task === 'urgency_tag') {
    return 'normal';
  }
  if (opts.task === 'health_score') {
    return '50';
  }
  if (opts.task === 'follow_up_nudge') {
    return 'Consider following up with this customer.';
  }
  return '[heuristic] No AI available; please write a manual response.';
}

/**
 * Test a specific provider (used by the Settings "Test" button).
 * Returns { ok, latency_ms, sample }.
 */
export async function testProvider(provider) {
  const start = Date.now();
  try {
    const out = await callProvider(provider, 'Reply with the single word: PONG', { maxTokens: 20 });
    return { ok: true, provider, latency_ms: Date.now() - start, sample: out };
  } catch (err) {
    return { ok: false, provider, latency_ms: Date.now() - start, error: err.message };
  }
}
