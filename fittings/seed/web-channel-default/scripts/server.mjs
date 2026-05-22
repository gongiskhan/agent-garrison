#!/usr/bin/env node
// Web-channel Fitting backend — mobile-first browser chat surface.
//
// Talks to the Operative through the http-gateway:
//   - POST /api/chat   → proxies gateway POST /chat/stream (SSE)
//   - GET  /api/stream → proxies gateway GET  /channels/web/stream (SSE)
// Also serves a static React bundle from dist/.
//
// LAN bind: default 127.0.0.1 (mirrors CLAUDE.md "talks only to localhost").
// User opts into 0.0.0.0 via config_schema.bind_host when they want phone access.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "web-channel-default.json");
const MONITOR_STATUS_FILE = path.join(STATUS_ROOT, "monitor-default.json");

const CHANNEL_ID = "web";

function parseArgs(argv) {
  const out = {
    port: Number(process.env.WEB_CHANNEL_PORT || 7083),
    host: process.env.WEB_CHANNEL_HOST || "127.0.0.1",
    gatewayUrl: process.env.GARRISON_GATEWAY_URL || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--gateway-url") out.gatewayUrl = argv[++i];
  }
  if (!out.gatewayUrl) {
    const h = process.env.GARRISON_GATEWAY_HOST || "127.0.0.1";
    const p = process.env.GARRISON_GATEWAY_PORT || "4777";
    out.gatewayUrl = `http://${h}:${p}`;
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleMonitor(req, res) {
  if (!existsSync(MONITOR_STATUS_FILE)) {
    jsonRes(res, 200, { available: false });
    return;
  }
  let info;
  try {
    info = JSON.parse(readFileSync(MONITOR_STATUS_FILE, "utf8"));
  } catch {
    jsonRes(res, 200, { available: false });
    return;
  }
  if (!info?.url) {
    jsonRes(res, 200, { available: false });
    return;
  }
  const ok = await pingHealth(info.url, 500);
  if (!ok) {
    jsonRes(res, 200, { available: false });
    return;
  }
  jsonRes(res, 200, { available: true, url: info.url });
}

function pingHealth(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const target = new URL("/health", baseUrl);
      const req = http.request({
        method: "GET",
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        timeout: timeoutMs
      }, (res) => {
        res.resume();
        settle(res.statusCode === 200);
      });
      req.on("error", () => settle(false));
      req.on("timeout", () => { req.destroy(); settle(false); });
      req.end();
    } catch {
      settle(false);
    }
  });
}

function pipeUpstreamSse(req, res, upstreamOpts, upstreamBody) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const upstream = http.request(upstreamOpts, (up) => {
    if (up.statusCode && up.statusCode >= 400) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: `upstream ${up.statusCode}` })}\n\n`);
      up.resume();
      res.end();
      return;
    }
    up.on("data", (chunk) => {
      try { res.write(chunk); } catch {}
    });
    up.on("end", () => {
      try { res.end(); } catch {}
    });
    up.on("error", (err) => {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); } catch {}
      try { res.end(); } catch {}
    });
  });
  upstream.on("error", (err) => {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } catch {}
  });
  req.on("close", () => {
    try { upstream.destroy(); } catch {}
  });
  if (upstreamBody !== undefined) {
    upstream.write(upstreamBody);
  }
  upstream.end();
}

function handleStream(req, res, opts) {
  const target = new URL(`/channels/${CHANNEL_ID}/stream`, opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "GET",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: { Accept: "text/event-stream" }
  });
}

async function readJsonBody(req, limit = 256 * 1024) {
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
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function handleChat(req, res, opts) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonRes(res, 400, { error: `invalid json: ${err.message}` });
    return;
  }
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message.trim()) {
    jsonRes(res, 400, { error: "message is required" });
    return;
  }
  const payload = JSON.stringify({ message, channel: CHANNEL_ID });
  const target = new URL("/chat/stream", opts.gatewayUrl);
  pipeUpstreamSse(req, res, {
    method: "POST",
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Accept: "text/event-stream"
    }
  }, payload);
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    const indexFallback = path.join(distDir, "index.html");
    if (existsSync(indexFallback)) {
      const data = readFileSync(indexFallback);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(data);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("web-channel: dist/ not built yet — run `node ui/build.mjs` in the Fitting directory.");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ctMap = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".map": "application/json"
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", ctMap[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
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
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "web-channel-default",
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");

  const free = await findFreePort(opts.port, opts.host);
  if (free === null) {
    console.error(`[web-channel] no free port found starting from ${opts.port}`);
    process.exit(1);
  }
  const liveOpts = { ...opts, port: free };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" || pathname === "/api/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/api/monitor" && method === "GET") return handleMonitor(req, res);
      if (pathname === "/api/stream" && method === "GET") return handleStream(req, res, liveOpts);
      if (pathname === "/api/chat" && method === "POST") return handleChat(req, res, liveOpts);
      if (pathname.startsWith("/api/")) {
        jsonRes(res, 404, { error: "not found", path: pathname });
        return;
      }
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[web-channel] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  });

  server.listen(liveOpts.port, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    console.log(`[web-channel] listening on http://${liveOpts.host}:${liveOpts.port} (gateway=${liveOpts.gatewayUrl})`);
  });

  const shutdown = async (signal) => {
    console.log(`[web-channel] shutdown (${signal})`);
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
    console.error("[web-channel] failed to start:", err);
    process.exit(1);
  });
}
