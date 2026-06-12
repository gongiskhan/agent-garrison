#!/usr/bin/env node
// dev-env backend — the consolidated Dev Env Fitting (port 7086). One server
// folds the three retired dev-work Fittings into a single surface:
//   - PTY terminals (ptys.mjs, from terminal-armory-default)
//   - session state + Claude Code hook receiver (state.mjs, from
//     session-view-sequoias) — every Claude Code session becomes a tab
//   - git worktree CRUD (worktrees.mjs, from worktree-management-sequoias)
// Scaffolding (routing, WS upgrade, status file, static serving) follows the
// terminal donor.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import {
  ensurePty,
  getPty,
  isTmuxMode,
  killPty,
  killSessionPtys,
  listParked,
  listPtys,
  mirrorHandle,
  ptyIdFor,
  ptySummary,
  rehydratePtys,
  resizePty,
  setDefaultShell,
  setTmuxMode,
  shutdownPtys
} from "./ptys.mjs";
import { tmuxAvailable } from "./tmux.mjs";
import {
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
  enumerateCommandsCached
} from "@garrison/claude-pty";
import {
  aggregateSessions,
  applyHookEvent,
  cleanupState,
  getDirty,
  readStateFile,
  runWorkingIdleFallback,
  setDirtyCheckTtl
} from "./state.mjs";
import {
  createProjectSession,
  createWorktree,
  deleteSession,
  expandHome,
  findSessionById,
  isWorktreePath,
  listProjects,
  listWorktreesEnriched,
  readDevRoot,
  removeSessionRecord,
  setPaneClosed,
  writeDevRoot
} from "./worktrees.mjs";

const FITTING_ID = "dev-env";
const DEFAULT_PORT = 7086;

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);
const BROWSER_STATUS_FILE = path.join(STATUS_ROOT, "browser-default.json");

const EXTERNAL_STATUSES = new Set(["working", "waiting", "starting"]);

function parseArgs(argv) {
  const out = {
    port: Number(process.env.DEV_ENV_PORT || DEFAULT_PORT),
    host: process.env.DEV_ENV_HOST || "127.0.0.1",
    defaultShell: process.env.DEV_ENV_SHELL || process.env.SHELL || "/bin/zsh",
    dirtyTtlMs: Number(process.env.DEV_ENV_DIRTY_TTL_MS || 10_000),
    // PTY backing: auto (tmux if installed, else direct), on (require tmux),
    // off (direct node-pty). tmux keeps shells/claude alive across restarts.
    useTmux: String(process.env.DEV_ENV_USE_TMUX || "auto").toLowerCase()
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--shell") out.defaultShell = argv[++i];
    else if (a === "--use-tmux") out.useTmux = String(argv[++i] || "auto").toLowerCase();
  }
  return out;
}

// Resolve the requested PTY backing into a concrete on/off decision. `on`
// hard-fails when tmux is missing (the operator explicitly asked for
// persistence); `auto` silently falls back to direct spawning.
function resolveTmuxMode(useTmux) {
  if (useTmux === "off") return false;
  if (useTmux === "on") {
    if (!tmuxAvailable()) {
      console.error("[dev-env] use_tmux=on but tmux is not installed — refusing to start without it");
      process.exit(1);
    }
    return true;
  }
  return tmuxAvailable(); // auto
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CSRF guard for mutating routes. This server spawns
// `claude --dangerously-skip-permissions` in arbitrary directories, so a
// drive-by web page must not be able to POST to it. Browsers attach an
// Origin header to cross-site requests; our own UI is same-origin (Origin
// host === Host), and server-to-server consumers (gateway passthrough, curl)
// send no Origin at all. Anything else is rejected.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser caller (gateway passthrough, curl)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // includes "Origin: null" (sandboxed/opaque origins)
  }
}

