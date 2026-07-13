// S6b — fake-media E2E for the streaming voice capture path.
//
// Hermetic: this test spins up its OWN http server that (a) serves the harness +
// the esbuild-bundled real VoiceConversation component + the pcm-worklet, and
// (b) acts as the mock voice relay over WebSockets (/api/voice/stream +
// /api/voice/tts-stream). Chromium runs with --use-fake-device-for-media-stream
// (see voice.pw.config.ts) so getUserMedia returns a synthetic stream and the
// AudioWorklet produces real PCM frames — no mic, no Deepgram.
//
// Run:  npx playwright test -c fittings/seed/web-channel-default/ui/__tests__/voice.pw.config.ts
//
// Covers: mic control starts capture + the WS opens + PCM frames flow (b);
// interim transcripts render and the final replaces the interim (c); the
// streaming-TTS read-aloud path fires and the end-of-speech→first-audio latency
// readout renders (d, in-browser); push-to-talk hold/release sends.

import { test, expect } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { build } from "esbuild";
import { WebSocketServer, WebSocket } from "ws";

// Playwright runs test files as CommonJS (repo is type:commonjs), so __dirname is
// available — mirrors the other tests/e2e specs.
const HERE = __dirname;
const UI_DIR = path.resolve(HERE, "..");

interface ServerState {
  sttConnections: number;
  sttBinaryFrames: number;
  ttsConnections: number;
  ttsSpeakText: string | null;
  ttsCleared: boolean;
}

let server: http.Server;
let baseUrl = "";
const state: ServerState = { sttConnections: 0, sttBinaryFrames: 0, ttsConnections: 0, ttsSpeakText: null, ttsCleared: false };

function resetState() {
  state.sttConnections = 0;
  state.sttBinaryFrames = 0;
  state.ttsConnections = 0;
  state.ttsSpeakText = null;
  state.ttsCleared = false;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>voice harness</title>
<style>body{font-family:sans-serif;margin:0}</style></head>
<body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;

// Mock STT relay: mirrors the deepgram-voice /stream protocol the client expects.
function attachSttMock(ws: WebSocket, scenario: string) {
  state.sttConnections += 1;
  let emitted = false;
  const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  send({ type: "ready", sampleRate: 16000 });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      state.sttBinaryFrames += 1;
      if (!emitted) {
        emitted = true;
        // A realistic interim→final→(silence) sequence once audio is flowing.
        setTimeout(() => send({ type: "transcript", text: "hello", isFinal: false, speechFinal: false }), 60);
        setTimeout(() => send({ type: "transcript", text: "hello world", isFinal: true, speechFinal: true }), 240);
        if (scenario === "full") {
          setTimeout(() => send({ type: "utterance_end", transcript: "hello world" }), 420);
        }
      }
    }
  });
}

