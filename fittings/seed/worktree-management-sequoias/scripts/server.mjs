#!/usr/bin/env node
// worktree-management-sequoias backend. Slim port: git worktree CRUD + state.json
// upsert so session-view sees new worktrees automatically.
//
// Out of scope for the initial Fitting port (handled previously by the
// Garrison-shell Next.js routes; will be re-added in a follow-up):
//   - port-pool allocation
//   - env file rewriting
//   - package.json patching
//   - outpost-target variants
//
// PR creation lives here as of 2026-05-20: POST /worktrees/:id/pr pushes the
// branch and runs `gh pr create`. Requires the `gh` CLI authenticated for the
// repo's host.
//
// What is preserved:
//   - State.json schema (projects[path].sessions[branch] = { id, branch, ... })
//   - Worktree directory layout ~/.worktrees/<repo>/<branch-slug>
//   - id is a UUID assigned on creation; cleared on removal

import { exec, spawn } from "node:child_process";

const DEFAULT_IDE_PATH = "/Applications/Rebased.app";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { promisify } from "node:util";

const execP = promisify(exec);
const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "worktree-management-sequoias.json");
const TERMINAL_STATUS_FILE = path.join(STATUS_ROOT, "terminal-armory-default.json");
const DEV_ROOT_FILE = path.join(HOME, ".garrison", "dev-root");
const STATE_FILE = process.env.GARRISON_STATE_PATH && process.env.GARRISON_STATE_PATH.trim().length > 0
  ? process.env.GARRISON_STATE_PATH
  : path.join(HOME, ".garrison", "sessions", "state.json");
const WORKTREES_ROOT = path.join(HOME, ".worktrees");

function parseArgs(argv) {
  const out = {
    port: Number(process.env.WORKTREES_PORT || 7080),
    host: process.env.WORKTREES_HOST || "127.0.0.1",
    repoPath: process.env.WORKTREES_REPO_PATH || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--repo-path") out.repoPath = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(HOME, p.slice(1).replace(/^\/+/, ""));
  return p;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return null; }
}

function slugifyBranch(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 80);
}

function branchToDirName(branch) {
  // feat/foo-bar → feat-foo-bar
  return slugifyBranch(branch).replace(/\//g, "-");
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, projects: {} };
    if (!parsed.projects || typeof parsed.projects !== "object") parsed.projects = {};
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") return { version: 1, projects: {} };
    return { version: 1, projects: {} };
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

function ensureProject(state, projectPath) {
  if (!state.projects[projectPath]) {
    state.projects[projectPath] = {
      path: projectPath,
      name: path.basename(projectPath),
      sessions: {}
    };
  }
  return state.projects[projectPath];
}

async function gitWorktreeList(repoPath) {
  // git worktree list --porcelain → blocks of "worktree <path>" / "HEAD <sha>" / "branch <refname>"
  try {
    const { stdout } = await execP("git worktree list --porcelain", { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 });
    const blocks = stdout.split("\n\n");
    const items = [];
    for (const block of blocks) {
      if (!block.trim()) continue;
      const item = { path: "", branch: "", commit: "", isMain: false };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) item.path = line.slice("worktree ".length).trim();
        else if (line.startsWith("HEAD ")) item.commit = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch ")) item.branch = line.slice("branch refs/heads/".length).trim();
        else if (line.startsWith("bare")) item.isBare = true;
      }
      if (item.path) {
        const norm = path.resolve(repoPath);
        item.isMain = path.resolve(item.path) === norm;
        items.push(item);
      }
    }
    return items;
  } catch (err) {
    throw new Error(`git worktree list failed: ${err.message}`);
  }
}

async function handleListWorktrees(req, res, queryParams) {
  const repoPath = expandHome(queryParams.repoPath || "");
  if (!repoPath) return jsonRes(res, 400, { error: "repoPath required" });
  try {
    const items = await gitWorktreeList(repoPath);
    const state = await readState();
    // Upsert a session record for every non-main worktree git knows about
    // but state.json doesn't. Worktrees created outside Garrison (by Sequoias,
    // direct `git worktree add`, etc.) start out without an id; backfill one
    // so Remove / Create PR can address them.
    let stateDirty = false;
    for (const it of items) {
      if (it.isMain || !it.branch) continue;
      const project = ensureProject(state, repoPath);
      const existing = project.sessions[it.branch];
      if (existing && existing.id) continue;
      project.sessions[it.branch] = {
        branch: it.branch,
        worktreePath: it.path,
        id: existing?.id || randomUUID(),
        title: existing?.title ?? null,
        baseBranch: existing?.baseBranch ?? null,
        status: existing?.status ?? "active",
        lastStatus: existing?.lastStatus ?? "idle",
        lastStatusAt: existing?.lastStatusAt ?? new Date().toISOString(),
        createdAt: existing?.createdAt ?? null,
        bindings: existing?.bindings ?? [],
        adopted: existing ? Boolean(existing.adopted) : true
      };
      stateDirty = true;
    }
    if (stateDirty) {
      try { await writeState(state); }
      catch (err) { console.error(`[worktrees] state write warning: ${err.message}`); }
    }

    const project = state.projects[repoPath] ?? { sessions: {} };
    const enriched = items.map((it) => {
      const session = project.sessions?.[it.branch];
      return {
        path: it.path,
        branch: it.branch,
        commit: it.commit,
        isMain: it.isMain,
        id: session?.id ?? null,
        title: session?.title ?? null,
        baseBranch: session?.baseBranch ?? null,
        lastStatus: session?.lastStatus ?? "idle",
        createdAt: session?.createdAt ?? null,
        status: session?.status ?? null,
        prUrl: session?.prUrl ?? null
      };
    });
    jsonRes(res, 200, { worktrees: enriched, projectPath: repoPath });
  } catch (err) {
    jsonRes(res, 500, { error: err.message });
  }
}

