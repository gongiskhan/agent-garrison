#!/usr/bin/env node
// Ports Fitting backend — lists listening TCP sockets on this box and labels
// each one (ui-fitting status file > owning pid/command).
//
// Discovery: `ss -tlnpH` on Linux, `lsof -iTCP -sTCP:LISTEN -P -n` on macOS.
// Labeling + parsing are pure and live in ../lib/ports-core.mjs.
//
// Mutations are narrow and guarded: open a port in the Browser Fitting pane,
// and kill an owning pid (SIGTERM / SIGKILL) only when it currently holds a
// listening socket and is neither this server nor its parent.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import {
  parseSs,
  parseLsof,
  buildPortRows,
  buildStatusIndex,
  listeningPidSet,
  killGuard
} from "../lib/ports-core.mjs";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_ROOT = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "ports-default.json");
const BROWSER_STATUS_FILE = path.join(STATUS_ROOT, "browser-default.json");
const FITTING_ID = "ports-default";

// The runner projects composition config as GARRISON_<ID>_<KEY> (ownPortConfigEnv).
// Reading ONLY the bare PORTS_* names made the composition's `config:` block
// decorative. The runner-projected name wins; the bare name stays for standalone use.
function parseArgs(argv) {
  const out = {
    port: Number(process.env.GARRISON_PORTSDEFAULT_PORT || process.env.PORTS_PORT || 7088),
    host: process.env.GARRISON_PORTSDEFAULT_BIND_HOST || process.env.PORTS_BIND_HOST || "127.0.0.1",
    parentPid: Number(process.env.GARRISON_PARENT_PID || 0),
    scanMs: Number(
      process.env.GARRISON_PORTSDEFAULT_SCAN_INTERVAL_MS || process.env.PORTS_SCAN_INTERVAL_MS || 5000
    )
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--parent-pid") out.parentPid = Number(argv[++i]);
    else if (a === "--scan-ms") out.scanMs = Number(argv[++i]);
  }
  if (!out.parentPid) out.parentPid = process.ppid || 1;
  if (!Number.isFinite(out.scanMs) || out.scanMs < 500) out.scanMs = 5000;
  return out;
}

// ---------------------------------------------------------------------------
// Subprocess helper — collect stdout with a hard timeout, never rejects.
// ---------------------------------------------------------------------------
function execCollect(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ stdout: "", stderr: String(err?.message ?? err), code: -1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ stdout, stderr: String(err?.message ?? err), code: -1 }); });
  });
}

