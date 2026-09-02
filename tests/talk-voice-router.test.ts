// The talk router's voice surface (docs/decisions/2026-09-garrison-app.md D22):
// the host names the voice provider through `liveOpts.voice` ({fittingId(),
// token()}), the router resolves the provider's status file under
// <GARRISON_HOME>/ui-fittings/<id>.json, probes its /health for the {voice}
// block, and proxies /stt + /tts with the capture token as a Bearer header the
// page never sees. Everything runs against a temp GARRISON_HOME and a stub
// provider on port 0 - no real ~/.garrison, no fixed ports.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "garrison-talk-voice-"));
process.env.GARRISON_HOME = home;

type Router = typeof import("../packages/talk/src/router.mjs");
let router: Router;

// Stub provider: /health answers with a capture-service shaped body, /stt and
// /tts echo what authorization reached them and whether the body arrived.
const providerCalls: Array<{ path: string; authorization: string | undefined; contentType: string | undefined; bodyLength: number }> = [];
let providerHealth: Record<string, unknown> = { voice: { stt: true, tts: true, ttsBackend: "elevenlabs", restEnabled: true } };
let providerStatus = 200;
let providerUrl = "";
let provider: http.Server;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function writeStatus(fittingId: string, url: string) {
  mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
  writeFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), JSON.stringify({ fittingId, url, pid: process.pid }));
}

async function serveRouter(voice: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = router.createTalkRouter({ gatewayUrl: "http://127.0.0.1:1", voice } as never, { log: { error() {}, warn() {}, log() {} } as never });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled: boolean) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  const url = await listen(server);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

beforeAll(async () => {
  router = await import("../packages/talk/src/router.mjs");
  provider = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url === "/health") {
        res.statusCode = providerStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(providerHealth));
        return;
      }
      providerCalls.push({ path: req.url ?? "", authorization: req.headers.authorization, contentType: req.headers["content-type"], bodyLength: body.length });
      if (req.headers.authorization !== "Bearer cap-token") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      if (req.url === "/tts") {
        res.statusCode = 200;
        res.setHeader("content-type", "audio/mpeg");
        res.end(Buffer.from([1, 2, 3, 4]));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "hello", bytes: body.length }));
    });
  });
  providerUrl = await listen(provider);
});

