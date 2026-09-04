// The voice REST surface (D20): POST /stt and POST /tts, Bearer-gated at the
// top level of the capture service, plus the /health voice block that tells a
// surface whether it may show a mic or a speaker at all.
//
// Deepgram is an in-file http mock on port 0 answering /v1/listen and
// /v1/speak; the service is pointed at it through the one
// GARRISON_CAPTURESERVICE_DG_URL hook (scheme-flipped for the REST lane), so
// no test here ever needs a real key or binds a fixed port.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";

const TOKEN = "capture-test-token";
const MP3 = Buffer.from("ID3fake-mp3-bytes-from-aura");

type Upstream = {
  server: http.Server;
  base: string;
  calls: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
  failNext: { status: number; body: string } | null;
};

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function startUpstream(): Promise<Upstream> {
  const up: Upstream = { server: null as unknown as http.Server, base: "", calls: [], failNext: null };
  up.server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const url = new URL(req.url ?? "/", "http://mock");
    up.calls.push({ path: url.pathname + url.search, method: req.method ?? "", headers: req.headers, body });
    if (up.failNext) {
      const f = up.failNext;
      up.failNext = null;
      res.writeHead(f.status, { "content-type": "application/json" });
      res.end(f.body);
      return;
    }
    if (url.pathname === "/v1/listen") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "cria uma tarefa para amanha", confidence: 0.97 }] }] }
        })
      );
      return;
    }
    if (url.pathname === "/v1/speak") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(MP3);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => up.server.listen(0, "127.0.0.1", () => resolve()));
  const port = (up.server.address() as { port: number }).port;
  up.base = `http://127.0.0.1:${port}`;
  return up;
}

type Handle = Awaited<ReturnType<typeof startServer>>;

async function boot(home: string, env: Record<string, string>, upstream: Upstream): Promise<Handle> {
  const fullEnv = {
    GARRISON_HOME: home,
    GARRISON_CAPTURESERVICE_ENABLED: "true",
    GARRISON_CAPTURESERVICE_TTS_ENABLED: "true",
    // ws:// flips to http:// for the REST lane - one mock, both lanes.
    GARRISON_CAPTURESERVICE_DG_URL: upstream.base.replace(/^http:/, "ws:"),
    ...env
  };
  const cfg = loadConfig(fullEnv);
  return startServer({ ...cfg, port: 0, env: fullEnv });
}

function urlOf(handle: Handle): string {
  return `http://127.0.0.1:${handle.cfg.port}`;
}