// ---------------------------------------------------------------------------
// Scan — platform command + parse into normalized rows.
// ---------------------------------------------------------------------------
async function scanSockets() {
  if (process.platform === "darwin") {
    const { stdout } = await execCollect("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
    return parseLsof(stdout);
  }
  const { stdout } = await execCollect("ss", ["-tlnpH"]);
  return parseSs(stdout);
}

// Read every ~/.garrison/ui-fittings/*.json status file (the flat directory
// only — the spawn/ subdir holds Garrison-side records, never Fitting status).
async function readStatusFiles() {
  let entries;
  try {
    entries = await readdir(STATUS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(STATUS_ROOT, entry.name), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // skip malformed status file
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tailnet host — `tailscale ip -4` cached, fallback to the machine's LAN IP.
// ---------------------------------------------------------------------------
let cachedTailnetHost = null;

function lanIpFallback() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return os.hostname();
}

async function resolveTailnetHost() {
  if (cachedTailnetHost) return cachedTailnetHost;
  const selfFile = path.join(GARRISON_HOME, "tailscale-self.json");
  if (existsSync(selfFile)) {
    try {
      const data = JSON.parse(readFileSync(selfFile, "utf8"));
      if (data?.hostname) { cachedTailnetHost = data.hostname; return cachedTailnetHost; }
    } catch { /* fall through */ }
  }
  const { stdout } = await execCollect("tailscale", ["ip", "-4"], 2000);
  const ip = stdout.split("\n").map((l) => l.trim()).find((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
  cachedTailnetHost = ip || lanIpFallback();
  return cachedTailnetHost;
}

// ---------------------------------------------------------------------------
// In-memory scan state (single latest snapshot).
// ---------------------------------------------------------------------------
let latest = { rows: [], listeningPids: new Set(), scannedAt: null, tailnetHost: null, platform: process.platform };

async function runScan() {
  let parsed = [];
  try {
    parsed = await scanSockets();
  } catch (err) {
    console.error("[ports] scan failed:", err?.message ?? err);
  }
  const statusFiles = await readStatusFiles();
  const statusIndex = buildStatusIndex(statusFiles);
  const tailnetHost = await resolveTailnetHost().catch(() => lanIpFallback());
  latest = {
    rows: buildPortRows(parsed, { statusIndex }),
    listeningPids: listeningPidSet(parsed),
    scannedAt: new Date().toISOString(),
    tailnetHost,
    platform: process.platform
  };
  return latest;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Local-origin guard for STATE-CHANGING requests (kill, open-in-browser). The
// server is unauthenticated and loopback-bound, so a page the user visits could
// otherwise reach it two ways: a CORS-simple cross-site POST (which the browser
// sends with an Origin header), or DNS-rebinding (which points a hostile domain
// at 127.0.0.1, so the request's Host header is that domain). Reject both:
//   - Host must resolve to loopback (blocks DNS-rebinding), and
//   - Origin, if present, must be same-origin (blocks cross-site fetch).
// Returns true when the request is blocked (and has already been answered 403).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
export function crossSiteBlocked(req, res, opts) {
  const hostHeader = String(req.headers["host"] || "");
  const hostName = hostHeader.replace(/:\d+$/, "").toLowerCase();
  if (hostName && !LOOPBACK_HOSTS.has(hostName)) {
    jsonRes(res, 403, { error: "forbidden", reason: `non-loopback Host '${hostName}' (DNS-rebinding guard)` });
    return true;
  }
  const origin = req.headers["origin"];
  if (origin) {
    let ok = false;
    try {
      const h = new URL(origin).hostname.toLowerCase();
      ok = LOOPBACK_HOSTS.has(h);
    } catch { ok = false; }
    if (!ok) {
      jsonRes(res, 403, { error: "forbidden", reason: "cross-site Origin (CSRF guard)" });
      return true;
    }
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function snapshotPayload(opts) {
  return {
    ports: latest.rows,
    scannedAt: latest.scannedAt,
    tailnetHost: latest.tailnetHost,
    platform: latest.platform,
    self: { port: opts.port, pid: process.pid }
  };
}

// GET /api/ports (?fresh=1 forces a rescan before responding)
async function handlePorts(req, res, query, opts) {
  if (query.fresh === "1" || query.fresh === "true") {
    await runScan();
  }
  jsonRes(res, 200, snapshotPayload(opts));
}

// POST /api/ports/:port/open-in-browser — navigate a browser-default tab to
// http://127.0.0.1:<port>. Loopback-safe: the browser runs on this box.
async function handleOpenInBrowser(req, res, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    return jsonRes(res, 400, { error: "invalid port" });
  }
  if (!existsSync(BROWSER_STATUS_FILE)) {
    return jsonRes(res, 502, { error: "Browser Fitting is not running (no browser-default.json)" });
  }
  let base;
  try {
    const status = JSON.parse(readFileSync(BROWSER_STATUS_FILE, "utf8"));
    base = status?.url;
  } catch {
    return jsonRes(res, 502, { error: "Browser Fitting status file is unreadable" });
  }
  if (!base) {
    return jsonRes(res, 502, { error: "Browser Fitting status file has no url" });
  }
  const target = `http://127.0.0.1:${p}`;
  try {
    const upstream = await fetch(`${base.replace(/\/$/, "")}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
      signal: AbortSignal.timeout(4000)
    });
    const bodyText = await upstream.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }
    if (!upstream.ok) {
      return jsonRes(res, 502, { error: `Browser Fitting returned ${upstream.status}`, detail: body });
    }
    return jsonRes(res, 200, { ok: true, target, tab: body });
  } catch (err) {
    return jsonRes(res, 502, { error: `Browser Fitting unreachable: ${err?.message ?? err}` });
  }
}

// POST /api/pids/:pid/kill { signal: "TERM" | "KILL" }
async function handleKill(req, res, pid, opts) {
  const body = await readBody(req);
  const signalName = body?.signal === "KILL" ? "KILL" : "TERM";
  const n = Number(pid);
  // Re-scan RIGHT NOW before the guard: `latest.listeningPids` is up to a full
  // scan interval (5s) stale, so a listener that has since exited and had its
  // pid reused by an unrelated process would pass the guard and get signalled
  // (PID-reuse TOCTOU). A fresh scan shrinks that window to the guard-to-kill
  // microseconds. Best-effort — a failed scan leaves the last set in place.
  await runScan().catch(() => {});
  const guard = killGuard(n, {
    selfPid: process.pid,
    parentPid: opts.parentPid,
    listeningPids: latest.listeningPids
  });
  if (!guard.allowed) {
    return jsonRes(res, 403, { error: guard.reason, pid: n });
  }
  try {
    process.kill(n, `SIG${signalName}`);
  } catch (err) {
    return jsonRes(res, 500, { error: `kill failed: ${err?.message ?? err}`, pid: n });
  }
  // Refresh so the row reflects the kill on the next poll immediately.
  runScan().catch(() => {});
  return jsonRes(res, 200, { ok: true, pid: n, signal: `SIG${signalName}` });
}

// ---------------------------------------------------------------------------
// Static file serving (dist/)
// ---------------------------------------------------------------------------
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
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(readFileSync(indexFallback));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ctMap = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ctMap[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Port binding + status file
// ---------------------------------------------------------------------------
async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");

  const liveOpts = { ...opts };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") {
        return jsonRes(res, 200, { ok: true, port: liveOpts.port, pid: process.pid, host: liveOpts.host });
      }
      if (pathname === "/api/ports" && method === "GET") {
        return await handlePorts(req, res, parsed.query, liveOpts);
      }
      const openMatch = pathname.match(/^\/api\/ports\/(\d+)\/open-in-browser$/);
      if (openMatch && method === "POST") {
        if (crossSiteBlocked(req, res, liveOpts)) return;
        return await handleOpenInBrowser(req, res, openMatch[1]);
      }
      const killMatch = pathname.match(/^\/api\/pids\/(\d+)\/kill$/);
      if (killMatch && method === "POST") {
        if (crossSiteBlocked(req, res, liveOpts)) return;
        return await handleKill(req, res, killMatch[1], liveOpts);
      }
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[ports] handler error:", err);
      jsonRes(res, 500, { error: err?.message ?? String(err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `[ports] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(liveOpts.port, liveOpts.host, async () => {
    // Trust the OS-assigned port (handles port 0 / ephemeral). Handlers read
    // liveOpts.port at request time, so mutating it before any request lands
    // keeps /health, /api/ports, and the status file consistent.
    const bound = server.address();
    if (bound && typeof bound === "object" && bound.port) liveOpts.port = bound.port;
    await writeStatusFile(liveOpts);
    console.log(`[ports] listening on http://${liveOpts.host}:${liveOpts.port} (parent=${liveOpts.parentPid})`);
  });

  const tick = () => runScan().catch((err) => console.error("[ports] scan error:", err?.message ?? err));
  tick();
  const scanHandle = setInterval(tick, liveOpts.scanMs);

  const shutdown = async (signal) => {
    console.log(`[ports] shutdown (${signal})`);
    clearInterval(scanHandle);
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
    console.error("[ports] failed to start:", err);
    process.exit(1);
  });
}
