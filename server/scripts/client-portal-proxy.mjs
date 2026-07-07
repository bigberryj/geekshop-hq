#!/usr/bin/env node
/**
 * Public client-portal edge proxy for Cloudflare Tunnel.
 *
 * Purpose: expose only the client portal surface to the public internet:
 *   - /portal/* SPA routes
 *   - /assets/* built Vite assets
 *   - /api/portal/* client-portal API
 *   - /api/health read-only health check
 *
 * Everything else, including admin HQ routes and non-portal /api/* endpoints,
 * returns 404 from this process. Cloudflare Tunnel should point to this proxy,
 * not directly to Vite (:5173) or the backend (:5050).
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const rootDir = resolve(__dirname, '../..');
const distDir = process.env.PORTAL_DIST_DIR || resolve(rootDir, 'client/dist');
const backendOrigin = process.env.PORTAL_BACKEND_ORIGIN || 'http://127.0.0.1:5050';
const listenHost = process.env.PORTAL_PROXY_HOST || '127.0.0.1';
const listenPort = Number(process.env.PORTAL_PROXY_PORT || 5080);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function setPublicHeaders(res, contentType) {
  res.setHeader('content-type', contentType);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  // The React portal currently uses same-origin API calls and static assets only.
  // Keep CSP conservative; relax only with a documented reason.
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function safeFilePath(urlPath) {
  const withoutLeading = urlPath.replace(/^\/+/, '');
  const candidate = normalize(join(distDir, withoutLeading));
  if (!candidate.startsWith(distDir)) return null;
  return candidate;
}

function serveFile(res, filePath) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return send(res, 404, 'not found');
  }
  setPublicHeaders(res, mime[extname(filePath)] || 'application/octet-stream');
  createReadStream(filePath).pipe(res);
}

function serveSpa(res) {
  serveFile(res, resolve(distDir, 'index.html'));
}

function proxyToBackend(req, res) {
  const target = new URL(req.url, backendOrigin);
  const upstream = httpRequest(target, {
    method: req.method,
    headers: {
      ...req.headers,
      host: target.host,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': 'https',
    },
  }, (upstreamRes) => {
    const headers = { ...upstreamRes.headers };
    // Do not let the backend loosen frame/content settings accidentally on the public edge.
    headers['x-content-type-options'] = 'nosniff';
    headers['referrer-policy'] = headers['referrer-policy'] || 'same-origin';
    res.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (err) => send(res, 502, `backend unavailable: ${err.message}`));
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/') {
    res.writeHead(302, { location: '/portal/login' });
    res.end();
    return;
  }

  if (path === '/healthz') {
    return send(res, 200, 'ok');
  }

  if (path === '/api/health' || path.startsWith('/api/portal/')) {
    return proxyToBackend(req, res);
  }

  if (path.startsWith('/api/')) {
    return send(res, 404, 'not found');
  }

  if (path.startsWith('/assets/')) {
    return serveFile(res, safeFilePath(path));
  }

  if (path.startsWith('/portal')) {
    return serveSpa(res);
  }

  return send(res, 404, 'not found');
});

server.listen(listenPort, listenHost, () => {
  console.log(`GeekShop client portal proxy listening on http://${listenHost}:${listenPort}`);
  console.log(`Serving ${distDir}; proxying /api/portal/* to ${backendOrigin}`);
});
