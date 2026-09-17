import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
// @ts-expect-error Standalone Node module without declarations.
import { cursorProxy } from '../packages/talk/src/cursor-proxy.mjs';
import { NodeRequestShim, NodeResponseShim } from '../src/lib/node-handler-shim';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe('Cursor browser relay', () => {
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
