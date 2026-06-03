#!/usr/bin/env node
// deepgram-voice backend — Voice Faculty Fitting.
//
// Proxies Deepgram so the API key never reaches the browser:
//   - POST /stt  → Deepgram /v1/listen  (audio in → { transcript } out)
//   - POST /tts  → Deepgram /v1/speak   ({ text } in → audio bytes out)
//   - GET  /health, GET / (status page)
//
// The key is read from DEEPGRAM_API_KEY, injected from the vault by the runner
// for own-port Fittings that declare `consumes: vault` (see
// src/lib/own-port-lifecycle.ts vaultEnvForEntry). Localhost-bind by default,
// per CLAUDE.md "talks only to localhost"; user opts into 0.0.0.0 via config.

import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "deepgram-voice.json");

const DG_BASE = "https://api.deepgram.com";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.DEEPGRAM_VOICE_PORT || 7085),
    host: process.env.DEEPGRAM_VOICE_HOST || "127.0.0.1",
    sttModel: process.env.DEEPGRAM_STT_MODEL || "nova-2",
    ttsModel: process.env.DEEPGRAM_TTS_MODEL || "aura-asteria-en",
    apiKey: process.env.DEEPGRAM_API_KEY || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--stt-model") out.sttModel = argv[++i];
    else if (a === "--tts-model") out.ttsModel = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
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
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Voice — Deepgram</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d10;color:#e6e9ef;margin:0;padding:2rem;line-height:1.5}
code{background:#1a1f26;padding:.15rem .4rem;border-radius:4px}h1{font-size:1.1rem}.k{color:${opts.apiKey ? "#46d18a" : "#e06a6a"}}</style></head>
<body><h1>Voice Fitting — Deepgram</h1>
<p>Speech I/O backend on port ${opts.port}. API key: <span class="k">${opts.apiKey ? "configured" : "MISSING (set DEEPGRAM_API_KEY in the vault)"}</span></p>
<p>Endpoints: <code>POST /stt</code> (audio → transcript), <code>POST /tts</code> (text → audio), <code>GET /health</code>.</p>
<p>This Fitting has no interactive UI — channels (e.g. the web channel) consume it for voice in/out.</p></body></html>`);
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
  const free = await findFreePort(opts.port, opts.host);
  if (free === null) {
    console.error(`[voice] no free port found starting from ${opts.port}`);
    process.exit(1);
  }
  const liveOpts = { ...opts, port: free };

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
