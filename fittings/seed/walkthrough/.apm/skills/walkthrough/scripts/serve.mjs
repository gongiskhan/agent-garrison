#!/usr/bin/env node
// serve.mjs — serve the central runs directory over the tailnet with correct
// HTTP Range/206 support (so phones can scrub instead of downloading), plus a
// rich gallery SPA (search / sort / group, real thumbnails, and an in-page
// fullscreen player with arrow-key + swipe navigation). Binds to the Tailscale
// IP only (tailnet-only), never 0.0.0.0.
//
// Routes:
//   GET /                 -> gallery.html with run data injected
//   GET /api/runs         -> JSON list of every run (data behind the gallery)
//   GET /thumb/<rel>      -> small cached JPEG poster for a run (ffmpeg, lazy)
//   GET /<path under ROOT>-> the file itself, with Range/206 (videos, frames…)
//
// Usage: node serve.mjs [--root <dir>] [--port <n>] [--host <ip>]
//   defaults: root=~/.walkthrough/runs  port=8099  host=<tailscale ip -4>
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exec } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ROOT = path.resolve(arg('--root', path.join(os.homedir(), '.walkthrough', 'runs')));
const PORT = parseInt(arg('--port', '8099'), 10);
let HOST = arg('--host', '');
if (!HOST) {
  try { HOST = execSync('tailscale ip -4', { encoding: 'utf8' }).trim().split('\n')[0]; }
  catch { HOST = '127.0.0.1'; }
}

const GALLERY_HTML = readFileSync(path.join(__dirname, 'gallery.html'), 'utf8');

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
};

// Walk runs under each project. A run is ANY directory containing final.mp4, so
// both the flat layout (ROOT/<project>/<timestamp>/) and the foldered layout
// (ROOT/<project>/<folder>/<timestamp>/, folders may nest) are discovered. The
// folder is the path between the project and the timestamp dir.
function listRuns() {
  if (!existsSync(ROOT)) return [];
  const runs = [];
  for (const project of safeDirs(ROOT)) {
    const stack = [{ dir: path.join(ROOT, project), parts: [] }];
    while (stack.length) {
      const { dir, parts } = stack.pop();
      const finalMp4 = path.join(dir, 'final.mp4');
      if (existsSync(finalMp4)) {
        const ts = parts.length ? parts[parts.length - 1] : path.basename(dir);
        const folderFromPath = parts.slice(0, -1).join('/') || null;
        let manifest = {}, pass = {}, bytes = 0;
        try { manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {}
        try { pass = JSON.parse(readFileSync(path.join(dir, 'pass-record.json'), 'utf8')); } catch {}
        try { bytes = statSync(finalMp4).size; } catch {}
        // Chapter markers (caption + start time) drive search and the in-player
        // seek strip; keep only beats that actually carry a caption.
        const chapters = (manifest.beats || [])
          .filter((b) => b && b.caption)
          .map((b) => ({ caption: b.caption, t: Number(b.tStart) || 0, fail: !!b.expectFailure }));
        runs.push({
          project, folder: manifest.folder ?? folderFromPath, ts,
          rel: path.relative(ROOT, finalMp4).split(path.sep).join('/'),
          title: manifest.title || project, duration: manifest.duration || 0,
          beats: (manifest.beats || []).length, flagged: !!manifest.flagged,
          verified: !!(pass && pass.verifiedAt), createdAt: manifest.createdAt || ts,
          bytes, chapters,
        });
        continue; // run dirs are leaves — do not descend into work/frames
      }
      for (const child of safeDirs(dir)) stack.push({ dir: path.join(dir, child), parts: [...parts, child] });
    }
  }
  runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return runs;
}
function safeDirs(p) {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}

// ---- thumbnails -----------------------------------------------------------
// One small JPEG poster per run, generated once with ffmpeg and cached as
// thumb.jpg beside final.mp4. ffmpeg is already a hard dependency (record +
// preflight). Generation is bounded by a tiny semaphore so a fresh gallery
// load can't fork 80 ffmpegs at once.
const THUMB_W = 480;
const MAX_THUMB_JOBS = 4;
let runningJobs = 0;
const waiters = [];
function acquire() {
  if (runningJobs < MAX_THUMB_JOBS) { runningJobs++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  const next = waiters.shift();
  if (next) next();        // hand the held slot straight to the next waiter
  else runningJobs--;      // no waiter: free it
}
const inflight = new Map();

function thumbTimestamp(runDir, duration) {
  // Prefer the first real content beat (intro/outro are title cards); else a
  // little way into the video.
  try {
    const m = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    const beat = (m.beats || []).find(
      (b) => typeof b.tMid === 'number' && !/^(intro|outro|title)$/i.test(b.id || ''));
    if (beat) return Math.max(0.1, beat.tMid);
  } catch {}
  return duration ? Math.min(2, Math.max(0.1, duration * 0.3)) : 1;
}

function ensureThumb(rel) {
  const finalPath = path.normalize(path.join(ROOT, rel));
  if (!finalPath.startsWith(ROOT) || path.basename(finalPath) !== 'final.mp4' || !existsSync(finalPath)) {
    return Promise.resolve(null);
  }
  const runDir = path.dirname(finalPath);
  const thumb = path.join(runDir, 'thumb.jpg');
  try {
    if (existsSync(thumb) && statSync(thumb).mtimeMs >= statSync(finalPath).mtimeMs) {
      return Promise.resolve(thumb);
    }
  } catch {}
  if (inflight.has(thumb)) return inflight.get(thumb);

  const job = (async () => {
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); } catch {}
    const t = thumbTimestamp(runDir, manifest.duration || 0);
    await acquire();
    try {
      const r = await exec('ffmpeg', [
        '-y', '-loglevel', 'error', '-ss', String(t), '-i', finalPath,
        '-frames:v', '1', '-vf', `scale=${THUMB_W}:-2`, '-q:v', '5', thumb,
      ], { timeoutMs: 20000 });
      return (r.code === 0 && existsSync(thumb)) ? thumb : null;
    } finally {
      release();
    }
  })().finally(() => inflight.delete(thumb));

  inflight.set(thumb, job);
  return job;
}

function escapeHtml(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function serveFile(req, res, filePath, extraHeaders = {}) {
  const stat = statSync(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
      ...extraHeaders,
    });
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extraHeaders });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURI((req.url || '/').split('?')[0]);

    if (url === '/' || url === '/index.html') {
      const data = JSON.stringify(listRuns()).replace(/</g, '\\u003c');
      const html = GALLERY_HTML.replace('__RUNS_JSON__', data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }

    if (url === '/api/runs') {
      const body = JSON.stringify(listRuns());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }

    if (url.startsWith('/thumb/')) {
      const rel = url.slice('/thumb/'.length);
      const thumb = await ensureThumb(rel);
      if (!thumb) { res.writeHead(404); return res.end('no thumb'); }
      return serveFile(req, res, thumb, { 'Cache-Control': 'public, max-age=86400' });
    }

    // Resolve within ROOT only (no traversal).
    const target = path.normalize(path.join(ROOT, url));
    if (!target.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    if (!existsSync(target) || !statSync(target).isFile()) { res.writeHead(404); return res.end('not found'); }
    serveFile(req, res, target);
  } catch (e) {
    res.writeHead(500); res.end('error: ' + String(e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, url: `http://${HOST}:${PORT}/`, root: ROOT, host: HOST, port: PORT }, null, 2));
});
