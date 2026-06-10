#!/usr/bin/env node
// terminal-armory-default backend. Local-PTY-only port adapted from
// scripts/trenches-ws.mjs (the Garrison-shell legacy will be deleted in
// Phase 4). Single user, no tmux. Outpost variant (over outpost-host
// broker) is deferred and will be added back via the consumed outpost
// capability.

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import {
  deleteInstance,
  flushInstanceWrites,
  readAllInstances,
  scheduleInstanceWrite
} from "./view-state.mjs";

const DEFAULT_IDE_PATH = "/Applications/Rebased.app";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "terminal-armory-default.json");
const BROWSER_STATUS_FILE = path.join(STATUS_ROOT, "browser-default.json");
const DEV_ROOT_FILE = path.join(HOME, ".garrison", "dev-root");

const sessions = new Map(); // id -> { id, name, cwd, shell, pty, ws, lastActivity, createdAt, buffer }
// Big enough to replay a full alt-screen redraw (Claude Code, vim, less etc.)
// on genuine reconnect. The UI keeps panes mounted on tab switch so this is
// only hit on browser refresh / network blip.
const OUTPUT_BUFFER_BYTES = 512 * 1024;
const PTY_DETACHED_TIMEOUT_MS = 5 * 60 * 1000;

// View-state persistence (Garrison Layer 2). Each session continuously
// persists { name, cwd, shell, command, scrollback } keyed by its session id
// (= the Garrison instance id). On boot the server rehydrates every persisted
// session: a FRESH shell respawns at the restored cwd and the old scrollback
// replays — the PTY itself does not survive a restart (D1; true process
// survival is herdr's job). The persisted scrollback is a tail of the replay
// buffer, base64-coded because raw PTY bytes are not valid JSON text.
const FITTING_ID = "terminal-armory-default";
const PERSIST_SCROLLBACK_BYTES = 128 * 1024;
let shuttingDown = false;

// Live cwd of the shell (the user cds around) — best-effort via lsof, falling
// back to the spawn cwd. Runs only at debounced-persist time, never per-write.
function probeCwd(session) {
  return new Promise((resolve) => {
    const pid = session.pty?.pid;
    if (typeof pid !== "number") return resolve(null);
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : null);
    });
  });
}

function persistSession(session) {
  if (shuttingDown) return;
  scheduleInstanceWrite(FITTING_ID, session.id, async () => ({
    name: session.name,
    cwd: (await probeCwd(session)) || session.cwd,
    shell: session.shell,
    command: session.command || null,
    createdAt: session.createdAt,
    scrollbackB64: session.buffer.slice(-PERSIST_SCROLLBACK_BYTES).toString("base64")
  }));
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.TERMINAL_PORT || 7078),
    host: process.env.TERMINAL_HOST || "127.0.0.1",
    defaultShell: process.env.TERMINAL_SHELL || process.env.SHELL || "/bin/zsh"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--shell") out.defaultShell = argv[++i];
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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function sessionSummary(s) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    shell: s.shell,
    command: s.command || null,
    busy: Date.now() - s.lastActivity < 2000,
    createdAt: s.createdAt
  };
}

function createSession({ id: explicitId, name, cwd, shell, command }) {
  const id = explicitId || randomUUID();
  const finalShell = shell || process.env.SHELL || "/bin/zsh";
  const finalCwd = cwd && existsSync(cwd) ? cwd : process.env.HOME || "/tmp";
  const term = pty.spawn(finalShell, ["-l"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: finalCwd,
    env: { ...process.env, TERM: "xterm-256color" }
  });

  const session = {
    id,
    name: name || `terminal-${sessions.size + 1}`,
    cwd: finalCwd,
    shell: finalShell,
    command: command && typeof command === "string" ? command : null,
    pty: term,
    ws: null,
    lastActivity: Date.now(),
    createdAt: new Date().toISOString(),
    buffer: Buffer.alloc(0),
    detachTimeout: null
  };

  term.onData((data) => {
    session.lastActivity = Date.now();
    const buf = Buffer.from(data, "utf8");
    // Maintain a rolling output buffer for reconnection replay
    session.buffer = Buffer.concat([session.buffer, buf]).slice(-OUTPUT_BUFFER_BYTES);
    if (session.ws && session.ws.readyState === 1) {
      try { session.ws.send(buf); } catch {}
    }
    persistSession(session);
  });

  term.onExit(({ exitCode, signal }) => {
    if (session.ws && session.ws.readyState === 1) {
      try { session.ws.send(JSON.stringify({ type: "exit", exitCode, signal })); } catch {}
      try { session.ws.close(); } catch {}
    }
    sessions.delete(id);
    // A shell that ended on its own (user typed exit) or was explicitly
    // killed has nothing to restore. Shutdown and detach-reap preserve state
    // — surviving restarts is the whole point.
    if (!shuttingDown && !session.preserveState) {
      void deleteInstance(FITTING_ID, id).catch(() => {});
    }
  });

  sessions.set(id, session);
  persistSession(session);

  if (command && typeof command === "string" && command.trim()) {
    setTimeout(() => {
      try { term.write(command + "\r"); } catch {}
    }, 250);
  }

  return session;
}

