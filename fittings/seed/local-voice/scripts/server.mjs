#!/usr/bin/env node
// Local Voice's public HTTP boundary and supervised Python engine. Only this
// wrapper publishes an own-port record; the engine stays on private loopback.
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const VOICE_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../voice-server');
const cfg = key => process.env[`GARRISON_LOCALVOICE_${key}`];
export const LIMITS = Object.freeze({ audio: 25 * 1024 * 1024, json: 16 * 1024,
  transcript: 64 * 1024, speech: 12 * 1024 * 1024, text: 900,
  bodyMs: 15_000, requestMs: 120_000, requests: 2, wsPayload: 16 * 1024, wsClients: 16 });

export function parseArgs(argv = []) {
  const out = { port: Number(cfg('PORT')), host: cfg('BIND_HOST') || '127.0.0.1',
    pythonBin: cfg('PYTHON_BIN') || process.env.LOCAL_VOICE_PYTHON || '',
    kokoroVoice: cfg('KOKORO_VOICE') || 'bm_george', kokoroSpeed: cfg('KOKORO_SPEED') || '1.0',
    whisperModel: cfg('WHISPER_MODEL') || 'small', langVoices: cfg('LANG_VOICES') || '',
    wakeWord: cfg('WAKE_WORD') || 'off', authToken: process.env.LOCAL_VOICE_AUTH_TOKEN || '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--python') out.pythonBin = argv[++i];
  }
  return out;
}

export function resolvePython(opts) {
  const venv = process.env.LOCAL_VOICE_VENV || path.join(os.homedir(), '.cache/garrison-local-voice/venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(python)) return python;
  return opts.pythonBin || 'python3';
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function jsonRes(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Tailnet Serve connects over loopback, so its browser Origin must still match
// the incoming Host. Another tailnet node or localhost port is another origin.
function trustedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.ts.net')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^(?:f[cd]|fe[89ab])/i.test(host);
}
export function originAllowed(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin === undefined) return true;
  try {
    const origin = new URL(req.headers.origin);
    const target = new URL(`http://${req.headers.host || ''}`);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === req.headers.origin &&
      origin.host.toLowerCase() === target.host.toLowerCase() && trustedHost(target.hostname);
  } catch { return false; }
}

function equalToken(a, b) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function requestAuthorized(req, ctx) {
  const addr = req.socket?.remoteAddress || '';
  if (addr === '::1' || addr === '::ffff:127.0.0.1' || /^127\./.test(addr)) return true;
  if (!ctx.authToken) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const query = new URL(req.url || '/', 'http://local').searchParams.get('token') || '';
  return equalToken(bearer, ctx.authToken) || equalToken(query, ctx.authToken);
}

export async function readBody(req, limit, timeoutMs = LIMITS.bodyMs) {
  if (req.aborted) throw httpError(400, 'request aborted');
  if (Number(req.headers['content-length']) > limit) throw httpError(413, 'payload too large');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const finish = (error, body) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onError);
      chunks = [];
      if (error) { req.once('error', () => {}); req.resume(); reject(error); } else resolve(body);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) finish(httpError(413, 'payload too large'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onAbort = () => finish(httpError(400, 'request aborted'));
    const onError = () => finish(httpError(400, 'could not read request'));
    const timer = setTimeout(() => finish(httpError(408, 'request body timed out')), timeoutMs);
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onError);
  });
}