describe("voice REST - keyed, Deepgram-only (auto picks Aura)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-voice-rest-"));
  let upstream: Upstream;
  let handle: Handle;
  let base: string;

  beforeAll(async () => {
    upstream = await startUpstream();
    handle = await boot(home, { CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: "dg-test-key" }, upstream);
    base = urlOf(handle);
  });
  afterAll(async () => {
    handle?.server.close();
    upstream?.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("walks the auth ladder: 401 on a bad bearer, 200 on the right one", async () => {
    const bad = await fetch(`${base}/stt`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "audio/webm" },
      body: Buffer.from("webm-bytes")
    });
    expect(bad.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);

    const res = await fetch(`${base}/stt?language=pt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "audio/webm; codecs=opus" },
      body: Buffer.from("webm-bytes")
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ transcript: "cria uma tarefa para amanha", confidence: 0.97, language: "pt", model: "nova-3" });

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toContain("/v1/listen?");
    expect(call.path).toContain("model=nova-3");
    expect(call.path).toContain("smart_format=true");
    expect(call.path).toContain("punctuate=true");
    expect(call.path).toContain("language=pt");
    expect(call.headers.authorization).toBe("Token dg-test-key");
    // The MediaRecorder codec parameter is stripped; Deepgram sniffs the container.
    expect(call.headers["content-type"]).toBe("audio/webm");
    expect(call.body.toString()).toBe("webm-bytes");
  });

  it("defaults the clip language to stt_language when the caller names none", async () => {
    upstream.calls.length = 0;
    const res = await fetch(`${base}/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: Buffer.from("x")
    });
    expect(res.status).toBe(200);
    expect((await res.json()).language).toBe("pt");
    expect(upstream.calls[0].path).toContain("language=pt");
    expect(upstream.calls[0].headers["content-type"]).toBe("audio/webm");
  });

  it("answers 400 on an empty clip without touching Deepgram", async () => {
    upstream.calls.length = 0;
    const res = await fetch(`${base}/stt`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("empty audio body");
    expect(upstream.calls).toHaveLength(0);
  });

  it("maps a Deepgram failure to 502 with the upstream status and a bounded excerpt", async () => {
    upstream.failNext = { status: 400, body: JSON.stringify({ err_msg: "Bad Request: failed to process audio" }) };
    const res = await fetch(`${base}/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: Buffer.from("garbage")
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("deepgram upstream failed");
    expect(body.backend).toBe("deepgram");
    expect(body.status).toBe(400);
    expect(body.detail).toContain("failed to process audio");
    expect(body.detail.length).toBeLessThanOrEqual(200);
  });

  it("speaks through Aura when only the Deepgram key is sealed, and names the backend and clip", async () => {
    upstream.calls.length = 0;
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Criei a tarefa.", format: "mp3" })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-voice-backend")).toBe("deepgram");
    const clipId = res.headers.get("x-clip-id");
    expect(clipId).toMatch(/^[0-9a-f]{16,}$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(MP3)).toBe(true);

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.path).toBe("/v1/speak?model=aura-asteria-en");
    expect(call.headers.authorization).toBe("Token dg-test-key");
    expect(call.headers.accept).toBe("audio/mpeg");
    expect(JSON.parse(call.body.toString())).toEqual({ text: "Criei a tarefa." });

    // The same clip is the phone's: /speak/<id>.mp3 serves it unauthenticated.
    const phone = await fetch(`${base}/speak/${clipId}.mp3`);
    expect(phone.status).toBe(200);
    expect(Buffer.from(await phone.arrayBuffer()).equals(MP3)).toBe(true);

    // Cache hit: same text, same id, no second upstream call.
    const again = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Criei a tarefa." })
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("x-clip-id")).toBe(clipId);
    expect(upstream.calls).toHaveLength(1);
  });

  it("rejects empty, oversized and non-mp3 requests with 400", async () => {
    const post = (payload: unknown) =>
      fetch(`${base}/tts`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const long = await post({ text: "a".repeat(601) });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toContain("600");
    expect((await post({ text: "hi", format: "wav" })).status).toBe(400);
  });

  it("maps an Aura failure to 502 naming the backend", async () => {
    upstream.failNext = { status: 429, body: "rate limited" };
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Uma linha nova que ainda nao esta em cache." })
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "deepgram upstream failed", backend: "deepgram", status: 429 });
    expect(body.detail).toContain("rate limited");
  });

  it("reports the voice block on /health", async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.voice).toEqual({ stt: true, tts: true, ttsBackend: "deepgram", ttsFallback: null, restEnabled: true, maxTextChars: 600 });
    expect(health.keyConfigured).toBe(true);
    expect(health.secrets).toMatchObject({ deepgramApiKey: true, elevenLabsApiKey: false, captureToken: true });
  });
});

describe("voice REST - backend selection", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-voice-rest-sel-"));
  const handles: Handle[] = [];
  let upstream: Upstream;

  beforeAll(async () => {
    upstream = await startUpstream();
  });
  afterAll(async () => {
    for (const h of handles) h.server.close();
    upstream?.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("an explicit tts_backend=elevenlabs without its key means no TTS, never a silent swap to Aura", async () => {
    const handle = await boot(
      path.join(home, "explicit"),
      { CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: "dg-test-key", GARRISON_CAPTURESERVICE_TTS_BACKEND: "elevenlabs" },
      upstream
    );
    handles.push(handle);
    const base = urlOf(handle);
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Ola." })
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("ElevenLabs");
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.voice).toMatchObject({ stt: true, tts: false, ttsBackend: null });
    expect(upstream.calls.filter((c) => c.path.startsWith("/v1/speak"))).toHaveLength(0);
  });

  it("auto prefers ElevenLabs when both keys are sealed", async () => {
    const handle = await boot(
      path.join(home, "both"),
      { CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: "dg-test-key", ELEVENLABS_API_KEY: "sk-eleven" },
      upstream
    );
    handles.push(handle);
    const health = await fetch(`${urlOf(handle)}/health`).then((r) => r.json());
    expect(health.voice).toEqual({ stt: true, tts: true, ttsBackend: "elevenlabs", ttsFallback: null, restEnabled: true, maxTextChars: 600 });
  });

  it("tts_backend=deepgram with both keys sealed speaks through Aura", async () => {
    const handle = await boot(
      path.join(home, "aura"),
      {
        CAPTURE_TOKEN: TOKEN,
        DEEPGRAM_API_KEY: "dg-test-key",
        ELEVENLABS_API_KEY: "sk-eleven",
        GARRISON_CAPTURESERVICE_TTS_BACKEND: "deepgram",
        GARRISON_CAPTURESERVICE_TTS_DEEPGRAM_MODEL: "aura-luna-en"
      },
      upstream
    );
    handles.push(handle);
    const base = urlOf(handle);
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Ola." })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-voice-backend")).toBe("deepgram");
    expect(upstream.calls.at(-1)?.path).toBe("/v1/speak?model=aura-luna-en");
  });
});

describe("voice REST - unkeyed and sealed-off", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-voice-rest-off-"));
  const handles: Handle[] = [];
  let upstream: Upstream;

  beforeAll(async () => {
    upstream = await startUpstream();
  });
  afterAll(async () => {
    for (const h of handles) h.server.close();
    upstream?.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("answers 503 on both lanes without DEEPGRAM_API_KEY, and /health says so", async () => {
    const handle = await boot(path.join(home, "unkeyed"), { CAPTURE_TOKEN: TOKEN }, upstream);
    handles.push(handle);
    const base = urlOf(handle);
    const stt = await fetch(`${base}/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: Buffer.from("bytes")
    });
    expect(stt.status).toBe(503);
    expect((await stt.json()).error).toBe("DEEPGRAM_API_KEY not sealed");
    const tts = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Ola." })
    });
    expect(tts.status).toBe(503);
    expect((await tts.json()).error).toContain("no TTS backend");
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.voice).toEqual({ stt: false, tts: false, ttsBackend: null, ttsFallback: null, restEnabled: true, maxTextChars: 600 });
    expect(health.keyConfigured).toBe(false);
    expect(upstream.calls).toHaveLength(0);
  });

  it("answers 403 on both lanes when CAPTURE_TOKEN is not sealed, whatever bearer arrives", async () => {
    const handle = await boot(path.join(home, "sealed"), { DEEPGRAM_API_KEY: "dg-test-key" }, upstream);
    handles.push(handle);
    const base = urlOf(handle);
    for (const route of ["/stt", "/tts"]) {
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: route === "/tts" ? JSON.stringify({ text: "Ola." }) : Buffer.from("bytes")
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("CAPTURE_TOKEN not sealed");
    }
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.voice.restEnabled).toBe(false);
    expect(health.voice.stt).toBe(true);
    expect(upstream.calls).toHaveLength(0);
  });
});
