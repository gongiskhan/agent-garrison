#!/usr/bin/env node
// Standalone end-to-end DRIVER (not a test stub) for the web-channel voice
// feature. The mic flow needs Chromium launched with fake-audio flags, which
// the playwright-cli MCP can't set — hence a raw playwright driver.
//
// It stands up: the deepgram-voice Fitting (real Deepgram key), a mock gateway
// (so /api/chat returns a deterministic reply without a live Operative), and
// the web-channel server; then drives a fake-audio Chromium through:
//   1. push-to-talk: mic → /api/voice/stt → transcript → auto-send → reply
//   2. read-aloud toggle: completed reply auto-spoken via /api/voice/tts
//   3. per-reply speaker button → /api/voice/tts
//
// Usage: DEEPGRAM_API_KEY=... node scripts/spike/voice-e2e.mjs
// Exit 0 = all assertions passed.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const KEY = process.env.DEEPGRAM_API_KEY || "";
const WAV = path.join(HERE, "fixtures", "voice-input.wav");

const VOICE_PORT = 7185;
const GATEWAY_PORT = 4877;
const WEB_PORT = 7183;

const procs = [];
let mockGateway;
let browser;

function log(msg) { console.log(`[voice-e2e] ${msg}`); }
function fail(msg) { console.error(`[voice-e2e] FAIL: ${msg}`); }

