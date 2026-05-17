#!/usr/bin/env node
// outpost-tailscale-host backend — UI server on port 7082 that proxies to the
// outpost-host daemon (default 127.0.0.1:3702). Lists registered outposts and
// forwards register / unregister / RPC.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "outpost-tailscale-host.json");

function parseArgs(argv) {
  const out = {
    port: Number(process.env.OUTPOST_UI_PORT || 7082),
    host: process.env.OUTPOST_UI_HOST || "127.0.0.1",
    outpostHostUrl: process.env.OUTPOST_HOST_URL || "http://127.0.0.1:3702"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--outpost-host-url") out.outpostHostUrl = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return null; }
}

async function proxyJson(targetUrl, init = {}) {
  try {
    const res = await fetch(targetUrl, init);
    let data;
    try { data = await res.json(); } catch { data = { error: `non-JSON response from outpost-host` }; }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: "outpost-host unreachable", details: err instanceof Error ? err.message : String(err) } };
  }
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleListOutposts(req, res, opts) {
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts`, { cache: "no-store" });
  jsonRes(res, result.status, result.data);
}

async function handleRegisterOutpost(req, res, opts) {
  const body = await readBody(req);
  if (!body || typeof body.name !== "string" || typeof body.token !== "string") {
    return jsonRes(res, 400, { error: "name and token (strings) required" });
  }
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: body.name, token: body.token })
  });
  jsonRes(res, result.status, result.data);
}

async function handleUnregisterOutpost(req, res, opts, name) {
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/${encodeURIComponent(name)}`, { method: "DELETE" });
  jsonRes(res, result.status, result.data);
}

async function handleRpc(req, res, opts, name) {
  const body = await readBody(req);
  if (!body || typeof body.type !== "string") {
    return jsonRes(res, 400, { error: "{type, payload} required" });
  }
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts/${encodeURIComponent(name)}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  jsonRes(res, result.status, result.data);
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) { res.statusCode = 403; return res.end("forbidden"); }
  if (!existsSync(filePath)) {
    const idx = path.join(distDir, "index.html");
    if (existsSync(idx)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      return res.end(readFileSync(idx));
    }
    res.statusCode = 404;
    return res.end("not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

async function findFreePort(startPort) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 50; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "outpost-tailscale-host",
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
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");

  const free = await findFreePort(opts.port);
  if (free === null) { console.error(`[outpost] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/outposts" && method === "GET") return handleListOutposts(req, res, liveOpts);
      if (pathname === "/outposts" && method === "POST") return handleRegisterOutpost(req, res, liveOpts);

      const unregMatch = pathname.match(/^\/outposts\/([^/]+)$/);
      if (unregMatch && method === "DELETE") return handleUnregisterOutpost(req, res, liveOpts, decodeURIComponent(unregMatch[1]));

      const rpcMatch = pathname.match(/^\/outposts\/([^/]+)\/rpc$/);
      if (rpcMatch && method === "POST") return handleRpc(req, res, liveOpts, decodeURIComponent(rpcMatch[1]));

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[outpost] listening on http://${liveOpts.host}:${liveOpts.port} (outpost-host=${liveOpts.outpostHostUrl})`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[outpost] shutdown (${signal})`);
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
  try { return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || ""); } catch { return false; }
})();

if (isDirect) {
  startServer().catch((err) => { console.error("[outpost] failed:", err); process.exit(1); });
}
