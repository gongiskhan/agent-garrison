#!/usr/bin/env node
// screen-share-default backend — periodic screencapture loop + frame server.
//
// macOS-first. Linux fallback (scrot / imagemagick import) included for parity.
// No remote/outpost variant in this port — that can be added back via a
// consumed `outpost` capability in a follow-up.

import { spawn, execSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
// GARRISON_HOME (when set) IS the .garrison root - the sandbox convention every
// own-port fitting follows so spawned test instances never touch live status files.
const STATUS_ROOT = path.join(process.env.GARRISON_HOME || path.join(HOME, ".garrison"), "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "screen-share-default.json");
const SCREENSHOT_PATH = "/tmp/garrison-screen-latest.jpg";
const LOCK_PATH = "/tmp/garrison-screen-running.lock";
const IS_LINUX = process.platform === "linux";
const IS_MACOS = process.platform === "darwin";

let captureInterval = null;
let captureProcess = null;
let captureIntervalMs = 1000;
const state = {
  running: false,
  permissionGranted: true,
  lastError: null,
  lastCaptureAt: null
};

function parseArgs(argv) {
  const out = {
    port: Number(process.env.SCREEN_SHARE_PORT || 27079),
    host: process.env.SCREEN_SHARE_HOST || "127.0.0.1",
    intervalMs: Number(process.env.SCREEN_SHARE_INTERVAL_MS || 1000)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--interval-ms") out.intervalMs = Number(argv[++i]);
  }
  return out;
}

function removeLock() {
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
}
function touchLock() {
  try { writeFileSync(LOCK_PATH, Date.now().toString(), "utf8"); } catch {}
}

function captureMacOS() {
  return new Promise((resolve) => {
    captureProcess = spawn("screencapture", ["-x", "-t", "jpg", SCREENSHOT_PATH]);
    let stderr = "";
    captureProcess.stderr?.on("data", (d) => { stderr += String(d); });
    captureProcess.on("close", (code) => {
      captureProcess = null;
      if (code === 0 && existsSync(SCREENSHOT_PATH) && statSync(SCREENSHOT_PATH).size > 0) {
        state.lastCaptureAt = Date.now();
        state.permissionGranted = true;
        state.lastError = null;
        return resolve({ success: true });
      }
      const lower = stderr.toLowerCase();
      const looksPerm = lower.includes("cannot capture") || lower.includes("not permitted") || lower.includes("could not create image");
      state.permissionGranted = !looksPerm;
      state.lastError = looksPerm
        ? "Screen Recording permission required. System Settings → Privacy & Security → Screen Recording."
        : stderr || `screencapture exit=${code}`;
      resolve({ success: false, error: state.lastError });
    });
    captureProcess.on("error", (err) => {
      captureProcess = null;
      state.lastError = err.message;
      resolve({ success: false, error: err.message });
    });
  });
}

function captureLinux() {
  return new Promise((resolve) => {
    let cmd, args;
    try { execSync("which scrot"); cmd = "scrot"; args = ["-o", "-q", "85", SCREENSHOT_PATH]; }
    catch {
      try { execSync("which import"); cmd = "import"; args = ["-window", "root", "-quality", "85", SCREENSHOT_PATH]; }
      catch { return resolve({ success: false, error: "No screenshot tool (scrot/imagemagick) found." }); }
    }
    captureProcess = spawn(cmd, args, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } });
    let stderr = "";
    captureProcess.stderr?.on("data", (d) => { stderr += String(d); });
    captureProcess.on("close", (code) => {
      captureProcess = null;
      if (code === 0 && existsSync(SCREENSHOT_PATH) && statSync(SCREENSHOT_PATH).size > 0) {
        state.lastCaptureAt = Date.now();
        state.lastError = null;
        return resolve({ success: true });
      }
      state.lastError = stderr || `${cmd} exit=${code}`;
      resolve({ success: false, error: state.lastError });
    });
    captureProcess.on("error", (err) => {
      captureProcess = null;
      state.lastError = err.message;
      resolve({ success: false, error: err.message });
    });
  });
}

async function captureOnce() {
  if (IS_MACOS) return captureMacOS();
  if (IS_LINUX) return captureLinux();
  return { success: false, error: `Unsupported platform: ${process.platform}` };
}

async function startCapture() {
  if (state.running) return { success: true };
  const first = await captureOnce();
  if (!first.success) return first;
  state.running = true;
  touchLock();
  captureInterval = setInterval(() => { if (state.running) { touchLock(); void captureOnce(); } }, captureIntervalMs);
  return { success: true };
}

async function stopCapture() {
  state.running = false;
  removeLock();
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (captureProcess) { try { captureProcess.kill(); } catch {}; captureProcess = null; }
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

function handleState(req, res) {
  jsonRes(res, 200, { ...state, intervalMs: captureIntervalMs });
}

async function handleStart(req, res) {
  const result = await startCapture();
  if (!result.success) return jsonRes(res, 500, { error: result.error });
  jsonRes(res, 201, { running: true });
}

async function handleStop(req, res) {
  await stopCapture();
  jsonRes(res, 200, { ok: true, running: false });
}

function handleFrame(req, res) {
  if (!existsSync(SCREENSHOT_PATH)) return jsonRes(res, 404, { error: "no frame yet" });
  try {
    const stat = statSync(SCREENSHOT_PATH);
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Last-Modified", new Date(stat.mtimeMs).toUTCString());
    createReadStream(SCREENSHOT_PATH).pipe(res);
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
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
    console.error(`[screen-share] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
  }
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "screen-share-default",
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
  captureIntervalMs = opts.intervalMs;
  removeLock();
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");

  assertStatusSlotFree();
  const liveOpts = { ...opts };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/state") return handleState(req, res);
      if (pathname === "/frame") return handleFrame(req, res);
      if (pathname === "/start" && method === "POST") return handleStart(req, res);
      if (pathname === "/stop" && method === "POST") return handleStop(req, res);
      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[screen-share] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });
  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[screen-share] listening on http://${liveOpts.host}:${liveOpts.port}`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[screen-share] shutdown (${signal})`);
    await stopCapture();
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
  startServer().catch((err) => {
    console.error("[screen-share] failed to start:", err);
    process.exit(1);
  });
}