async function waitForHealth(urlStr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(urlStr, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on("error", () => resolve(false));
        req.setTimeout(400, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startMockGateway() {
  return new Promise((resolve) => {
    mockGateway = http.createServer((req, res) => {
      const u = url.parse(req.url || "/", true);
      if (u.pathname === "/chat/stream" && req.method === "POST") {
        // Drain the body, then reply with a deterministic SSE stream.
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          res.write(`event: chunk\ndata: ${JSON.stringify({ text: "Done — task added." })}\n\n`);
          res.write(`event: done\ndata: ${JSON.stringify({ reply: "Done — task added.", session_id: "e2e-1" })}\n\n`);
          res.end();
        });
        return;
      }
      if (u.pathname === "/channels/web/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(": keepalive\n\n");
        // keep open
        return;
      }
      res.writeHead(404); res.end();
    });
    mockGateway.listen(GATEWAY_PORT, "127.0.0.1", () => resolve());
  });
}

function startProc(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: path.dirname(path.dirname(script)),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(child);
  return child;
}

async function cleanup() {
  try { if (browser) await browser.close(); } catch {}
  for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
  try { if (mockGateway) mockGateway.close(); } catch {}
}

async function main() {
  if (!KEY) { fail("DEEPGRAM_API_KEY not set"); process.exit(2); }

  log("starting mock gateway");
  await startMockGateway();

  log("starting voice fitting");
  startProc("voice", path.join(ROOT, "fittings/seed/deepgram-voice/scripts/start.mjs"), {
    DEEPGRAM_API_KEY: KEY,
    DEEPGRAM_VOICE_PORT: String(VOICE_PORT)
  });
  if (!(await waitForHealth(`http://127.0.0.1:${VOICE_PORT}/health`))) {
    fail("voice fitting did not become healthy"); await cleanup(); process.exit(1);
  }

  log("starting web-channel");
  startProc("web", path.join(ROOT, "fittings/seed/web-channel-default/scripts/start.mjs"), {
    WEB_CHANNEL_PORT: String(WEB_PORT),
    GARRISON_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`
  });
  if (!(await waitForHealth(`http://127.0.0.1:${WEB_PORT}/health`))) {
    fail("web-channel did not become healthy"); await cleanup(); process.exit(1);
  }

  log("launching fake-audio chromium");
  browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${WAV}`
    ]
  });
  const origin = `http://127.0.0.1:${WEB_PORT}`;
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();

  // Track the voice/chat network calls.
  const hits = { stt: 0, ttsBeforeToggle: 0, tts: 0, chat: 0 };
  let sttBody = null;
  let toggledOn = false;
  page.on("response", async (resp) => {
    const u = resp.url();
    if (u.endsWith("/api/voice/stt")) { hits.stt++; try { sttBody = await resp.json(); } catch {} }
    if (u.endsWith("/api/voice/tts")) { hits.tts++; if (toggledOn) hits.ttsBeforeToggle++; }
    if (u.endsWith("/api/chat")) { hits.chat++; }
  });
  page.on("console", (m) => { if (m.type() === "error") console.log(`[page-console-error] ${m.text()}`); });

  await page.goto(origin, { waitUntil: "domcontentloaded" });

  const checks = [];
  const assert = (cond, label) => { checks.push({ ok: Boolean(cond), label }); log(`${cond ? "OK  " : "BAD "} ${label}`); };

  // Secure context + voice controls present.
  const secure = await page.evaluate(() => window.isSecureContext);
  assert(secure, "page is a secure context (mic capture allowed)");
  await page.waitForSelector('[data-testid="mic-button"]', { timeout: 5000 });
  assert(true, "mic button rendered (voice available)");
  assert(await page.locator('[data-testid="read-aloud-toggle"]').count() > 0, "read-aloud toggle rendered");

  // 1) Push-to-talk: start, let fake audio play, stop.
  log("recording (push-to-talk)…");
  await page.click('[data-testid="mic-button"]');
  await page.waitForSelector('[data-testid="mic-button"].recording', { timeout: 3000 });
  await page.waitForTimeout(2600);
  await page.click('[data-testid="mic-button"]'); // stop → STT → auto-send

  // Wait for STT to resolve.
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && hits.stt === 0; i++) await page.waitForTimeout(150);
  assert(hits.stt >= 1, "POST /api/voice/stt fired on stop");
  const transcript = (sttBody && typeof sttBody.transcript === "string") ? sttBody.transcript : "";
  log(`transcript = ${JSON.stringify(transcript)}`);
  assert(sttBody !== null, "STT returned a JSON body");
  assert(transcript.length > 0, "transcript is non-empty (tolerant of exact words)");

  // Auto-send → chat → reply bubble.
  for (let i = 0; i < 40 && hits.chat === 0; i++) await page.waitForTimeout(150);
  assert(hits.chat >= 1, "transcript auto-sent → POST /api/chat fired");
  const userBubble = await page.locator(".bubble.user").first().innerText().catch(() => "");
  assert(userBubble.trim().length > 0, "user message bubble shows the transcript");
  await page.waitForFunction(() => document.querySelector(".bubble.assistant") && /task added/i.test(document.querySelector(".bubble.assistant").textContent || ""), null, { timeout: 5000 }).catch(() => {});
  const assistantText = await page.locator(".bubble.assistant").last().innerText().catch(() => "");
  assert(/task added/i.test(assistantText), "assistant reply rendered");

  // 2) Read-aloud toggle: turn on, send a typed message, expect TTS on done.
  const ttsBefore = hits.tts;
  await page.click('[data-testid="read-aloud-toggle"]');
  toggledOn = true;
  assert(await page.locator('[data-testid="read-aloud-toggle"].on').count() > 0, "read-aloud toggle turned on");
  await page.fill("textarea", "another task please");
  await page.click(".send-button");
  for (let i = 0; i < 40 && hits.tts === ttsBefore; i++) await page.waitForTimeout(150);
  assert(hits.tts > ttsBefore, "completed reply auto-spoken via /api/voice/tts");

  // 3) Per-reply speaker button → TTS.
  const ttsBefore2 = hits.tts;
  const speaker = page.locator('[data-testid="speak-button"]').last();
  await speaker.click({ force: true });
  for (let i = 0; i < 30 && hits.tts === ttsBefore2; i++) await page.waitForTimeout(150);
  assert(hits.tts > ttsBefore2, "speaker button triggers /api/voice/tts");

  await cleanup();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[voice-e2e] ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error("[voice-e2e] FAILED checks: " + failed.map((c) => c.label).join("; "));
    process.exit(1);
  }
  console.log("[voice-e2e] ALL PASSED");
  process.exit(0);
}

main().catch(async (err) => {
  fail(err?.stack || String(err));
  await cleanup();
  process.exit(1);
});
