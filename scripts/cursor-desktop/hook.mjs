#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let finished = false;
let request;
const finish = (value = {}) => {
  if (finished) return;
  finished = true;
  request?.destroy();
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(0));
};
process.on('SIGTERM', () => finish());
process.on('SIGINT', () => finish());
process.on('uncaughtException', () => finish());
process.on('unhandledRejection', () => finish());
const watchdog = setTimeout(() => finish(), 1700);
const mode = process.argv[2];
let input = '';
process.stdin.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 4 * 1024 * 1024) finish(); });
process.stdin.on('error', () => finish());
process.stdin.on('end', () => {
  try {
    if (!['event', 'stop'].includes(mode)) return finish();
    const file = process.env.GARRISON_CURSOR_ENV_FILE ?? path.join(os.homedir(), '.garrison', 'cursor-hook.env');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) return finish();
    const env = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
      const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
    }));
    const url = new URL(env.GARRISON_CURSOR_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) return finish();
    if (!env.GARRISON_CURSOR_TOKEN || !env.GARRISON_CURSOR_NODE_ID) return finish();
    const payload = JSON.parse(input);
    const data = JSON.stringify({ ...payload, node_id: env.GARRISON_CURSOR_NODE_ID, received_at: Date.now() });
    url.pathname = `${url.pathname.startsWith('/api') ? '/api' : ''}/cursor/hooks/${mode}`;
    request = http.request(url, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      'x-garrison-internal': env.GARRISON_CURSOR_TOKEN,
    } }, response => {
      if (response.statusCode !== 200) return finish();
      if (mode === 'stop') clearTimeout(watchdog);
      let result = '';
      response.on('data', chunk => { result += chunk.toString(); if (result.length > 4 * 1024 * 1024) finish(); });
      response.on('error', () => finish());
      response.on('aborted', () => finish());
      response.on('end', () => {
        try {
          const answer = JSON.parse(result);
          if (mode === 'stop') {
            return finish(['followup', 'rearm'].includes(answer.action) && typeof answer.text === 'string' ? { followup_message: answer.text } : {});
          }
          if (answer.ok !== true) return finish();
          if (payload.hook_event_name === 'beforeSubmitPrompt') return finish({ continue: true });
          if (['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse'].includes(payload.hook_event_name)) return finish({ permission: 'allow' });
          finish();
        } catch { finish(); }
      });
    });
    request.on('error', () => finish());
    request.end(data);
  } catch { finish(); }
});
