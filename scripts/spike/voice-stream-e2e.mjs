#!/usr/bin/env node
// End-to-end DRIVER for the STREAMING voice path (Deepgram live + endpointing).
// Fake-audio Chromium → web-channel → proxy → voice Fitting → Deepgram. Verifies:
//   1. tap mic → "listening" indicator + WS to /api/voice/stream opens
//   2. silence endpointing → utterance_end → auto-send → reply (no manual stop)
//   3. hands-free: after the reply's TTS ends → "arming" countdown → "listening"
//      again automatically (the full loop), with the visual state indicator.
//
// Uses a real Deepgram key + a phrase+trailing-silence fixture so UtteranceEnd
// fires. Not a .spec.ts stub — a raw driver (fake-audio needs launch flags).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures");
const KEY = process.env.DEEPGRAM_API_KEY || "";
const VOICE_PORT = 7188, GATEWAY_PORT = 4880, WEB_PORT = 7187;
if (!KEY) { console.error("DEEPGRAM_API_KEY required"); process.exit(2); }

// Fresh .garrison root for the spawned fittings (shared, so web-channel still
// discovers the voice instance) — never touch the live ~/.garrison status files.
const GARRISON_HOME = mkdtempSync(path.join(os.tmpdir(), "voice-stream-e2e-garrison-"));

// Ensure phrase+silence fixture exists (built by voice-stream-check; rebuild if missing).
const wav = path.join(FIX, "voice-input-silence.wav");
if (!existsSync(wav)) {
  const parse = (buf) => { let off = 12, sr = 16000, dOff = 44, dLen = buf.length - 44;
    while (off + 8 <= buf.length) { const id = buf.toString("ascii", off, off + 4); const sz = buf.readUInt32LE(off + 4);
      if (id === "fmt ") sr = buf.readUInt32LE(off + 12); if (id === "data") { dOff = off + 8; dLen = sz; break; } off += 8 + sz + (sz % 2); }
    return { sr, pcm: buf.subarray(dOff, dOff + dLen) }; };
  const b = parse(readFileSync(path.join(FIX, "voice-input.wav")));
  const sil = Buffer.alloc(b.sr * 2 * 2.5 | 0);
  const pcm = Buffer.concat([b.pcm, sil]);
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(b.sr, 24); h.writeUInt32LE(b.sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(wav, Buffer.concat([h, pcm]));
}

const procs = [];
let mockGateway, browser;
function startProc(name, script, env) {
  const c = spawn(process.execPath, [script], { cwd: path.dirname(path.dirname(script)), env: { ...process.env, GARRISON_HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  c.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(c); return c;
}
function waitHealth(u, tries = 40) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < tries; i++) {
      const ok = await new Promise((r) => { const q = http.get(u, (x) => { x.resume(); r(x.statusCode === 200); }); q.on("error", () => r(false)); q.setTimeout(400, () => { q.destroy(); r(false); }); });
      if (ok) return resolve(true);
      await new Promise((r) => setTimeout(r, 250));
    }
    resolve(false);
  });
}
async function cleanup() {
  try { if (browser) await browser.close(); } catch {}
  for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
  try { if (mockGateway) mockGateway.close(); } catch {}
}

