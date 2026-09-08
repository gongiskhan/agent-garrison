import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
// @ts-expect-error fitting JavaScript is an independently installed runtime
import { createRequestHandler, originAllowed, parseArgs, LIMITS, startServer, clearStatusFile, pythonEnvironment } from '../fittings/seed/local-voice/scripts/server.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, port: (server.address() as { port: number }).port };
}
async function pair(handler: http.RequestListener, limits = {}) {
  const upstream = await listen(handler);
  const ctx = { pyReady: true, pyPort: upstream.port, inFlight: 0, limits };
  const wrapper = await listen(createRequestHandler(ctx));
  return { ...wrapper, ctx, upstream, url: `http://127.0.0.1:${wrapper.port}` };
}
const post = (url: string, route: string, body: string | Buffer, headers = {}) => fetch(url + route, { method: 'POST', body: body as BodyInit,
  headers: { 'Content-Type': route === '/tts' ? 'application/json' : 'audio/wav', ...headers } });
async function eventually(fn: () => boolean) { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); expect(fn()).toBe(true); }

describe('Local Voice request boundary', () => {
  it('keeps a normal POST alive after body end and returns bounded transcript metadata', async () => {
    const { url, ctx } = await pair((req, res) => { req.resume(); req.on('end', () => setTimeout(() => res.end(JSON.stringify({ text: 'Hello', eot_prob: .9, language: 'en', ms: 12 })), 30)); });
    const result = await post(url, '/stt', Buffer.alloc(1024));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ transcript: 'Hello', confidence: null, detected_language: 'en', eot_prob: .9, language: 'en', ms: 12 });
    expect(ctx.inFlight).toBe(0);
  });
  it('closes Python request when the client disappears after upload', async () => {
    let started = false, closed = false;
    const { port, ctx } = await pair((req, res) => { req.resume(); req.on('end', () => { started = true; }); res.on('close', () => { closed = true; }); });
    const client = http.request({ hostname: '127.0.0.1', port, path: '/stt', method: 'POST', headers: { 'Content-Type': 'audio/wav' } });
    client.on('error', () => {}); client.end(Buffer.alloc(1024));
    await eventually(() => started); client.destroy(); await eventually(() => closed && ctx.inFlight === 0);
  });
  it('releases an aborted partial upload without spawning engine work', async () => {
    let called = false;
    const { port, ctx } = await pair((_req, res) => { called = true; res.end(); });
    const client = http.request({ hostname: '127.0.0.1', port, path: '/stt', method: 'POST', headers: { 'Content-Type': 'audio/wav', 'Content-Length': '2048' } });
    client.on('error', () => {}); client.write(Buffer.alloc(1024));
    await eventually(() => ctx.inFlight === 1); client.destroy();
    await eventually(() => ctx.inFlight === 0); expect(called).toBe(false);
  });
  it('catches asynchronous route failure instead of escaping the HTTP dispatcher', async () => {
    const ctx = { pyReady: true, inFlight: 0 };
    const { port } = await listen(createRequestHandler(ctx, { proxyRequest: async () => { await Promise.resolve(); throw new Error('fixture'); } }));
    const response = await post(`http://127.0.0.1:${port}`, '/stt', Buffer.alloc(1024));
    expect(response.status).toBe(500); expect(ctx.inFlight).toBe(0);
  });
  it.each(['/stt', '/tts'])('enforces wall-clock timeout and releases %s capacity', async route => {
    const { url, ctx } = await pair(req => req.resume(), { requestMs: 40 });
    const response = await post(url, route, route === '/tts' ? JSON.stringify({ text: 'Hello' }) : Buffer.alloc(1024));
    expect(response.status).toBe(504); expect(ctx.inFlight).toBe(0);
  });
  it('bounds slow request bodies', async () => {
    const { port, ctx } = await pair(req => req.resume(), { bodyMs: 40 });
    const result = await new Promise<number>(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/stt', method: 'POST', headers: { 'Content-Type': 'audio/wav', 'Content-Length': '2048' } }, res => { res.resume(); resolve(res.statusCode!); req.destroy(); });
      req.on('error', () => {}); req.write(Buffer.alloc(10));
    });
    expect(result).toBe(408); expect(ctx.inFlight).toBe(0);
  });
  it.each(['broken', '{}', '{"text":42}'])('rejects malformed engine transcript %s', async output => {
    const { url } = await pair((_req, res) => res.end(output));
    expect((await post(url, '/stt', Buffer.alloc(1024))).status).toBe(502);
  });
  it('bounds transcript and error response buffers', async () => {
    for (const status of [200, 500]) {
      const { url } = await pair((_req, res) => { res.statusCode = status; res.end('x'.repeat(20_000)); }, { transcript: 100 });
      expect((await post(url, '/stt', Buffer.alloc(1024))).status).toBe(502);
    }
  });
  it('handles a truncated engine response without hanging', async () => {
    const { url } = await pair((_req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 20); });
    expect((await post(url, '/stt', Buffer.alloc(1024))).status).toBe(502);
  });
  it('rejects large input, unsupported media and unbounded text before engine work', async () => {
    let calls = 0;
    const { url } = await pair((_req, res) => { calls++; res.end(); }, { audio: 1024 });
    expect((await post(url, '/stt', Buffer.alloc(1025))).status).toBe(413);
    expect((await post(url, '/stt', 'abc', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(url, '/tts', JSON.stringify({ text: 'a'.repeat(901) }))).status).toBe(413);
    expect((await post(url, '/tts', '{}')).status).toBe(400);
    expect((await post(url, '/tts', JSON.stringify({ text: 'Hello', format: 'mp3' }))).status).toBe(400);
    expect(calls).toBe(0);
  });
  it('preserves all accepted speech text and language using a JSON POST', async () => {
    let received: unknown;
    const audio = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100, 1)]);
    const { url } = await pair((req, res) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      received = { method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Voice': 'kokoro:bm_george' }); res.end(audio);
    }); });
    const text = 'a'.repeat(900), response = await post(url, '/tts', JSON.stringify({ text, lang: 'en' }));
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(audio);
    expect(received).toEqual({ method: 'POST', path: '/speak', body: { text, lang: 'en' } });
  });
  it('limits simultaneous voice requests', async () => {
    const { url, ctx } = await pair(req => req.resume(), { requestMs: 100 });
    const first = post(url, '/stt', Buffer.alloc(1024)); const second = post(url, '/stt', Buffer.alloc(1024));
    await eventually(() => ctx.inFlight === 2);
    expect((await post(url, '/stt', Buffer.alloc(1024))).status).toBe(429);
    await Promise.all([first, second]);
  });
  it('checks browser HTTP origin even when tailnet proxy arrives over loopback', async () => {
    const { url } = await pair((_req, res) => res.end('{"text":"ok"}'));
    expect((await post(url, '/stt', Buffer.alloc(1024), { Origin: 'https://other.tail31efa.ts.net' })).status).toBe(403);
    expect((await post(url, '/stt', Buffer.alloc(1024), { Origin: url })).status).toBe(200);
  });
  it('only accepts exact Host origins; no-Origin native callers remain supported', () => {
    const host = 'node.tail31efa.ts.net:8500';
    for (const origin of ['https://other.tail31efa.ts.net:8500', 'http://localhost:8500', 'null', 'https://node.tail31efa.ts.net:8501']) expect(originAllowed({ headers: { host, origin } })).toBe(false);
    expect(originAllowed({ headers: { host, origin: `https://${host}` } })).toBe(true);
    expect(originAllowed({ headers: { host } })).toBe(true);
    expect(originAllowed({ headers: { host: 'public.example', origin: 'http://public.example' } })).toBe(false);
    expect(originAllowed({ headers: { host, 'sec-fetch-site': 'cross-site' } })).toBe(false);
  });
  it('advertises only ready and actually enabled voice capabilities', async () => {
    const ctx = { pyReady: false, pyHealth: { wake: { enabled: true, ok: true } } };
    const { port } = await listen(createRequestHandler(ctx));
    const health = () => fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
    expect((await health()).voice).toEqual({ stt: false, tts: false, restEnabled: false, maxTextChars: 900, ttsFormat: 'wav', stream: false, wakeEvents: false });
    ctx.pyReady = true; expect((await health()).voice.wakeEvents).toBe(true);
    ctx.pyHealth.wake.ok = false; expect((await health()).voice.wakeEvents).toBe(false);
  });
});

