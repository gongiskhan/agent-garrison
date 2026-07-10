#!/usr/bin/env node
// Power Fitting backend — the idle watcher loop + a mobile-first own-port UI.
//
// The watcher ticks every 30s, evaluates six busy signals (dev-env working
// sessions, kanban in-flight cards, presence heartbeats, active SSH sessions,
// 1-minute load average, and the Keep Awake pin), and maintains a
// continuous-clear timer. When the box has been clear for `idle_minutes`, it
// self-suspends: log the request, broadcast a 10s warning, `sync`, then POST the
// GCE suspend call. Every tick it also watches for a resume (wall-vs-monotonic
// divergence) and health-probes the other own-port fittings.
//
// Own-port pattern (docs/UI-FITTINGS.md): binds a port, writes a status file at
// ~/.garrison/ui-fittings/power-default.json, serves dist/, cleans up on exit.
// Lifecycle is DETACHED — the watcher must outlive any single operative so the
// box can still suspend itself when nothing is running.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile, appendFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import {
  parseW,
  sessionsSignal,
  kanbanSignal,
  presenceSignal,
  sshSignal,
  loadSignal,
  keepAwakeSignal,
  aggregateSignals,
  tickCountdown,
  awakeHoursSummary,
  startOfLocalDay
} from "../lib/power-core.mjs";
import { suspendSelf } from "../lib/gcp-suspend.mjs";

const HOME = os.homedir();
const GARRISON = path.join(HOME, ".garrison");
const POWER_DIR = path.join(GARRISON, "power");
const STATUS_ROOT = path.join(GARRISON, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "power-default.json");
const CONFIG_FILE = path.join(POWER_DIR, "config.json");
const PRESENCE_FILE = path.join(POWER_DIR, "presence.json");
const KEEP_AWAKE_FILE = path.join(POWER_DIR, "keep-awake.json");
const LOG_FILE = path.join(POWER_DIR, "log.jsonl");
const SESSIONS_STATE_FILE = path.join(GARRISON, "sessions", "state.json");
const KANBAN_ROOT = path.join(GARRISON, "kanban-loop");

const FITTING_ID = "power-default";
const TICK_MS = 30_000;
const SUSPEND_WARNING_MS = 10_000;
const RESUME_GAP_THRESHOLD_MS = 2 * 60 * 1000; // wall-vs-monotonic divergence
const PRESENCE_RETENTION_MS = 24 * 3600 * 1000; // prune presence records older than a day

const KEEP_AWAKE_HOURS = new Set([1, 4, 8]);

const DEFAULT_CONFIG = {
  port: 7090,
  bind_host: "127.0.0.1",
  idle_minutes: 30,
  load_threshold: 1.0,
  power_page_url: ""
};

// ── config (source of truth: ~/.garrison/power/config.json) ─────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.bind_host = argv[++i];
    else if (a === "--idle-minutes") out.idle_minutes = Number(argv[++i]);
    else if (a === "--load-threshold") out.load_threshold = Number(argv[++i]);
  }
  return out;
}