async function main() {
  mockGateway = http.createServer((req, res) => {
    const u = url.parse(req.url || "/", true);
    if (u.pathname === "/chat/stream" && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        let msg = ""; try { msg = JSON.parse(body).message || ""; } catch {}
        const reply = `Heard: ${msg}`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: reply })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ reply, session_id: "s" })}\n\n`);
        res.end();
      });
      return;
    }
    if (u.pathname === "/channels/web/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ka\n\n"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => mockGateway.listen(GATEWAY_PORT, "127.0.0.1", r));

  startProc("voice", path.join(ROOT, "fittings/seed/deepgram-voice/scripts/start.mjs"), { DEEPGRAM_API_KEY: KEY, DEEPGRAM_VOICE_PORT: String(VOICE_PORT) });
  if (!(await waitHealth(`http://127.0.0.1:${VOICE_PORT}/health`))) { console.error("voice unhealthy"); await cleanup(); process.exit(1); }
  startProc("web", path.join(ROOT, "fittings/seed/web-channel-default/scripts/start.mjs"), { WEB_CHANNEL_PORT: String(WEB_PORT), GARRISON_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}` });
  if (!(await waitHealth(`http://127.0.0.1:${WEB_PORT}/health`))) { console.error("web unhealthy"); await cleanup(); process.exit(1); }

  browser = await chromium.launch({ args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required"
  ] });
  const origin = `http://127.0.0.1:${WEB_PORT}`;
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();

  const hits = { ws: 0, chat: 0, tts: 0 };
  const stateLog = [];
  page.on("websocket", (w) => { if (w.url().includes("/api/voice/stream")) hits.ws++; });
  page.on("response", (r) => { const u = r.url(); if (u.endsWith("/api/chat")) hits.chat++; if (u.endsWith("/api/voice/tts")) hits.tts++; });
  page.on("console", (m) => { if (m.type() === "error") console.log(`[page-err] ${m.text()}`); });

  // Use a short silence threshold so the test (which streams a 2.5s-silence
  // fixture) triggers UtteranceEnd quickly; production defaults to 5000ms.
  await page.goto(`${origin}/?silence_ms=1500`, { waitUntil: "domcontentloaded" });
  const checks = [];
  const ok = (c, l) => { checks.push({ c: !!c, l }); console.log(`${c ? "OK  " : "BAD "} ${l}`); };

  // Poll the voice-status data-state into a transition log.
  let polling = true;
  (async () => { let last = ""; while (polling) {
    try {
      const s = await page.getAttribute('[data-testid="voice-status"]', "data-state");
      const cur = s || "idle"; if (cur !== last) { stateLog.push(cur); last = cur; }
      await page.waitForTimeout(120);
    } catch { break; }
  } })();

  ok(await page.evaluate(() => window.isSecureContext), "secure context");
  await page.waitForSelector('[data-testid="mic-button"]', { timeout: 5000 });
  ok(await page.locator('[data-testid="auto-send-toggle"]').count() > 0, "auto-send toggle present");
  ok(await page.locator('[data-testid="hands-free-toggle"]').count() > 0, "hands-free toggle present");

  // --- Phase 1: manual tap → stream → silence auto-send ---
  console.log("phase 1: tap mic, stream fake audio, expect silence auto-send");
  await page.click('[data-testid="mic-button"]');
  await page.waitForSelector('[data-testid="voice-status"][data-state="listening"]', { timeout: 6000 });
  ok(true, "entered listening state");
  ok(hits.ws >= 1, "WS to /api/voice/stream opened");
  // Wait for utterance_end → auto-send (no manual stop)
  for (let i = 0; i < 80 && hits.chat === 0; i++) await page.waitForTimeout(150);
  ok(hits.chat >= 1, "silence endpointing → auto-sent (POST /api/chat)");
  const userText = await page.locator(".bubble.user").first().innerText().catch(() => "");
  ok(userText.trim().length > 0, "transcript appeared as a user message");
  await page.waitForFunction(() => /Heard:/.test(document.querySelector(".bubble.assistant")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  ok(/Heard:/.test(await page.locator(".bubble.assistant").last().innerText().catch(() => "")), "assistant reply rendered");

  // --- Phase 2: hands-free loop ---
  console.log("phase 2: enable hands-free, expect arming→listening loop after a reply");
  await page.click('[data-testid="hands-free-toggle"]');
  ok(await page.locator('[data-testid="hands-free-toggle"].on').count() > 0, "hands-free on");
  ok(await page.locator('[data-testid="read-aloud-toggle"].on').count() > 0, "hands-free auto-enabled read-aloud");
  const chatBefore = hits.chat;
  // Kick one cycle manually; from then on it should loop on its own.
  await page.click('[data-testid="mic-button"]');
  // Expect: listening → (utterance) → send → reply → TTS → arming → listening again
  await page.waitForFunction(() => true);
  let sawArming = false, sawSecondListen = false;
  for (let i = 0; i < 140; i++) {
    if (stateLog.includes("arming")) sawArming = true;
    // a listening occurrence AFTER an arming = the auto re-listen
    const ai = stateLog.indexOf("arming");
    if (ai >= 0 && stateLog.slice(ai + 1).includes("listening")) sawSecondListen = true;
    if (sawArming && sawSecondListen && hits.chat > chatBefore + 1) break;
    await page.waitForTimeout(150);
  }
  console.log("state transitions:", stateLog.join(" → "));
  ok(hits.tts >= 1, "reply read aloud (POST /api/voice/tts)");
  ok(sawArming, "showed 'arming' countdown after the spoken reply");
  ok(sawSecondListen, "auto re-entered 'listening' after arming (hands-free loop)");
  ok(hits.chat > chatBefore + 1, "hands-free produced another auto-send without a manual tap");

  polling = false;
  await cleanup();
  const failed = checks.filter((c) => !c.c);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.error("FAILED: " + failed.map((c) => c.l).join("; ")); process.exit(1); }
  console.log("ALL PASSED");
  process.exit(0);
}
main().catch(async (e) => { console.error("FAIL:", e?.stack || e); await cleanup(); process.exit(1); });
