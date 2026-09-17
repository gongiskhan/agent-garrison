import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
// @ts-expect-error Standalone Node module without declarations.
import { createCursorHttp } from '../packages/talk/src/cursor/http.mjs';

describe('captured Cursor hook integration', () => {
  it.skipIf(!process.env.GARRISON_CURSOR_CAPTURE_FILE)('replays the real node-local Phase 0 payloads through the endpoint', async () => {
    const rows = fs.readFileSync(process.env.GARRISON_CURSOR_CAPTURE_FILE!, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'payload');
    const events = new Set(rows.map(row => row.payload.hook_event_name));
    expect(events.size).toBe(14);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-capture-'));
    fs.writeFileSync(path.join(home, 'internal-token'), 'capture-test-token', { mode: 0o600 });
    const cursor = createCursorHttp({ home, nodeId: 'capture-test' });
    const server = http.createServer((req, res) => { void cursor.handle(req, res, req.url); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      for (const row of rows) {
        const payload = { ...row.payload, node_id: 'capture-test', received_at: row.at };
        const response = await fetch(url + '/cursor/hooks/event', { method: 'POST', headers: { 'x-garrison-internal': 'capture-test-token', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        expect(response.status).toBe(200);
        if (payload.hook_event_name === 'afterAgentResponse') {
          expect(cursor.store.entries(payload.conversation_id).some((entry: any) => entry.event === 'assistant.message' && entry.blocks[0].text === payload.text)).toBe(true);
        }
      }
      expect(cursor.store.rows().length).toBeGreaterThan(5);
    } finally {
      cursor.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
