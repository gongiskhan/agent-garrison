// dev-env session state — ported nearly verbatim from session-view-sequoias
// scripts/server.mjs. Dev Env remains the writer/reader of
// ~/.garrison/sessions/state.json (GARRISON_STATE_PATH override kept; the
// ~/.sequoias/state.json legacy fallback is dropped with the Sequoias
// retirement). New here: the git-dirty cache (stale-while-revalidate) and the
// extended cleanup that operates on the RAW state file — the aggregate hides
// missing-path rows, so cleanup must not go through it.

import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execP = promisify(exec);

const HOME = os.homedir();
export const STATE_FILE = process.env.GARRISON_STATE_PATH && process.env.GARRISON_STATE_PATH.trim().length > 0
  ? process.env.GARRISON_STATE_PATH
  : path.join(HOME, ".garrison", "sessions", "state.json");

export const SESSION_STATUSES = new Set(["starting", "working", "waiting", "idle", "errored", "dead", "stale"]);
const STARTING_TIMEOUT_MS = 60_000; // a session stuck in "starting" past this is reported as "stale"
const WORKING_IDLE_FALLBACK_MS = 60_000; // working with no further hook for 60s → idle

// In-memory branch cache, keyed by cwd (used by auto-create-on-hook)
const branchCache = new Map(); // cwd -> { value, expiresAt }
const BRANCH_CACHE_TTL_MS = 30_000;

export function statusFromHookEvent(event) {
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

export function readStateFile() {
  if (!existsSync(STATE_FILE)) return null;
  let raw;
  try {
    raw = readFileSync(STATE_FILE, "utf8");
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

export async function writeStateAtomic(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

// Aggregate view: one row per session, missing-path rows hidden, stale
// derived. This feeds GET /sessions; cleanup goes through the raw file.
export function aggregateSessions() {
  const state = readStateFile();
  const out = [];
  if (!state) return out;
  const now = Date.now();
  for (const [key, project] of Object.entries(state.projects ?? {})) {
    const projectPath = (project && project.path) || key;
    const projectName = (project && project.name) || path.basename(projectPath);
    const projectExists = !projectPath.startsWith("/") || existsSync(projectPath);
    for (const [branchKey, session] of Object.entries(project?.sessions ?? {})) {
      const branch = (session && session.branch) || branchKey;
      const worktreePath = (session && session.worktreePath) || "";
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
        id: session?.id ?? null,
        branch,
        worktreePath,
        lastStatus,
        lastStatusAt,
        lastHookEvent: session?.lastHookEvent,
        projectName,
        projectPath,
        claudeSessionId: session?.claudeSessionId ?? null,
        title: session?.title ?? null,
        source: session?.source ?? "state"
      });
    }
  }
  return out;
}

// Mutate state.json: find session by branch in the named project; update
// status fields. If project or session does not exist, create them.
export async function setSessionStatus(projectPath, branch, status, hookEvent, opts = {}) {
  const state = readStateFile() || { version: 1, projects: {} };
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
  await writeStateAtomic(state);
  return session;
}

// Hook receiver core. Two payload shapes are accepted:
//   - Legacy (Garrison-only): { event, cwd }
//   - New (Claude Code stdin forwarded by install-hooks.mjs):
//     { session_id, transcript_path, hook_event_name, cwd, ... }
//     with `?event=<name>` on the query string.
export async function applyHookEvent(event, body) {
  const cwd = String(body?.cwd || "");
  const claudeSessionId =
    (body && (body.session_id || body.sessionId)) ? String(body.session_id || body.sessionId) : null;
  if (!event || !cwd) {
    return { ok: false, error: "event and cwd required" };
  }
  const status = statusFromHookEvent(event);
  if (!status) {
    return { ok: true, matched: false, reason: `untracked event: ${event}` };
  }
  const normalized = path.resolve(cwd);

  // Try to match an existing session by worktreePath (covers both
  // worktree-created sessions and previously hook-autocreated ones).
  const state = readStateFile() || { version: 1, projects: {} };
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
    return { ok: true, matched: true, autoCreated: false };
  }

  // Auto-create: key the project by the actual cwd so multiple Claude
  // instances in the same git repo at different subdirs get distinct rows.
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
  return { ok: true, matched: false, autoCreated: true };
}

// 60s fallback: any "working" session that hasn't fired a hook in 60s
// downgrades to idle.
export async function runWorkingIdleFallback() {
  const state = readStateFile();
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
    try { await writeStateAtomic(state); }
    catch (err) { console.error(`[dev-env] fallback write failed: ${err.message}`); }
  }
}

// Extended cleanup — operates on the RAW state file (the aggregate hides
// missing-path rows) and removes missing-path AND stale/dead records.
// Returns the removed rows; the caller kills + forgets their PTYs.
export async function cleanupState() {
  const removed = [];
  const state = readStateFile();
  if (!state || !state.projects || typeof state.projects !== "object") {
    return { scanned: 0, removed };
  }
  let scanned = 0;
  let changed = false;
  const now = Date.now();
  for (const [projectPath, project] of Object.entries(state.projects)) {
    const projectExists = !projectPath.startsWith("/") || existsSync(projectPath);
    if (!projectExists) {
      for (const [branch, session] of Object.entries(project?.sessions ?? {})) {
        scanned++;
        removed.push({ projectPath, branch, reason: "project-missing", id: session?.id ?? null });
      }
      delete state.projects[projectPath];
      changed = true;
      continue;
    }
    const sessions = project?.sessions ?? {};
    for (const [branch, session] of Object.entries(sessions)) {
      scanned++;
      const wt = session?.worktreePath || "";
      const wtExists = wt.startsWith("/") ? existsSync(wt) : true;
      let reason = null;
      if (!wtExists) {
        reason = "worktree-missing";
      } else if (session?.lastStatus === "dead") {
        reason = "dead";
      } else if (session?.lastStatus === "stale") {
        reason = "stale";
      } else if (session?.lastStatus === "starting" && session?.lastStatusAt) {
        const t = Date.parse(session.lastStatusAt);
        if (!Number.isNaN(t) && now - t > STARTING_TIMEOUT_MS) reason = "stale";
      }
      if (reason) {
        removed.push({ projectPath, branch, reason, id: session?.id ?? null });
        delete sessions[branch];
        changed = true;
      }
    }
  }
  if (changed) {
    await writeStateAtomic(state);
  }
  return { scanned, removed };
}

// Git-dirty cache: stale-while-revalidate. Returns the last known value
// immediately (null while the first check is in flight) and refreshes in the
// background once the TTL lapses.
const dirtyCache = new Map(); // cwd -> { value, fetchedAt, inflight }
let dirtyTtlMs = 10_000;

export function setDirtyCheckTtl(ms) {
  if (Number.isFinite(ms) && ms > 0) dirtyTtlMs = ms;
}

function refreshDirty(cwd) {
  const entry = dirtyCache.get(cwd) || { value: null, fetchedAt: 0, inflight: false };
  if (entry.inflight) return;
  entry.inflight = true;
  dirtyCache.set(cwd, entry);
  execFile("git", ["status", "--porcelain"], { cwd, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    entry.inflight = false;
    entry.fetchedAt = Date.now();
    if (!err) entry.value = String(stdout).trim().length > 0;
  });
}

export function getDirty(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const entry = dirtyCache.get(cwd);
  if (!entry || Date.now() - entry.fetchedAt > dirtyTtlMs) {
    refreshDirty(cwd);
  }
  return entry ? entry.value : null;
}