function killSession(id, { preserveState = false } = {}) {
  const s = sessions.get(id);
  if (!s) return false;
  s.preserveState = preserveState;
  try { s.pty.kill(); } catch {}
  if (s.ws && s.ws.readyState === 1) { try { s.ws.close(); } catch {} }
  sessions.delete(id);
  return true;
}

// Boot-time rehydration: every persisted instance comes back as a fresh shell
// at its restored cwd with the old scrollback replayed (a dim marker separates
// past from present). The recorded `command` is kept for labeling but NOT
// re-run — auto-rerunning arbitrary commands on boot would be destructive.
async function rehydrateSessions() {
  let envelopes = [];
  try {
    envelopes = await readAllInstances(FITTING_ID);
  } catch (err) {
    console.error("[terminal] view-state rehydrate scan failed:", err);
    return 0;
  }
  for (const envelope of envelopes) {
    const st = envelope.state && typeof envelope.state === "object" ? envelope.state : {};
    try {
      const session = createSession({
        id: envelope.instanceId,
        name: typeof st.name === "string" ? st.name : undefined,
        cwd: typeof st.cwd === "string" ? st.cwd : undefined,
        shell: typeof st.shell === "string" ? st.shell : undefined
      });
      session.command = typeof st.command === "string" ? st.command : null;
      if (typeof st.scrollbackB64 === "string" && st.scrollbackB64) {
        const restored = Buffer.from(st.scrollbackB64, "base64");
        const marker = Buffer.from(
          `\r\n\x1b[2m[garrison: session restored — fresh shell at ${session.cwd}]\x1b[0m\r\n`,
          "utf8"
        );
        session.buffer = Buffer.concat([restored, marker]).slice(-OUTPUT_BUFFER_BYTES);
      }
      console.log(`[terminal] rehydrated session ${session.id} (${session.name}) at ${session.cwd}`);
    } catch (err) {
      console.error(`[terminal] rehydrate failed for ${envelope.instanceId}:`, err);
    }
  }
  return envelopes.length;
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host, sessions: sessions.size });
}

function getTailscaleIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      // Tailscale uses 100.64.0.0/10 (CGNAT range).
      const m = iface.address.match(/^100\.(\d+)\./);
      if (!m) continue;
      const n = Number(m[1]);
      if (n >= 64 && n <= 127) return iface.address;
    }
  }
  return null;
}

function handleTailscaleIp(req, res) {
  const ip = getTailscaleIp();
  if (!ip) return jsonRes(res, 404, { error: "no tailscale interface found" });
  jsonRes(res, 200, { ip });
}