// DevEnvSession assembly: one row per aggregate session, decorated with PTY
// summaries, git-dirty, and the external flag. Also the orphan sweep — PTYs
// (and parked claude envelopes) whose session row vanished (deleted cwd,
// cleared record) are killed + forgotten here.
function assembleSessions() {
  const rows = aggregateSessions();
  const live = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.id) continue; // legacy rows without an id cannot be addressed
    live.add(row.id);
    const claudePty = ptySummary(row.id, "claude");
    const shellPty = ptySummary(row.id, "shell");
    const external = claudePty.state !== "running" && EXTERNAL_STATUSES.has(row.lastStatus);
    out.push({
      id: row.id,
      branch: row.branch,
      worktreePath: row.worktreePath,
      projectName: row.projectName,
      projectPath: row.projectPath,
      lastStatus: row.lastStatus,
      lastStatusAt: row.lastStatusAt,
      claudeSessionId: row.claudeSessionId,
      title: row.title,
      source: row.source,
      dirty: getDirty(row.worktreePath),
      isWorktree: isWorktreePath(row.worktreePath),
      external,
      claudeClosed: Boolean(row.panesClosed?.claude),
      shellClosed: Boolean(row.panesClosed?.shell),
      claudePty,
      shellPty
    });
  }
  for (const rec of listPtys()) {
    if (!live.has(rec.sessionId)) killPty(rec.id, { forget: true });
  }
  for (const parkedId of listParked()) {
    const m = parkedId.match(/^(.+)-(claude|shell)$/);
    if (m && !live.has(m[1])) killPty(parkedId, { forget: true });
  }
  return out;
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, {
    ok: true,
    fittingId: FITTING_ID,
    port: opts.port,
    pid: process.pid,
    host: opts.host,
    tmux: isTmuxMode(),
    ptys: listPtys().length
  });
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

