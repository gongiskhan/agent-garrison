#!/usr/bin/env node
// session-view-sequoias backend — read-only aggregator of Garrison session state.
//
// Reads ~/.garrison/sessions/state.json (and ~/.sequoias/state.json as fallback
// during the Sequoias retirement window). Exposes /sessions for the UI.
// No mutation endpoints. No outpost RPC in this initial port — outpost-aware
// aggregation can be added back later by consuming the outpost capability.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "session-view-sequoias.json");
const GARRISON_STATE_FILE = process.env.GARRISON_STATE_PATH && process.env.GARRISON_STATE_PATH.trim().length > 0
  ? process.env.GARRISON_STATE_PATH
  : path.join(HOME, ".garrison", "sessions", "state.json");
const SEQUOIAS_STATE_FILE = path.join(HOME, ".sequoias", "state.json");

const SESSION_STATUSES = new Set(["starting", "working", "waiting", "idle", "errored", "dead"]);

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
  for (const [key, project] of Object.entries(state.projects ?? {})) {
    const projectPath = (project && project.path) || key;
    const projectName = (project && project.name) || path.basename(projectPath);
    for (const [branchKey, session] of Object.entries(project?.sessions ?? {})) {
      const branch = (session && session.branch) || branchKey;
      const worktreePath = (session && session.worktreePath) || "";
      let lastStatus = session?.lastStatus;
      if (!SESSION_STATUSES.has(lastStatus)) lastStatus = "idle";
      const lastStatusAt = session?.lastStatusAt || "";
      out.push({
        branch,
        worktreePath,
        lastStatus,
        lastStatusAt,
        projectName,
        projectPath,
        machine,
        online: true,
        id: session?.id,
        title: session?.title,
        urls: session?.urls,
        ports: session?.ports,
        bindings: session?.bindings ?? []
      });
    }
  }
  return out;
}

function aggregate() {
  const garrison = readStateFile(GARRISON_STATE_FILE);
  const sequoias = readStateFile(SEQUOIAS_STATE_FILE);
  const sessions = [];
  const seen = new Set();
  for (const s of projectsToSessions(garrison, "local")) {
    const key = `local::${s.projectPath}::${s.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(s);
  }
  for (const s of projectsToSessions(sequoias, "local")) {
    const key = `local::${s.projectPath}::${s.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(s);
  }
  return { sessions, outposts: [] };
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
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

  const server = http.createServer((req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/sessions") return handleSessions(req, res);
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
