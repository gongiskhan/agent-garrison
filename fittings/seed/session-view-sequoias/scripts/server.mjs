#!/usr/bin/env node
// session-view-sequoias backend — read-only aggregator of Garrison session state.
//
// Reads ~/.garrison/sessions/state.json (and ~/.sequoias/state.json as fallback
// during the Sequoias retirement window). Exposes /sessions for the UI.
// No mutation endpoints. No outpost RPC in this initial port — outpost-aware
// aggregation can be added back later by consuming the outpost capability.

import { exec } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execP = promisify(exec);

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "session-view-sequoias.json");
const GARRISON_STATE_FILE = process.env.GARRISON_STATE_PATH && process.env.GARRISON_STATE_PATH.trim().length > 0
  ? process.env.GARRISON_STATE_PATH
  : path.join(HOME, ".garrison", "sessions", "state.json");
const SEQUOIAS_STATE_FILE = path.join(HOME, ".sequoias", "state.json");

const SESSION_STATUSES = new Set(["starting", "working", "waiting", "idle", "errored", "dead", "stale"]);
const STARTING_TIMEOUT_MS = 60_000; // a session stuck in "starting" past this is reported as "stale"
const WORKING_IDLE_FALLBACK_MS = 60_000; // working with no further hook for 60s → idle

// In-memory branch cache, keyed by cwd (used by auto-create-on-hook)
const branchCache = new Map(); // cwd -> { value, expiresAt }
const BRANCH_CACHE_TTL_MS = 30_000;

function statusFromHookEvent(event) {
  switch (event) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "Stop":
      return "idle";
    case "Notification":
      return "waiting";
    default:
      return null;
  }
}

async function gitRevParseAbbrevHead(cwd) {
  if (!cwd) return null;
  const cached = branchCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value = null;
  try {
    const { stdout } = await execP("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 1500 });
    value = stdout.trim() || null;
  } catch { value = null; }
  branchCache.set(cwd, { value, expiresAt: Date.now() + BRANCH_CACHE_TTL_MS });
  return value;
}

async function gitTopLevel(cwd) {
  try {
    const { stdout } = await execP("git rev-parse --show-toplevel", { cwd, timeout: 1500 });
    return stdout.trim() || null;
  } catch { return null; }
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.SESSION_VIEW_PORT || 7081),
    host: process.env.SESSION_VIEW_HOST || "127.0.0.1"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readStateFile(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.projects || typeof parsed.projects !== "object") return null;
  return parsed;
}

function projectsToSessions(state, machine) {
  const out = [];
  if (!state) return out;
  const now = Date.now();
  for (const [key, project] of Object.entries(state.projects ?? {})) {
    const projectPath = (project && project.path) || key;
    const projectName = (project && project.name) || path.basename(projectPath);
    // Skip sessions whose project directory no longer exists
    const projectExists = !projectPath.startsWith("/") || existsSync(projectPath);
    for (const [branchKey, session] of Object.entries(project?.sessions ?? {})) {
      const branch = (session && session.branch) || branchKey;
      const worktreePath = (session && session.worktreePath) || "";
      // Skip session if its worktree path is absolute and missing on disk
      const worktreeExists = worktreePath.startsWith("/") ? existsSync(worktreePath) : true;
      if (!projectExists || !worktreeExists) continue;
      let lastStatus = session?.lastStatus;
      if (!SESSION_STATUSES.has(lastStatus)) lastStatus = "idle";
      const lastStatusAt = session?.lastStatusAt || "";
      // Downgrade long-stuck "starting" to "stale"
      if (lastStatus === "starting" && lastStatusAt) {
        const t = Date.parse(lastStatusAt);
        if (!Number.isNaN(t) && now - t > STARTING_TIMEOUT_MS) {
          lastStatus = "stale";
        }
      }
      out.push({
        branch,
        worktreePath,
        lastStatus,
        lastStatusAt,
        lastHookEvent: session?.lastHookEvent,
        projectName,
        projectPath,
        machine,
        online: true,
        id: session?.id,
        claudeSessionId: session?.claudeSessionId ?? null,
        title: session?.title,
        urls: session?.urls,
        ports: session?.ports,
        bindings: session?.bindings ?? [],
        source: session?.source ?? "state"
      });
    }
  }
  return out;
}

async function readStateAtomic(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeStateAtomic(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, filePath);
}