function envConfig() {
  const out = {};
  if (process.env.POWER_PORT) out.port = Number(process.env.POWER_PORT);
  if (process.env.POWER_BIND_HOST) out.bind_host = process.env.POWER_BIND_HOST;
  if (process.env.POWER_IDLE_MINUTES) out.idle_minutes = Number(process.env.POWER_IDLE_MINUTES);
  if (process.env.POWER_LOAD_THRESHOLD) out.load_threshold = Number(process.env.POWER_LOAD_THRESHOLD);
  if (process.env.POWER_PAGE_URL) out.power_page_url = process.env.POWER_PAGE_URL;
  return out;
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonSyncSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Atomic JSON write: temp file then rename, mode 0600.
async function atomicWriteJSON(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

async function loadConfig() {
  const onDisk = (await readJsonSafe(CONFIG_FILE)) ?? {};
  const merged = { ...DEFAULT_CONFIG, ...onDisk, ...envConfig(), ...parseArgs(process.argv.slice(2)) };
  // Coerce + clamp the numeric fields so a corrupt config can never wedge the watcher.
  merged.port = Number.isFinite(merged.port) ? merged.port : DEFAULT_CONFIG.port;
  merged.idle_minutes = Number.isFinite(merged.idle_minutes) && merged.idle_minutes > 0 ? merged.idle_minutes : DEFAULT_CONFIG.idle_minutes;
  merged.load_threshold = Number.isFinite(merged.load_threshold) && merged.load_threshold > 0 ? merged.load_threshold : DEFAULT_CONFIG.load_threshold;
  merged.bind_host = typeof merged.bind_host === "string" && merged.bind_host ? merged.bind_host : DEFAULT_CONFIG.bind_host;
  merged.power_page_url = typeof merged.power_page_url === "string" ? merged.power_page_url : "";
  return merged;
}

// Persist ONLY the durable config fields. power_page_url is stored but is NEVER
// written to the log or console (it is a wake-from-outside secret-ish URL).
async function persistConfig(config) {
  await atomicWriteJSON(CONFIG_FILE, {
    port: config.port,
    bind_host: config.bind_host,
    idle_minutes: config.idle_minutes,
    load_threshold: config.load_threshold,
    power_page_url: config.power_page_url
  });
}

// ── power log (append-only jsonl) ───────────────────────────────────────────

async function appendLog(entry) {
  try {
    await mkdir(POWER_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch (err) {
    console.error("[power] log append failed:", err?.message ?? err);
  }
}

async function readLog() {
  try {
    const raw = await readFile(LOG_FILE, "utf8");
    const entries = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch {
        // skip a torn line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── live server state ───────────────────────────────────────────────────────

const runtime = {
  config: { ...DEFAULT_CONFIG },
  countdown: { clearSince: null, remainingMs: null, suspend: false },
  lastSignals: [],
  busy: false,
  suspending: false,
  lastSuspend: null, // { at, kind, error, status }
  keepAwake: null, // { until }
  presence: [], // [{ source, at }]
  wall: null, // last tick wall ms
  mono: null // last tick monotonic ns (bigint)
};

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // client gone; the close handler removes it
    }
  }
}

// ── signal gathering (IO happens here; pure logic lives in power-core) ───────

function runCommand(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, out: "", error: err?.message ?? String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({ ok: false, out, error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, code });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out, error: err?.message ?? String(err) });
    });
  });
}

async function loadKanban() {
  const board = await readJsonSafe(path.join(KANBAN_ROOT, "board.json"));
  const cardsDir = path.join(KANBAN_ROOT, "cards");
  const cards = [];
  let entries = [];
  try {
    entries = await readdir(cardsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const card = await readJsonSafe(path.join(cardsDir, e.name, "card.json"));
    if (card) cards.push(card);
  }
  return { board, cards };
}

// Wrap a signal computation so ANY evaluation error becomes a BUSY (fail safe).
async function safeSignal(id, label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { id, label, blocking: true, value: null, error: String(err?.message ?? err) };
  }
}

async function gatherSignals(now) {
  const { config } = runtime;
  const signals = await Promise.all([
    safeSignal("sessions", "Working sessions", async () =>
      sessionsSignal(await readJsonSafe(SESSIONS_STATE_FILE), { now })
    ),
    safeSignal("kanban", "In-flight cards", async () => {
      const { board, cards } = await loadKanban();
      return kanbanSignal(cards, board);
    }),
    safeSignal("presence", "Presence heartbeat", async () =>
      presenceSignal(runtime.presence, { now, idleMinutes: config.idle_minutes })
    ),
    safeSignal("ssh", "SSH sessions", async () => {
      const { out } = await runCommand("w", ["-h"], 3000);
      return sshSignal(parseW(out), { idleMinutes: config.idle_minutes });
    }),
    safeSignal("load", "Load average (1m)", async () => loadSignal(os.loadavg()[0], config.load_threshold)),
    safeSignal("keepAwake", "Keep Awake", async () => keepAwakeSignal(runtime.keepAwake, { now }))
  ]);
  return signals;
}

