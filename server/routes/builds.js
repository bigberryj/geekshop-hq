/**
 * Build-artifact downloads.
 *
 * Exposes /builds/:filename over HQ's existing API server so the operator can
 * pull prebuilt plugin zips, etc. from a known URL without juggling ad-hoc
 * HTTP servers. Only files directly inside the configured build root are
 * served; path traversal is rejected.
 *
 * Add BUILDS_ROOT to server/.env to enable. Defaults to
 * /home/byron/projects/hide-variable-price/build/ for now (the only thing
 * actually using it).
 */
import { createReadStream, statSync } from 'node:fs';
import { resolve, join, normalize, basename } from 'node:path';

const DEFAULT_BUILDS_ROOT = '/home/byron/projects/hide-variable-price/build';

function safeJoin(rootDir, requested) {
  // Strip any directory components — only top-level filenames are allowed.
  const flat = basename(String(requested || ''));
  if (!flat || flat === '.' || flat === '..' || flat.includes('/') || flat.includes('\\')) {
    return null;
  }
  const full = normalize(join(rootDir, flat));
  // Defence in depth: ensure full is still inside rootDir.
  if (!full.startsWith(resolve(rootDir))) {
    return null;
  }
  return full;
}

export async function buildRoutes(app) {
  // Read at request time so tests can override BUILDS_ROOT per-run.
  const buildsRoot = () => process.env.BUILDS_ROOT || DEFAULT_BUILDS_ROOT;

  app.get('/builds/:filename', async (req, reply) => {
    const full = safeJoin(buildsRoot(), req.params.filename);
    if (!full) {
      reply.code(400);
      return { error: 'invalid filename' };
    }
    let st;
    try {
      st = statSync(full);
    } catch {
      reply.code(404);
      return { error: 'not found' };
    }
    if (!st.isFile()) {
      reply.code(404);
      return { error: 'not found' };
    }
    reply.header('Content-Length', String(st.size));
    reply.header('Content-Disposition', `attachment; filename="${basename(full)}"`);
    // application/zip for .zip, application/gzip for .tar.gz, otherwise octet-stream.
    if (full.endsWith('.zip')) reply.type('application/zip');
    else if (full.endsWith('.tar.gz') || full.endsWith('.tgz')) reply.type('application/gzip');
    else reply.type('application/octet-stream');
    return reply.send(createReadStream(full));
  });
}
