#!/usr/bin/env node
// autothing-report: standing, Tailscale-reachable static file server for run logs.
//
// Serves files IN PLACE by following symlinks the skill creates, so logs are
// LINKED, never duplicated. Idempotent + self-daemonizing: the first call spawns
// a detached server and prints its Tailscale URL; later calls detect the running
// server and just print the URL. Read-only (GET), with a directory index.
//
// Usage:  node serve.mjs [--root <dir>] [--port <n>]
//   default root = ~/.autothing/report   default port = 8091
// Status file: ~/.autothing/report-serve.json  ({pid, port, root, url, startedAt})
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';

const HOME = os.homedir();
const argVal = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const ROOT = path.resolve(argVal('--root') || path.join(HOME, '.autothing', 'report'));
const PORT = parseInt(argVal('--port') || '8091', 10);
const STATUS = path.join(HOME, '.autothing', 'report-serve.json');
const SELF = new URL(import.meta.url).pathname;

function tailscaleIP() {
  try {
    const out = execSync('tailscale ip -4', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n')[0].trim();
    if (out) return out;
  } catch {}
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const safeIsDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function ctype(fp) {
  const e = path.extname(fp).toLowerCase();
  return ({ '.json': 'application/json', '.jsonl': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.mp4': 'video/mp4', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg' }[e]
    || 'application/octet-stream');
}

if (process.env._AUTOTHING_SERVE_CHILD === '1') runServer();
else ensureRunning();

function ensureRunning() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
    if (s.pid && s.port === PORT && s.root === ROOT && alive(s.pid)) { console.log(s.url); return; }
  } catch {}
  const child = spawn(process.execPath, [SELF, '--root', ROOT, '--port', String(PORT)],
    { detached: true, stdio: 'ignore', env: { ...process.env, _AUTOTHING_SERVE_CHILD: '1' } });
  child.unref();
  const url = `http://${tailscaleIP()}:${PORT}/`;
  fs.writeFileSync(STATUS, JSON.stringify({ pid: child.pid, port: PORT, root: ROOT, url, startedAt: new Date().toISOString() }, null, 2));
  console.log(url);
}

function runServer() {
  const server = http.createServer((req, res) => {
    try {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (reqPath.includes('..')) { res.writeHead(400); return res.end('bad path'); }
      const fp = path.join(ROOT, reqPath);
      let st; try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end('not found'); }
      if (st.isDirectory()) {
        const entries = fs.readdirSync(fp, { withFileTypes: true });
        const items = entries.map((e) => {
          const isDir = e.isDirectory() || (e.isSymbolicLink() && safeIsDir(path.join(fp, e.name)));
          const href = path.posix.join(reqPath, e.name) + (isDir ? '/' : '');
          return `<li><a href="${href}">${e.name}${isDir ? '/' : ''}</a></li>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset=utf8><title>${reqPath}</title>` +
          `<h2>Index of ${reqPath}</h2><ul>${items || '<li><em>(empty)</em></li>'}</ul>`);
      }
      res.writeHead(200, { 'content-type': ctype(fp) });
      fs.createReadStream(fp).pipe(res);
    } catch { res.writeHead(500); res.end('error'); }
  });
  server.listen(PORT, '0.0.0.0', () => {
    try { const s = JSON.parse(fs.readFileSync(STATUS, 'utf8')); s.pid = process.pid; fs.writeFileSync(STATUS, JSON.stringify(s, null, 2)); } catch {}
  });
}
