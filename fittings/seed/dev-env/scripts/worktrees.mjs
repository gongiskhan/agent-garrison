// dev-env worktree CRUD — ported from worktree-management-sequoias
// scripts/server.mjs. Dropped: handleCreatePr and handleOpenInIde (PR /
// commit flows now go through the running Claude PTY via /sessions/:id/
// instruct; Open-in-IDE was cut). Create stamps `source:"dev-env"` on the
// state record. The /worktrees HTTP aliases in server.mjs exist so the
// http-gateway's worktrees-passthrough keeps working unmodified.

import { exec } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readStateFile, realResolve, tombstoneCwd, withStateWrite, writeStateAtomic } from "./state.mjs";

const execP = promisify(exec);
const HOME = os.homedir();
const DEV_ROOT_FILE = path.join(HOME, ".garrison", "dev-root");
export const WORKTREES_ROOT = path.join(HOME, ".worktrees");

export function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(HOME, p.slice(1).replace(/^\/+/, ""));
  return p;
}

export function isWorktreePath(p) {
  return typeof p === "string" && p.startsWith(WORKTREES_ROOT + path.sep);
}

export function slugifyBranch(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 80);
}

export function branchToDirName(branch) {
  // feat/foo-bar → feat-foo-bar
  return slugifyBranch(branch).replace(/\//g, "-");
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

export async function gitWorktreeList(repoPath) {
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

// List worktrees enriched with state-record fields (gateway-compat shape).
// Upserts a session record for every non-main worktree git knows about but
// state.json doesn't, so Remove can address worktrees created outside
// Garrison.
export async function listWorktreesEnriched(repoPath) {
  const items = await gitWorktreeList(repoPath);
  const state = await withStateWrite(async () => {
    const st = readStateFile() || { version: 1, projects: {} };
    let stateDirty = false;
    for (const it of items) {
      if (it.isMain || !it.branch) continue;
      const project = ensureProject(st, repoPath);
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
        // Epoch, not now: a fresh adoption is ledger bookkeeping, not activity.
        // Stamping now would make every routine GET /worktrees (gateway proxy)
        // resurrect closed worktree tabs through the 90-min recency filter.
        lastStatusAt: existing?.lastStatusAt ?? new Date(0).toISOString(),
        createdAt: existing?.createdAt ?? null,
        bindings: existing?.bindings ?? [],
        adopted: existing ? Boolean(existing.adopted) : true
      };
      stateDirty = true;
    }
    if (stateDirty) {
      try { await writeStateAtomic(st); }
      catch (err) { console.error(`[dev-env] state write warning: ${err.message}`); }
    }
    return st;
  });

  const project = state.projects[repoPath] ?? { sessions: {} };
  return items.map((it) => {
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
}

// Create a worktree at ~/.worktrees/<repo>/<slug> and record the session
// (source: "dev-env"). Throws { status, message } style errors for the HTTP
// layer to surface.
export async function createWorktree({ repoPath: rawRepoPath, branch: rawBranch, baseBranch: rawBase, title: rawTitle }) {
  const repoPath = expandHome(rawRepoPath || "");
  const branch = String(rawBranch || "").trim();
  const baseBranch = String(rawBase || "main").trim();
  const title = rawTitle ? String(rawTitle) : null;

  if (!repoPath || !branch) {
    throw httpError(400, "repoPath and branch required");
  }
  if (!existsSync(repoPath)) {
    throw httpError(404, `repoPath does not exist: ${repoPath}`);
  }
  const slug = branchToDirName(branch);
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(WORKTREES_ROOT, repoName, slug);

  if (existsSync(worktreePath)) {
    throw httpError(409, `worktree path already exists: ${worktreePath}`);
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
    if (err && err.status) throw err;
    throw httpError(500, `git worktree add failed: ${err.message}`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  await withStateWrite(async () => {
    const state = readStateFile() || { version: 1, projects: {} };
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
      bindings: [],
      source: "dev-env"
    };
    try {
      await writeStateAtomic(state);
    } catch (err) {
      throw httpError(500, `state write failed: ${err.message}`);
    }
  });

  return {
    id, branch, baseBranch, worktreePath, projectPath: repoPath,
    title, status: "active", lastStatus: "idle", createdAt: now, source: "dev-env"
  };
}

// Create (or reuse) a session record for an arbitrary project directory —
// the menu's "Start session" path. No worktree is created: the record keys
// by the directory itself, like hook auto-create, but with source "dev-env".
export async function createProjectSession({ path: rawPath, title: rawTitle }) {
  const projectPath = expandHome(String(rawPath || "").trim());
  const title = rawTitle ? String(rawTitle) : null;
  if (!projectPath || !projectPath.startsWith("/")) {
    throw httpError(400, "path (absolute) required");
  }
  if (!existsSync(projectPath)) {
    throw httpError(404, `path does not exist: ${projectPath}`);
  }
  // realResolve: ~/dev and ~/Projects alias each other on some machines —
  // lexical comparison would create two sessions (two claudes) for one
  // physical directory.
  const normalized = realResolve(projectPath);

  // Reuse an existing record whose worktreePath is this directory. Rows whose
  // project key vanished from disk are skipped: the aggregate hides them, so
  // reusing one would hand back a session the orphan sweep immediately kills.
  return withStateWrite(async () => {
    const state = readStateFile() || { version: 1, projects: {} };
    for (const [projectKey, project] of Object.entries(state.projects ?? {})) {
      const projectExists = !projectKey.startsWith("/") || existsSync(projectKey);
      if (!projectExists) continue;
      for (const session of Object.values(project?.sessions ?? {})) {
        if (session?.worktreePath && realResolve(session.worktreePath) === normalized && session.id) {
          return { session, existed: true };
        }
      }
    }

    let branch = "detached";
    try {
      const { stdout } = await execP("git rev-parse --abbrev-ref HEAD", { cwd: normalized, timeout: 1500 });
      branch = stdout.trim() || "detached";
    } catch {}

    const id = randomUUID();
    const now = new Date().toISOString();
    const project = ensureProject(state, normalized);
    project.sessions[branch] = {
      branch,
      worktreePath: normalized,
      id,
      title,
      baseBranch: null,
      status: "active",
      lastStatus: "idle",
      lastStatusAt: now,
      createdAt: now,
      bindings: [],
      source: "dev-env"
    };
    try {
      await writeStateAtomic(state);
    } catch (err) {
      throw httpError(500, `state write failed: ${err.message}`);
    }
    return { session: project.sessions[branch], existed: false };
  });
}

// Remove ONLY the session record — the tab-close path. The directory and any
// git worktree stay untouched; hooks or worktree adoption will recreate the
// record if the session comes back to life. The tombstone stops the dying
// claude's last hooks from resurrecting the row immediately.
export async function removeSessionRecord(id) {
  return withStateWrite(async () => {
    const found = findSessionById(id);
    if (!found) throw httpError(404, `session id not found: ${id}`);
    tombstoneCwd(found.worktreePath);
    const state = readStateFile();
    const project = state?.projects?.[found.projectPath];
    if (project?.sessions) {
      delete project.sessions[found.key];
      await writeStateAtomic(state);
    }
    return found;
  });
}

// Per-pane closed markers live on the session record so every connected
// Dev Env client (desktop + iPad) sees the same close state — a client-local
// flag would let the other client's lazy shell-spawn resurrect the pane.
export async function setPaneClosed(id, role, closed) {
  return withStateWrite(async () => {
    const found = findSessionById(id);
    if (!found) return null;
    const state = readStateFile();
    const session = state?.projects?.[found.projectPath]?.sessions?.[found.key];
    if (!session) return null;
    const panes = session.panesClosed && typeof session.panesClosed === "object" ? session.panesClosed : {};
    if (closed) panes[role] = true;
    else delete panes[role];
    session.panesClosed = panes;
    await writeStateAtomic(state);
    return session;
  });
}

// Find a session record by id in the raw state file.
export function findSessionById(id) {
  const state = readStateFile();
  if (!state) return null;
  for (const [projectPath, project] of Object.entries(state.projects ?? {})) {
    for (const [branchKey, session] of Object.entries(project?.sessions ?? {})) {
      if (session?.id === id) {
        return {
          projectPath,
          branch: session.branch || branchKey,
          key: branchKey, // the actual sessions-map key (≠ branch for UUID-keyed /open tabs)
          claudeSessionId: session.claudeSessionId ?? null, // so lazy resume can --resume the EXACT session
          worktreePath: session.worktreePath || projectPath,
          session
        };
      }
    }
  }
  return null;
}

// Remove the session record (and, when its cwd lives under ~/.worktrees,
// the git worktree + any leftover directory). Returns the removed locator.
export async function deleteSession(id) {
  return withStateWrite(async () => {
    const found = findSessionById(id);
    if (!found) throw httpError(404, `session id not found: ${id}`);
    tombstoneCwd(found.worktreePath);

    if (isWorktreePath(found.worktreePath)) {
      try {
        if (existsSync(found.worktreePath)) {
          await execP(`git worktree remove ${JSON.stringify(found.worktreePath)} --force`, { cwd: found.projectPath });
        }
      } catch (err) {
        // Continue with state cleanup even if git removal had partial failure
        console.error(`[dev-env] git remove warning: ${err.message}`);
      }
      try {
        if (existsSync(found.worktreePath)) {
          await rm(found.worktreePath, { recursive: true, force: true });
        }
      } catch (err) {
        console.error(`[dev-env] leftover dir remove warning: ${err.message}`);
      }
    }

    const state = readStateFile();
    const project = state?.projects?.[found.projectPath];
    if (project?.sessions) {
      delete project.sessions[found.key];
      if (Object.keys(project.sessions).length === 0 && project.path !== found.worktreePath) {
        // Keep the (now empty) project entry — hook auto-create will repopulate.
      }
      await writeStateAtomic(state);
    }
    return found;
  });
}

export async function readDevRoot() {
  try {
    const raw = await readFile(DEV_ROOT_FILE, "utf8");
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  } catch {}
  return path.join(HOME, "dev");
}

export async function writeDevRoot(value) {
  await mkdir(path.dirname(DEV_ROOT_FILE), { recursive: true });
  await writeFile(DEV_ROOT_FILE, String(value).trim() + "\n");
}

export function listProjects(devRoot) {
  if (!existsSync(devRoot)) return [];
  const projects = [];
  let entries = [];
  entries = readdirSync(devRoot, { withFileTypes: true });
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
  return projects;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
