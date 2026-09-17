import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const readable = /^\/cursor\/(events|conversations|conversations\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/stream)$/;
export function cursorProxy(req, res, pathname, { home, nodeUrl, prefix = '/cursor' }) {
  if (!pathname.startsWith('/api/cursor/')) return false;
  const subpath = pathname.slice(4);
  const fail = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error })); };
  if (req.method !== 'GET' || !readable.test(subpath)) { fail(404, 'Cursor route not available'); return true; }
  try {
    const base = new URL(nodeUrl);
    if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password) throw new Error('Cursor node must be local');
    const token = fs.readFileSync(path.join(home, 'internal-token'), 'utf8').trim();
    const upstream = http.request(new URL(prefix + subpath.slice('/cursor'.length), base), { headers: { 'x-garrison-internal': token }, method: req.method }, response => {
      upstream.setTimeout(0);
      res.statusCode = response.statusCode;
      for (const name of ['content-type', 'cache-control', 'x-accel-buffering']) if (response.headers[name]) res.setHeader(name, response.headers[name]);
      res.flushHeaders?.();
      response.pipe(res);
      response.on('error', () => res.end());
    });
    upstream.setTimeout(1800, () => upstream.destroy(new Error('Cursor node unavailable')));
    upstream.on('error', () => { if (!res.headersSent) fail(503, 'Cursor node unavailable'); else res.end(); });
    res.once('close', () => upstream.destroy());
    upstream.end();
  } catch { fail(503, 'Cursor node unavailable'); }
  return true;
}