function handleListSessions(req, res) {
  try {
    jsonRes(res, 200, { sessions: assembleSessions() });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleEnsurePty(req, res, sessionId) {
  const body = (await readBody(req)) || {};
  const role = body.role === "claude" ? "claude" : body.role === "shell" ? "shell" : null;
  if (!role) return jsonRes(res, 400, { error: 'role must be "claude" or "shell"' });
  const found = findSessionById(sessionId);
  if (!found) return jsonRes(res, 404, { error: `session id not found: ${sessionId}` });
  try {
    ensurePty({
      session: { id: sessionId, worktreePath: found.worktreePath },
      role,
      resume: body.resume === true
    });
    // Starting a pane clears its closed marker for every connected client.
    await setPaneClosed(sessionId, role, false);
    jsonRes(res, 200, { ok: true, pty: ptySummary(sessionId, role) });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Send an instruction into the running Claude PTY. The two-phase write
// (text, pause, "\r") is deliberate: single-chunk text+"\r" can be swallowed
// as a multiline paste by the Ink TUI, and the pause lets /run's slash-menu
// resolve before Enter. Default pause is 600ms — 300ms was observed to lose
// the Enter against a live claude TUI.
async function handleInstruct(req, res, sessionId) {
  const body = (await readBody(req)) || {};
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return jsonRes(res, 400, { error: "text required" });
  const rec = getPty(ptyIdFor(sessionId, "claude"));
  if (!rec || rec.state !== "running" || rec.claudeAlive === false) {
    return jsonRes(res, 409, { error: "no running Claude PTY for this session" });
  }
  try {
    rec.pty.write(text);
    const delayMs = Number.isFinite(body.delayMs) ? Math.max(0, Math.min(5000, body.delayMs)) : 600;
    await sleep(delayMs);
    rec.pty.write("\r");
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleDeleteSession(req, res, sessionId) {
  try {
    const removed = await deleteSession(sessionId);
    killSessionPtys(sessionId, { forget: true });
    jsonRes(res, 200, { ok: true, id: sessionId, removed });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// POST /sessions — "Start session": record + both PTYs for an arbitrary
// project directory. Reuses an existing record for the same cwd; claude
// resumes (--continue) when the reused record already saw a claude session.
// EXCEPT when the reused record looks external (claude running elsewhere,
// hooks busy): silently double-attaching a second `claude --continue` is
// exactly what the UI's Take-over overlay exists to warn about, so only the
// shell spawns and the overlay handles the rest.
async function handleCreateSession(req, res) {
  const body = (await readBody(req)) || {};
  try {
    const { session, existed } = await createProjectSession({ path: body.path, title: body.title });
    const stub = { id: session.id, worktreePath: session.worktreePath };
    const externalNow =
      existed &&
      ptySummary(session.id, "claude").state !== "running" &&
      EXTERNAL_STATUSES.has(session.lastStatus);
    if (!externalNow) {
      ensurePty({ session: stub, role: "claude", resume: existed && Boolean(session.claudeSessionId) });
    }
    ensurePty({ session: stub, role: "shell" });
    await setPaneClosed(session.id, "shell", false);
    await setPaneClosed(session.id, "claude", false);
    const assembled = assembleSessions().find((s) => s.id === session.id) ?? null;
    jsonRes(res, existed ? 200 : 201, { id: session.id, existed, session: assembled });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// POST /sessions/:id/close — tab close: PTYs die, record goes, the
// directory and any git worktree stay.
async function handleCloseSession(req, res, sessionId) {
  try {
    killSessionPtys(sessionId, { forget: true });
    const removed = await removeSessionRecord(sessionId);
    jsonRes(res, 200, { ok: true, id: sessionId, removed });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

// DELETE /sessions/:id/ptys/:role — close a single pane's PTY. The closed
// marker is server-side state so other connected clients' lazy shell-spawn
// cannot resurrect a pane the user just closed.
async function handleKillPty(req, res, sessionId, role) {
  const existed = killPty(ptyIdFor(sessionId, role), { forget: true });
  await setPaneClosed(sessionId, role, true);
  jsonRes(res, 200, { ok: true, existed });
}

async function handleCleanup(req, res) {
  try {
    const result = await cleanupState();
    for (const row of result.removed) {
      if (row.id) killSessionPtys(row.id, { forget: true });
    }
    jsonRes(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleHook(req, res, queryParams = {}) {
  const body = await readBody(req);
  const event = String(queryParams.event || body?.event || body?.hook_event_name || "");
  const result = await applyHookEvent(event, body);
  if (result.ok === false) return jsonRes(res, 400, { error: result.error });
  jsonRes(res, 200, result);
}

// POST /worktrees — create + record + spawn BOTH PTYs before responding, so
// the new tab appears (with live panes) on the UI's next poll. The flat
// legacy fields stay top-level for gateway-passthrough compatibility; the
// assembled DevEnvSession rides along under `session`.
async function handleCreateWorktree(req, res) {
  const body = (await readBody(req)) || {};
  try {
    const created = await createWorktree(body);
    const sessionStub = { id: created.id, worktreePath: created.worktreePath };
    ensurePty({ session: sessionStub, role: "claude" });
    ensurePty({ session: sessionStub, role: "shell" });
    const session = assembleSessions().find((s) => s.id === created.id) ?? null;
    jsonRes(res, 201, { ...created, session });
  } catch (err) {
    jsonRes(res, err.status ?? 500, { error: err.message });
  }
}

async function handleListWorktrees(req, res, queryParams) {
  const repoPath = expandHome(queryParams.repoPath || "");
  if (!repoPath) return jsonRes(res, 400, { error: "repoPath required" });
  try {
    const worktrees = await listWorktreesEnriched(repoPath);
    jsonRes(res, 200, { worktrees, projectPath: repoPath });
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleListProjects(req, res, queryParams) {
  const devRoot = expandHome(queryParams.devRoot || (await readDevRoot()));
  try {
    jsonRes(res, 200, { devRoot, projects: listProjects(devRoot) });
  } catch (err) {
    jsonRes(res, 500, { error: `scan failed: ${err.message}` });
  }
}

async function handleGetDevRoot(req, res) {
  const root = await readDevRoot();
  jsonRes(res, 200, { devRoot: root, exists: existsSync(root) });
}

async function handlePatchDevRoot(req, res) {
  const body = await readBody(req);
  if (!body || typeof body.devRoot !== "string") {
    return jsonRes(res, 400, { error: "devRoot string required" });
  }
  const expanded = expandHome(body.devRoot);
  if (!expanded.startsWith("/")) {
    return jsonRes(res, 400, { error: "devRoot must be an absolute path" });
  }
  await writeDevRoot(expanded);
  jsonRes(res, 200, { devRoot: expanded, exists: existsSync(expanded) });
}

// ─────────────────────────── rich chat surface (/sessions/:id/claude/*)
// Backed by the claude PTY's headless mirror; same protocol as the gateway, so
// the shared @garrison/claude-chat component works against either.

function claudeRecFor(sessionId) {
  const rec = getPty(ptyIdFor(sessionId, "claude"));
  if (!rec || rec.state !== "running") return null;
  return rec;
}

function handleClaudeStream(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.flushHeaders?.();
    res.write(`event: error\ndata: ${JSON.stringify({ message: "no running claude PTY" })}\n\n`);
    return;
  }
  openRichStream(mirrorHandle(rec), res);
}

function handleClaudeStatus(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  jsonRes(res, 200, richStatus(mirrorHandle(rec)));
}

function handleClaudeCommands(req, res, sessionId) {
  const found = findSessionById(sessionId);
  const cwd = found?.worktreePath;
  jsonRes(res, 200, { commands: enumerateCommandsCached(cwd ? { cwd } : {}) });
}

async function handleClaudeMessage(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const text = typeof body.text === "string" ? body.text : typeof body.message === "string" ? body.message : "";
  if (!text.trim()) return jsonRes(res, 400, { error: "text required" });
  try {
    rec.pty.write(text);
    const delayMs = Number.isFinite(body.delayMs) ? Math.max(0, Math.min(5000, body.delayMs)) : 600;
    await sleep(delayMs);
    rec.pty.write("\r");
    jsonRes(res, 202, { ack: true });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleClaudeKeys(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const seq = keySequence(String(body.key ?? ""));
  if (!seq) return jsonRes(res, 400, { error: "unknown key" });
  try { rec.pty.write(seq); } catch {}
  jsonRes(res, 200, { ok: true });
}

async function handleClaudeMode(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  const body = (await readBody(req)) || {};
  const result = await cycleMode(mirrorHandle(rec), String(body.mode ?? ""), (b) => {
    try { rec.pty.write(b); } catch {}
  });
  jsonRes(res, 200, result);
}

function handleClaudeInterrupt(req, res, sessionId) {
  const rec = claudeRecFor(sessionId);
  if (!rec) return jsonRes(res, 409, { error: "no running claude PTY" });
  try { rec.pty.write("\x1b"); } catch {}
  jsonRes(res, 200, { ok: true });
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
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

function rawSessionIds() {
  const ids = new Set();
  const state = readStateFile();
  if (!state) return ids;
  for (const project of Object.values(state.projects ?? {})) {
    for (const session of Object.values(project?.sessions ?? {})) {
      if (session?.id) ids.add(session.id);
    }
  }
  return ids;
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");
  setDefaultShell(opts.defaultShell);
  setDirtyCheckTtl(opts.dirtyTtlMs);
  const tmuxOn = resolveTmuxMode(opts.useTmux);
  setTmuxMode(tmuxOn);
  console.log(`[dev-env] PTY backing: ${tmuxOn ? "tmux (sessions survive restarts)" : "node-pty (direct)"}`);
  const free = await findFreePort(opts.port);
  if (free === null) { console.error(`[dev-env] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };
  if (free !== DEFAULT_PORT) {
    // The installed Claude Code hooks curl the port baked at install time
    // (inherited limitation of the hook contract).
    console.warn(`[dev-env] live port ${free} differs from default ${DEFAULT_PORT} — installed hooks still POST to the baked port`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // CORS for cross-fitting calls (gateway passthrough, browser fitting)
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      // Mutations require same-origin (or no Origin, i.e. non-browser).
      if (method !== "GET" && !originAllowed(req)) {
        return jsonRes(res, 403, { error: "cross-origin mutation rejected" });
      }

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/sessions" && method === "GET") return handleListSessions(req, res);
      if (pathname === "/sessions" && method === "POST") return await handleCreateSession(req, res);
      if (pathname === "/sessions/cleanup" && method === "POST") return await handleCleanup(req, res);
      if (pathname === "/_hook" && method === "POST") return await handleHook(req, res, parsed.query);
      if (pathname === "/projects" && method === "GET") return await handleListProjects(req, res, parsed.query);
      if (pathname === "/dev-root" && method === "GET") return await handleGetDevRoot(req, res);
      if (pathname === "/dev-root" && method === "PATCH") return await handlePatchDevRoot(req, res);
      if (pathname === "/tailscale-ip" && method === "GET") return handleTailscaleIp(req, res);
      if (pathname === "/app-port" && method === "GET") return await handleAppPort(req, res, parsed.query);
      if (pathname === "/browser-target" && method === "GET") return await handleBrowserTarget(req, res);
      if (pathname === "/worktrees" && method === "GET") return await handleListWorktrees(req, res, parsed.query);
      if (pathname === "/worktrees" && method === "POST") return await handleCreateWorktree(req, res);

      const wtDelMatch = pathname.match(/^\/worktrees\/([^/]+)$/);
      if (wtDelMatch && method === "DELETE") return await handleDeleteSession(req, res, decodeURIComponent(wtDelMatch[1]));

      const ptyKillMatch = pathname.match(/^\/sessions\/([^/]+)\/ptys\/(claude|shell)$/);
      if (ptyKillMatch && method === "DELETE") {
        return await handleKillPty(req, res, decodeURIComponent(ptyKillMatch[1]), ptyKillMatch[2]);
      }

      const ptysMatch = pathname.match(/^\/sessions\/([^/]+)\/ptys$/);
      if (ptysMatch && method === "POST") return await handleEnsurePty(req, res, decodeURIComponent(ptysMatch[1]));

      const closeMatch = pathname.match(/^\/sessions\/([^/]+)\/close$/);
      if (closeMatch && method === "POST") return await handleCloseSession(req, res, decodeURIComponent(closeMatch[1]));

      const instructMatch = pathname.match(/^\/sessions\/([^/]+)\/instruct$/);
      if (instructMatch && method === "POST") return await handleInstruct(req, res, decodeURIComponent(instructMatch[1]));

      // Rich chat surface over the claude PTY mirror.
      const claudeMatch = pathname.match(/^\/sessions\/([^/]+)\/claude\/([a-z]+)$/);
      if (claudeMatch) {
        const sid = decodeURIComponent(claudeMatch[1]);
        const action = claudeMatch[2];
        if (action === "stream" && method === "GET") return handleClaudeStream(req, res, sid);
        if (action === "status" && method === "GET") return handleClaudeStatus(req, res, sid);
        if (action === "commands" && method === "GET") return handleClaudeCommands(req, res, sid);
        if (action === "message" && method === "POST") return await handleClaudeMessage(req, res, sid);
        if (action === "keys" && method === "POST") return await handleClaudeKeys(req, res, sid);
        if (action === "mode" && method === "POST") return await handleClaudeMode(req, res, sid);
        if (action === "interrupt" && method === "POST") return handleClaudeInterrupt(req, res, sid);
      }

      const sessDelMatch = pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessDelMatch && method === "DELETE") return await handleDeleteSession(req, res, decodeURIComponent(sessDelMatch[1]));

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // WebSocket: /io — init.sessionId names a PTY id (<sessionId>-<role>).
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
    let ptyId = null;
    ws.on("message", (data, isBinary) => {
      if (!ptyId) {
        // expect init frame as JSON
        let msg;
        try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
        if (msg.type === "init" && typeof msg.sessionId === "string") {
          const rec = getPty(msg.sessionId);
          if (!rec) {
            try { ws.send(JSON.stringify({ type: "error", message: "session not found" })); } catch {}
            ws.close();
            return;
          }
          rec.ws = ws;
          ptyId = rec.id;
          try {
            // `tmux: true` tells the client to stop converting wheel→arrows
            // (the outer xterm is permanently in the alternate screen under
            // tmux); tmux's own mouse mode scrolls the pane history instead.
            ws.send(JSON.stringify({ type: "init_ack", id: rec.id, cwd: rec.cwd, shell: rec.shell, tmux: isTmuxMode() }));
            if (rec.buffer.length > 0) ws.send(rec.buffer);
          } catch {}
        }
        return;
      }

      const rec = getPty(ptyId);
      if (!rec || rec.state !== "running") return;

      if (isBinary) {
        // stdin bytes (binary frame)
        try { rec.pty.write(data.toString("utf8")); rec.lastActivity = Date.now(); } catch {}
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
          resizePty(rec, frame.cols, frame.rows);
        } else if (frame.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); } catch {}
        } else if (frame.type === "stdin" && typeof frame.data === "string") {
          try { rec.pty.write(frame.data); rec.lastActivity = Date.now(); } catch {}
        }
        return;
      }
      // Raw text stdin
      try { rec.pty.write(text); rec.lastActivity = Date.now(); } catch {}
    });

    ws.on("close", () => {
      if (!ptyId) return;
      const rec = getPty(ptyId);
      if (!rec || rec.ws !== ws) return;
      // PTYs are persistent: just detach. No reap timer — the PTY lives
      // until session delete/cleanup or server shutdown.
      rec.ws = null;
    });
  });

  // Eagerly restore persisted PTYs before accepting traffic so the first
  // /sessions response already carries replayed shells + parked claudes.
  const restored = await rehydratePtys(rawSessionIds());
  if (restored > 0) console.log(`[dev-env] restored ${restored} persisted PTY(s)`);

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[dev-env] listening on http://${liveOpts.host}:${liveOpts.port}`);
      resolve();
    });
  });

  // working → idle fallback timer
  const fallbackTimer = setInterval(() => { void runWorkingIdleFallback(); }, 5000);
  fallbackTimer.unref?.();

  const shutdown = async (signal) => {
    console.log(`[dev-env] shutdown (${signal})`);
    // Land pending view-state writes while the ptys (and their buffers) are
    // still alive — this is what makes sessions survive the restart.
    await shutdownPtys();
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
  startServer().catch((err) => { console.error("[dev-env] failed:", err); process.exit(1); });
}
