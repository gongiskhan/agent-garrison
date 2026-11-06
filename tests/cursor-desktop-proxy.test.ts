import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
// @ts-expect-error Standalone Node module without declarations.
import { cursorProxy } from '../packages/talk/src/cursor-proxy.mjs';
import { createTalkRouter } from '../packages/talk/src/router.mjs';
import { NodeRequestShim, NodeResponseShim } from '../src/lib/node-handler-shim';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe('Cursor browser relay', () => {
  it('mounts private hooks through the app shim and refuses forwarded callers even with a valid token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-app-ingress-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const previousHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;
    cleanups.push(() => { process.env.GARRISON_HOME = previousHome; });
    fs.writeFileSync(path.join(home, 'internal-token'), 'only-on-node', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({ id: 'fixture-node' }));
    const router = createTalkRouter({ port: 12345 });
    async function request(pathname: string, headers = {}, payload?: unknown) {
      const body = payload ? Buffer.from(JSON.stringify(payload)) : null;
      const req = new NodeRequestShim(new NextRequest(`http://localhost${pathname}`, { method: body ? 'POST' : 'GET', headers }) as any, body);
      const res = new NodeResponseShim();
      expect(await router(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse)).toBe(true);
      return res.toResponse();
    }
    const event = { node_id: 'fixture-node', conversation_id: 'real-id', hook_event_name: 'beforeSubmitPrompt', prompt: 'A desktop prompt' };
    expect((await request('/api/cursor/hooks/event', {}, event)).status).toBe(401);
    expect((await request('/api/cursor/hooks/event', { 'x-garrison-internal': 'only-on-node', 'x-forwarded-for': '100.64.0.1' }, event)).status).toBe(403);
    const accepted = await request('/api/cursor/hooks/event', { 'x-garrison-internal': 'only-on-node' }, event);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    const listing = await request('/api/cursor/internal/conversations', { 'x-garrison-internal': 'only-on-node' });
    expect((await listing.json()).rows).toMatchObject([{ id: 'real-id', cursor: { state: 'working', origin_of_last_prompt: 'desk' } }]);
  });
  it('injects the local token server-side and streams through the app response shim', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-relay-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.writeFileSync(path.join(home, 'internal-token'), 'only-on-node', { mode: 0o600 });
    let presented: unknown;
    const node = http.createServer((req, res) => {
      presented = req.headers['x-garrison-internal'];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"rows":[]}\n\n');
    });
    node.listen(0, '127.0.0.1'); await once(node, 'listening');
    cleanups.push(async () => { node.closeAllConnections(); await new Promise<void>(r => node.close(() => r())); });
    const req = new NodeRequestShim(new NextRequest('http://localhost/api/cursor/events') as any, null);
    const res = new NodeResponseShim();
    expect(cursorProxy(req, res, '/api/cursor/events', { home, nodeUrl: `http://127.0.0.1:${(node.address() as any).port}` })).toBe(true);
    const response = await res.toResponse();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"rows":[]}\n\n');
    expect(presented).toBe('only-on-node');
    expect([...response.headers.values()].join(' ')).not.toContain('only-on-node');
  });
  it.each(['/api/cursor/hooks/event', '/api/cursor/hooks/stop'])('does not expose %s through the browser relay', async pathname => {
    const req = new NodeRequestShim(new NextRequest(`http://localhost${pathname}`, { method: 'POST' }) as any, null);
    const res = new NodeResponseShim();
    cursorProxy(req, res, pathname, { home: '/unused', nodeUrl: 'http://127.0.0.1:1' });
    expect((await res.toResponse()).status).toBe(404);
  });
});
