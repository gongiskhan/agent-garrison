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
import { WebSocketServer, WebSocket } from "ws";

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
    wakeWord: process.env.WAKE_WORD || "off",
    // Optional shared secret required for OFF-BOX access to the STT/TTS/events
    // endpoints. Loopback (the jarvis-os proxy) never needs it. Unset + a
    // non-loopback bind = off-box access is denied outright (secure default).
    authToken: process.env.LOCAL_VOICE_AUTH_TOKEN || ""
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
// The venv holds the installed deps (numpy, kokoro, faster-whisper), so it must
// win at runtime even when LOCAL_VOICE_PYTHON is set — that env only picks the
// interpreter setup.sh uses to BUILD the venv, not the runtime interpreter.
function resolvePython(opts) {
  // The venv lives OUTSIDE the package tree (default ~/.cache/garrison-local-voice/venv,
  // override via LOCAL_VOICE_VENV) so apm install -- which deep-copies the fitting and
  // hard-fails on any symlink escaping the package root -- never trips on the venv python
  // symlink. A legacy in-package .venv is still honored for older installs.
  const external = path.join(
    process.env.LOCAL_VOICE_VENV || path.join(os.homedir(), ".cache", "garrison-local-voice", "venv"),
    "bin",
    "python"
  );
  if (existsSync(external)) return external;
  const legacy = path.join(VOICE_SERVER_DIR, ".venv", "bin", "python");
  if (existsSync(legacy)) return legacy;
  if (opts.pythonBin) return opts.pythonBin;
  return "python3";
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function isLoopbackAddr(addr) {
  if (!addr) return false;
  return addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

// The STT/TTS/events endpoints are CPU-heavy and unauthenticated by default —
// fine on loopback (the jarvis-os proxy is always loopback), but if the user binds
// a LAN IP, an off-box client must present the configured LOCAL_VOICE_AUTH_TOKEN
// (Bearer header or ?token=). No token configured → off-box access is denied.
function requestAuthorized(req, ctx) {
  if (isLoopbackAddr(req.socket?.remoteAddress)) return true;
  const token = ctx?.authToken;
  if (!token) return false;
  const auth = String(req.headers?.["authorization"] || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let q = "";
  try { q = String(url.parse(req.url || "", true).query.token || ""); } catch {}
  return bearer === token || q === token;
}

// Cross-site WebSocket hijacking defense: allow no-Origin (native client),
// loopback/tailnet Origin, or same-host Origin; reject a page on another site.
function wsOriginAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "[::1]") return true;
    if (/\.ts\.net$/i.test(o.hostname)) return true;
    return o.host === (request.headers.host || "");
  } catch { return false; }
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
      headers: { "Content-Type": contentType, "Content-Length": audio.length },
      // large-v3 decodes in ~5-6s on CPU; cap generously so a wedged Python worker
      // (or GPU/Metal contention) can't hang the request — and its socket — forever.
      timeout: 30_000
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
        // eot_prob (0..1, may be null on older voice-servers) = how likely the
        // transcript is a FINISHED utterance — smart-endpointing consumers size
        // their grace window from it.
        jsonRes(res, 200, {
          transcript: typeof data.text === "string" ? data.text : "",
          confidence: null,
          detected_language: typeof data.language === "string" ? data.language : null,
          eot_prob: typeof data.eot_prob === "number" ? data.eot_prob : null
        });
      });
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) { try { res.destroy(err); } catch {} return; }
    try { jsonRes(res, 502, { error: `voice-server stt failed: ${err.message}` }); } catch {}
  });
  upstream.on("timeout", () => { try { upstream.destroy(new Error("stt upstream timeout")); } catch {} });
  // Client gave up (barge-in / navigation) — stop the upstream STT work.
  req.on("close", () => { try { upstream.destroy(); } catch {} });
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
    // Once we've started piping audio the headers are already sent — a jsonRes here
    // would throw and leave the response hanging open; destroy it instead.
    if (res.headersSent) { try { res.destroy(err); } catch {} return; }
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
      // /stt + /tts are unauthenticated + CPU-heavy — gate off-box access.
      if ((pathname === "/stt" || pathname === "/tts") && !requestAuthorized(req, ctx)) {
        return jsonRes(res, 403, { error: "forbidden (off-box access needs LOCAL_VOICE_AUTH_TOKEN)" });
      }
      if (pathname === "/stt" && method === "POST") return handleStt(req, res, ctx);
      if (pathname === "/tts" && method === "POST") return handleTts(req, res, ctx);
      if (pathname === "/" && method === "GET") return handleStatusPage(res, ctx);
      jsonRes(res, 404, { error: "not found", path: pathname });
    } catch (err) {
      console.error("[local-voice] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  });

  // WS /events — pure passthrough relay to the Python voice-server's /events
  // (wake-word "hey jarvis" + hello). Consumers (jarvis-os) reach the internal
  // Python port only through here, mirroring how /stt and /tts are proxied.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    // Cross-site WebSocket hijacking defense (WS bypasses same-origin policy):
    // reject a browser Origin that isn't same-host / loopback / tailnet. Native
    // clients (jarvis-os relay) send no Origin and pass.
    if (!wsOriginAllowed(request) || !requestAuthorized(request, ctx)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = url.parse(request.url || "/", true);
    if (parsed.pathname !== "/events") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${ctx.pyPort}/events`);
      const pending = [];
      upstream.on("open", () => {
        for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
        pending.length = 0;
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on("close", () => { try { client.close(); } catch {} });
      upstream.on("error", () => { try { client.close(); } catch {} });
      client.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      });
      client.on("close", () => { try { upstream.close(); } catch {} });
      client.on("error", () => { try { upstream.close(); } catch {} });
    });
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
