#!/usr/bin/env node
// Monitor Fitting backend — read-only observability over Garrison-spawned processes.
//
// Discovery: parent-PID descendant walk via `ps -ax`.
// Per-entity details: `ps -o ...`, `lsof -i -P -n -p <pid>`, `lsof -p <pid>` (cwd row), `ps eww -p <pid>`.
// Log capture: any process that went through src/lib/spawn.ts has logs at ~/.garrison/logs/<pid>/.
// macOS-first; cross-platform parity deferred.
//
// Read-only — no signals, no kills, no input injection.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { collectVitals } from "./vitals.mjs";

const HOME = os.homedir();
const LOGS_ROOT = path.join(HOME, ".garrison", "logs");
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "monitor-default.json");
const SESSIONS_STATE_FILE = path.join(HOME, ".garrison", "sessions", "state.json");

const REDACT_PATTERN = /(_TOKEN$|_KEY$|_SECRET$|_PASSWORD$|^TOKEN$|^SECRET$|^PASSWORD$|^KEY$)/i;
const REDACTED = "***REDACTED***";

function parseArgs(argv) {
  const out = { port: Number(process.env.MONITOR_PORT || 7077), host: process.env.MONITOR_HOST || "127.0.0.1", parentPid: Number(process.env.GARRISON_PARENT_PID || 0), pollMs: Number(process.env.MONITOR_POLL_MS || 1000), retentionHours: Number(process.env.MONITOR_LOG_RETENTION_HOURS || 24) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--parent-pid") out.parentPid = Number(argv[++i]);
    else if (a === "--poll-ms") out.pollMs = Number(argv[++i]);
    else if (a === "--retention-hours") out.retentionHours = Number(argv[++i]);
  }
  if (!out.parentPid) out.parentPid = process.ppid || 1;
  return out;
}

async function execLines(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1 });
    });
  });
}

async function getProcessTable() {
  const { stdout } = await execLines("ps", ["-axo", "pid=,ppid=,etime=,pcpu=,pmem=,stat=,start=,command="]);
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], pcpu: Number(m[4]), pmem: Number(m[5]), stat: m[6], start: m[7], command: m[8] });
  }
  return rows;
}

function walkDescendants(table, rootPid, stopAtPid) {
  const byParent = new Map();
  for (const row of table) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const descendants = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const children = byParent.get(pid) ?? [];
    for (const child of children) {
      descendants.push(child);
      // Don't descend into our own probe subprocesses (ps/lsof/etc. spawned
      // by getProcessTable/getPorts/getCwd/getEnv on every poll). Including
      // them as short-lived "DEAD" entries pollutes the UI.
      if (stopAtPid != null && child.pid === stopAtPid) continue;
      queue.push(child.pid);
    }
  }
  return descendants;
}

async function getPorts(pid) {
  const { stdout } = await execLines("lsof", ["-i", "-P", "-n", "-p", String(pid)]);
  const listening = [];
  const connections = [];
  for (const line of stdout.split("\n")) {
    if (!line || line.startsWith("COMMAND")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const name = parts.slice(8).join(" ");
    const stateMatch = name.match(/\(([A-Z_]+)\)$/);
    const state = stateMatch ? stateMatch[1] : "";
    const addrPart = stateMatch ? name.slice(0, stateMatch.index).trim() : name.trim();
    if (state === "LISTEN") {
      const portMatch = addrPart.match(/:(\d+)$/);
      if (portMatch) listening.push({ port: Number(portMatch[1]), address: addrPart });
    } else if (state && addrPart) {
      connections.push({ state, peer: addrPart });
    }
  }
  return { listening, connections };
}

async function getCwd(pid) {
  const { stdout } = await execLines("lsof", ["-p", String(pid)]);
  for (const line of stdout.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts[3] === "cwd") {
      return parts.slice(8).join(" ");
    }
  }
  return null;
}