afterAll(async () => {
  await new Promise<void>((r) => provider.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

describe("readVoiceInfo", () => {
  it("reads <home>/ui-fittings/<id>.json and refuses ids that could escape the directory", () => {
    writeStatus("capture-service", providerUrl);
    expect(router.readVoiceInfo("capture-service")?.url).toBe(providerUrl);
    expect(router.readVoiceInfo("../capture-service")).toBeNull();
    expect(router.readVoiceInfo("")).toBeNull();
    expect(router.readVoiceInfo("never-stationed")).toBeNull();
  });
});

describe("/api/voice/health", () => {
  it("answers no voice provider when the host names none", async () => {
    const srv = await serveRouter(undefined);
    try {
      const body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: router.VOICE_NO_PROVIDER });
      expect(router.VOICE_NO_PROVIDER).toBe("no voice provider");
    } finally { await srv.close(); }
  });

  it("answers not running when the provider has no status file", async () => {
    const srv = await serveRouter({ fittingId: () => "voice-not-up", token: () => "cap-token" });
    try {
      const body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: "voice provider not running", fitting: "voice-not-up" });
    } finally { await srv.close(); }
  });

  it("answers voice locked when the token resolver has nothing and the host cannot say why", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: async () => "capture-service", token: async () => { throw new Error("Vault is locked"); } });
    try {
      const body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: "voice locked", fitting: "capture-service" });
    } finally { await srv.close(); }
  });

  it("tells a locked vault from an unsealed token when the host passes vaultLocked()", async () => {
    writeStatus("capture-service", providerUrl);
    const locked = await serveRouter({ fittingId: () => "capture-service", token: () => null, vaultLocked: () => true });
    try {
      const body = await (await fetch(`${locked.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: router.VOICE_LOCKED, fitting: "capture-service" });
    } finally { await locked.close(); }

    const unset = await serveRouter({ fittingId: () => "capture-service", token: () => null, vaultLocked: async () => false });
    try {
      const body = await (await fetch(`${unset.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: router.VOICE_TOKEN_UNSET, fitting: "capture-service" });
      expect(router.VOICE_TOKEN_UNSET).toBe("capture token not sealed");
    } finally { await unset.close(); }
  });

  it("relays the host's exact tokenReason() - a mesh node names a refusing or unreachable authority, never a locked vault", async () => {
    writeStatus("capture-service", providerUrl);
    for (const reason of [router.VOICE_TOKEN_DENIED, router.VOICE_SECRETS_UNREACHABLE, router.VOICE_TOKEN_UNSET, router.VOICE_LOCKED]) {
      const srv = await serveRouter({ fittingId: () => "capture-service", token: () => null, tokenReason: async () => reason, vaultLocked: () => true });
      try {
        const body = await (await fetch(`${srv.url}/api/voice/health`)).json();
        expect(body).toEqual({ available: false, reason, fitting: "capture-service" });
      } finally { await srv.close(); }
    }
    expect(router.VOICE_TOKEN_DENIED).toBe("capture token not granted to this node");
    expect(router.VOICE_SECRETS_UNREACHABLE).toBe("secret authority unreachable");

    // A reason outside the router's vocabulary is not shown verbatim: the UI
    // maps these strings to next steps, so an unknown one falls back to locked.
    const odd = await serveRouter({ fittingId: () => "capture-service", token: () => null, tokenReason: () => "something else" });
    try {
      const body = await (await fetch(`${odd.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: router.VOICE_LOCKED, fitting: "capture-service" });
    } finally { await odd.close(); }
  });

  it("the shell's reason strings are the router's, byte for byte", async () => {
    const shell = await import("../src/lib/voice-provider");
    expect(shell.VOICE_LOCKED).toBe(router.VOICE_LOCKED);
    expect(shell.VOICE_TOKEN_UNSET).toBe(router.VOICE_TOKEN_UNSET);
    expect(shell.VOICE_TOKEN_DENIED).toBe(router.VOICE_TOKEN_DENIED);
    expect(shell.VOICE_SECRETS_UNREACHABLE).toBe(router.VOICE_SECRETS_UNREACHABLE);
  });

  it("reports a provider whose REST lane is off as unavailable with a reason, not as a lit mic", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      providerHealth = { voice: { stt: true, tts: true, ttsBackend: "deepgram", restEnabled: false, maxTextChars: 600 } };
      const body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: router.VOICE_REST_DISABLED, fitting: "capture-service" });
      expect(router.VOICE_REST_DISABLED).toBe("voice rest disabled");
    } finally { await srv.close(); }
  });

  it("mirrors the provider's voice block: stt lights the mic, tts says read-aloud works, maxTextChars is the chunk size", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      providerHealth = { voice: { stt: true, tts: true, ttsBackend: "elevenlabs", restEnabled: true, maxTextChars: 600 } };
      let body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: true, keyConfigured: true, tts: true, backend: "elevenlabs", maxTextChars: 600, fitting: "capture-service" });
      // The page never receives the provider's machine-local url: every hop
      // goes through this same-origin proxy.
      expect(JSON.stringify(body)).not.toContain(providerUrl);

      providerHealth = { voice: { stt: true, tts: false, ttsBackend: null, restEnabled: true } };
      body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: true, keyConfigured: true, tts: false, backend: null, maxTextChars: null, fitting: "capture-service" });

      providerHealth = { voice: { stt: false, tts: false, ttsBackend: null, restEnabled: true, maxTextChars: 600 } };
      body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toMatchObject({ available: false, keyConfigured: false, tts: false, maxTextChars: 600 });
    } finally { await srv.close(); }
  });

  it("answers unreachable when the provider's /health fails or the port is dead", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      providerStatus = 500;
      let body = await (await fetch(`${srv.url}/api/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: "voice unreachable", fitting: "capture-service" });
      providerStatus = 200;

      writeStatus("dead-voice", "http://127.0.0.1:1");
      const dead = await serveRouter({ fittingId: () => "dead-voice", token: () => "cap-token" });
      try {
        body = await (await fetch(`${dead.url}/api/voice/health`)).json();
        expect(body).toEqual({ available: false, reason: "voice unreachable", fitting: "dead-voice" });
      } finally { await dead.close(); }
    } finally { await srv.close(); }
  });
});

describe("/api/voice (info)", () => {
  it("reports available and names the provider fitting (never its url) once it pings", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      const body = await (await fetch(`${srv.url}/api/voice`)).json();
      expect(body).toEqual({ available: true, fitting: "capture-service" });
    } finally { await srv.close(); }
  });

  it("reports no voice provider without a host resolver", async () => {
    const srv = await serveRouter(undefined);
    try {
      const body = await (await fetch(`${srv.url}/api/voice`)).json();
      expect(body).toEqual({ available: false, reason: "no voice provider" });
    } finally { await srv.close(); }
  });
});