async function fixtureNode(options: { ignoreTerm?: boolean; pyPort?: number; health?: unknown } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'local-voice-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const runtime = await startServer({ ...parseArgs(), port: 0, host: '127.0.0.1' }, {
    home, allowEphemeral: true, signals: false, childGraceMs: 40, pyPort: options.pyPort,
    pyHealth: async () => options.health || { ok: true, wake: { enabled: false, ok: false } },
    spawnPython: () => spawn(process.execPath, ['-e', `${options.ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}console.log('ready');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  cleanup.push(runtime.shutdown);
  await once(runtime.child.stdout, 'data');
  await eventually(() => runtime.options.pyReady);
  return { ...runtime, home, status: path.join(home, 'ui-fittings/local-voice.json') };
}

describe('Local Voice child and status lifecycle', () => {
  it('requires a projected or explicit canonical public port', async () => {
    await expect(startServer({ port: NaN })).rejects.toThrow('configured port');
    expect(pythonEnvironment({ pyPort: 123, wakeWord: 'off' }).VOICE_PARENT_PID).toBe(String(process.pid));
  });
  it('preserves replacement status during shutdown', async () => {
    const runtime = await fixtureNode();
    const original = JSON.parse(await readFile(runtime.status, 'utf8'));
    const replacement = { ...original, startupId: 'replacement' };
    await writeFile(runtime.status, JSON.stringify(replacement));
    await runtime.shutdown(); expect(JSON.parse(await readFile(runtime.status, 'utf8'))).toEqual(replacement);
    await clearStatusFile(runtime.status, replacement); await expect(readFile(runtime.status)).rejects.toThrow();
  });
  it('waits for SIGKILL of a child that ignores TERM before removing owned status', async () => {
    const runtime = await fixtureNode({ ignoreTerm: true });
    await runtime.shutdown();
    expect(runtime.child.signalCode).toBe('SIGKILL'); await expect(readFile(runtime.status)).rejects.toThrow();
  });
  it('refuses an existing live owner without spawning or altering the record', async () => {
    const runtime = await fixtureNode(); let spawned = false;
    const before = await readFile(runtime.status, 'utf8');
    await expect(startServer({ port: runtime.options.port, host: '127.0.0.1' }, { home: runtime.home, spawnPython: () => { spawned = true; } })).rejects.toThrow('live status owner');
    expect(spawned).toBe(false); expect(await readFile(runtime.status, 'utf8')).toBe(before);
  });
  it('does not spawn a model when binding the configured port fails', async () => {
    const occupied = await listen((_req, res) => res.end()); let spawned = false;
    const home = await mkdtemp(path.join(os.tmpdir(), 'local-voice-bind-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
    await expect(startServer({ port: occupied.port, host: '127.0.0.1' }, { home, spawnPython: () => { spawned = true; } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(spawned).toBe(false); await expect(readFile(path.join(home, 'ui-fittings/local-voice.json'))).rejects.toThrow();
  });
  it('fails cleanly on missing Python without publishing status or retaining the listener', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'local-voice-spawn-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
    await expect(startServer({ port: 0, host: '127.0.0.1' }, { home, allowEphemeral: true,
      spawnPython: () => spawn('/definitely-missing-local-voice-python') })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(home, 'ui-fittings/local-voice.json'))).rejects.toThrow();
  });
  it('cleans the public server and status when the engine dies', async () => {
    const runtime = await fixtureNode(); runtime.child.kill('SIGKILL');
    await eventually(() => !runtime.server.listening);
    await runtime.shutdown(); await expect(readFile(runtime.status)).rejects.toThrow();
  });
  it('terminates a child that never finishes warming up', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'local-voice-warmup-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const runtime = await startServer({ ...parseArgs(), port: 0, host: '127.0.0.1' }, {
      home, allowEphemeral: true, signals: false, warmupMs: 40, healthMs: 10, pyHealth: async () => null,
      spawnPython: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']),
    });
    cleanup.push(runtime.shutdown);
    await eventually(() => !runtime.server.listening);
    await runtime.shutdown(); expect(runtime.child.signalCode).toBe('SIGTERM');
    await expect(readFile(path.join(home, 'ui-fittings/local-voice.json'))).rejects.toThrow();
  });
  it('rejects cross-host websocket upgrades', async () => {
    const runtime = await fixtureNode();
    const code = await new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${runtime.options.port}/events`, { origin: 'https://other.tail31efa.ts.net' });
      ws.on('error', () => {}); ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
    });
    expect(code).toBe(403);
  });
  it('bounds client frames and tears down a stalled upstream handshake', async () => {
    const upstream = await listen((_req, res) => res.end()); let upstreamClosed = false;
    upstream.server.on('upgrade', (_req, socket) => { socket.resume(); socket.on('end', () => { upstreamClosed = true; socket.destroy(); }); socket.on('error', () => {}); cleanup.push(async () => { socket.destroy(); }); });
    const runtime = await fixtureNode({ pyPort: upstream.port });
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.options.port}/events`); ws.on('error', () => {});
    await once(ws, 'open'); await new Promise(r => setTimeout(r, 20));
    const closed = once(ws, 'close'); ws.send(Buffer.alloc(LIMITS.wsPayload + 1));
    await closed; await eventually(() => upstreamClosed);
  });
});