async function handleOpenInIde(req, res) {
  const body = (await readBody(req)) || {};
  const projectPath = typeof body.path === "string" ? expandHome(body.path).trim() : "";
  if (!projectPath) return jsonRes(res, 400, { error: "path required" });
  if (!existsSync(projectPath)) return jsonRes(res, 404, { error: `path does not exist: ${projectPath}` });
  const idePath = process.env.GARRISON_IDE_PATH || DEFAULT_IDE_PATH;
  if (!existsSync(idePath)) return jsonRes(res, 500, { error: `IDE not found at ${idePath}` });
  const isAppBundle = idePath.endsWith(".app");
  const cmd = isAppBundle ? "open" : idePath;
  const args = isAppBundle ? ["-a", idePath, projectPath] : [projectPath];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    jsonRes(res, 200, { ok: true, pid: child.pid ?? null, ide: idePath, path: projectPath, via: cmd });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleBrowserTarget(_req, res) {
  try {
    const raw = await readFile(BROWSER_STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.url !== "string") {
      return jsonRes(res, 404, { error: "browser status file invalid" });
    }
    jsonRes(res, 200, {
      url: parsed.url,
      port: parsed.port ?? null,
      pid: parsed.pid ?? null,
      cdpWsEndpoint: parsed.cdpWsEndpoint ?? null
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return jsonRes(res, 404, { error: "browser fitting not running" });
    }
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleAppPort(req, res, queryParams) {
  const cwd = expandHome(queryParams.cwd || "");
  if (!cwd) return jsonRes(res, 400, { error: "cwd required" });
  try {
    const raw = await readFile(path.join(cwd, "app.port"), "utf8");
    const port = Number(raw.trim());
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return jsonRes(res, 404, { error: "invalid app.port file" });
    }
    jsonRes(res, 200, { port });
  } catch (err) {
    if (err && err.code === "ENOENT") return jsonRes(res, 404, { error: "app.port not found" });
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(HOME, p.slice(1).replace(/^\/+/, ""));
  return p;
}

async function readDevRoot() {
  try {
    const raw = await readFile(DEV_ROOT_FILE, "utf8");
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch {}
  return path.join(HOME, "dev");
}

async function handleListProjects(req, res, queryParams) {
  const devRoot = expandHome(queryParams.devRoot || (await readDevRoot()));
  if (!existsSync(devRoot)) return jsonRes(res, 200, { devRoot, projects: [] });
  const projects = [];
  let entries = [];
  try {
    entries = readdirSync(devRoot, { withFileTypes: true });
  } catch (err) {
    return jsonRes(res, 500, { error: `scan failed: ${err.message}` });
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const projectPath = path.join(devRoot, entry.name);
    try {
      const st = statSync(projectPath);
      if (!st.isDirectory()) continue;
    } catch { continue; }
    if (!existsSync(path.join(projectPath, ".git"))) continue;
    projects.push({ name: entry.name, path: projectPath });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  jsonRes(res, 200, { devRoot, projects });
}

function handleListSessions(req, res) {
  jsonRes(res, 200, { sessions: [...sessions.values()].map(sessionSummary) });
}

async function handleCreateSession(req, res) {
  const body = (await readBody(req)) || {};
  try {
    const s = createSession({ name: body.name, cwd: body.cwd, shell: body.shell, command: body.command });
    jsonRes(res, 201, sessionSummary(s));
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function handleDeleteSession(req, res, id) {
  const ok = killSession(id);
  jsonRes(res, ok ? 200 : 404, { ok });
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
    fittingId: "terminal-armory-default",
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
  if (free === null) { console.error(`[terminal] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };

  const server = http.createServer(async (req, res) => {
    try {
      // CORS for cross-fitting POSTs (worktree-management, session-view)
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/projects" && method === "GET") return handleListProjects(req, res, parsed.query);
      if (pathname === "/sessions" && method === "GET") return handleListSessions(req, res);
      if (pathname === "/terminals" && method === "POST") return handleCreateSession(req, res);
      if (pathname === "/tailscale-ip" && method === "GET") return handleTailscaleIp(req, res);
      if (pathname === "/app-port" && method === "GET") return handleAppPort(req, res, parsed.query);
      if (pathname === "/browser-target" && method === "GET") return handleBrowserTarget(req, res);
      if (pathname === "/open-in-ide" && method === "POST") return handleOpenInIde(req, res);

      const delMatch = pathname.match(/^\/terminals\/([^/]+)$/);
      if (delMatch && method === "DELETE") return handleDeleteSession(req, res, decodeURIComponent(delMatch[1]));

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // WebSocket: /io
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = url.parse(request.url || "/");
    if (pathname !== "/io") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    let sessionId = null;
    ws.on("message", (data, isBinary) => {
      if (!sessionId) {
        // expect init frame as JSON
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        if (msg.type === "init" && typeof msg.sessionId === "string") {
          const s = sessions.get(msg.sessionId);
          if (!s) {
            try { ws.send(JSON.stringify({ type: "error", message: "session not found" })); } catch {}
            ws.close();
            return;
          }
          // attach
          if (s.detachTimeout) { clearTimeout(s.detachTimeout); s.detachTimeout = null; }
          s.ws = ws;
          sessionId = s.id;
          try {
            ws.send(JSON.stringify({ type: "init_ack", id: s.id, cwd: s.cwd, shell: s.shell }));
            if (s.buffer.length > 0) ws.send(s.buffer);
          } catch {}
        }
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) return;

      if (isBinary) {
        // stdin bytes (binary frame)
        try { session.pty.write(data.toString("utf8")); session.lastActivity = Date.now(); } catch {}
        return;
      }

      // Text frame: either a JSON control frame or raw stdin
      const text = data.toString("utf8");
      let frame = null;
      if (text.startsWith("{")) {
        try { frame = JSON.parse(text); } catch {}
      }
      if (frame && typeof frame === "object" && typeof frame.type === "string") {
        if (frame.type === "resize" && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
          try { session.pty.resize(frame.cols, frame.rows); } catch {}
        } else if (frame.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch {}
        } else if (frame.type === "stdin" && typeof frame.data === "string") {
          try { session.pty.write(frame.data); session.lastActivity = Date.now(); } catch {}
        }
        return;
      }
      // Raw text stdin
      try { session.pty.write(text); session.lastActivity = Date.now(); } catch {}
    });

    ws.on("close", () => {
      if (!sessionId) return;
      const s = sessions.get(sessionId);
      if (!s) return;
      s.ws = null;
      // Detach but keep alive for reconnect window. Reaping preserves the
      // persisted state — the session returns on the next server boot.
      s.detachTimeout = setTimeout(() => {
        if (sessions.has(s.id)) killSession(s.id, { preserveState: true });
      }, PTY_DETACHED_TIMEOUT_MS);
    });
  });

  // Eagerly restore persisted sessions before accepting traffic so the first
  // /sessions response is already complete.
  const restored = await rehydrateSessions();
  if (restored > 0) console.log(`[terminal] restored ${restored} persisted session(s)`);

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[terminal] listening on http://${liveOpts.host}:${liveOpts.port}`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[terminal] shutdown (${signal})`);
    shuttingDown = true;
    // Land pending view-state writes while the ptys (and their buffers) are
    // still alive — this is what makes sessions survive the restart.
    try { await flushInstanceWrites(); } catch {}
    for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
    sessions.clear();
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
  startServer().catch((err) => { console.error("[terminal] failed:", err); process.exit(1); });
}