// Mock streaming-TTS relay: on flush, stream one PCM audio frame then {flushed}.
function attachTtsMock(ws: WebSocket) {
  state.ttsConnections += 1;
  const sendJson = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  sendJson({ type: "ready", sampleRate: 24000 });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let m: any;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m?.type === "speak") state.ttsSpeakText = m.text ?? "";
    else if (m?.type === "clear") state.ttsCleared = true;
    else if (m?.type === "flush") {
      // 100ms of silence @ 24kHz linear16 = 2400 samples.
      const pcm = Buffer.alloc(2400 * 2);
      try { ws.send(pcm, { binary: true }); } catch {}
      setTimeout(() => sendJson({ type: "flushed" }), 20);
    }
  });
}

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.join(HERE, "voice-harness.tsx")],
    bundle: true,
    format: "esm",
    write: false,
    jsx: "automatic",
    jsxDev: false,
    loader: { ".tsx": "tsx", ".ts": "ts" },
    target: ["es2022"],
    logLevel: "silent",
  });
  const harnessJs = bundle.outputFiles[0].text;
  const workletJs = readFileSync(path.join(UI_DIR, "pcm-worklet.js"), "utf8");

  server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
    } else if (url === "/harness.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(harnessJs);
    } else if (url === "/pcm-worklet.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(workletJs);
    } else if (url.startsWith("/api/voice/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ available: true, keyConfigured: true }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", "http://localhost");
    const scenario = u.searchParams.get("scenario") || "interim-final";
    if (u.pathname === "/api/voice/stream") {
      wss.handleUpgrade(req, socket, head, (ws) => attachSttMock(ws, scenario));
    } else if (u.pathname === "/api/voice/tts-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => attachTtsMock(ws));
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => resetState());

test("conversation: mic starts capture, WS opens, PCM frames flow", async ({ page }) => {
  await page.goto(`${baseUrl}/?scenario=interim-final`);
  await expect(page.getByTestId("wcv-convo")).toBeEnabled();

  // Start hands-free conversation → opens the mic + STT WebSocket.
  await page.getByTestId("wcv-convo").click();

  // The panel appears in the listening state.
  await expect(page.getByTestId("wcv-state")).toHaveAttribute("data-state", "listening");

  // The STT WebSocket connected and real PCM frames arrived from the worklet.
  await expect.poll(() => state.sttConnections, { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(() => state.sttBinaryFrames, { timeout: 5000 }).toBeGreaterThan(0);
});

test("transcript: interim renders, then final replaces it", async ({ page }) => {
  await page.goto(`${baseUrl}/?scenario=interim-final`);
  await page.getByTestId("wcv-convo").click();

  // Interim result shows the live (not-yet-final) text.
  await expect(page.getByTestId("wcv-interim")).toHaveText("hello", { timeout: 5000 });

  // The final result replaces the interim: it moves into the finalized span and
  // the interim span is gone.
  await expect(page.getByTestId("wcv-final")).toHaveText("hello world", { timeout: 5000 });
  await expect(page.getByTestId("wcv-interim")).toHaveCount(0);
});

test("conversation cycle: silence sends, reply streams TTS, latency readout renders", async ({ page }) => {
  await page.goto(`${baseUrl}/?scenario=full`);
  await page.getByTestId("wcv-convo").click();

  // Silence endpoint → the utterance is sent as a chat turn.
  await expect.poll(async () => await page.evaluate(() => (window as any).__sent ?? []), { timeout: 6000 })
    .toContain("hello world");

  // The (stubbed) reply settles → streaming TTS opens and the mock receives the text.
  await expect.poll(() => state.ttsConnections, { timeout: 6000 }).toBeGreaterThan(0);
  await expect.poll(() => state.ttsSpeakText, { timeout: 6000 }).toContain("spoken reply");

  // First audio frame arrived → the end-of-speech→first-audio latency readout renders.
  const latency = page.getByTestId("wcv-latency");
  await expect(latency).toBeVisible({ timeout: 6000 });
  const ms = Number(await latency.getAttribute("data-ms"));
  expect(Number.isFinite(ms)).toBe(true);
  expect(ms).toBeGreaterThanOrEqual(0);
});

test("push-to-talk: hold opens capture, release sends the transcript", async ({ page }) => {
  await page.goto(`${baseUrl}/?scenario=interim-final`);
  const mic = page.getByTestId("wcv-mic");
  await expect(mic).toBeEnabled();

  // Press-and-hold → capture opens (STT WS connects) and the final transcript lands.
  await mic.dispatchEvent("pointerdown");
  await expect(page.getByTestId("wcv-state")).toHaveAttribute("data-state", "listening");
  await expect.poll(() => state.sttConnections, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("wcv-final")).toHaveText("hello world", { timeout: 5000 });

  // Release → sends the accumulated transcript and returns to idle.
  await mic.dispatchEvent("pointerup");
  await expect.poll(async () => await page.evaluate(() => (window as any).__sent ?? []), { timeout: 5000 })
    .toContain("hello world");
});