// A wall-clock deadline covers headers, body and silence. Closing the RESPONSE
// detects a browser disappearing after upload; req.close only marks body end.
export function proxyRequest(req, res, ctx, { route, body, contentType, maxBytes, transform }) {
  return new Promise(resolve => {
    let upstream, response, settled = false, size = 0;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      res.off('close', disconnected); req.off('aborted', disconnected);
      if (error) {
        upstream?.destroy(); response?.destroy();
        jsonRes(res, error.status || 502, { error: error.message });
      }
      resolve();
    };
    const disconnected = () => {
      if (!res.writableFinished) finish(httpError(499, 'request cancelled'));
    };
    const timer = setTimeout(() => finish(httpError(504, 'voice engine request timed out')), ctx.limits.requestMs);
    res.once('close', disconnected); req.once('aborted', disconnected);
    if (res.destroyed || req.aborted) { disconnected(); return; }
    upstream = http.request({ hostname: '127.0.0.1', port: ctx.pyPort, path: route, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length } }, up => {
      response = up;
      const chunks = [];
      const failed = up.statusCode !== 200;
      up.on('error', () => finish(httpError(502, 'voice engine response failed')));
      up.on('aborted', () => finish(httpError(502, 'voice engine response interrupted')));
      up.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > (failed ? 8192 : maxBytes)) { finish(httpError(502, 'voice engine response too large')); return; }
        if (failed || transform) chunks.push(chunk);
        else {
          if (!res.headersSent) {
            if (!/^audio\/wav(?:;|$)/i.test(up.headers['content-type'] || '')) {
              finish(httpError(502, 'voice engine returned invalid audio')); return;
            }
            const headers = { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' };
            for (const key of ['x-voice-lang', 'x-voice']) if (up.headers[key]) headers[key] = String(up.headers[key]).slice(0, 128);
            res.writeHead(200, headers);
          }
          if (!res.write(chunk)) up.pause();
        }
      });
      res.on('drain', () => up.resume());
      up.once('end', () => {
        if (settled) return;
        if (failed) {
          const status = [400, 413, 415, 422, 429, 503].includes(up.statusCode) ? up.statusCode : 502;
          finish(httpError(status, `voice engine rejected request (${up.statusCode})`)); return;
        }
        try {
          if (transform) jsonRes(res, 200, transform(Buffer.concat(chunks)));
          else if (size <= 44) { finish(httpError(502, 'voice engine returned empty audio')); return; }
          else res.end();
          finish();
        } catch { finish(httpError(502, 'voice engine returned invalid transcript')); }
      });
    });
    upstream.once('error', () => finish(httpError(502, 'voice engine unavailable')));
    upstream.end(body);
  });
}

export function voiceCapabilities(ctx) {
  return { stt: ctx.pyReady, tts: ctx.pyReady, restEnabled: ctx.pyReady,
    maxTextChars: LIMITS.text, ttsFormat: 'wav', stream: false,
    wakeEvents: Boolean(ctx.pyReady && ctx.pyHealth?.wake?.enabled && ctx.pyHealth?.wake?.ok) };
}

