/**
 * Build-artifact download route.
 *
 * Covers /builds/:filename (the route added so Byron can pull prebuilt
 * plugin zips, etc. without juggling ad-hoc HTTP servers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../index.js';

let app;
let tempRoot;
let originalBuildsRoot;

beforeAll(async () => {
  // Redirect BUILDS_ROOT to a temp dir so the test never touches the
  // operator's real /home/byron/projects/hide-variable-price/build.
  tempRoot = mkdtempSync(join(tmpdir(), 'hvp-builds-test-'));
  mkdirSync(join(tempRoot, 'sub-dir-not-allowed'), { recursive: true });
  writeFileSync(join(tempRoot, 'hello.txt'), 'world');
  writeFileSync(join(tempRoot, 'plugin.zip'), 'fake-zip-bytes');
  originalBuildsRoot = process.env.BUILDS_ROOT;
  process.env.BUILDS_ROOT = tempRoot;

  app = await buildServer({
    logger: false,
    dbPath: ':memory:',
    skipPoller: true,
    skipSmtp: true,
  });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (typeof originalBuildsRoot === 'undefined') {
    delete process.env.BUILDS_ROOT;
  } else {
    process.env.BUILDS_ROOT = originalBuildsRoot;
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('GET /builds/:filename', () => {
  it('returns 200 + attachment headers for a top-level file', async () => {
    const res = await app.inject({ method: 'GET', url: '/builds/hello.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('hello.txt');
    expect(res.body).toBe('world');
  });

  it('returns application/zip content-type for .zip files', async () => {
    const res = await app.inject({ method: 'GET', url: '/builds/plugin.zip' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.body).toBe('fake-zip-bytes');
  });

  it('returns 404 for files that do not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/builds/does-not-exist.zip' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects path traversal attempts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/builds/' + encodeURIComponent('../etc/passwd'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects nested-directory paths (only top-level files allowed)', async () => {
    // Fastify decodes %2F back to / so this URL resolves to a path that
    // doesn't match /builds/:filename at all — the route is not found.
    // Either way (400 or 404), the important thing is we do NOT serve
    // the file from a subdirectory.
    const res = await app.inject({
      method: 'GET',
      url: '/builds/' + encodeURIComponent('sub-dir-not-allowed/inner.txt'),
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('rejects explicit ".." path component', async () => {
    // Fastify decodes ".." and treats /builds/.. as the root /, so we
    // land on a non-existent route — 404 is the correct rejection here.
    const res = await app.inject({
      method: 'GET',
      url: '/builds/' + encodeURIComponent('..'),
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});
