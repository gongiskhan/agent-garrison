#!/usr/bin/env node
// local-voice backend — Local Voice Fitting (channels role, own-port).
//
// A thin Node own-port wrapper that supervises the Fable voice-server
// (voice-server/server.py — Kokoro TTS + faster-whisper STT, kept verbatim)
// and exposes the Garrison voice contract, so it is a drop-in alternative to
// deepgram-voice:
//   - POST /stt    → proxies the Python POST /stt   (audio → { transcript })
//   - POST /tts    → proxies the Python GET  /speak  ({ text } → audio/wav)
//   - GET  /health → liveness + enginesReady (Python warm?)
//   - GET  /       → status page
//
// The Python child binds an internal localhost port (VOICE_PY_PORT); this Node
// process owns the public port (default 7090) and the status file, so the
// Garrison runner's own-port lifecycle (which kills the Node pid on `down`)
// works unchanged. On shutdown we kill the Python child too.
//
// Everything is local: no API key, no network. Mirrors CLAUDE.md "talks only
// to localhost"; the user opts into 0.0.0.0 via config_schema.bind_host.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

// Mirrors garrisonDir() in src/lib/claude-home.ts.
function garrisonDir() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const VOICE_SERVER_DIR = path.resolve(HERE, "..", "voice-server");
const STATUS_ROOT = path.join(garrisonDir(), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "local-voice.json");

function parseArgs(argv) {
  const out = {
    port: Number(process.env.LOCAL_VOICE_PORT || 7090),
    host: process.env.LOCAL_VOICE_HOST || "127.0.0.1",
    pythonBin: process.env.LOCAL_VOICE_PYTHON || "",
    // The Python reads these from env directly; we pass them through and only
    // force WAKE_WORD off by default (the Fable default is "on", but v1 is
    // push-to-talk and the mic would hear our own TTS).
    kokoroVoice: process.env.KOKORO_VOICE || "bm_george",
    kokoroSpeed: process.env.KOKORO_SPEED || "1.0",
    // Multilingual by default — `small` auto-detects the spoken language so the
    // Operative can be addressed in PT/FR/EN/… (use `small.en` for English-only).
    whisperModel: process.env.WHISPER_MODEL || "small",
    // JSON map ISO-lang → { voice, klang } for per-language TTS voice. Empty =
    // the voice-server's built-in defaults (en/pt/fr/es/it).
    langVoices: process.env.LANG_VOICES || "",
    wakeWord: process.env.WAKE_WORD || "off"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--python") out.pythonBin = argv[++i];
  }
  return out;
}

// venv python created by setup.sh → explicit override → system python3.
function resolvePython(opts) {
  if (opts.pythonBin) return opts.pythonBin;
  const venv = path.join(VOICE_SERVER_DIR, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function findFreePort(startPort, host) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 50; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
    if (free) return port;
  }
  return null;
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

// Probe the supervised Python /health. Resolves true only once the models are
// warm and uvicorn is serving (server.py warms the models before listening).
function pyHealth(pyPort, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const req = http.request(
        { method: "GET", hostname: "127.0.0.1", port: pyPort, path: "/health", timeout: timeoutMs },
        (res) => { res.resume(); settle(res.statusCode === 200); }
      );
      req.on("error", () => settle(false));
      req.on("timeout", () => { req.destroy(); settle(false); });
      req.end();
    } catch {
      settle(false);
    }
  });
}

function handleHealth(res, ctx) {
  jsonRes(res, 200, {
    ok: true,
    port: ctx.port,
    pid: process.pid,
    host: ctx.host,
    enginesReady: ctx.pyReady
  });
}