async function getEnv(pid) {
  const { stdout } = await execLines("ps", ["eww", "-p", String(pid)]);
  // The 'eww' format prints env vars at end of the command line column.
  // We parse the second non-header line and pick `KEY=VALUE` tokens that look envvar-shaped.
  const lines = stdout.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return {};
  const tail = lines[1];
  const env = {};
  for (const tok of tail.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = REDACT_PATTERN.test(key) ? REDACTED : value;
  }
  return env;
}

// In-memory cache of entities; rebuilt every poll.
let entities = new Map(); // pid -> entity record
let knownPids = new Set();
const sseSubscribers = new Set();

// Latest system-vitals sample (CPU / memory / disks / network / garrison-*
// systemd units). Refreshed on a slow cadence off the poll loop; broadcast in
// the SSE snapshot and served at GET /api/vitals. Null until the first sample.
let latestVitals = null;
let vitalsSampling = false;

// Refresh latestVitals without ever throwing into the poll loop. Guards against
// overlapping samples (fsSize / networkStats can outlast one poll tick).
async function sampleVitals() {
  if (vitalsSampling) return;
  vitalsSampling = true;
  try {
    latestVitals = await collectVitals();
  } catch (err) {
    console.error("[monitor] vitals error:", err?.message ?? err);
  } finally {
    vitalsSampling = false;
  }
}