// Mutate state.json: find session by branch in the named project; update status fields.
// If project or session does not exist, create them.
async function setSessionStatus(projectPath, branch, status, hookEvent, opts = {}) {
  const state = readStateFile(GARRISON_STATE_FILE) || { version: 1, projects: {} };
  let project = state.projects[projectPath];
  if (!project) {
    project = state.projects[projectPath] = {
      path: projectPath,
      name: opts.projectName || path.basename(projectPath),
      sessions: {}
    };
  } else if (opts.projectName && !project.name) {
    project.name = opts.projectName;
  }
  if (!project.sessions) project.sessions = {};
  let session = project.sessions[branch];
  const now = new Date().toISOString();
  if (!session) {
    session = project.sessions[branch] = {
      branch,
      worktreePath: opts.worktreePath || projectPath,
      ports: {},
      envFiles: [],
      createdAt: now,
      lastStatus: status,
      lastStatusAt: now,
      lastHookEvent: hookEvent || null,
      id: randomUUID(),
      claudeSessionId: opts.claudeSessionId || null,
      title: opts.title || null,
      baseBranch: opts.baseBranch || null,
      status: "active",
      urls: {},
      bindings: [],
      source: opts.source || "hook-autocreated"
    };
  } else {
    session.lastStatus = status;
    session.lastStatusAt = now;
    if (hookEvent !== undefined) session.lastHookEvent = hookEvent;
    if (opts.claudeSessionId) session.claudeSessionId = opts.claudeSessionId;
  }
  await writeStateAtomic(GARRISON_STATE_FILE, state);
  return { autoCreated: !project.sessions[branch] /* always false here */ , session };
}

// 60s fallback: any "working" session that hasn't fired a hook in 60s downgrades to idle.
async function runWorkingIdleFallback() {
  const state = readStateFile(GARRISON_STATE_FILE);
  if (!state || !state.projects) return;
  let changed = false;
  const now = Date.now();
  for (const project of Object.values(state.projects)) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (session?.lastStatus === "working" && session.lastStatusAt) {
        const t = Date.parse(session.lastStatusAt);
        if (!Number.isNaN(t) && now - t > WORKING_IDLE_FALLBACK_MS) {
          session.lastStatus = "idle";
          session.lastStatusAt = new Date().toISOString();
          session.lastHookEvent = "fallback";
          changed = true;
        }
      }
    }
  }
  if (changed) {
    try { await writeStateAtomic(GARRISON_STATE_FILE, state); }
    catch (err) { console.error(`[session-view] fallback write failed: ${err.message}`); }
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return null; }
}

async function handleHook(req, res, queryParams = {}) {
  const body = await readBody(req);
  // Two payload shapes are accepted:
  //   - Legacy (Garrison-only): { event, cwd }
  //   - New (Claude Code stdin forwarded by install-hooks.mjs):
  //     { session_id, transcript_path, hook_event_name, cwd, ... }
  //     with `?event=<name>` on the query string.
  const event = String(queryParams.event || body?.event || body?.hook_event_name || "");
  const cwd = String(body?.cwd || "");
  const claudeSessionId =
    (body && (body.session_id || body.sessionId)) ? String(body.session_id || body.sessionId) : null;
  if (!event || !cwd) {
    return jsonRes(res, 400, { error: "event and cwd required" });
  }
  const status = statusFromHookEvent(event);
  if (!status) {
    return jsonRes(res, 200, { ok: true, matched: false, reason: `untracked event: ${event}` });
  }
  const normalized = path.resolve(cwd);

  // Try to match an existing session by worktreePath (covers both worktree-created
  // sessions and previously hook-autocreated ones).
  const state = readStateFile(GARRISON_STATE_FILE) || { version: 1, projects: {} };
  let matchedProject = null;
  let matchedBranch = null;
  for (const [projectPath, project] of Object.entries(state.projects ?? {})) {
    for (const [branchKey, session] of Object.entries(project?.sessions ?? {})) {
      if (session?.worktreePath && path.resolve(session.worktreePath) === normalized) {
        matchedProject = projectPath;
        matchedBranch = session.branch || branchKey;
        break;
      }
    }
    if (matchedProject) break;
  }

  if (matchedProject) {
    await setSessionStatus(matchedProject, matchedBranch, status, event, { claudeSessionId });
    return jsonRes(res, 200, { ok: true, matched: true, autoCreated: false });
  }

  // Auto-create: key the project by the actual cwd so multiple Claude instances
  // in the same git repo at different subdirs get distinct rows. Display name
  // includes the relative subpath when cwd differs from the git root.
  const gitRoot = await gitTopLevel(normalized);
  const branch = (await gitRevParseAbbrevHead(normalized)) || "detached";
  let displayName = path.basename(normalized);
  if (gitRoot) {
    const rel = path.relative(gitRoot, normalized);
    displayName = rel ? `${path.basename(gitRoot)}/${rel}` : path.basename(gitRoot);
  }
  await setSessionStatus(normalized, branch, status, event, {
    worktreePath: normalized,
    projectName: displayName,
    source: "hook-autocreated",
    claudeSessionId
  });
  jsonRes(res, 200, { ok: true, matched: false, autoCreated: true });
}