export function createRequestHandler(ctx, overrides = {}) {
  ctx.limits = { ...LIMITS, ...ctx.limits };
  ctx.inFlight ??= 0;
  const proxy = overrides.proxyRequest || proxyRequest;
  return async (req, res) => {
    let release;
    try {
      const pathname = new URL(req.url || '/', 'http://local').pathname;
      if (req.method === 'GET' && ['/health', '/api/health'].includes(pathname)) {
        return jsonRes(res, 200, { ok: true, fittingId: 'local-voice', enginesReady: ctx.pyReady,
          voice: voiceCapabilities(ctx), wake: ctx.pyHealth?.wake || { enabled: false, ok: false } });
      }
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Local Voice</title><style>body{font:18px system-ui;max-width:40rem;margin:3rem auto;padding:1rem}</style><h1>Local Voice</h1><p>${ctx.pyReady ? 'Speech engines ready.' : 'Speech engines warming up.'}</p><p>Local speech recognition and WAV playback. Microphone wake-word capture is optional.</p>`);
      }
      if (!['/stt', '/tts'].includes(pathname)) return jsonRes(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return jsonRes(res, 405, { error: 'POST required' });
      if (!originAllowed(req) || !requestAuthorized(req, ctx)) return jsonRes(res, 403, { error: 'forbidden' });
      if (!ctx.pyReady) return jsonRes(res, 503, { error: 'voice engines not ready' });
      if (ctx.inFlight >= ctx.limits.requests) return jsonRes(res, 429, { error: 'voice engine busy' });
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return jsonRes(res, 415, { error: 'encoded request body is not supported' });
      if (pathname === '/tts' ? type !== 'application/json' : !/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/.test(type)) {
        return jsonRes(res, 415, { error: pathname === '/tts' ? 'application/json required' : 'audio content type required' });
      }
      ctx.inFlight++;
      let released = false;
      release = () => { if (!released) { released = true; ctx.inFlight--; } };
      res.once('close', release);
      const body = await readBody(req, pathname === '/tts' ? ctx.limits.json : ctx.limits.audio, ctx.limits.bodyMs);
      if (res.destroyed || req.aborted) return;
      if (pathname === '/stt') {
        if (!body.length) throw httpError(400, 'empty audio');
        await proxy(req, res, ctx, { route: '/stt', body, contentType: type, maxBytes: ctx.limits.transcript,
          transform: bytes => {
            const value = JSON.parse(bytes.toString('utf8'));
            if (typeof value.text !== 'string') throw new Error('missing text');
            return { transcript: value.text, confidence: null, detected_language: typeof value.language === 'string' ? value.language : null, ...(Number.isFinite(value.eot_prob) ? { eot_prob: value.eot_prob } : {}),
              ...(typeof value.language === 'string' ? { language: value.language } : {}),
              ...(Number.isFinite(value.ms) ? { ms: value.ms } : {}) };
          } });
      } else {
        let value; try { value = JSON.parse(body.toString('utf8')); } catch { throw httpError(400, 'invalid JSON'); }
        if (typeof value?.text !== 'string' || !value.text.trim()) throw httpError(400, 'text is required');
        if ([...value.text.trim()].length > ctx.limits.text) throw httpError(413, `text exceeds ${ctx.limits.text} characters`);
        if (value.format !== undefined && value.format !== 'wav') throw httpError(400, 'only wav output is supported');
        if (value.lang !== undefined && (typeof value.lang !== 'string' || !/^[a-z]{2}$/i.test(value.lang))) throw httpError(400, 'invalid language');
        await proxy(req, res, ctx, { route: '/speak', body: Buffer.from(JSON.stringify({ text: value.text.trim(), lang: value.lang })),
          contentType: 'application/json', maxBytes: ctx.limits.speech });
      }
    } catch (error) { jsonRes(res, error.status || 500, { error: error.status ? error.message : 'voice request failed' }); }
    finally { release?.(); }
  };
}

export async function pyHealth(port) {
  return new Promise(resolve => {
    let finished = false, chunks = [], size = 0;
    const done = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health' }, res => {
      res.on('data', chunk => { size += chunk.length; if (size > 16_384) req.destroy(); else chunks.push(chunk); });
      res.on('error', () => done(null));
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks)); done(res.statusCode === 200 && value.ok === true ? value : null); } catch { done(null); } });
    });
    const timer = setTimeout(() => { req.destroy(); done(null); }, 2500);
    req.on('error', () => done(null));
  });
}

const PY_CONFIG_KEYS = ['PAUSE_COMMA', 'PAUSE_CLAUSE', 'PAUSE_SENTENCE', 'PAUSE_QUESTION', 'PAUSE_ELLIPSIS', 'PAUSE_PARA', 'MIN_CLAUSE',
  'WHISPER_LANG', 'STT_ENGINE', 'WHISPER_CPP_MODEL', 'WHISPER_CPP_NO_TIMESTAMPS', 'STT_NORMALIZE_GAIN', 'TTS_FORCE_LANG', 'PIPER_VOICES', 'WAKE_THRESHOLD', 'WHISPER_BEAM'];
export function pythonEnvironment(opts) {
  const env = { ...process.env, VOICE_PY_PORT: String(opts.pyPort), VOICE_PARENT_PID: String(process.pid),
    KOKORO_VOICE: opts.kokoroVoice, KOKORO_SPEED: opts.kokoroSpeed, WHISPER_MODEL: opts.whisperModel,
    WAKE_WORD: opts.wakeWord || 'off' };
  for (const key of PY_CONFIG_KEYS) if (cfg(key) !== undefined && cfg(key) !== '') env[key] = cfg(key);
  if (opts.langVoices) env.LANG_VOICES = opts.langVoices;
  return env;
}
function spawnPython(opts) {
  const child = spawn(resolvePython(opts), ['server.py'], { cwd: VOICE_SERVER_DIR, env: pythonEnvironment(opts), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', bytes => process.stdout.write(`[voice-py] ${bytes}`));
  child.stderr?.on('data', bytes => process.stderr.write(`[voice-py] ${bytes}`));
  return child;
}
async function reserveInternalPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } }
export async function clearStatusFile(file, owner) {
  try { const record = JSON.parse(await readFile(file, 'utf8')); if (record.pid === owner.pid && record.startupId === owner.startupId) await unlink(file); } catch {}
}
export async function stopChild(child, graceMs = 2500) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    let killTimer;
    const done = () => { clearTimeout(killTimer); resolve(); };
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); return; }
    killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { done(); } }, graceMs);
  });
}

export async function startServer(opts = parseArgs(process.argv.slice(2)), deps = {}) {
  if (!Number.isInteger(opts.port) || opts.port < (deps.allowEphemeral ? 0 : 1) || opts.port > 65535) throw new Error('a valid configured port is required');
  const statusFile = path.join(deps.home || process.env.GARRISON_HOME || path.join(os.homedir(), '.garrison'), 'ui-fittings/local-voice.json');
  try { const record = JSON.parse(await readFile(statusFile, 'utf8')); if (Number.isInteger(record.pid) && record.pid > 0 && alive(record.pid)) throw new Error('local-voice already has a live status owner'); }
  catch (error) { if (error.message === 'local-voice already has a live status owner') throw error; }
  const ctx = { ...opts, pyReady: false, pyHealth: null, inFlight: 0, limits: { ...LIMITS, ...deps.limits } };
  const server = http.createServer(createRequestHandler(ctx));
  // Bind before spawning a heavyweight model process or publishing status.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, resolve); });
  ctx.port = server.address().port;
  const address = opts.host === '0.0.0.0' ? 'localhost' : opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const owner = { fittingId: 'local-voice', pid: process.pid, startupId: randomUUID(), port: ctx.port,
    url: `http://${address}:${ctx.port}`, startedAt: new Date().toISOString() };
  let child, timer, warmupTimer, shuttingDown, polling = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: ctx.limits.wsPayload });
  const relays = new Set();
  const signals = [];
  const shutdown = () => shuttingDown ||= (async () => {
    ctx.pyReady = false; clearInterval(timer); clearTimeout(warmupTimer);
    for (const [signal, handler] of signals) process.off(signal, handler);
    for (const ws of relays) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), stopChild(child, deps.childGraceMs)]);
    await clearStatusFile(statusFile, owner);
  })();
  try {
    ctx.pyPort = deps.pyPort || await reserveInternalPort();
    child = (deps.spawnPython || spawnPython)(ctx);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.on('error', () => { void shutdown().finally(() => deps.onFatal?.(1)); });
    child.on('exit', () => { if (!shuttingDown) void shutdown().finally(() => deps.onFatal?.(1)); });
    await mkdir(path.dirname(statusFile), { recursive: true });
    const temp = `${statusFile}.${owner.startupId}.tmp`;
    try { await writeFile(temp, JSON.stringify(owner), { mode: 0o600 }); await rename(temp, statusFile); }
    finally { await unlink(temp).catch(() => {}); }
    if (shuttingDown) { await shuttingDown; await clearStatusFile(statusFile, owner); throw new Error('voice engine exited during startup'); }
    const poll = async () => {
      if (polling || ctx.inFlight || shuttingDown) return;
      polling = true;
      try { const health = await (deps.pyHealth || pyHealth)(ctx.pyPort); if (!shuttingDown) { ctx.pyHealth = health; ctx.pyReady = Boolean(health); if (health) clearTimeout(warmupTimer); } }
      finally { polling = false; }
    };
    warmupTimer = setTimeout(() => { void shutdown().finally(() => deps.onFatal?.(1)); }, deps.warmupMs || 600_000);
    timer = setInterval(() => { void poll(); }, deps.healthMs || 1500);
    void poll();
    server.on('upgrade', (req, socket, head) => {
      const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
      if (!originAllowed(req) || !requestAuthorized(req, ctx)) return reject('403 Forbidden');
      if (new URL(req.url || '/', 'http://local').pathname !== '/events') return reject('404 Not Found');
      if (!ctx.pyReady || wss.clients.size >= ctx.limits.wsClients) return reject('503 Service Unavailable');
      wss.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(`ws://127.0.0.1:${ctx.pyPort}/events`, { handshakeTimeout: 5000, maxPayload: ctx.limits.wsPayload });
        relays.add(upstream);
        const close = () => { upstream.terminate(); client.terminate(); relays.delete(upstream); };
        upstream.on('message', (data, isBinary) => {
          if (client.bufferedAmount > 64 * 1024) return close();
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
        // The upstream is an event feed; client pings have no application
        // payload. Never accumulate a queue while its handshake is pending.
        upstream.on('close', close); upstream.on('error', close);
        client.on('close', close); client.on('error', close);
      });
    });
    if (deps.signals !== false) for (const signal of ['SIGTERM', 'SIGINT']) {
      const handler = () => { void shutdown().then(() => deps.onShutdown?.(0)); };
      signals.push([signal, handler]); process.on(signal, handler);
    }
    return { server, options: ctx, shutdown, child };
  } catch (error) { await shutdown(); throw error; }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  startServer(undefined, { onFatal: code => process.exit(code), onShutdown: code => process.exit(code) }).catch(error => {
    console.error(`[local-voice] start failed: ${error.message}`); process.exit(1);
  });
}
