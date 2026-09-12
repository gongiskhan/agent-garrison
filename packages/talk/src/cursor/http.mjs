import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { CursorStore, validIdentity } from './store.mjs';

export function readCursorToken(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Cursor token requires a private regular file');
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error('Cursor token is empty');
  return value;
}
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Cursor payload exceeds four megabytes');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createCursorHttp({ home, nodeId, accent, host = '127.0.0.1', tokenPath = path.join(home, 'internal-token'), store }) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(home, 'cursor', 'settings.json'), 'utf8')); } catch {}
  const state = store ?? new CursorStore({ home, nodeId, accent, config });
  const streams = new Set();
  function stream(req, res, conversationId) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = value => {
      try { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`); } catch { res.destroy(); }
    };
    const listener = change => {
      if (!conversationId) send({ row: change.row });
      else if (change.row.id === conversationId) {
        if (change.entry) send({ type: 'events', events: [change.entry] });
        send({ type: 'state', cursor: change.row.cursor });
      }
    };
    state.on('change', listener);
    streams.add(res);
    send(conversationId ? { type: 'init', available: true, live: true, events: state.entries(conversationId) } : { rows: state.rows() });
    const keep = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20000);
    keep.unref();
    res.once('close', () => { clearInterval(keep); state.off('change', listener); streams.delete(res); });
  }
  return {
    store: state,
    async handle(req, res, pathname) {
      if (!pathname.startsWith('/cursor/')) return false;
      const address = req.socket.remoteAddress;
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
      const loopback = ['127.0.0.1', '::ffff:127.0.0.1'];
      if (host !== '127.0.0.1' || (address && !loopback.includes(address)) || forwarded.some(value => !loopback.includes(value))) {
        json(res, 403, { error: 'Cursor routes require loopback' }); return true;
      }
      let expected;
      try { expected = readCursorToken(tokenPath); } catch { json(res, 503, { error: 'Cursor local token unavailable' }); return true; }
      const received = req.headers['x-garrison-internal'];
      if (typeof received !== 'string' || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
        json(res, 401, { error: 'Cursor local token required' }); return true;
      }
      try {
        if (req.method === 'POST' && ['/cursor/hooks/event', '/cursor/hooks/stop'].includes(pathname)) {
          const payload = await body(req);
          state.ingest(payload);
          json(res, 200, pathname.endsWith('/stop') ? { action: 'release' } : { ok: true });
        } else if (req.method === 'GET' && pathname === '/cursor/conversations') {
          json(res, 200, { rows: state.rows() });
        } else if (req.method === 'GET' && pathname === '/cursor/events') {
          stream(req, res);
        } else {
          const match = /^\/cursor\/conversations\/([^/]+)\/([^/]+)\/stream$/.exec(pathname);
          if (req.method === 'GET' && match && match[1] === nodeId && validIdentity(match[2]) && state.get(match[2])) stream(req, res, match[2]);
          else json(res, 404, { error: 'Cursor conversation not found' });
        }
      } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.end(); }
      return true;
    },
    close() { for (const res of streams) res.end(); state.removeAllListeners(); },
  };
}