async function handleCreateWorktree(req, res) {
  const body = await readBody(req);
  if (!body) return jsonRes(res, 400, { error: "JSON body required" });
  const repoPath = expandHome(body.repoPath || "");
  const branch = String(body.branch || "").trim();
  const baseBranch = String(body.baseBranch || "main").trim();
  const title = body.title ? String(body.title) : null;

  if (!repoPath || !branch) {
    return jsonRes(res, 400, { error: "repoPath and branch required" });
  }
  if (!existsSync(repoPath)) {
    return jsonRes(res, 404, { error: `repoPath does not exist: ${repoPath}` });
  }
  const slug = branchToDirName(branch);
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(WORKTREES_ROOT, repoName, slug);

  if (existsSync(worktreePath)) {
    return jsonRes(res, 409, { error: `worktree path already exists: ${worktreePath}` });
  }

  try {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    // Check if branch already exists
    let branchExists = false;
    try {
      await execP(`git rev-parse --verify --quiet refs/heads/${branch}`, { cwd: repoPath });
      branchExists = true;
    } catch {}
    const cmd = branchExists
      ? `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`
      : `git worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)} ${JSON.stringify(baseBranch)}`;
    await execP(cmd, { cwd: repoPath });
  } catch (err) {
    return jsonRes(res, 500, { error: `git worktree add failed: ${err.message}` });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const state = await readState();
  const project = ensureProject(state, repoPath);
  project.sessions[branch] = {
    branch,
    worktreePath,
    id,
    title,
    baseBranch,
    status: "active",
    lastStatus: "idle",
    lastStatusAt: now,
    createdAt: now,
    bindings: []
  };
  try {
    await writeState(state);
  } catch (err) {
    return jsonRes(res, 500, { error: `state write failed: ${err.message}` });
  }

  jsonRes(res, 201, {
    id, branch, baseBranch, worktreePath, projectPath: repoPath, title, status: "active", lastStatus: "idle", createdAt: now
  });
}

async function handleCreatePr(req, res, id) {
  const body = (await readBody(req)) ?? {};
  const state = await readState();
  let found = null;
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (session.id === id) {
        found = {
          projectPath,
          branch: session.branch,
          worktreePath: session.worktreePath,
          baseBranch: session.baseBranch || "main",
          title: session.title || null
        };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return jsonRes(res, 404, { error: `worktree id not found: ${id}` });
  if (!existsSync(found.worktreePath)) {
    return jsonRes(res, 409, { error: `worktree path missing: ${found.worktreePath}` });
  }

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : found.title;
  const prBody = typeof body.body === "string" ? body.body : "";
  const base = typeof body.base === "string" && body.base.trim() ? body.base.trim() : found.baseBranch;
  const draft = body.draft === true;
  const cwd = found.worktreePath;

  const trace = [];
  const runStep = async (label, cmd) => {
    trace.push(`$ ${cmd}`);
    try {
      const { stdout, stderr } = await execP(cmd, { cwd, maxBuffer: 4 * 1024 * 1024 });
      if (stdout) trace.push(stdout.trim());
      if (stderr) trace.push(stderr.trim());
      return { stdout: stdout || "", stderr: stderr || "" };
    } catch (err) {
      const detail = err && typeof err === "object" ? `${err.stdout || ""}${err.stderr || ""}${err.message}` : String(err);
      trace.push(`! ${label} failed`);
      if (detail) trace.push(detail.trim());
      throw new Error(`${label} failed: ${detail.trim() || err.message}`);
    }
  };

  try {
    await runStep("git push", `git push -u origin ${JSON.stringify(found.branch)}`);
  } catch (err) {
    return jsonRes(res, 502, { error: err.message, trace });
  }

  const ghArgs = ["pr", "create", "--base", base, "--head", found.branch];
  if (title) {
    ghArgs.push("--title", title);
    ghArgs.push("--body", prBody);
  } else {
    ghArgs.push("--fill");
  }
  if (draft) ghArgs.push("--draft");
  const ghCmd = ["gh", ...ghArgs.map((a) => JSON.stringify(a))].join(" ");

  let url;
  try {
    const result = await runStep("gh pr create", ghCmd);
    const match = (result.stdout + "\n" + result.stderr).match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (!match) {
      return jsonRes(res, 502, { error: "gh pr create returned without a PR URL", trace });
    }
    url = match[0];
  } catch (err) {
    return jsonRes(res, 502, { error: err.message, trace });
  }

  // Persist PR URL so the UI can surface a "View PR" button after refresh.
  try {
    const project = state.projects[found.projectPath];
    const session = project?.sessions?.[found.branch];
    if (session) {
      session.prUrl = url;
      await writeState(state);
    }
  } catch (err) {
    console.error(`[worktrees] state write warning (prUrl): ${err.message}`);
  }

  jsonRes(res, 201, { id, branch: found.branch, base, url, draft, trace });
}

async function handleDeleteWorktree(req, res, id) {
  const state = await readState();
  let found = null;
  for (const [projectPath, project] of Object.entries(state.projects)) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (session.id === id) {
        found = { projectPath, branch: session.branch, worktreePath: session.worktreePath };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return jsonRes(res, 404, { error: `worktree id not found: ${id}` });

  try {
    if (existsSync(found.worktreePath)) {
      await execP(`git worktree remove ${JSON.stringify(found.worktreePath)} --force`, { cwd: found.projectPath });
    }
  } catch (err) {
    // Continue with state cleanup even if git removal had partial failure
    console.error(`[worktrees] git remove warning: ${err.message}`);
  }

  // Remove the session entry from state
  const project = state.projects[found.projectPath];
  if (project?.sessions) {
    delete project.sessions[found.branch];
  }
  await writeState(state);

  jsonRes(res, 200, { ok: true, id, removed: found });
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleOpenInIde(req, res) {
  const body = (await readBody(req)) || {};
  const projectPath = typeof body.path === "string" ? body.path.trim() : "";
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

async function handleTerminalTarget(req, res) {
  try {
    const raw = await readFile(TERMINAL_STATUS_FILE, "utf8");
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

async function readDevRoot() {
  try {
    const raw = await readFile(DEV_ROOT_FILE, "utf8");
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch {}
  return path.join(HOME, "dev");
}

async function writeDevRoot(value) {
  await mkdir(path.dirname(DEV_ROOT_FILE), { recursive: true });
  await writeFile(DEV_ROOT_FILE, String(value).trim() + "\n");
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

async function handleListProjects(req, res, queryParams) {
  const devRoot = expandHome(queryParams.devRoot || (await readDevRoot()));
  if (!existsSync(devRoot)) {
    return jsonRes(res, 200, { devRoot, projects: [] });
  }
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
    const gitPath = path.join(projectPath, ".git");
    if (!existsSync(gitPath)) continue;
    projects.push({ name: entry.name, path: projectPath });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  jsonRes(res, 200, { devRoot, projects });
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
    fittingId: "worktree-management-sequoias",
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
  if (free === null) { console.error(`[worktrees] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/terminal-target" && method === "GET") return handleTerminalTarget(req, res);
      if (pathname === "/open-in-ide" && method === "POST") return handleOpenInIde(req, res);
      if (pathname === "/projects" && method === "GET") return handleListProjects(req, res, parsed.query);
      if (pathname === "/dev-root" && method === "GET") return handleGetDevRoot(req, res);
      if (pathname === "/dev-root" && method === "PATCH") return handlePatchDevRoot(req, res);
      if (pathname === "/worktrees" && method === "GET") return handleListWorktrees(req, res, parsed.query);
      if (pathname === "/worktrees" && method === "POST") return handleCreateWorktree(req, res);

      const prMatch = pathname.match(/^\/worktrees\/([^/]+)\/pr$/);
      if (prMatch && method === "POST") return handleCreatePr(req, res, decodeURIComponent(prMatch[1]));

      const delMatch = pathname.match(/^\/worktrees\/([^/]+)$/);
      if (delMatch && method === "DELETE") return handleDeleteWorktree(req, res, decodeURIComponent(delMatch[1]));

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[worktrees] listening on http://${liveOpts.host}:${liveOpts.port} (repo=${liveOpts.repoPath || "<unset>"})`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[worktrees] shutdown (${signal})`);
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
  startServer().catch((err) => { console.error("[worktrees] failed:", err); process.exit(1); });
}
