#!/usr/bin/env node
// Spike driver — proves the multilingual voice cycle end-to-end THROUGH the
// Garrison HTTP contract (not the Python server directly):
//
//   text ──POST /tts──▶ spoken audio (in that language's voice)
//        ──POST /stt──▶ transcript + auto-detected language
//
// For each of EN / PT / FR it:
//   1. POSTs the reply text to /tts, asserts audio came back and that the
//      X-Voice-Lang header is the expected language (TTS picked the voice from
//      the text), then
//   2. POSTs that same audio to /stt, asserts detected_language matches and the
//      transcript is non-empty (STT auto-detected the spoken language).
//
// This boots the real Node wrapper (which spawns the Python voice-server), so
// it needs the venv + models (run scripts/setup.sh first). Warmup ~10-15s.
//
//   node scripts/spike/voice-multilingual.mjs
//
// Exit 0 = all languages round-tripped; non-zero = a leg failed.

import http from "node:http";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import url from "node:url";

// Isolate the status file under a throwaway GARRISON_HOME so the spike never
// clobbers the real ~/.garrison/ui-fittings/local-voice.json that channels read
// to discover the running voice server. Must be set BEFORE startServer writes it.
process.env.GARRISON_HOME = mkdtempSync(path.join(os.tmpdir(), "local-voice-spike-"));

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const { startServer } = await import(path.join(HERE, "..", "server.mjs"));

const CASES = [
  { lang: "en", text: "Good evening. Your top three priorities are ready for review." },
  { lang: "pt", text: "Boa noite. As tuas três prioridades já estão prontas para revisão." },
  { lang: "fr", text: "Bonsoir. Vos trois priorités sont prêtes pour la revue." }
];

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(port, host, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await req({ method: "GET", hostname: host, port, path: "/health" });
      if (status === 200 && JSON.parse(body.toString()).enginesReady) return true;
    } catch {}
    await sleep(1500);
  }
  return false;
}

async function tts(port, host, text) {
  return req(
    {
      method: "POST",
      hostname: host,
      port,
      path: "/tts",
      headers: { "Content-Type": "application/json" }
    },
    JSON.stringify({ text, format: "wav" })
  );
}

async function stt(port, host, wav) {
  return req(
    {
      method: "POST",
      hostname: host,
      port,
      path: "/stt",
      headers: { "Content-Type": "audio/wav", "Content-Length": wav.length }
    },
    wav
  );
}

let server;
const failures = [];
try {
  const host = "127.0.0.1";
  const { server: srv, options } = await startServer({
    port: 7390,
    host,
    pythonBin: "",
    kokoroVoice: "bm_george",
    kokoroSpeed: "1.0",
    whisperModel: "small", // multilingual
    langVoices: "",
    wakeWord: "off"
  });
  server = srv;
  const port = options.port;
  console.log(`[spike] server on :${port}; warming engines (whisper + kokoro)…`);
  if (!(await waitReady(port, host))) {
    console.error("[spike] FAIL: engines never became ready (run scripts/setup.sh?)");
    process.exit(1);
  }
  console.log("[spike] engines ready\n");

  for (const c of CASES) {
    // 1. TTS — assert audio + the voice language the server chose from the text
    const t = await tts(port, host, c.text);
    const voiceLang = t.headers["x-voice-lang"];
    const ttsOk = t.status === 200 && t.body.length > 1000;
    const langOk = voiceLang === c.lang;
    console.log(
      `[tts ${c.lang}] status=${t.status} bytes=${t.body.length} voice=${t.headers["x-voice"]} X-Voice-Lang=${voiceLang} ` +
        `${ttsOk && langOk ? "OK" : "FAIL"}`
    );
    if (!ttsOk) failures.push(`tts/${c.lang}: status=${t.status} bytes=${t.body.length}`);
    if (!langOk) failures.push(`tts/${c.lang}: voice language ${voiceLang} != ${c.lang}`);

    // 2. STT — feed that audio back, assert detected language + transcript
    if (ttsOk) {
      const s = await stt(port, host, t.body);
      let data = {};
      try { data = JSON.parse(s.body.toString()); } catch {}
      const sttOk = s.status === 200 && typeof data.transcript === "string" && data.transcript.trim().length > 0;
      const detOk = data.detected_language === c.lang;
      console.log(
        `[stt ${c.lang}] status=${s.status} detected_language=${data.detected_language} ` +
          `transcript=${JSON.stringify((data.transcript || "").slice(0, 60))} ${sttOk && detOk ? "OK" : "FAIL"}`
      );
      if (!sttOk) failures.push(`stt/${c.lang}: empty transcript (status=${s.status})`);
      if (!detOk) failures.push(`stt/${c.lang}: detected ${data.detected_language} != ${c.lang}`);
    }
    console.log("");
  }
} catch (err) {
  console.error("[spike] error:", err);
  failures.push(String(err?.message || err));
} finally {
  try { server?.close(); } catch {}
}

if (failures.length) {
  console.error(`[spike] FAIL (${failures.length}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("[spike] PASS — EN/PT/FR each synthesized in-language and re-transcribed with the right detected language.");
process.exit(0);
