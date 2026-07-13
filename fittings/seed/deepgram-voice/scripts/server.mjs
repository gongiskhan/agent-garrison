#!/usr/bin/env node
// deepgram-voice backend — Voice Faculty Fitting.
//
// Proxies Deepgram so the API key never reaches the browser:
//   - POST /stt        → Deepgram /v1/listen  (audio in → { transcript } out)
//   - POST /tts        → Deepgram /v1/speak   ({ text } in → audio bytes out)
//   - WS   /stream     → Deepgram live /v1/listen (real-time STT + endpointing)
//   - WS   /tts-stream → Deepgram live /v1/speak  (streaming read-aloud, Aura-2)
//   - GET  /health, GET / (status page)
//
// The key is read from DEEPGRAM_API_KEY, injected from the vault by the runner
// for own-port Fittings that declare `consumes: vault` (see
// src/lib/own-port-lifecycle.ts vaultEnvForEntry). Localhost-bind by default,
// per CLAUDE.md "talks only to localhost"; user opts into 0.0.0.0 via config.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set)
// IS the .garrison root, else ~/.garrison. Sandboxed runs (spike drivers) set
// it so their spawned instances never touch the live install's status files.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "deepgram-voice.json");

const DG_BASE = "https://api.deepgram.com";
// WebSocket base for Deepgram's live endpoints (/v1/listen for STT, /v1/speak
// for streaming TTS). Overridable via DEEPGRAM_WS_BASE / --ws-base so the mocked
// test suite can point the relays at a local WS server; defaults to the real
// host. It is a base URL only — it carries no secret and never reaches a client.
const DG_WS_BASE = process.env.DEEPGRAM_WS_BASE || "wss://api.deepgram.com";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.DEEPGRAM_VOICE_PORT || 7085),
    host: process.env.DEEPGRAM_VOICE_HOST || "127.0.0.1",
    sttModel: process.env.DEEPGRAM_STT_MODEL || "nova-2",
    ttsModel: process.env.DEEPGRAM_TTS_MODEL || "aura-asteria-en",
    // Streaming read-aloud runs over Deepgram's /v1/speak WebSocket; the Aura-2
    // voices target that path for the lowest first-audio latency with
    // token-by-token input. Distinct from ttsModel (batch /tts, Aura-1 default).
    ttsStreamModel: process.env.DEEPGRAM_TTS_STREAM_MODEL || "aura-2-thalia-en",
    wsBase: DG_WS_BASE,
    apiKey: process.env.DEEPGRAM_API_KEY || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--stt-model") out.sttModel = argv[++i];
    else if (a === "--tts-model") out.ttsModel = argv[++i];
    else if (a === "--tts-stream-model") out.ttsStreamModel = argv[++i];
    else if (a === "--ws-base") out.wsBase = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Structured per-stage latency instrumentation (one JSON line per event on
// stdout). S6b's browser voice loop consumes these to measure the end-of-speech
// → first-audio budget (target 2s). Each line carries { ts (epoch ms, so events
// on the separate STT and TTS sockets are wall-clock comparable), evt, stage,
// session }. It never contains audio bytes, transcript text, or the API key.
function logLatency(stage, fields) {
  try {
    console.log(JSON.stringify({ ts: Date.now(), evt: "voice-latency", stage, ...fields }));
  } catch {}
}

function handleHealth(res, opts) {
  jsonRes(res, 200, {
    ok: true,
    port: opts.port,
    pid: process.pid,
    host: opts.host,
    keyConfigured: Boolean(opts.apiKey)
  });
}

function handleStatusPage(res, opts) {
  const hasKey = Boolean(opts.apiKey);

  // API-key state as a status chip: sage square + CONFIGURED when present,
  // alarm square + remediation copy when absent.
  const keyChip = hasKey
    ? `<span class="chip chip-ok"><span class="sq sq-ok"></span>CONFIGURED</span>`
    : `<span class="chip chip-alarm"><span class="sq sq-alarm"></span>MISSING - set DEEPGRAM_API_KEY in the vault</span>`;

  // Real endpoints this server serves; /stream + /tts-stream are the live
  // WebSocket paths (STT and read-aloud respectively).
  const endpoints = [
    ["POST", "/stt", "audio in, transcript out"],
    ["POST", "/tts", "text in, audio bytes out"],
    ["WS", "/stream", "live streaming transcription"],
    ["WS", "/tts-stream", "streaming read-aloud (Aura-2)"],
    ["GET", "/health", "liveness probe (JSON)"]
  ];
  const rows = endpoints
    .map(
      ([method, epPath, desc]) =>
        `<tr><td><span class="method">${method}</span></td>` +
        `<td><span class="path">${epPath}</span></td>` +
        `<td class="desc">${desc}</td></tr>`
    )
    .join("");

  const runtime = [
    ["PORT", String(opts.port)],
    ["HOST", opts.host],
    ["STT MODEL", opts.sttModel],
    ["TTS MODEL", opts.ttsModel],
    ["TTS STREAM MODEL", opts.ttsStreamModel]
  ]
    .map(
      ([label, value]) =>
        `<div class="meta"><div class="meta-label">${label}</div>` +
        `<div class="meta-value">${value}</div></div>`
    )
    .join("");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#fbf8f1" />
<title>Voice Fitting - Deepgram</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
:root{
  --paper:#fbf8f1; --paper-2:#f4ede0; --paper-3:#ece2cc;
  --ink:#18211c; --ink-2:#2a342e; --mute:#66695f; --mute-2:#7d8077;
  --sage:#2f4a3a; --sage-2:#3d6249; --sage-soft:#eaf1e7;
  --brass:#b4862a; --rule:#d6cdba; --rule-2:#c4b89f;
  --alarm:#9b362d; --alarm-soft:#f7eae6;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --serif:"Source Serif 4",Georgia,serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;background:var(--paper);-webkit-text-size-adjust:100%;}
body{
  font-family:var(--sans); font-size:15px; line-height:1.55; color:var(--ink);
  -webkit-font-smoothing:antialiased;
  min-height:100vh; padding:40px 20px;
  display:flex; align-items:flex-start; justify-content:center;
}
.card{
  width:100%; max-width:620px; background:var(--paper);
  border:1px solid var(--rule); border-radius:2px; overflow:hidden;
}
.card-head{
  display:flex; align-items:center; gap:12px;
  padding:22px 24px; border-bottom:1px solid var(--rule);
  background:var(--paper-2);
}
.mark{ flex-shrink:0; color:var(--sage-2); }
.head-text{ min-width:0; }
.kicker{
  font-family:var(--mono); font-size:10px; letter-spacing:0.14em;
  text-transform:uppercase; color:var(--brass); margin-bottom:4px;
}
.title{
  font-family:var(--serif); font-weight:600; font-size:22px;
  letter-spacing:-0.01em; color:var(--ink); line-height:1.15;
}
.subtitle{ font-size:13px; color:var(--mute); margin-top:3px; }
.section{ padding:20px 24px; border-bottom:1px solid var(--rule); }
.section:last-child{ border-bottom:0; }
.label{
  font-family:var(--mono); font-size:10px; letter-spacing:0.08em;
  text-transform:uppercase; color:var(--mute); margin-bottom:12px;
}
/* status chip */
.chip{
  display:inline-flex; align-items:center; gap:9px;
  font-family:var(--mono); font-size:11px; font-weight:500;
  letter-spacing:0.04em; padding:7px 12px;
  border:1px solid var(--rule); border-radius:2px; color:var(--ink);
}
.chip-ok{ background:var(--sage-soft); border-color:#cfdcc9; }
.chip-alarm{ background:var(--alarm-soft); border-color:#e6cbc6; color:var(--alarm); }
.sq{ width:7px; height:7px; flex-shrink:0; }
.sq-ok{ background:var(--sage-2); box-shadow:0 0 0 3px rgba(61,98,73,0.14); }
.sq-alarm{ background:var(--alarm); box-shadow:0 0 0 3px rgba(155,54,45,0.14); }
/* endpoints table */
table{ width:100%; border-collapse:collapse; }
td{
  padding:10px 12px 10px 0; border-bottom:1px solid var(--rule);
  vertical-align:middle; font-size:13.5px;
}
tr:last-child td{ border-bottom:0; }
td:last-child{ padding-right:0; }
.method{
  display:inline-block; min-width:42px; text-align:center;
  font-family:var(--mono); font-size:9.5px; font-weight:600;
  letter-spacing:0.08em; color:var(--sage-2);
  background:var(--sage-soft); border:1px solid #cfdcc9;
  border-radius:2px; padding:2px 6px;
}
.path{
  font-family:var(--mono); font-size:12.5px; color:var(--ink);
  background:var(--paper-3); border-radius:2px; padding:2px 7px;
}
.desc{ color:var(--mute); font-size:12.5px; }
/* runtime meta grid */
.meta-grid{
  display:grid; grid-template-columns:repeat(2,1fr); gap:14px 20px;
}
.meta-label{
  font-family:var(--mono); font-size:9.5px; letter-spacing:0.1em;
  text-transform:uppercase; color:var(--mute-2); margin-bottom:3px;
}
.meta-value{
  font-family:var(--mono); font-size:13px; color:var(--ink-2);
  font-variant-numeric:tabular-nums; word-break:break-word;
}
/* footer note */
.note{
  padding:18px 24px; background:var(--paper-2);
  font-size:12.5px; color:var(--mute); line-height:1.5;
}
@media (max-width:460px){
  body{ padding:20px 12px; }
  .card-head{ padding:18px 16px; }
  .section{ padding:16px; }
  .note{ padding:16px; }
  .title{ font-size:19px; }
  .desc{ display:none; }
  .meta-grid{ gap:12px 16px; }
}
</style>
</head>
<body>
<main class="card">
  <header class="card-head">
    <svg class="mark" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M4 10v4" /><path d="M8 6v12" /><path d="M12 3v18" /><path d="M16 6v12" /><path d="M20 10v4" />
    </svg>
    <div class="head-text">
      <div class="kicker">Garrison Fitting</div>
      <div class="title">Voice Fitting</div>
      <div class="subtitle">Deepgram speech I/O backend</div>
    </div>
  </header>

  <section class="section">
    <div class="label">API Key</div>
    ${keyChip}
  </section>

  <section class="section">
    <div class="label">Endpoints</div>
    <table><tbody>${rows}</tbody></table>
  </section>

  <section class="section">
    <div class="label">Runtime</div>
    <div class="meta-grid">${runtime}</div>
  </section>

  <p class="note">This Fitting has no interactive UI. Channels (e.g. the web channel) consume it for voice input and output.</p>
</main>
</body>
</html>`);
}

async function readBinaryBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req, limit = 1 * 1024 * 1024) {
  const buf = await readBinaryBody(req, limit);
  const raw = buf.toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

async function handleStt(req, res, opts) {
  if (!opts.apiKey) {
    jsonRes(res, 503, { error: "DEEPGRAM_API_KEY not configured" });
    return;
  }
  let audio;
  try {
    audio = await readBinaryBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `bad audio body: ${err.message}` });
    return;
  }
  if (!audio.length) {
    jsonRes(res, 400, { error: "empty audio body" });
    return;
  }
  const contentType = req.headers["content-type"] || "audio/webm";
  const qs = new URLSearchParams({
    model: opts.sttModel,
    smart_format: "true",
    punctuate: "true"
  });
  try {
    const dg = await fetch(`${DG_BASE}/v1/listen?${qs.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": contentType },
      body: audio
    });
    if (!dg.ok) {
      const text = await dg.text();
      jsonRes(res, 502, { error: `deepgram listen ${dg.status}`, detail: text.slice(0, 500) });
      return;
    }
    const data = await dg.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    jsonRes(res, 200, {
      transcript: typeof alt.transcript === "string" ? alt.transcript : "",
      confidence: typeof alt.confidence === "number" ? alt.confidence : null
    });
  } catch (err) {
    jsonRes(res, 502, { error: `deepgram listen failed: ${err.message}` });
  }
}

async function handleTts(req, res, opts) {
  if (!opts.apiKey) {
    jsonRes(res, 503, { error: "DEEPGRAM_API_KEY not configured" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    return;
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    jsonRes(res, 400, { error: "text is required" });
    return;
  }
  const format = body?.format === "wav" ? "wav" : "mp3";
  const qs = new URLSearchParams({ model: opts.ttsModel });
  if (format === "wav") {
    qs.set("encoding", "linear16");
    qs.set("container", "wav");
    qs.set("sample_rate", "16000");
  }
  try {
    const dg = await fetch(`${DG_BASE}/v1/speak?${qs.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!dg.ok) {
      const detail = await dg.text();
      jsonRes(res, 502, { error: `deepgram speak ${dg.status}`, detail: detail.slice(0, 500) });
      return;
    }
    const audio = Buffer.from(await dg.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", format === "wav" ? "audio/wav" : "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(audio);
  } catch (err) {
    jsonRes(res, 502, { error: `deepgram speak failed: ${err.message}` });
  }
}

// Live streaming STT: relay a browser PCM stream to Deepgram's live WebSocket
// and translate its events into a small, stable protocol for the client:
//   server → client: {type:"ready"} | {type:"speech_started"}
//                    | {type:"transcript", text, isFinal, speechFinal}
//                    | {type:"utterance_end", transcript}   (accumulated finals)
//                    | {type:"error", error}
//   client → server: binary PCM (linear16, mono, sampleRate from the query) and
//                    optional {type:"CloseStream"} to flush.
// sampleRate comes from the client at runtime (AudioContext.sampleRate differs
// per device — iOS Safari often locks to 48000), so we never hardcode it.
function attachStream(clientWs, opts, sampleRate, utteranceEndMs) {
  if (!opts.apiKey) {
    try { clientWs.send(JSON.stringify({ type: "error", error: "DEEPGRAM_API_KEY not configured" })); } catch {}
    clientWs.close();
    return;
  }
  const rate = Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000
    ? Math.round(sampleRate)
    : 16000;
  // How long the speaker must be silent before we emit UtteranceEnd (→ auto-send).
  // Client-configurable; Deepgram requires >= 1000. Default 5s so a normal
  // mid-sentence pause doesn't fire a premature send in hands-free mode.
  const utterEnd = Number.isFinite(utteranceEndMs) && utteranceEndMs >= 1000 && utteranceEndMs <= 20000
    ? Math.round(utteranceEndMs)
    : 5000;

  const qs = new URLSearchParams({
    model: opts.sttModel,
    encoding: "linear16",
    sample_rate: String(rate),
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    endpointing: "300",      // ms of silence to finalize an interim result
    utterance_end_ms: String(utterEnd), // emit UtteranceEnd after this much silence
    vad_events: "true"
  });
  const session = randomUUID();
  const dg = new WebSocket(`${opts.wsBase || DG_WS_BASE}/v1/listen?${qs.toString()}`, {
    headers: { Authorization: `Token ${opts.apiKey}` }
  });

  // Accumulate final transcripts for the current utterance; flush on UtteranceEnd.
  let finals = [];
  let firstFrameLogged = false;   // audio-in: first client PCM frame forwarded
  let firstResultLogged = false;  // first-interim: first transcript back from DG
  const sendClient = (obj) => { try { clientWs.send(JSON.stringify(obj)); } catch {} };

  dg.on("open", () => sendClient({ type: "ready", sampleRate: rate }));

  dg.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "Results") {
      const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
      const isFinal = msg.is_final === true;
      const speechFinal = msg.speech_final === true;
      if (text && !firstResultLogged) {
        firstResultLogged = true;
        logLatency("first_interim", { session, dir: "stt", isFinal });
      }
      if (isFinal && text) finals.push(text);
      sendClient({ type: "transcript", text, isFinal, speechFinal });
    } else if (msg.type === "SpeechStarted") {
      sendClient({ type: "speech_started" });
    } else if (msg.type === "UtteranceEnd") {
      const transcript = finals.join(" ").replace(/\s+/g, " ").trim();
      finals = [];
      logLatency("utterance_end", { session, dir: "stt" });
      sendClient({ type: "utterance_end", transcript });
    }
  });

  dg.on("error", (err) => sendClient({ type: "error", error: `deepgram: ${err.message}` }));
  dg.on("close", () => { try { clientWs.close(); } catch {} });

  // Buffer any PCM that arrives before Deepgram's socket is open (the client
  // also waits for {type:"ready"}, but guard anyway).
  const pending = [];
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!firstFrameLogged) {
        firstFrameLogged = true;
        logLatency("audio_in", { session, dir: "stt" });
      }
      if (dg.readyState === WebSocket.OPEN) dg.send(data);
      else pending.push(data);
      return;
    }
    // Text control messages (e.g. CloseStream).
    let ctrl;
    try { ctrl = JSON.parse(data.toString()); } catch { return; }
    if (ctrl?.type === "CloseStream" && dg.readyState === WebSocket.OPEN) {
      dg.send(JSON.stringify({ type: "CloseStream" }));
    }
  });
  dg.on("open", () => { for (const d of pending) dg.send(d); pending.length = 0; });

  clientWs.on("close", () => {
    try {
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "CloseStream" }));
    } catch {}
    try { dg.close(); } catch {}
  });
  clientWs.on("error", () => { try { dg.close(); } catch {} });
}

// Streaming TTS (read-aloud): relay client text to Deepgram's live /v1/speak
// WebSocket and stream the Aura audio back as it is generated, so playback can
// start before the full reply text exists. Mirrors attachStream's architecture
// (the API key stays server-side; Deepgram logic stays here). Protocol:
//   client → server: {type:"speak", text}     append text to synthesize
//                     {type:"flush"}           force audio for buffered text
//                     {type:"clear"}           barge-in: drop pending audio
//                     {type:"close"}           finish + close
//   server → client: {type:"ready", sampleRate} Deepgram socket open
//                    <binary>                  raw linear16 PCM audio frames
//                    {type:"flushed"}          buffered text fully synthesized
//                    {type:"cleared"}          pending audio dropped
//                    {type:"metadata", data}   Deepgram model metadata
//                    {type:"error", error}
// sampleRate is client-selectable (?sample_rate=, 8000-48000, default 24000 —
// Aura-2's native rate); the browser feeds the PCM straight into an AudioContext.
function attachTtsStream(clientWs, opts, sampleRate) {
  if (!opts.apiKey) {
    try { clientWs.send(JSON.stringify({ type: "error", error: "DEEPGRAM_API_KEY not configured" })); } catch {}
    clientWs.close();
    return;
  }
  const rate = Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000
    ? Math.round(sampleRate)
    : 24000;

  const qs = new URLSearchParams({
    model: opts.ttsStreamModel,
    encoding: "linear16",
    sample_rate: String(rate)
  });
  const session = randomUUID();
  const dg = new WebSocket(`${opts.wsBase || DG_WS_BASE}/v1/speak?${qs.toString()}`, {
    headers: { Authorization: `Token ${opts.apiKey}` }
  });

  let firstTextLogged = false;   // tts-text-in: first speak text forwarded
  let firstAudioLogged = false;  // tts-first-audio: first audio chunk back from DG
  const sendClient = (obj) => { try { clientWs.send(JSON.stringify(obj)); } catch {} };

  // Buffer client control messages that arrive before Deepgram's socket opens.
  const pending = [];
  const forward = (obj) => {
    if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify(obj));
    else pending.push(obj);
  };

  dg.on("open", () => {
    sendClient({ type: "ready", sampleRate: rate });
    for (const obj of pending) dg.send(JSON.stringify(obj));
    pending.length = 0;
  });

  dg.on("message", (data, isBinary) => {
    // Deepgram streams audio as binary frames and status as JSON text frames.
    if (isBinary) {
      if (!firstAudioLogged) {
        firstAudioLogged = true;
        logLatency("tts_first_audio", { session, dir: "tts" });
      }
      try { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: true }); } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "Flushed") sendClient({ type: "flushed" });
    else if (msg.type === "Cleared") sendClient({ type: "cleared" });
    else if (msg.type === "Metadata") sendClient({ type: "metadata", data: msg });
    else if (msg.type === "Warning" || msg.type === "Error") {
      sendClient({ type: "error", error: `deepgram: ${msg.description || msg.message || msg.type}` });
    }
  });

  dg.on("error", (err) => sendClient({ type: "error", error: `deepgram: ${err.message}` }));
  dg.on("close", () => { try { clientWs.close(); } catch {} });

  clientWs.on("message", (data, isBinary) => {
    if (isBinary) return; // TTS input is text only; ignore stray binary.
    let ctrl;
    try { ctrl = JSON.parse(data.toString()); } catch { return; }
    switch (ctrl?.type) {
      case "speak": {
        const text = typeof ctrl.text === "string" ? ctrl.text : "";
        if (!text) return;
        if (!firstTextLogged) {
          firstTextLogged = true;
          logLatency("tts_text_in", { session, dir: "tts" });
        }
        forward({ type: "Speak", text });
        break;
      }
      case "flush":
        forward({ type: "Flush" });
        break;
      case "clear":
        forward({ type: "Clear" });
        break;
      case "close":
        forward({ type: "Close" });
        break;
      default:
        break;
    }
  });

  clientWs.on("close", () => {
    try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "Close" })); } catch {}
    try { dg.close(); } catch {}
  });
  clientWs.on("error", () => { try { dg.close(); } catch {} });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The status file is a single tracking slot. If it names another live process,
// this boot is a duplicate - refuse instead of silently stealing the slot.
function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[voice] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
  }
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: "deepgram-voice",
        port: opts.port,
        url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  assertStatusSlotFree();
  const liveOpts = { ...opts };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(res, liveOpts);
      if (pathname === "/stt" && method === "POST") return handleStt(req, res, liveOpts);
      if (pathname === "/tts" && method === "POST") return handleTts(req, res, liveOpts);
      if (pathname === "/" && method === "GET") return handleStatusPage(res, liveOpts);
      jsonRes(res, 404, { error: "not found", path: pathname });
    } catch (err) {
      console.error("[voice] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  });

  // Live streaming over WebSocket: /stream = STT (mic → transcript), /tts-stream
  // = read-aloud (text → audio). One WSS in noServer mode routes both by path.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const parsed = url.parse(request.url || "/", true);
    const sampleRate = Number(parsed.query.sample_rate);
    if (parsed.pathname === "/stream") {
      const utteranceEndMs = Number(parsed.query.utterance_end_ms);
      wss.handleUpgrade(request, socket, head, (clientWs) => attachStream(clientWs, liveOpts, sampleRate, utteranceEndMs));
      return;
    }
    if (parsed.pathname === "/tts-stream") {
      wss.handleUpgrade(request, socket, head, (clientWs) => attachTtsStream(clientWs, liveOpts, sampleRate));
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[voice] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(liveOpts.port, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    console.log(
      `[voice] listening on http://${liveOpts.host}:${liveOpts.port} ` +
        `(stt=${liveOpts.sttModel} tts=${liveOpts.ttsModel} key=${liveOpts.apiKey ? "set" : "MISSING"})`
    );
  });

  const shutdown = async (signal) => {
    console.log(`[voice] shutdown (${signal})`);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer().catch((err) => {
    console.error("[voice] failed to start:", err);
    process.exit(1);
  });
}
