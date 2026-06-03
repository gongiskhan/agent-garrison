#!/usr/bin/env node
// Layer-1 proof of the Deepgram LIVE contract through the voice Fitting's
// /stream WS (no browser, no proxy). Streams real PCM and verifies:
//   (a) phrase + trailing silence → utterance_end fires with the transcript
//   (b) pure silence              → no/empty utterance (the loop-safety guard)
//
// Usage: DEEPGRAM_API_KEY=... node scripts/spike/voice-stream-check.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";
import { WebSocket } from "ws";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FIX = path.join(HERE, "fixtures");
const KEY = process.env.DEEPGRAM_API_KEY || "";
const PORT = 7186;
if (!KEY) { console.error("DEEPGRAM_API_KEY required"); process.exit(2); }

// --- WAV helpers (PCM16 mono) ---------------------------------------------
function parseWav(buf) {
  // find "data" subchunk
  let off = 12;
  let sampleRate = 16000;
  let dataOff = 44, dataLen = buf.length - 44;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") sampleRate = buf.readUInt32LE(off + 12);
    if (id === "data") { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  return { sampleRate, pcm: buf.subarray(dataOff, dataOff + dataLen) };
}
function buildWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function silencePcm(sampleRate, seconds) { return Buffer.alloc(Math.round(sampleRate * 2 * seconds)); }

// Build fixtures from the existing phrase clip.
const base = parseWav(readFileSync(path.join(FIX, "voice-input.wav")));
const SR = base.sampleRate;
const phraseSilencePath = path.join(FIX, "voice-input-silence.wav");
const silencePath = path.join(FIX, "silence.wav");
if (!existsSync(phraseSilencePath)) {
  writeFileSync(phraseSilencePath, buildWav(Buffer.concat([base.pcm, silencePcm(SR, 2.5)]), SR));
  console.log("[fixture] wrote voice-input-silence.wav");
}
if (!existsSync(silencePath)) {
  writeFileSync(silencePath, buildWav(silencePcm(SR, 3), SR));
  console.log("[fixture] wrote silence.wav");
}

// --- start voice fitting ---------------------------------------------------
const voice = spawn(process.execPath, [path.join(ROOT, "fittings/seed/deepgram-voice/scripts/start.mjs")], {
  cwd: path.join(ROOT, "fittings/seed/deepgram-voice"),
  env: { ...process.env, DEEPGRAM_API_KEY: KEY, DEEPGRAM_VOICE_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});
voice.stdout.on("data", (d) => process.stdout.write(`[voice] ${d}`));
voice.stderr.on("data", (d) => process.stderr.write(`[voice] ${d}`));

function streamFile(wavPath, label) {
  return new Promise((resolve) => {
    const { sampleRate, pcm } = parseWav(readFileSync(wavPath));
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream?sample_rate=${sampleRate}`);
    const events = { ready: false, speechStarted: false, utteranceEnd: null, finals: [] };
    let pos = 0;
    const chunk = Math.round(sampleRate * 2 * 0.05); // 50ms frames
    let timer = null;
    const pump = () => {
      if (pos >= pcm.length) {
        clearInterval(timer);
        try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
        return;
      }
      ws.send(pcm.subarray(pos, Math.min(pos + chunk, pcm.length)));
      pos += chunk;
    };
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "ready") { events.ready = true; timer = setInterval(pump, 50); }
      else if (m.type === "speech_started") events.speechStarted = true;
      else if (m.type === "transcript" && m.isFinal && m.text) events.finals.push(m.text);
      else if (m.type === "utterance_end") {
        events.utteranceEnd = m.transcript ?? "";
        // give a beat then close
        setTimeout(() => ws.close(), 300);
      } else if (m.type === "error") { console.log(`[${label}] error:`, m.error); }
    });
    // Safety timeout
    const to = setTimeout(() => { try { ws.close(); } catch {} }, 20000);
    ws.on("close", () => { clearTimeout(to); clearInterval(timer); resolve(events); });
    ws.on("error", (e) => { console.log(`[${label}] ws error:`, e.message); resolve(events); });
  });
}

async function waitHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const ok = await new Promise((res) => {
        const r = http.get(`http://127.0.0.1:${PORT}/health`, (x) => { x.resume(); res(x.statusCode === 200); });
        r.on("error", () => res(false)); r.setTimeout(400, () => { r.destroy(); res(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const checks = [];
const assert = (ok, label) => { checks.push({ ok, label }); console.log(`${ok ? "OK  " : "BAD "} ${label}`); };

(async () => {
  if (!(await waitHealth())) { console.error("voice not healthy"); voice.kill(); process.exit(1); }

  console.log("\n=== (a) phrase + 2.5s trailing silence ===");
  const a = await streamFile(phraseSilencePath, "phrase");
  console.log("events:", JSON.stringify({ ready: a.ready, speechStarted: a.speechStarted, utteranceEnd: a.utteranceEnd, finals: a.finals }));
  assert(a.ready, "got ready handshake");
  assert(a.utteranceEnd !== null, "UtteranceEnd fired (silence endpointing)");
  assert((a.utteranceEnd || "").trim().length > 0, "UtteranceEnd carried a non-empty transcript");

  console.log("\n=== (b) pure silence (loop-safety guard) ===");
  const b = await streamFile(silencePath, "silence");
  console.log("events:", JSON.stringify({ ready: b.ready, speechStarted: b.speechStarted, utteranceEnd: b.utteranceEnd, finals: b.finals }));
  assert(b.ready, "got ready handshake");
  assert((b.utteranceEnd || "").trim().length === 0, "pure silence → empty/no transcript (safe to drop, no auto-send)");

  voice.kill("SIGTERM");
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e.message); voice.kill(); process.exit(1); });