function handleStatusPage(res, ctx) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Voice — Local</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d10;color:#e6e9ef;margin:0;padding:2rem;line-height:1.5}
code{background:#1a1f26;padding:.15rem .4rem;border-radius:4px}h1{font-size:1.1rem}.k{color:${ctx.pyReady ? "#46d18a" : "#e0b06a"}}</style></head>
<body><h1>Local Voice — Kokoro + faster-whisper</h1>
<p>Key-free local speech I/O on port ${ctx.port}. Engines: <span class="k">${ctx.pyReady ? "ready" : "warming up / unavailable (see logs)"}</span></p>
<p>Endpoints: <code>POST /stt</code> (audio → transcript), <code>POST /tts</code> (text → audio), <code>GET /health</code>.</p>
<p>No interactive UI — channels (e.g. the Jarvis or web channel) consume it for voice in/out.</p></body></html>`);
}

async function handleStt(req, res, ctx) {
  if (!ctx.pyReady) {
    jsonRes(res, 503, { error: "voice engines not ready" });
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
  const upstream = http.request(
    {
      method: "POST",
      hostname: "127.0.0.1",
      port: ctx.pyPort,
      path: "/stt",
      headers: { "Content-Type": contentType, "Content-Length": audio.length }
    },
    (up) => {
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (up.statusCode !== 200) {
          jsonRes(res, 502, { error: `voice-server stt ${up.statusCode}`, detail: raw.slice(0, 300) });
          return;
        }
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        // Translate the voice-server shape { text, ms, language, language_probability }
        // → the Garrison voice contract { transcript, confidence, detected_language }.
        // confidence stays null (whisper gives no transcript-level confidence);
        // detected_language is the auto-detected spoken language (ISO-639-1).
        jsonRes(res, 200, {
          transcript: typeof data.text === "string" ? data.text : "",
          confidence: null,
          detected_language: typeof data.language === "string" ? data.language : null
        });
      });
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `voice-server stt failed: ${err.message}` }); } catch {}
  });
  upstream.end(audio);
}

async function handleTts(req, res, ctx) {
  if (!ctx.pyReady) {
    jsonRes(res, 503, { error: "voice engines not ready" });
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
  // The Fable voice-server exposes GET /speak?text=... and streams audio/wav
  // sentence-by-sentence. We proxy it straight back (format is always wav).
  const qs = new URLSearchParams({ text }).toString();
  const upstream = http.request(
    { method: "GET", hostname: "127.0.0.1", port: ctx.pyPort, path: `/speak?${qs}` },
    (up) => {
      if (up.statusCode !== 200) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => jsonRes(res, 502, {
          error: `voice-server tts ${up.statusCode}`,
          detail: Buffer.concat(chunks).toString("utf8").slice(0, 300)
        }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      // Surface the language/voice the voice-server actually chose from the text,
      // so consumers can log which voice spoke (X-Voice-Lang = ISO-639-1).
      if (up.headers["x-voice-lang"]) res.setHeader("X-Voice-Lang", up.headers["x-voice-lang"]);
      if (up.headers["x-voice"]) res.setHeader("X-Voice", up.headers["x-voice"]);
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    try { jsonRes(res, 502, { error: `voice-server tts failed: ${err.message}` }); } catch {}
  });
  req.on("close", () => { try { upstream.destroy(); } catch {} });
  upstream.end();
}

function spawnPython(ctx) {
  const python = resolvePython(ctx);
  const child = spawn(python, ["server.py"], {
    cwd: VOICE_SERVER_DIR,
    env: {
      ...process.env,
      VOICE_PY_PORT: String(ctx.pyPort),
      KOKORO_VOICE: ctx.kokoroVoice,
      KOKORO_SPEED: ctx.kokoroSpeed,
      WHISPER_MODEL: ctx.whisperModel,
      ...(ctx.langVoices ? { LANG_VOICES: ctx.langVoices } : {}),
      WAKE_WORD: ctx.wakeWord
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => process.stdout.write(`[voice-py] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[voice-py] ${d}`));
  child.on("error", (err) => {
    console.error(`[local-voice] failed to spawn python (${python}): ${err.message}. ` +
      `Run setup (scripts/setup.sh) to create the venv and fetch models.`);
  });
  return child;
}

async function writeStatusFile(ctx) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: "local-voice",
        port: ctx.port,
        url: `http://${ctx.host === "0.0.0.0" ? "localhost" : ctx.host}:${ctx.port}`,
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
  const port = await findFreePort(opts.port, opts.host);
  if (port === null) {
    console.error(`[local-voice] no free port found starting from ${opts.port}`);
    process.exit(1);
  }
  // Internal port for the Python child — well clear of the public range.
  const pyPort = await findFreePort(7600, "127.0.0.1");
  if (pyPort === null) {
    console.error("[local-voice] no free internal port for the voice-server");
    process.exit(1);
  }

  const ctx = { ...opts, port, pyPort, pyReady: false };

  const pyChild = spawnPython(ctx);
  let shuttingDown = false;
  pyChild.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[local-voice] voice-server exited (code ${code}); shutting down so Garrison can heal`);
    clearStatusFile().finally(() => process.exit(1));
  });

  // Poll the Python until it warms up; flip enginesReady on. `pyReady` is
  // STICKY: once the engines are confirmed up, a single slow /health (the
  // Python is busy synthesizing on CPU and can't answer within the timeout)
  // must NOT gate real requests — only sustained misses flip it back to
  // not-ready. A genuine Python death is caught separately by pyChild.on(exit),
  // which shuts the whole wrapper down, so this poll is purely warmup +
  // liveness, never the crash detector.
  let healthMisses = 0;
  const HEALTH_MISS_LIMIT = 3;
  const healthTimer = setInterval(async () => {
    const ok = await pyHealth(pyPort);
    if (ok) {
      healthMisses = 0;
      if (!ctx.pyReady) {
        ctx.pyReady = true;
        console.log("[local-voice] voice engines ready");
      }
    } else {
      healthMisses++;
      if (ctx.pyReady && healthMisses >= HEALTH_MISS_LIMIT) {
        ctx.pyReady = false;
        console.log(`[local-voice] voice engines unresponsive (${healthMisses} missed health checks)`);
      }
    }
  }, 1500);

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(res, ctx);
      if (pathname === "/stt" && method === "POST") return handleStt(req, res, ctx);
      if (pathname === "/tts" && method === "POST") return handleTts(req, res, ctx);
      if (pathname === "/" && method === "GET") return handleStatusPage(res, ctx);
      jsonRes(res, 404, { error: "not found", path: pathname });
    } catch (err) {
      console.error("[local-voice] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  });

  server.listen(port, opts.host, async () => {
    await writeStatusFile(ctx);
    console.log(
      `[local-voice] listening on http://${opts.host}:${port} ` +
        `(python ${resolvePython(opts)} on :${pyPort}, voice=${ctx.kokoroVoice} whisper=${ctx.whisperModel} wake=${ctx.wakeWord})`
    );
  });

  const shutdown = async (signal) => {
    shuttingDown = true;
    console.log(`[local-voice] shutdown (${signal})`);
    clearInterval(healthTimer);
    try { pyChild.kill("SIGTERM"); } catch {}
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => {
      try { pyChild.kill("SIGKILL"); } catch {}
      process.exit(1);
    }, 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: ctx };
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
    console.error("[local-voice] failed to start:", err);
    process.exit(1);
  });
}