function metaForPid(pid) {
  const metaPath = path.join(LOGS_ROOT, String(pid), "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

// Read the Garrison session registry and build a map keyed on the claude
// session UUID. Each entry's value carries the soul, tier, branch, and
// worktree path — enough to badge a Monitor card with "engineer ·
// sonnet · feat/x". Re-read on every poll; the file is small.
function readGarrisonBindings() {
  if (!existsSync(SESSIONS_STATE_FILE)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(SESSIONS_STATE_FILE, "utf8"));
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const project of Object.values(raw?.projects ?? {})) {
    for (const session of Object.values(project?.sessions ?? {})) {
      const branch = session?.branch ?? null;
      const worktreePath = session?.worktreePath ?? null;
      const title = session?.title ?? null;
      for (const binding of session?.bindings ?? []) {
        if (!binding?.sessionId) continue;
        map.set(binding.sessionId, {
          soul: binding.soul ?? null,
          tier: binding.tier ?? null,
          tierFlags: binding.tierFlags ?? [],
          mode: binding.mode ?? null,
          branch,
          worktreePath,
          title,
          spawnedAt: binding.spawnedAt ?? null
        });
      }
    }
  }
  return map;
}

// Extract the `--session-id <uuid>` arg from a command line. Claude Code
// session subprocesses include it; the orchestrator binds its session UUID
// at boot. We use it to look up the Garrison binding metadata.
function extractSessionId(cmd) {
  if (!cmd) return null;
  const m = cmd.match(/--session-id[= ]([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function broadcastSnapshot() {
  if (sseSubscribers.size === 0) return;
  const payload = `data: ${JSON.stringify({ kind: "snapshot", entities: [...entities.values()], vitals: latestVitals })}\n\n`;
  for (const res of sseSubscribers) {
    try { res.write(payload); } catch {}
  }
}

async function poll(rootPid) {
  let table;
  try {
    table = await getProcessTable();
  } catch (err) {
    console.error("[monitor] ps failed:", err.message);
    return;
  }

  const descendants = walkDescendants(table, rootPid, process.pid);
  const bindings = readGarrisonBindings();
  const next = new Map();
  for (const proc of descendants) {
    const meta = metaForPid(proc.pid);
    const previous = entities.get(proc.pid);
    const tracked = previous ?? { ports: { listening: [], connections: [] }, cwd: null, env: {} };
    const sessionId = extractSessionId(proc.command);
    const garrison = sessionId ? bindings.get(sessionId) : null;
    const entry = {
      pid: proc.pid,
      ppid: proc.ppid,
      etime: proc.etime,
      pcpu: proc.pcpu,
      pmem: proc.pmem,
      stat: proc.stat,
      start: proc.start,
      command: meta?.command ?? proc.command.split(" ")[0],
      commandLine: meta?.args ? `${meta.command} ${meta.args.join(" ")}` : proc.command,
      cwd: tracked.cwd,
      env: tracked.env,
      ports: tracked.ports,
      tracked: Boolean(meta),
      spawnSite: meta?.spawnSite ?? null,
      description: meta?.description ?? null,
      spawnedAt: meta?.spawnedAt ?? null,
      hasLogs: existsSync(path.join(LOGS_ROOT, String(proc.pid))),
      status: proc.stat?.startsWith("Z") ? "exiting" : "alive",
      // Garrison-binding metadata (joined via the `--session-id` arg in the
      // claude command line). When present, the UI shows soul + tier + branch
      // badges so the user can tell sessions apart at a glance.
      garrisonSessionId: sessionId,
      soul: garrison?.soul ?? null,
      tier: garrison?.tier ?? null,
      branch: garrison?.branch ?? null,
      worktreePath: garrison?.worktreePath ?? null,
      title: garrison?.title ?? null,
      mode: garrison?.mode ?? null
    };
    next.set(proc.pid, entry);
  }

  // Refresh costly fields (cwd, env, ports) opportunistically — every 5 polls per PID.
  for (const [pid, entry] of next) {
    if (!knownPids.has(pid)) {
      // brand new; do a full read once
      const [ports, cwd, env] = await Promise.all([
        getPorts(pid).catch(() => ({ listening: [], connections: [] })),
        getCwd(pid).catch(() => null),
        getEnv(pid).catch(() => ({}))
      ]);
      entry.ports = ports;
      entry.cwd = cwd ?? entry.cwd;
      entry.env = env;
    } else if (Math.random() < 0.2) {
      // periodic refresh of ports for existing entries
      try {
        entry.ports = await getPorts(pid);
      } catch {}
    }
  }

  // Mark dead PIDs
  for (const pid of knownPids) {
    if (!next.has(pid)) {
      const prev = entities.get(pid);
      if (prev) {
        const dead = { ...prev, status: "dead", diedAt: prev.diedAt ?? new Date().toISOString() };
        // Keep dead entries around briefly so the UI can show them. The retention-hours sweeper will eventually purge.
        next.set(pid, dead);
      }
    }
  }

  entities = next;
  knownPids = new Set(next.keys());
  broadcastSnapshot();
}

async function cleanupOldLogs(retentionHours) {
  if (!existsSync(LOGS_ROOT)) return;
  let dirs;
  try {
    dirs = await readdir(LOGS_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionHours * 3600_000;
  for (const dir of dirs) {
    const pid = Number(dir);
    if (!Number.isFinite(pid)) continue;
    if (entities.get(pid)?.status === "alive") continue;
    const full = path.join(LOGS_ROOT, dir);
    try {
      const s = await stat(full);
      const mtime = s.mtimeMs;
      // Only delete dirs that are old AND whose PID is no longer alive.
      if (mtime < cutoff) {
        await rm(full, { recursive: true, force: true });
      }
    } catch {}
  }
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

function handleEntities(req, res) {
  jsonRes(res, 200, { entities: [...entities.values()] });
}

function handleVitals(req, res) {
  jsonRes(res, 200, latestVitals ?? { ts: null, cpu: null, mem: null, disks: [], net: null, units: [] });
}

function handleEntity(req, res, pid) {
  const e = entities.get(Number(pid));
  if (!e) {
    jsonRes(res, 404, { error: "not found", pid });
    return;
  }
  jsonRes(res, 200, e);
}

function handleEntityStream(req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ kind: "snapshot", entities: [...entities.values()], vitals: latestVitals })}\n\n`);
  sseSubscribers.add(res);
  req.on("close", () => sseSubscribers.delete(res));
}

function handleLogs(req, res, pid, query) {
  const logsDir = path.join(LOGS_ROOT, String(pid));
  if (!existsSync(logsDir)) {
    jsonRes(res, 404, { error: "no logs for pid", pid });
    return;
  }
  const streamName = query.stream === "stderr" ? "stderr" : query.stream === "combined" ? "combined" : "stdout";
  const tail = query.tail === "1" || query.tail === "true";

  res.statusCode = 200;
  if (tail) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  } else {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }

  const files = streamName === "combined" ? ["stdout.log", "stderr.log"] : [`${streamName}.log`];

  // Initial dump
  for (const f of files) {
    const fp = path.join(logsDir, f);
    if (!existsSync(fp)) continue;
    if (tail) {
      const data = readFileSync(fp, "utf8");
      const lines = data.split("\n").filter(Boolean).slice(-200);
      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ source: f, line })}\n\n`);
      }
    } else {
      res.write(readFileSync(fp));
    }
  }

  if (!tail) {
    res.end();
    return;
  }

  // SSE tail mode: watch files for changes
  const watchers = files.map((f) => {
    const fp = path.join(logsDir, f);
    if (!existsSync(fp)) return null;
    let offset = readFileSync(fp).length;
    const listener = () => {
      try {
        const s = readFileSync(fp);
        if (s.length > offset) {
          const chunk = s.slice(offset).toString("utf8");
          offset = s.length;
          for (const line of chunk.split("\n").filter(Boolean)) {
            res.write(`data: ${JSON.stringify({ source: f, line })}\n\n`);
          }
        }
      } catch {}
    };
    watchFile(fp, { interval: 500 }, listener);
    return { fp, listener };
  }).filter(Boolean);

  req.on("close", () => {
    for (const w of watchers) {
      unwatchFile(w.fp, w.listener);
    }
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
    // Try index.html for SPA-style routes
    const indexFallback = path.join(distDir, "index.html");
    if (existsSync(indexFallback)) {
      const data = readFileSync(indexFallback);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(data);
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
    fittingId: "monitor-default",
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

  const desiredPort = opts.port;
  let actualPort = desiredPort;
  const free = await findFreePort(desiredPort);
  if (free === null) {
    console.error(`[monitor] no free port found starting from ${desiredPort}`);
    process.exit(1);
  }
  actualPort = free;
  const liveOpts = { ...opts, port: actualPort };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/api/entities") return handleEntities(req, res);
      if (pathname === "/api/vitals") return handleVitals(req, res);
      if (pathname === "/api/entities/stream") return handleEntityStream(req, res);
      const entityMatch = pathname.match(/^\/api\/entities\/(\d+)$/);
      if (entityMatch) return handleEntity(req, res, entityMatch[1]);
      const logsMatch = pathname.match(/^\/api\/entities\/(\d+)\/logs$/);
      if (logsMatch) return handleLogs(req, res, logsMatch[1], parsed.query);
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[monitor] handler error:", err);
      jsonRes(res, 500, { error: err.message });
    }
  });

  server.listen(actualPort, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    console.log(`[monitor] listening on http://${liveOpts.host}:${actualPort} (parent=${liveOpts.parentPid})`);
  });

  // Sample vitals roughly every 5s, off the (default 1 Hz) poll cadence.
  const vitalsEveryTicks = Math.max(1, Math.round(5000 / liveOpts.pollMs));
  let tickCount = 0;
  const tick = () => {
    if (tickCount % vitalsEveryTicks === 0) sampleVitals();
    tickCount++;
    return poll(liveOpts.parentPid).catch((err) => console.error("[monitor] poll error:", err.message));
  };
  tick();
  const pollHandle = setInterval(tick, liveOpts.pollMs);

  const cleanupHandle = setInterval(() => {
    cleanupOldLogs(liveOpts.retentionHours).catch(() => {});
  }, 60 * 60 * 1000); // hourly

  const shutdown = async (signal) => {
    console.log(`[monitor] shutdown (${signal})`);
    clearInterval(pollHandle);
    clearInterval(cleanupHandle);
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
    console.error("[monitor] failed to start:", err);
    process.exit(1);
  });
}
