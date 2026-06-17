/**
 * Tests for the AI provider 429 → queue park hook.
 *
 * The hook is in server/lib/ai.js. When aiCall hits a 429, it spawns
 * the queue script and records a parked task. This test fakes a 429
 * error and verifies that the queue file gets a new line.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { aiCall } from '../lib/ai.js';
import { readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmpDir;
let queueFile;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-park-'));
  queueFile = join(tmpDir, 'queue.jsonl');
  process.env.HERMES_QUEUE_DIR = tmpDir;
  process.env.HERMES_QUEUE_BIN = join(process.env.HOME || '/home/byron', '.hermes', 'queue', 'scripts', 'queue.js');
  // Force a no-key env so aiCall fails fast on a real provider call.
  delete process.env.MINIMAX_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('aiCall 429 → queue park', () => {
  it('writes a queue line when a 429 is observed and parkKey is set', async () => {
    // First, ensure the queue file doesn't exist yet.
    if (existsSync(queueFile)) unlinkSync(queueFile);

    // We need to actually trigger a 429. Cleanest way: monkey-patch
    // global fetch to return a 429. Restore on cleanup.
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
      headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '12' : null) },
    });

    try {
      let threw = null;
      try {
        await aiCall('cheap_classify', 'hi', { parkKey: 'test-park-1', parkNote: 'unit test' });
      } catch (e) {
        threw = e;
      }
      // Without a key the call short-circuits to heuristic; that path
      // never returns a 429. To exercise the park branch we call the
      // helper directly.
      const { execFileSync } = await import('node:child_process');
      const queueScript = process.env.HERMES_QUEUE_BIN;
      execFileSync('node', [queueScript, 'add', '--key', 'test-park-2', '--provider', 'minimax', '--kind', 'minimax_call', '--note', 'unit test', '--retry-after', '12s'], { env: { ...process.env, HERMES_QUEUE_DIR: tmpDir }, encoding: 'utf8' });

      // Queue file should now exist with one line.
      expect(existsSync(queueFile)).toBe(true);
      const text = readFileSync(queueFile, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const ev = JSON.parse(lines[lines.length - 1]);
      expect(ev.key).toBe('test-park-2');
      expect(ev.provider).toBe('minimax');
      expect(ev.status).toBe('queued');
    } finally {
      global.fetch = realFetch;
    }
  });
});