async function handleCleanup(req, res) {
  const result = { garrison: { scanned: 0, removed: [] }, sequoias: { scanned: 0, removed: [] } };
  for (const [label, filePath] of [["garrison", GARRISON_STATE_FILE], ["sequoias", SEQUOIAS_STATE_FILE]]) {
    const state = await readStateAtomic(filePath);
    if (!state || !state.projects || typeof state.projects !== "object") continue;
    let changed = false;
    for (const [projectPath, project] of Object.entries(state.projects)) {
      const projectExists = !projectPath.startsWith("/") || existsSync(projectPath);
      if (!projectExists) {
        // Drop the entire project
        for (const [branch, session] of Object.entries(project?.sessions ?? {})) {
          result[label].scanned++;
          result[label].removed.push({ projectPath, branch, reason: "project-missing", id: session?.id ?? null });
        }
        delete state.projects[projectPath];
        changed = true;
        continue;
      }
      const sessions = project?.sessions ?? {};
      for (const [branch, session] of Object.entries(sessions)) {
        result[label].scanned++;
        const wt = session?.worktreePath || "";
        const wtExists = wt.startsWith("/") ? existsSync(wt) : true;
        if (!wtExists) {
          result[label].removed.push({ projectPath, branch, reason: "worktree-missing", id: session?.id ?? null });
          delete sessions[branch];
          changed = true;
        }
      }
    }
    if (changed) {
      try { await writeStateAtomic(filePath, state); }
      catch (err) { return jsonRes(res, 500, { error: `write ${label} failed: ${err.message}` }); }
    }
  }
  jsonRes(res, 200, { ok: true, ...result });
}

function aggregate() {
  const garrison = readStateFile(GARRISON_STATE_FILE);
  const sequoias = readStateFile(SEQUOIAS_STATE_FILE);
  const sessions = [];
  const seen = new Set();
  for (const s of projectsToSessions(garrison, "local")) {
    const key = `local::${s.projectPath}::${s.branch}::${s.id ?? "noid"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(s);
  }
  for (const s of projectsToSessions(sequoias, "local")) {
    const key = `local::${s.projectPath}::${s.branch}::${s.id ?? "noid"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(s);
  }
  return { sessions, outposts: [] };
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleTerminalTarget(req, res) {
  const filePath = path.join(STATUS_ROOT, "terminal-armory-default.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.url !== "string") {
      return jsonRes(res, 404, { error: "terminal status file invalid" });
    }
    jsonRes(res, 200, { url: parsed.url, port: parsed.port ?? null, pid: parsed.pid ?? null });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return jsonRes(res, 404, { error: "terminal fitting not running" });
    }
    jsonRes(res, 500, { error: err.message });
  }
}

function handleSessions(req, res) {
  try {
    const aggregated = aggregate();
    jsonRes(res, 200, aggregated);
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
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
  const ctMap = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml"
  };
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
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: "session-view-sequoias",
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
  try {
    await unlink(STATUS_FILE);
  } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");

  const free = await findFreePort(opts.port);
  if (free === null) {
    console.error(`[session-view] no free port found starting from ${opts.port}`);
    process.exit(1);
  }
  const liveOpts = { ...opts, port: free };

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/sessions" && method === "GET") return handleSessions(req, res);
      if (pathname === "/sessions/cleanup" && method === "POST") return await handleCleanup(req, res);
      if (pathname === "/terminal-target" && method === "GET") return await handleTerminalTarget(req, res);
      if (pathname === "/_hook" && method === "POST") return await handleHook(req, res, parsed.query);
      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[session-view] listening on http://${liveOpts.host}:${liveOpts.port}`);
      resolve();
    });
  });

  // working → idle fallback timer
  const fallbackTimer = setInterval(() => { void runWorkingIdleFallback(); }, 5000);
  fallbackTimer.unref?.();

  const shutdown = async (signal) => {
    console.log(`[session-view] shutdown (${signal})`);
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
    console.error("[session-view] failed to start:", err);
    process.exit(1);
  });
}
