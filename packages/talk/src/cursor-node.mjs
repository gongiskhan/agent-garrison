import fs from 'node:fs';
import path from 'node:path';
import { createCursorHttp } from './cursor/http.mjs';

export function cursorNodeHandler({ home }) {
  try {
    const node = JSON.parse(fs.readFileSync(path.join(home, 'node.json'), 'utf8'));
    return createCursorHttp({ home, nodeId: node.id ?? node.name, accent: node.accentHex });
  } catch {
    return {
      handle(req, res) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Cursor local journal unavailable' }));
      },
      close() {},
    };
  }
}
