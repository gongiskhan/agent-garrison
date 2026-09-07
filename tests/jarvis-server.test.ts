import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
// @ts-ignore standalone fitting modules
import { createRequestHandler, startServer, writeStatusFile, clearStatusFile, parseArgs, findLocalWorkingWorkspace } from "../fittings/seed/jarvis-os/scripts/server.mjs";
// @ts-ignore standalone fitting modules
import { proxyResponse, fetchJson } from "../fittings/seed/jarvis-os/scripts/http-transport.mjs";

let root: string;
let distDir: string;
const servers: Server[] = [];
const webSockets: WebSocket[] = [];
const webSocketServers: WebSocketServer[] = [];
const silentVoice = { capabilities: async () => ({ available: false, fittingId: null }), websocket: async () => null };
function deps(extra: Record<string, unknown> = {}) {
  return { distDir, voice: silentVoice, readSettings: async () => ({ exists: false }), writeSettings: () => {}, configRoots: [], ...extra };
}
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}
async function jarvis(extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return serve(createRequestHandler({ host: "127.0.0.1", port: 0, gatewayUrl: "", ...options }, deps(extra)));
}
function request(port: number, route: string, body?: string | Buffer, headers: IncomingHttpHeaders = {}, method = body === undefined ? "GET" : "POST") {
  return new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, agent: false,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      res.once("error", reject);
    });
    req.once("error", reject); req.end(body);
  });
}
const post = (port: number, route: string, body: object = {}, headers: IncomingHttpHeaders = {}) => request(port, route, JSON.stringify(body), headers);
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "garrison-jarvis-http-"));
  distDir = path.join(root, "dist"); await mkdir(distDir);
  await writeFile(path.join(distDir, "index.html"), "Jarvis fixture");
  await writeFile(path.join(root, "outside.txt"), "outside sentinel");
  await symlink(path.join(root, "outside.txt"), path.join(distDir, "escape.txt"));
});
afterEach(async () => {
  for (const ws of webSockets.splice(0)) ws.terminate();
  for (const ws of webSocketServers.splice(0)) { for (const client of ws.clients) client.terminate(); ws.close(); }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.unstubAllEnvs();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("Jarvis request boundary", () => {
  it.each(["https://evil.example", "https://other.tail31efa.ts.net", "null", "http://localhost:9999"])("rejects foreign Origin %s before state mutation", async origin => {
    const write = vi.fn(); const app = await jarvis({ writeSettings: write });
    expect((await post(app.port, "/api/hud-settings", { color: "#123456" }, { origin })).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });
  it("accepts exact published host and no-Origin server requests", async () => {
    const app = await jarvis();
    expect((await post(app.port, "/api/hud-settings", { color: "#123456" }, { host: "mini.tail31efa.ts.net:8482", origin: "https://mini.tail31efa.ts.net:8482" })).status).toBe(200);
    expect((await post(app.port, "/api/hud-settings", { color: "#abcdef" })).status).toBe(200);
  });
  it("rejects cross-site hints, wrong media types, compressed and malformed bodies", async () => {
    const app = await jarvis();
    expect((await post(app.port, "/api/hud-settings", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await request(app.port, "/api/hud-settings", "{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(app.port, "/api/hud-settings", {}, { "content-encoding": "gzip" })).status).toBe(415);
    for (const body of ["{", "[]", "null", ""]) expect((await request(app.port, "/api/hud-settings", body)).status).toBe(400);
  });
  it("rejects declared and chunked oversized JSON before writes", async () => {
    const write = vi.fn(); const app = await jarvis({ writeSettings: write });
    const large = JSON.stringify({ color: "x".repeat(256 * 1024) });
    expect((await request(app.port, "/api/hud-settings", large, { "content-length": String(Buffer.byteLength(large)) })).status).toBe(413);
    expect((await request(app.port, "/api/hud-settings", large, { "transfer-encoding": "chunked" })).status).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });
  it("settles a slow body without mutation", async () => {
    const write = vi.fn(); const app = await jarvis({ writeSettings: write, bodyTimeoutMs: 30 });
    const result = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: app.port, path: "/api/hud-settings", method: "POST", headers: { "content-type": "application/json", "content-length": "100" } }, res => { res.resume(); resolve(res.statusCode!); req.destroy(); });
      req.once("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
      req.write("{");
    });
    expect(result).toBe(408); expect(write).not.toHaveBeenCalled();
  });
  it("handles abort and async failures without unhandled rejection or mutation", async () => {
    const write = vi.fn(); const app = await jarvis({ writeSettings: write });
    const req = http.request({ host: "127.0.0.1", port: app.port, path: "/api/hud-settings", method: "POST", headers: { "content-type": "application/json", "content-length": "100" } });
    req.on("error", () => {}); req.write("{"); await new Promise(resolve => setTimeout(resolve, 10)); req.destroy();
    expect((await request(app.port, "/health")).status).toBe(200); expect(write).not.toHaveBeenCalled();
    const bad = await jarvis({ voice: { capabilities: async () => { throw new Error("private failure"); } } });
    expect(await request(bad.port, "/api/voice")).toMatchObject({ status: 500, text: '{"error":"request failed"}' });
  });
  it("preserves saved fields when the first call after boot is a partial POST", async () => {
    const read = vi.fn(async () => ({ exists: true, state: { color: "#112233", orbMode: true, orbCorner: "top-left", stateColors: { thinking: "#abcdef" } } }));
    const app = await jarvis({ readSettings: read });
    const result = JSON.parse((await post(app.port, "/api/hud-settings", { color: "#998877" })).text);
    expect(result).toMatchObject({ color: "#998877", orbMode: true, orbCorner: "top-left", stateColors: { thinking: "#abcdef", listening: "#10ddf9" } });
    await request(app.port, "/api/hud-settings"); expect(read).toHaveBeenCalledTimes(1);
  });
  it("confines static assets including symlinks and handles invalid paths", async () => {
    const app = await jarvis();
    for (const route of ["/escape.txt", "/%2e%2e/outside.txt", "/../outside.txt"]) expect((await request(app.port, route)).status).toBe(404);
    expect((await request(app.port, "/%xx")).status).toBe(400);
    expect((await request(app.port, "/nested/view")).text).toBe("Jarvis fixture");
    expect((await request(app.port, "/", undefined, {}, "HEAD")).text).toBe("");
    expect((await post(app.port, "/", {})).status).toBe(405);
  });
  it("uses projected gateway and explicit instance profile", async () => {
    vi.stubEnv("GARRISON_GATEWAY_URL", ""); vi.stubEnv("GARRISON_JARVISOS_GATEWAY_URL", ""); vi.stubEnv("GARRISON_GATEWAY_PORT", "");
    vi.stubEnv("GARRISON_JARVISOS_PORT", ""); vi.stubEnv("GARRISON_INSTANCE_ID", "codex");
    expect(parseArgs()).toMatchObject({ port: 8082, gatewayUrl: "" });
    const app = await jarvis(); expect((await post(app.port, "/api/chat", { message: "fixture" })).status).toBe(503);
    expect(JSON.parse((await request(app.port, "/api/ui-config")).text).instanceProfile).toBe("codex");
  });
  it("bounds simultaneous responses and releases capacity after completion", async () => {
    const first = deferred(); const entered = deferred();
    const app = await jarvis({ maxRequests: 1, voice: { capabilities: async () => { entered.resolve(); await first.promise; return { available: false }; } } });
    const pending = request(app.port, "/api/voice"); await entered.promise;
    expect((await request(app.port, "/api/voice")).status).toBe(429);
    first.resolve(); expect((await pending).status).toBe(200);
    expect((await request(app.port, "/health")).status).toBe(200);
  });
  it("never probes a remote session path and canonicalizes local active repositories", async () => {
    const local = path.join(root, "local-workspace"); const alias = path.join(root, "local-workspace-link");
    await mkdir(local); await symlink(local, alias);
    const pathExists = vi.fn(() => true); const repoRoot = vi.fn(async (cwd: string) => cwd);
    const mesh = { self: { node: "this-node" }, rows: [
      { node: "remote-node", status: "working", cwd: "/remote/client/project", lastActivityAt: "2026-09-07T12:00:00Z" },
      { node: "this-node", status: "idle", cwd: "/idle/project" },
      { node: "this-node", status: "working", cwd: alias, lastActivityAt: "2026-09-07T11:00:00Z" }
    ] };
    expect(await findLocalWorkingWorkspace(mesh, null, { pathExists, repoRoot })).toBe(local);
    expect(pathExists.mock.calls).toEqual([[alias]]); expect(repoRoot.mock.calls).toEqual([[alias]]);
    pathExists.mockClear(); repoRoot.mockClear();
    expect(await findLocalWorkingWorkspace({ ...mesh, rows: [mesh.rows[0]] }, null, { pathExists, repoRoot })).toBe(null);
    expect(pathExists).not.toHaveBeenCalled(); expect(repoRoot).not.toHaveBeenCalled();
    expect(await findLocalWorkingWorkspace(mesh, local, { pathExists, repoRoot })).toBe(null);
  });
  it("preserves canonical mesh session identity and status", async () => {
    const envelope = { self: { node: "fixture-node", accentColor: "#123456" }, nodes: [{ node: "fixture-peer", status: "active" }],
      rows: [{ id: "same-native-id", node: "fixture-peer", runtime: "cursor", title: "fixture", status: "working", kind: "shell" }] };
    let requested = "";
    const appServer = await serve((req, res) => { requested = req.url!; res.end(JSON.stringify(envelope)); });
    const app = await jarvis({}, { appUrl: appServer.base });
    expect(JSON.parse((await request(app.port, "/api/sessions")).text)).toEqual(envelope);
    expect(requested).toBe("/api/sessions");
  });
  it("reports current runtime configuration without retired data", async () => {
    const config = path.join(root, "config"); await mkdir(path.join(config, "skills", "fixture-skill"), { recursive: true });
    await mkdir(path.join(config, "commands"), { recursive: true }); await writeFile(path.join(config, "commands", "fixture-command.md"), "fixture");
    const app = await jarvis({ configRoots: [config] });
    const data = JSON.parse((await request(app.port, "/api/runtime")).text);
    expect(data.skills).toEqual(["fixture-skill"]); expect(data.commands).toEqual(["fixture-command"]);
    expect(data).not.toHaveProperty("souls"); expect((await request(app.port, "/api/operative")).status).toBe(404);
  });
});

async function voiceFixture(voice: object = {}, handle?: http.RequestListener, id = "capture-service", extra: Record<string, unknown> = {}) {
  const observed: { path: string; auth?: string; text: string; contentType?: string }[] = [];
  const upstream = await serve((req, res) => {
    if (req.url === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, voice: { stt: true, tts: true, restEnabled: true, maxTextChars: 600, ...voice } })); return; }
    let text = ""; req.on("data", c => { text += c; }); req.on("end", () => {
      observed.push({ path: req.url!, auth: req.headers.authorization, text, contentType: req.headers["content-type"] });
      if (handle) handle(req, res); else { res.setHeader("content-type", req.url?.startsWith("/stt") ? "application/json" : "audio/mpeg"); res.end(req.url?.startsWith("/stt") ? '{"transcript":"fixture"}' : "audio fixture"); }
    });
  });
  const statusRoot = await mkdtemp(path.join(root, "status-"));
  await writeFile(path.join(statusRoot, `${id}.json`), JSON.stringify({ url: upstream.base }));
  const app = await jarvis({ voice: undefined, statusRoot, voiceFittingId: () => id, voiceToken: () => "fixture-token", ...extra });
  return { ...app, upstream, observed, statusRoot };
}

describe("Jarvis selected voice contract", () => {
  it("advertises capture REST without leaking token or loopback URL", async () => {
    const app = await voiceFixture();
    const result = await request(app.port, "/api/voice");
    expect(JSON.parse(result.text)).toEqual({ available: true, fittingId: "capture-service", stt: true, tts: true, maxTextChars: 600, ttsFormat: "mp3", wakeEvents: false, stream: false });
    expect(result.text).not.toContain("fixture-token"); expect(result.text).not.toContain("127.0.0.1");
  });
  it("uses only the selected provider and refuses missing capture scope", async () => {
    const app = await voiceFixture({}, undefined, "capture-service", { voiceToken: () => "" });
    expect(JSON.parse((await request(app.port, "/api/voice")).text)).toMatchObject({ available: false, reason: "capture token not granted" });
    expect((await post(app.port, "/api/voice/tts", { text: "fixture" })).status).toBe(503); expect(app.observed).toEqual([]);
    const other = await jarvis({ voice: undefined, statusRoot: app.statusRoot, voiceFittingId: () => "unselected", voiceToken: () => "fixture-token" });
    expect(JSON.parse((await request(other.port, "/api/voice")).text).available).toBe(false);
  });
  it("forwards raw STT with bearer and only language query", async () => {
    const app = await voiceFixture();
    expect((await request(app.port, "/api/voice/stt?language=pt&token=do-not-forward", "RIFF fixture", { "content-type": "audio/wav" })).status).toBe(200);
    expect(app.observed).toEqual([{ path: "/stt?language=pt", auth: "Bearer fixture-token", text: "RIFF fixture", contentType: "audio/wav" }]);
  });
  it("preserves delayed MP3 response after the POST body finishes", async () => {
    const app = await voiceFixture({}, (_req, res) => { setTimeout(() => { res.setHeader("content-type", "audio/mpeg"); res.end("delayed audio"); }, 30); });
    const result = await post(app.port, "/api/voice/tts", { text: "Olá", format: "mp3" });
    expect(result).toMatchObject({ status: 200, text: "delayed audio" });
    expect(app.observed[0]).toMatchObject({ auth: "Bearer fixture-token", text: '{"text":"Olá","format":"mp3"}' });
  });
  it("honors Local Voice WAV, limit and optional wake capability without a token", async () => {
    const app = await voiceFixture({ maxTextChars: 900, ttsFormat: "wav", wakeEvents: true, stream: false }, undefined, "local-voice", { voiceToken: () => "" });
    expect(JSON.parse((await request(app.port, "/api/voice")).text)).toMatchObject({ available: true, ttsFormat: "wav", maxTextChars: 900, wakeEvents: true, stream: false });
    expect((await post(app.port, "/api/voice/tts", { text: "a".repeat(900) })).status).toBe(200);
    expect(JSON.parse(app.observed[0].text).format).toBe("wav"); expect(app.observed[0].auth).toBeUndefined();
    expect((await post(app.port, "/api/voice/tts", { text: "a".repeat(901) })).status).toBe(413);
    expect((await post(app.port, "/api/voice/tts", { text: "fixture", format: "mp3" })).status).toBe(400);
    expect(app.observed).toHaveLength(1);
  });
  it("retains GET TTS compatibility with provider format and cross-site refusal", async () => {
    const app = await voiceFixture();
    expect((await request(app.port, "/api/voice/tts?text=fixture")).status).toBe(200);
    expect(JSON.parse(app.observed[0].text)).toEqual({ text: "fixture", format: "mp3" });
    expect((await request(app.port, "/api/voice/tts?text=fixture", undefined, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("rejects oversized audio before upstream work", async () => {
    const app = await voiceFixture();
    const result = await request(app.port, "/api/voice/stt", "small", { "content-type": "audio/wav", "content-length": String(8 * 1024 * 1024 + 1) });
    expect(result.status).toBe(413); expect(app.observed).toEqual([]);
  });
  it("bounds upstream deadline and declared response size", async () => {
    const app = await voiceFixture({}, () => {}, "capture-service", { voiceTimeoutMs: 60 });
    expect((await post(app.port, "/api/voice/tts", { text: "fixture" })).status).toBe(504);
    const large = await voiceFixture({}, (_req, res) => { res.writeHead(200, { "content-length": "1000" }); res.end("x".repeat(1000)); }, "capture-service", { voiceMaxResponseBytes: 100 });
    expect((await post(large.port, "/api/voice/tts", { text: "fixture" })).status).toBe(502);
  });
  it("does not send credentials to a foreign status URL", async () => {
    const app = await voiceFixture();
    await writeFile(path.join(app.statusRoot, "capture-service.json"), JSON.stringify({ url: "https://foreign.example" }));
    expect(JSON.parse((await request(app.port, "/api/voice")).text).available).toBe(false);
    expect(app.observed).toEqual([]);
  });
});

describe("Jarvis stream lifetime and discovery ownership", () => {
  it("keeps a delayed chat SSE alive and uses its own channel", async () => {
    let payload = "";
    const upstream = await serve((req, res) => { req.on("data", c => { payload += c; }); req.on("end", () => { setTimeout(() => { res.setHeader("content-type", "text/event-stream"); res.end('event: done\ndata: {"ok":true}\n\n'); }, 30); }); });
    const app = await jarvis({}, { gatewayUrl: upstream.base });
    const result = await post(app.port, "/api/chat", { message: "fixture" });
    expect(result.status).toBe(200); expect(result.text).toContain("event: done"); expect(JSON.parse(payload)).toEqual({ message: "fixture", channel: "jarvis" });
  });
  it("cancels the upstream only when the downstream response is abandoned", async () => {
    const started = deferred(); const closed = deferred();
    const upstream = await serve((_req, res) => { res.setHeader("content-type", "text/event-stream"); res.write("event: ready\ndata: {}\n\n"); res.on("close", () => closed.resolve()); started.resolve(); });
    const app = await jarvis({}, { gatewayUrl: upstream.base });
    const req = http.get(`${app.base}/api/stream`, res => { res.once("data", () => req.destroy()); }); req.on("error", () => {});
    await started.promise; await closed.promise;
  });
  it("enforces an absolute deadline even when JSON upstream trickles data", async () => {
    const upstream = await serve((_req, res) => { const timer = setInterval(() => res.write(" "), 5); res.on("close", () => clearInterval(timer)); });
    expect(await fetchJson(upstream.base, "/health", 40)).toBe(null);
  });
  it("rejects asynchronous proxy failures through the normal response path", async () => {
    const app = await serve((req, res) => { void proxyResponse(res, new URL("http://127.0.0.1:1"), { timeoutMs: 100 }).catch((err: { status: number }) => { res.statusCode = err.status; res.end("bounded failure"); }); });
    expect((await request(app.port, "/")).status).toBe(502);
  });
  it("publishes atomic records and preserves replacement ownership", async () => {
    const file = path.join(root, "atomic", "jarvis.json"); const options = { port: 12345, host: "127.0.0.1" };
    await writeStatusFile(options, { statusFile: file, pid: 101 });
    let stop = false; const seen: number[] = [];
    const reader = (async () => { while (!stop) seen.push(JSON.parse(await readFile(file, "utf8")).pid); })();
    try { for (let pid = 102; pid < 112; pid++) await writeStatusFile(options, { statusFile: file, pid }); } finally { stop = true; await reader; }
    expect(seen.length).toBeGreaterThan(0); await clearStatusFile({ statusFile: file, pid: 101 });
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(111);
    expect((await readdir(path.dirname(file))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    await clearStatusFile({ statusFile: file, pid: 111 }); await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves incumbent discovery and signal handlers when bind fails", async () => {
    const occupied = await serve((_req, res) => res.end()); const file = path.join(root, "incumbent.json"); await writeFile(file, '{"pid":100}');
    const counts = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    await expect(startServer({ port: occupied.port, host: "127.0.0.1", gatewayUrl: "" }, deps({ statusFile: file }))).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await readFile(file, "utf8")).toBe('{"pid":100}'); expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(counts);
  });
  it("advertises the actual bound port and refuses cross-node websocket Origin", async () => {
    const file = path.join(root, "live.json");
    const { server, options } = await startServer({ port: 0, host: "127.0.0.1", gatewayUrl: "" }, deps({ statusFile: file })); servers.push(server);
    expect(JSON.parse(await readFile(file, "utf8")).port).toBe(options.port);
    expect(JSON.parse((await request(options.port, "/health")).text).port).toBe(options.port);
    const status = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${options.port}/api/voice/events`, { origin: "https://other.tail31efa.ts.net" }); webSockets.push(client);
      client.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode!); client.terminate(); }); client.once("error", () => {}); client.once("open", () => reject(new Error("foreign websocket accepted")));
    });
    expect(status).toBe(403);
  });
  it("gates absent websocket capabilities and relays only advertised wake events", async () => {
    const fixture = await voiceFixture({ ttsFormat: "wav", maxTextChars: 900, wakeEvents: true, stream: false }, undefined, "local-voice");
    const upstreamWs = new WebSocketServer({ server: fixture.upstream.server, path: "/events" }); webSocketServers.push(upstreamWs);
    upstreamWs.on("connection", client => { client.send(JSON.stringify({ type: "hello", wake: { enabled: true } })); client.on("message", data => client.send(data)); });
    const file = path.join(fixture.statusRoot, "jarvis.json");
    const { server, options } = await startServer({ port: 0, host: "127.0.0.1", gatewayUrl: "" }, deps({ voice: undefined, statusRoot: fixture.statusRoot, statusFile: file,
      voiceFittingId: () => "local-voice", voiceToken: () => "" })); servers.push(server);
    const client = new WebSocket(`ws://127.0.0.1:${options.port}/api/voice/events`, { origin: `http://127.0.0.1:${options.port}` }); webSockets.push(client);
    const hello = await once(client, "message"); expect(JSON.parse(hello[0].toString())).toMatchObject({ type: "hello" });
    const echoed = once(client, "message"); client.send("fixture"); expect((await echoed)[0].toString()).toBe("fixture");
    const status = await new Promise<number>(resolve => {
      const unsupported = new WebSocket(`ws://127.0.0.1:${options.port}/api/voice/stream`); webSockets.push(unsupported);
      unsupported.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode!); unsupported.terminate(); }); unsupported.once("error", () => {});
    }); expect(status).toBe(503);
    const closed = once(client, "close"); client.send(Buffer.alloc(256 * 1024 + 1)); await closed;
  });
  it("cleans its own status after close but preserves a newer record", async () => {
    const file = path.join(root, "closed.json");
    const { server } = await startServer({ port: 0, host: "127.0.0.1", gatewayUrl: "" }, deps({ statusFile: file }));
    await writeStatusFile({ port: 22222, host: "127.0.0.1" }, { statusFile: file, pid: 999999 });
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(999999);
    const secondFile = path.join(root, "closed-owned.json");
    const second = await startServer({ port: 0, host: "127.0.0.1", gatewayUrl: "" }, deps({ statusFile: secondFile }));
    await new Promise<void>(resolve => second.server.close(() => resolve()));
    await vi.waitFor(async () => { await expect(readFile(secondFile)).rejects.toMatchObject({ code: "ENOENT" }); });
  });
  it.each([["--probe", "--port", "8082"], ["--unknown"], ["unexpected"], ["--port"], ["--host", "--unknown"]])(
    "rejects unsupported launcher arguments before creating a listener: %j", async (...args) => {
      const home = await mkdtemp(path.join(root, "entrypoint-"));
      const status = path.join(home, "ui-fittings", "jarvis-os.json"); await mkdir(path.dirname(status));
      const incumbent = '{"pid":123,"fittingId":"fixture-incumbent"}'; await writeFile(status, incumbent);
      const marker = path.join(home, "listener-attempted");
      const preload = path.join(home, "guard.mjs");
      // Instrument listen before the actual launcher loads. Even a regression
      // cannot bind a real port; its attempted side effect leaves a sentinel.
      await writeFile(preload, `import http from 'node:http';import {writeFileSync} from 'node:fs';http.Server.prototype.listen=function(){writeFileSync(process.env.JARVIS_LISTEN_SENTINEL,'attempted');throw new Error('listener attempted');};`);
      const result = spawnSync(process.execPath, ["--import", preload, path.resolve("fittings/seed/jarvis-os/scripts/start.mjs"), ...args], {
        env: { ...process.env, GARRISON_HOME: home, GARRISON_JARVISOS_PORT: "0", JARVIS_LISTEN_SENTINEL: marker }, encoding: "utf8", timeout: 2000
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/unsupported argument|requires a value/);
      expect(await readFile(status, "utf8")).toBe(incumbent);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  it("runs the dedicated read-only probe without starting Jarvis or changing status", async () => {
    const home = await mkdtemp(path.join(root, "entrypoint-probe-"));
    const status = path.join(home, "ui-fittings", "jarvis-os.json"); await mkdir(path.dirname(status));
    const incumbent = '{"pid":456,"fittingId":"fixture-incumbent"}'; await writeFile(status, incumbent);
    const result = spawnSync(process.execPath, [path.resolve("fittings/seed/jarvis-os/scripts/start.mjs"), "--probe"], {
      env: { ...process.env, GARRISON_HOME: home, GARRISON_JARVISOS_PORT: "0" }, encoding: "utf8", timeout: 3000
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe("ok");
    expect(await readFile(status, "utf8")).toBe(incumbent);
    expect(await readdir(home)).toEqual(["ui-fittings"]);
    expect(await readdir(path.dirname(status))).toEqual(["jarvis-os.json"]);
  });
  it("imports without starting servers or changing the selected home", async () => {
    const home = path.join(root, "import-home"); await mkdir(home);
    const moduleUrl = pathToFileURL(path.resolve("fittings/seed/jarvis-os/scripts/server.mjs")).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const before=process.listenerCount('SIGTERM');await import(${JSON.stringify(moduleUrl)});console.log(process.listenerCount('SIGTERM')-before);`], { env: { ...process.env, GARRISON_HOME: home }, encoding: "utf8" });
    expect(output.trim()).toBe("0"); expect(await readdir(home)).toEqual([]);
  });
});