// ── the watcher tick ────────────────────────────────────────────────────────

async function detectResume(now, monoNow) {
  if (runtime.wall === null || runtime.mono === null) return;
  const wallDelta = now - runtime.wall;
  const monoDelta = Number(monoNow - runtime.mono) / 1e6; // ns → ms
  const gap = wallDelta - monoDelta;
  if (gap > RESUME_GAP_THRESHOLD_MS) {
    const gapSeconds = Math.round(gap / 1000);
    await appendLog({ kind: "resume-detected", gapSeconds });
    await healthProbeFittings();
  }
}

async function healthProbeFittings() {
  let files = [];
  try {
    files = await readdir(STATUS_ROOT);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const status = await readJsonSafe(path.join(STATUS_ROOT, file));
    const base = status?.url;
    if (!base) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) await appendLog({ kind: "health-probe-failed", fitting: status.fittingId ?? file, status: res.status });
    } catch (err) {
      await appendLog({ kind: "health-probe-failed", fitting: status.fittingId ?? file, error: String(err?.message ?? err) });
    }
  }
}

async function tick() {
  const now = Date.now();
  const monoNow = process.hrtime.bigint();
  try {
    await detectResume(now, monoNow);
  } catch (err) {
    console.error("[power] resume-detect error:", err?.message ?? err);
  }
  runtime.wall = now;
  runtime.mono = monoNow;

  // Refresh the persisted keep-awake pin (it can be set by another process/tab).
  runtime.keepAwake = await readJsonSafe(KEEP_AWAKE_FILE);

  const signals = await gatherSignals(now);
  const { busy } = aggregateSignals(signals);
  runtime.lastSignals = signals;
  runtime.busy = busy;
  runtime.countdown = tickCountdown(runtime.countdown, { busy, now, idleMinutes: runtime.config.idle_minutes });

  broadcast({ type: "tick", state: publicState(now) });

  if (runtime.countdown.suspend && !runtime.suspending) {
    // Fire-and-forget: the suspend sequence has its own 10s warning delay and
    // must not block the tick loop.
    runSuspend("idle").catch((err) => console.error("[power] suspend error:", err?.message ?? err));
  }
}

// ── self-suspend sequence (D35) ─────────────────────────────────────────────