describe("/api/voice/stt and /api/voice/tts proxy", () => {
  it("is our 503 (no provider / not running / locked / token unset) before any upstream hop", async () => {
    const none = await serveRouter(undefined);
    try {
      const res = await fetch(`${none.url}/api/voice/stt`, { method: "POST", body: Buffer.from("aa") });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "no voice provider" });
    } finally { await none.close(); }

    const down = await serveRouter({ fittingId: () => "voice-not-up", token: () => "cap-token" });
    try {
      const res = await fetch(`${down.url}/api/voice/stt`, { method: "POST", body: Buffer.from("aa") });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice provider not running" });
    } finally { await down.close(); }

    writeStatus("capture-service", providerUrl);
    const locked = await serveRouter({ fittingId: () => "capture-service", token: () => null });
    try {
      const calls = providerCalls.length;
      const res = await fetch(`${locked.url}/api/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice locked" });
      expect(providerCalls.length).toBe(calls);
    } finally { await locked.close(); }

    const unset = await serveRouter({ fittingId: () => "capture-service", token: () => null, vaultLocked: () => false });
    try {
      const calls = providerCalls.length;
      const res = await fetch(`${unset.url}/api/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "capture token not sealed" });
      expect(providerCalls.length).toBe(calls);
    } finally { await unset.close(); }
  });

  it("forwards the body with Authorization: Bearer <token> and pipes the upstream reply back", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      const audio = Buffer.alloc(1234, 7);
      const stt = await fetch(`${srv.url}/api/voice/stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: audio });
      expect(stt.status).toBe(200);
      expect(await stt.json()).toEqual({ text: "hello", bytes: 1234 });
      const sttCall = providerCalls.at(-1);
      expect(sttCall).toMatchObject({ path: "/stt", authorization: "Bearer cap-token", contentType: "audio/webm", bodyLength: 1234 });

      const tts = await fetch(`${srv.url}/api/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
      expect(tts.status).toBe(200);
      expect(tts.headers.get("content-type")).toBe("audio/mpeg");
      expect(tts.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await tts.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(providerCalls.at(-1)).toMatchObject({ path: "/tts", authorization: "Bearer cap-token" });
    } finally { await srv.close(); }
  });

  it("carries the ?language= hint to the provider's /stt and nothing else from the query", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      const stt = await fetch(`${srv.url}/api/voice/stt?language=pt&debug=1`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.from("aa") });
      expect(stt.status).toBe(200);
      expect(providerCalls.at(-1)?.path).toBe("/stt?language=pt");

      // /tts reads no query parameter, so none crosses even when the page sends one.
      const tts = await fetch(`${srv.url}/api/voice/tts?language=pt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
      expect(tts.status).toBe(200);
      expect(providerCalls.at(-1)?.path).toBe("/tts");
    } finally { await srv.close(); }
  });

  it("passes an upstream 401 through as-is (our token does not match the sealed one)", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "stale-token" });
    try {
      const res = await fetch(`${srv.url}/api/voice/stt`, { method: "POST", body: Buffer.from("aa") });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "bad token" });
    } finally { await srv.close(); }
  });

  it("is a 502 when the provider's port is dead", async () => {
    writeStatus("dead-voice", "http://127.0.0.1:1");
    const srv = await serveRouter({ fittingId: () => "dead-voice", token: () => "cap-token" });
    try {
      const res = await fetch(`${srv.url}/api/voice/stt`, { method: "POST", body: Buffer.from("aa") });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/^voice upstream: /);
    } finally { await srv.close(); }
  });

  it("answers 413 to a body over the proxy limit instead of dropping the socket", async () => {
    writeStatus("capture-service", providerUrl);
    const srv = await serveRouter({ fittingId: () => "capture-service", token: () => "cap-token" });
    try {
      const calls = providerCalls.length;
      const res = await fetch(`${srv.url}/api/voice/stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.alloc(25 * 1024 * 1024 + 1, 1) });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/^payload too large/);
      expect(providerCalls.length).toBe(calls);
    } finally { await srv.close(); }
  });

  it("gives up on a provider that never answers and tears the hop down when the browser leaves", async () => {
    // A provider that accepts the request and then says nothing.
    const hung: http.ServerResponse[] = [];
    const silent = http.createServer((req, res) => { req.resume(); hung.push(res); });
    const silentUrl = await listen(silent);
    writeStatus("silent-voice", silentUrl);
    const srv = await serveRouter({ fittingId: () => "silent-voice", token: () => "cap-token" });
    try {
      const ac = new AbortController();
      const pending = fetch(`${srv.url}/api/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }), signal: ac.signal });
      await new Promise((r) => setTimeout(r, 150));
      expect(hung.length).toBe(1);
      const closed = new Promise<void>((r) => hung[0].on("close", () => r()));
      ac.abort();
      await expect(pending).rejects.toThrow();
      // The upstream request the router opened dies with the browser's.
      await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("upstream hop still open after the client left")), 2000))]);
    } finally {
      await srv.close();
      for (const r of hung) { try { r.destroy(); } catch {} }
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });
});
