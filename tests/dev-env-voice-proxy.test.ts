// The dev-env fitting's voice bridge (/voice/health, /voice/stt, /voice/tts and
// the same under /sessions/:id/voice/*): it names the provider from
// GARRISON_VOICE_FITTING_ID, finds its status file under
// <GARRISON_HOME>/ui-fittings, and forwards clips with the CAPTURE_TOKEN it was
// spawned with as a Bearer the page never sees. Boots the real server fully
// sandboxed (own HOME/GARRISON_HOME/state/.claude, tmux OFF) against a stub
// provider on port 0.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SB = mkdtempSync(path.join(tmpdir(), "devenv-voice-"));
const CLAUDE = path.join(SB, ".claude");
const GHOME = path.join(SB, ".garrison");
mkdirSync(path.join(CLAUDE, "sessions"), { recursive: true });
mkdirSync(path.join(GHOME, "ui-fittings"), { recursive: true });

process.env.HOME = SB;
process.env.GARRISON_HOME = GHOME;
process.env.GARRISON_STATE_PATH = path.join(SB, "state.json");
process.env.GARRISON_CLAUDE_HOME = CLAUDE;
process.env.DEV_ENV_USE_TMUX = "off";
process.env.GARRISON_VOICE_FITTING_ID = "capture-service";
process.env.CAPTURE_TOKEN = "cap-token";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

const SERVER = path.join(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "server.mjs");
const { startServer } = await import(SERVER);
let server: { close: () => void };
let base: string;

let providerHealth: Record<string, unknown> = { voice: { stt: true, tts: true, ttsBackend: "deepgram", restEnabled: true, maxTextChars: 600 } };
const providerCalls: Array<{ path: string; authorization: string | undefined; bodyLength: number }> = [];
let provider: http.Server;
let providerUrl = "";

function writeStatus(url: string) {
  writeFileSync(path.join(GHOME, "ui-fittings", "capture-service.json"), JSON.stringify({ fittingId: "capture-service", url, pid: process.pid }));
}

beforeAll(async () => {
  provider = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(providerHealth));
        return;
      }
      providerCalls.push({ path: req.url ?? "", authorization: req.headers.authorization, bodyLength: Buffer.concat(chunks).length });
      if (req.headers.authorization !== "Bearer cap-token") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      if (req.url === "/tts") {
        res.setHeader("content-type", "audio/mpeg");
        res.end(Buffer.from([9, 8, 7]));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ transcript: "hello", confidence: 0.9 }));
    });
  });
  providerUrl = await listen(provider);
  writeStatus(providerUrl);

  const port = await freePort();
  const r = await startServer({ port, host: "127.0.0.1", defaultShell: "/bin/zsh", dirtyTtlMs: 10_000, useTmux: "off" });
  server = r.server;
  base = `http://127.0.0.1:${r.options.port}`;
});

afterAll(async () => {
  try { server?.close(); } catch { /* ignore */ }
  await new Promise<void>((r) => provider.close(() => r()));
  rmSync(SB, { recursive: true, force: true });
});

describe("dev-env voice bridge", () => {
  it("health mirrors the provider's voice block, names the fitting and never leaks its url", async () => {
    const body = await (await fetch(`${base}/voice/health`)).json();
    expect(body).toEqual({ available: true, keyConfigured: true, tts: true, backend: "deepgram", maxTextChars: 600, fitting: "capture-service" });
    expect(JSON.stringify(body)).not.toContain(providerUrl);
    // The same answer under the chat transport's session prefix.
    const prefixed = await (await fetch(`${base}/sessions/any-session/voice/health`)).json();
    expect(prefixed).toEqual(body);
  });

  it("reports a provider whose REST lane is off as unavailable with a reason", async () => {
    providerHealth = { voice: { stt: true, tts: true, ttsBackend: "deepgram", restEnabled: false, maxTextChars: 600 } };
    try {
      const body = await (await fetch(`${base}/voice/health`)).json();
      expect(body).toEqual({ available: false, reason: "voice rest disabled", fitting: "capture-service" });
    } finally {
      providerHealth = { voice: { stt: true, tts: true, ttsBackend: "deepgram", restEnabled: true, maxTextChars: 600 } };
    }
  });

  it("forwards /stt and /tts with the Bearer the page never sees", async () => {
    const stt = await fetch(`${base}/voice/stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.alloc(321, 1) });
    expect(stt.status).toBe(200);
    expect(await stt.json()).toEqual({ transcript: "hello", confidence: 0.9 });
    expect(providerCalls.at(-1)).toEqual({ path: "/stt", authorization: "Bearer cap-token", bodyLength: 321 });

    const tts = await fetch(`${base}/sessions/s1/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", format: "mp3" }) });
    expect(tts.status).toBe(200);
    expect(tts.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await tts.arrayBuffer())).toEqual(Buffer.from([9, 8, 7]));
    expect(providerCalls.at(-1)).toMatchObject({ path: "/tts", authorization: "Bearer cap-token" });
  });

  it("answers 413 to a clip over the limit without dropping the socket", async () => {
    const calls = providerCalls.length;
    const res = await fetch(`${base}/voice/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.alloc(1024 * 1024 + 1, 32) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/^payload too large/);
    expect(providerCalls.length).toBe(calls);
  });

  it("is a 503 with a named reason when the provider's status file is gone", async () => {
    rmSync(path.join(GHOME, "ui-fittings", "capture-service.json"));
    try {
      const health = await (await fetch(`${base}/voice/health`)).json();
      expect(health).toEqual({ available: false, reason: "voice provider not running", fitting: "capture-service" });
      const res = await fetch(`${base}/voice/stt`, { method: "POST", body: Buffer.from("aa") });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "voice provider not running" });
    } finally {
      writeStatus(providerUrl);
    }
  });
});