async function runSuspend(reason) {
  if (runtime.suspending) return;
  runtime.suspending = true;
  broadcast({ type: "state", state: publicState() });
  try {
    // 1. log the request (signals snapshot minus any secret-ish values).
    await appendLog({ kind: "suspend-requested", reason, signals: runtime.lastSignals });
    // 2. warn connected clients they have 10 seconds.
    broadcast({ type: "suspend-warning", seconds: SUSPEND_WARNING_MS / 1000, reason });
    await delay(SUSPEND_WARNING_MS);
    // 3. flush filesystem buffers.
    await runCommand("sync", [], 5000);
    // 4. request the suspend.
    const result = await suspendSelf({ fetchImpl: globalThis.fetch });
    if (result.ok) {
      await appendLog({ kind: "suspend-succeeded", reason, status: result.status });
      runtime.lastSuspend = { at: new Date().toISOString(), kind: "suspend-succeeded", reason };
    } else {
      // Honest surfacing: the box's token lacks the compute scope → 403.
      await appendLog({ kind: "suspend-failed", reason, error: result.error, status: result.status });
      runtime.lastSuspend = {
        at: new Date().toISOString(),
        kind: "suspend-failed",
        reason,
        status: result.status,
        error: result.error,
        message:
          result.status === 403
            ? "suspend blocked: instance token lacks compute scope"
            : `suspend failed: ${result.error ?? "unknown error"}`
      };
    }
  } finally {
    runtime.suspending = false;
    // Reset the countdown so a failed suspend does not immediately re-fire; the
    // box stays awake and the timer restarts from the next clear tick.
    runtime.countdown = { clearSince: null, remainingMs: runtime.config.idle_minutes * 60 * 1000, suspend: false };
    broadcast({ type: "state", state: publicState() });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── presence + keep-awake mutations ─────────────────────────────────────────

async function recordPresence(source) {
  const now = Date.now();
  const cutoff = now - PRESENCE_RETENTION_MS;
  const kept = runtime.presence.filter((r) => {
    const at = Date.parse(r?.at ?? "");
    return Number.isFinite(at) && at >= cutoff;
  });
  kept.push({ source: String(source ?? "unknown"), at: new Date(now).toISOString() });
  runtime.presence = kept;
  await atomicWriteJSON(PRESENCE_FILE, kept);
}

async function setKeepAwake(hours) {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  runtime.keepAwake = { until, hours };
  await atomicWriteJSON(KEEP_AWAKE_FILE, runtime.keepAwake);
  return runtime.keepAwake;
}

async function clearKeepAwake() {
  runtime.keepAwake = null;
  try {
    await unlink(KEEP_AWAKE_FILE);
  } catch {
    // already gone
  }
}

// ── the public /api/state payload ───────────────────────────────────────────

function publicState(now = Date.now()) {
  const idleMs = runtime.config.idle_minutes * 60 * 1000;
  const remainingMs = runtime.busy ? idleMs : runtime.countdown.remainingMs ?? idleMs;
  const log = readJsonLogSync();
  const summary = awakeHoursSummary(log, { now, dayStartMs: startOfLocalDay(now) });
  return {
    now: new Date(now).toISOString(),
    fittingId: FITTING_ID,
    busy: runtime.busy,
    suspending: runtime.suspending,
    state: runtime.suspending ? "suspending" : runtime.busy ? "busy" : "idle",
    countdown: {
      remainingMs,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      idleMinutes: runtime.config.idle_minutes,
      clearSince: runtime.countdown.clearSince ? new Date(runtime.countdown.clearSince).toISOString() : null
    },
    signals: runtime.lastSignals,
    keepAwake: runtime.keepAwake,
    lastSuspend: runtime.lastSuspend,
    awakeHours: summary,
    config: {
      idle_minutes: runtime.config.idle_minutes,
      load_threshold: runtime.config.load_threshold,
      bind_host: runtime.config.bind_host,
      port: runtime.config.port,
      // The UI needs the URL for the "wake this box from outside" copy field;
      // it is returned here but NEVER logged.
      power_page_url: runtime.config.power_page_url
    }
  };
}

// Synchronous log read for the request handlers (small file).
function readJsonLogSync() {
  try {
    const raw = readFileSync(LOG_FILE, "utf8");
    const entries = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch {
        // skip
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
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
    const fallback = path.join(distDir, "index.html");
    if (existsSync(fallback)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(readFileSync(fallback));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ctMap = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ctMap[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res, distDir, liveOpts) {
  const parsed = url.parse(req.url || "/", true);
  const pathname = parsed.pathname || "/";
  const method = req.method || "GET";

  if (pathname === "/health") {
    return jsonRes(res, 200, { ok: true, port: liveOpts.port, pid: process.pid, host: liveOpts.host });
  }
  if (pathname === "/api/state" && method === "GET") {
    return jsonRes(res, 200, publicState());
  }
  if (pathname === "/presence" && method === "POST") {
    const body = await readBody(req);
    await recordPresence(body?.source);
    return jsonRes(res, 200, { ok: true });
  }
  if (pathname === "/api/suspend" && method === "POST") {
    const body = await readBody(req);
    if (body?.confirm !== true) {
      return jsonRes(res, 400, { ok: false, error: "confirm:true required" });
    }
    if (runtime.suspending) {
      return jsonRes(res, 409, { ok: false, error: "already suspending" });
    }
    // Manual path fires the same sequence (incl. the 10s warning).
    runSuspend("manual").catch((err) => console.error("[power] manual suspend error:", err?.message ?? err));
    return jsonRes(res, 202, { ok: true, warningSeconds: SUSPEND_WARNING_MS / 1000 });
  }
  if (pathname === "/api/keep-awake" && method === "POST") {
    const body = await readBody(req);
    const hours = Number(body?.hours);
    if (!KEEP_AWAKE_HOURS.has(hours)) {
      return jsonRes(res, 400, { ok: false, error: "hours must be 1, 4, or 8" });
    }
    const ka = await setKeepAwake(hours);
    broadcast({ type: "state", state: publicState() });
    return jsonRes(res, 200, { ok: true, keepAwake: ka });
  }
  if (pathname === "/api/keep-awake" && method === "DELETE") {
    await clearKeepAwake();
    broadcast({ type: "state", state: publicState() });
    return jsonRes(res, 200, { ok: true });
  }
  if (pathname === "/api/config" && method === "PUT") {
    const body = await readBody(req);
    if (Number.isFinite(Number(body?.idle_minutes)) && Number(body.idle_minutes) > 0) {
      runtime.config.idle_minutes = Number(body.idle_minutes);
    }
    if (Number.isFinite(Number(body?.load_threshold)) && Number(body.load_threshold) > 0) {
      runtime.config.load_threshold = Number(body.load_threshold);
    }
    if (typeof body?.power_page_url === "string") {
      runtime.config.power_page_url = body.power_page_url.trim();
    }
    await persistConfig(runtime.config);
    broadcast({ type: "state", state: publicState() });
    return jsonRes(res, 200, { ok: true, config: publicState().config });
  }
  if (pathname === "/api/events" && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ type: "state", state: publicState() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  return serveStatic(req, res, distDir);
}

// ── boot ────────────────────────────────────────────────────────────────────

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

async function writeStatusFile(host, port) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port,
        url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile() {
  try {
    await unlink(STATUS_FILE);
  } catch {
    // already gone
  }
}

export async function startServer() {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");
  runtime.config = await loadConfig();
  runtime.presence = (await readJsonSafe(PRESENCE_FILE)) ?? [];
  runtime.keepAwake = await readJsonSafe(KEEP_AWAKE_FILE);
  runtime.countdown = { clearSince: null, remainingMs: runtime.config.idle_minutes * 60 * 1000, suspend: false };

  const host = runtime.config.bind_host;
  const port = await findFreePort(runtime.config.port, host);
  if (port === null) {
    console.error(`[power] no free port from ${runtime.config.port}`);
    process.exit(1);
  }
  runtime.config.port = port;
  const liveOpts = { host, port };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, distDir, liveOpts).catch((err) => {
      console.error("[power] handler error:", err?.message ?? err);
      try {
        jsonRes(res, 500, { error: String(err?.message ?? err) });
      } catch {
        // response already sent
      }
    });
  });

  await new Promise((resolve) => {
    server.listen(port, host, resolve);
  });
  await writeStatusFile(host, port);
  console.log(`[power] listening on http://${host}:${port} (idle ${runtime.config.idle_minutes}m, load>${runtime.config.load_threshold})`);

  // Prime the wall/mono baseline, then tick immediately + on the interval.
  runtime.wall = Date.now();
  runtime.mono = process.hrtime.bigint();
  await tick();
  const handle = setInterval(() => {
    tick().catch((err) => console.error("[power] tick error:", err?.message ?? err));
  }, TICK_MS);

  const shutdown = async (signal) => {
    console.log(`[power] shutdown (${signal})`);
    clearInterval(handle);
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
    console.error("[power] failed to start:", err);
    process.exit(1);
  });
}
