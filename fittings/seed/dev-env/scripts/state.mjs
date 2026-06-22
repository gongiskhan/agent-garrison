// dev-env session state — ported nearly verbatim from session-view-sequoias
// scripts/server.mjs. Dev Env remains the writer/reader of
// ~/.garrison/sessions/state.json (GARRISON_STATE_PATH override kept; the
// ~/.sequoias/state.json legacy fallback is dropped with the Sequoias
// retirement). New here: the git-dirty cache (stale-while-revalidate) and the
// extended cleanup that operates on the RAW state file — the aggregate hides
// missing-path rows, so cleanup must not go through it.

import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isExcluded } from "./excludes.mjs";
import { readLiveRegistry } from "./claude-sessions.mjs";

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

// Symlink-safe path identity: ~/dev and ~/Projects are symlinked on some of
// the user's machines, so lexical path.resolve comparison would treat one
// physical directory as two sessions. Falls back to resolve when the path
// does not exist.
export function realResolve(p) {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Container directories too broad to collapse their children under a single
// tab. A session living directly in HOME, ~/dev or ~/Projects (the latter two
// are symlinked on this machine, so both raw and realpath forms are folded in)
// holds many unrelated projects; treating it as a "parent project folder"
// would hide every real project beneath it behind one home/dev tab. Anything
// deeper IS a project folder and may collapse the stray sub-cwd sessions a
// tool wandered into (e.g. ekoa-dev hides ekoa-dev/cortex). See assembleSessions.
const BROAD_ROOTS = (() => {
  const set = new Set();
  for (const p of [HOME, path.join(HOME, "dev"), path.join(HOME, "Projects"), path.dirname(HOME), "/"]) {
    if (!p) continue;
    set.add(p);
    set.add(realResolve(p));
  }
  return set;
})();

// True when `p` is one of the broad container roots above — i.e. too broad to
// act as the "parent project folder" that hides nested sessions.
export function isBroadRoot(p) {
  if (!p || typeof p !== "string") return false;
  if (BROAD_ROOTS.has(p)) return true;
  return BROAD_ROOTS.has(realResolve(p));
}

// Registry-backed liveness. Claude Code's own ~/.claude/sessions/*.json is the
// source of truth for "what claude is running right now" — read via
// claude-sessions.mjs (alive-pid + boot-time + procStart-reuse guards), which is
// cheaper and more precise than the prior ps/lsof cwd probe and yields the
// sessionId directly. Cached briefly so the /sessions hot path doesn't re-scan
// every poll; on a transient read error the last good snapshot is kept.
let liveReg = { rows: [], byCwd: new Set(), bySid: new Set(), at: 0 };
const LIVE_REG_TTL_MS = 4_000;

function liveRegistry() {
  if (liveReg.at && Date.now() - liveReg.at < LIVE_REG_TTL_MS) return liveReg;
  let rows;
  try {
    rows = readLiveRegistry();
  } catch {
    rows = liveReg.rows; // keep last good on a transient read error
  }
  const byCwd = new Set();
  const bySid = new Set();
  for (const r of rows) {
    if (r.cwd) { byCwd.add(r.cwd); byCwd.add(realResolve(r.cwd)); }
    if (r.sessionId) bySid.add(r.sessionId);
  }
  liveReg = { rows, byCwd, bySid, at: Date.now() };
  return liveReg;
}

// The live registry rows (Agents panel source): { sessionId, cwd, pid, status, … }.
export function liveRegistryRows() {
  return liveRegistry().rows;
}

// True when a live `claude` is running at `worktreePath`, or a live session
// carries `claudeSessionId`. Keeps the original name/signature so the server's
// assembleSessions keeps working; now backed by the registry, not ps/lsof.
export function hasLiveClaudeProcess(worktreePath, claudeSessionId = null) {
  const reg = liveRegistry();
  if (claudeSessionId && reg.bySid.has(claudeSessionId)) return true;
  if (!worktreePath) return false;
  return reg.byCwd.has(worktreePath) || reg.byCwd.has(realResolve(worktreePath));
}

// Close tombstones: closing/deleting a session races the dying claude's
// last hooks (PostToolUse/Stop), which would auto-create a fresh row for the
// same cwd within seconds. Tombstoned cwds drop hook events for a grace
// window. A genuinely still-running external claude resurrects the row after
// the window — which is honest.
const closeTombstones = new Map(); // realResolve(cwd) -> expiresAt
const TOMBSTONE_MS = 20_000;

export function tombstoneCwd(cwd, ms = TOMBSTONE_MS) {
  if (!cwd) return;
  closeTombstones.set(realResolve(cwd), Date.now() + ms);
}

export function isTombstoned(cwd) {
  if (!cwd) return false;
  const key = realResolve(cwd);
  const expires = closeTombstones.get(key);
  if (!expires) return false;
  if (Date.now() > expires) {
    closeTombstones.delete(key);
    return false;
  }
  return true;
}

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

// Serialize every read-modify-write on state.json within this process so a
// close/unpin can't be clobbered by a concurrent hook status update, and two
// writers can't collide on the temp file. Only the dev-env process writes this
// file, so an in-process chain is sufficient (no cross-process lock needed).
let stateWriteChain = Promise.resolve();
let tmpSeq = 0;
export function withStateWrite(fn) {
  const run = stateWriteChain.then(fn, fn);
  stateWriteChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

export async function writeStateAtomic(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`; // unique → no two-writer temp collision
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
        source: session?.source ?? "state",
        panesClosed: session?.panesClosed ?? null,
        openedInDevEnv: session?.openedInDevEnv === true
      });
    }
  }
  return out;
}

// Mutate state.json: find session by branch in the named project; update
// status fields. If project or session does not exist, create them.
export async function setSessionStatus(projectPath, branch, status, hookEvent, opts = {}) {
  return withStateWrite(async () => {
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
  // The sessions-map KEY can differ from the branch FIELD: a distinct claude
  // session in the same cwd+branch is keyed by its claudeSessionId (opts.key) so
  // it gets its own row instead of colliding on the branch.
  const mapKey = opts.key || branch;
  let session = project.sessions[mapKey];
  const now = new Date().toISOString();
  // Idempotency by claudeSessionId — runs under the state mutex against the
  // LATEST state, BEFORE any create OR branch-row update: if ANY record already
  // owns this id, update THAT and return. This prevents every racing-hook
  // duplicate variant: (a) creating a second record, AND (b) stamping the id
  // onto a different branch row (e.g. a pre-existing sid-less sessions['main'])
  // while another row already owns it.
  if (opts.claudeSessionId) {
    for (const p of Object.values(state.projects ?? {})) {
      for (const s of Object.values(p?.sessions ?? {})) {
        if (s && s.claudeSessionId === opts.claudeSessionId) {
          s.lastStatus = status;
          s.lastStatusAt = now;
          if (hookEvent !== undefined) s.lastHookEvent = hookEvent;
          await writeStateAtomic(state);
          return s;
        }
      }
    }
  }
  // After the re-scan, the row at mapKey (if any) does NOT own opts.claudeSessionId.
  // If it owns a DIFFERENT sid, it belongs to another (concurrent) session — do
  // NOT hijack it; create a distinct row keyed by the incoming sid instead. This
  // closes the two-concurrent-hooks-on-one-sid-less-row collapse.
  let createKey = mapKey;
  if (session && opts.claudeSessionId && session.claudeSessionId && session.claudeSessionId !== opts.claudeSessionId) {
    session = undefined;
    createKey = opts.claudeSessionId;
  }
  if (!session) {
    // A just-closed cwd must not be re-created by the dying claude's last
    // hooks — including via the read-modify-write path where the hook read
    // the state before the close landed.
    if (isTombstoned(opts.worktreePath || projectPath)) return null;
    session = project.sessions[createKey] = {
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
      source: opts.source || "hook-autocreated",
      // Hook-autocreated (external) sessions surface in the Agents panel, not as
      // an auto-opened tab. A dev-env-opened session gets openedInDevEnv via
      // setSessionOpen(id, true) right after creation.
      openedInDevEnv: opts.openedInDevEnv === true
    };
  } else {
    session.lastStatus = status;
    session.lastStatusAt = now;
    if (hookEvent !== undefined) session.lastHookEvent = hookEvent;
    // Only stamp the id onto a sid-less (or same-id) row — never overwrite a row
    // that already owns a DIFFERENT session id (that's another session's row).
    if (opts.claudeSessionId && (!session.claudeSessionId || session.claudeSessionId === opts.claudeSessionId)) {
      session.claudeSessionId = opts.claudeSessionId;
    }
  }
  await writeStateAtomic(state);
  return session;
  });
}

// Persist the open-set: which sessions are open as tabs in dev-env. This is the
// reboot-durable record — after a reboot nothing is live, so the tab strip can
// only be rebuilt from a flag that was written when the tab was opened/closed.
export async function setSessionOpen(sessionId, open) {
  return withStateWrite(async () => {
  const state = readStateFile();
  if (!state) return false;
  const nowIso = new Date().toISOString();
  for (const project of Object.values(state.projects ?? {})) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (session && session.id === sessionId) {
        session.openedInDevEnv = !!open;
        if (open) {
          session.tabOpenedAt = nowIso;
          session.closedAt = null;
        } else {
          session.closedAt = nowIso;
        }
        await writeStateAtomic(state);
        return true;
      }
    }
  }
  return false;
  });
}

// One-time migration for records that predate openedInDevEnv: seed it from the
// OLD visibility (a live/active/has-PTY record WAS a visible tab → keep it open;
// everything else closed). `isOpenDerive(session)` is supplied by the caller
// (server.mjs knows liveness + PTYs). Idempotent: records that already carry the
// boolean are left untouched, so it only runs meaningfully once.
export async function migrateOpenSet(isOpenDerive) {
  return withStateWrite(async () => {
  const state = readStateFile();
  if (!state) return 0;
  let changed = 0;
  for (const project of Object.values(state.projects ?? {})) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (!session || typeof session.openedInDevEnv === "boolean") continue;
      session.openedInDevEnv = typeof isOpenDerive === "function" ? !!isOpenDerive(session) : false;
      changed++;
    }
  }
  if (changed) await writeStateAtomic(state);
  return changed;
  });
}

// Open a session as a tab from Agents/History, keyed by claudeSessionId so two
// distinct sessions in the SAME cwd get distinct records (the sessions-map key
// is the session id, guaranteeing uniqueness; the `branch` field stays for
// display). Re-pins an existing record for the same id. The caller must pass a
// validated claudeSessionId.
export async function openSessionByClaudeId({ claudeSessionId, cwd, title = null, branch = null }) {
  return withStateWrite(async () => {
    const state = readStateFile() || { version: 1, projects: {} };
    for (const project of Object.values(state.projects)) {
      for (const session of Object.values(project.sessions ?? {})) {
        if (session && session.claudeSessionId === claudeSessionId) {
          session.openedInDevEnv = true;
          session.tabOpenedAt = new Date().toISOString();
          session.closedAt = null;
          await writeStateAtomic(state);
          return session;
        }
      }
    }
    const projectPath = cwd;
    let project = state.projects[projectPath];
    if (!project) project = state.projects[projectPath] = { path: projectPath, name: path.basename(projectPath), sessions: {} };
    if (!project.sessions) project.sessions = {};
    const now = new Date().toISOString();
    const session = (project.sessions[claudeSessionId] = {
      branch: branch || "main",
      worktreePath: cwd,
      ports: {},
      envFiles: [],
      createdAt: now,
      lastStatus: "idle",
      lastStatusAt: now,
      lastHookEvent: null,
      id: randomUUID(),
      claudeSessionId,
      title: title || null,
      baseBranch: null,
      status: "active",
      urls: {},
      bindings: [],
      source: "dev-env-open",
      openedInDevEnv: true,
      tabOpenedAt: now,
      closedAt: null
    });
    await writeStateAtomic(state);
    return session;
  });
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
  const normalized = realResolve(cwd);
  if (isTombstoned(normalized)) {
    return { ok: true, matched: false, dropped: true, reason: "cwd recently closed" };
  }

  // Try to match an existing session by worktreePath (covers both
  // worktree-created sessions and previously hook-autocreated ones).
  // realResolve keeps symlink aliases (~/dev vs ~/Projects) on one row.
  // Match an existing record. Prefer an EXACT claudeSessionId match (covers the
  // UUID-keyed /open tabs); else fall back to a worktreePath match. ALWAYS use
  // the actual sessions-map KEY so setSessionStatus updates THAT record instead
  // of creating a duplicate under session.branch ("main").
  const state = readStateFile() || { version: 1, projects: {} };
  let matchedProject = null;
  let matchedKey = null;
  let matchedWorktreePath = null;
  let matchedBySid = false;
  for (const [projectPath, project] of Object.entries(state.projects ?? {})) {
    for (const [mapKey, session] of Object.entries(project?.sessions ?? {})) {
      if (claudeSessionId && session?.claudeSessionId === claudeSessionId) {
        matchedProject = projectPath;
        matchedKey = mapKey;
        matchedWorktreePath = session.worktreePath || null;
        matchedBySid = true;
        break;
      }
      if (
        !matchedProject &&
        session?.worktreePath &&
        realResolve(session.worktreePath) === normalized &&
        // skip a same-cwd row that already owns a DIFFERENT sid — it's another
        // session, and this hook (carrying its own sid) must not hijack it.
        !(claudeSessionId && session.claudeSessionId && session.claudeSessionId !== claudeSessionId)
      ) {
        matchedProject = projectPath; // tentative cwd match — a later sid match still wins
        matchedKey = mapKey;
        matchedWorktreePath = session.worktreePath || null;
      }
    }
    if (matchedBySid) break;
  }

  if (matchedProject) {
    // Pass the matched worktreePath: if the row was DELETED between this (unlocked)
    // match and the locked write, setSessionStatus's create path then checks the
    // tombstone against the real worktree cwd — not projectPath — and refuses to
    // resurrect a just-deleted worktree session.
    await setSessionStatus(matchedProject, matchedKey, status, event, {
      claudeSessionId,
      worktreePath: matchedWorktreePath || undefined
    });
    return { ok: true, matched: true, autoCreated: false };
  }

  // Excluded system / internal dir with no existing record → don't start
  // monitoring it (this is what keeps the Fitting packages, memory-compiler,
  // ~/.claude, etc. out of the tab strip). An already-tracked path still
  // updates above; only fresh auto-creation is suppressed.
  if (isExcluded(normalized)) {
    return { ok: true, matched: false, autoCreated: false, excluded: true };
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
    claudeSessionId,
    key: claudeSessionId || undefined // key by sid → a distinct session in the same cwd gets its own row
  });
  return { ok: true, matched: false, autoCreated: true };
}

// 60s fallback: any "working" session that hasn't fired a hook in 60s
// downgrades to idle.
//
// `liveBusyIds` is the set of session ids whose claude PTY screen reports a
// turn in flight RIGHT NOW (the live "(esc to interrupt)" marker). A long
// thinking/inference phase fires no PostToolUse hooks for minutes, so without
// this guard the timer would demote a session that is plainly still working —
// dropping the tab spinner. Such sessions get their clock reset instead so the
// hook-driven status stays honest and a genuinely stuck "working" still ages
// out once the screen goes quiet.
export async function runWorkingIdleFallback(liveBusyIds = null) {
  return withStateWrite(async () => {
  const state = readStateFile();
  if (!state || !state.projects) return;
  let changed = false;
  const now = Date.now();
  const nowIso = new Date().toISOString();
  for (const project of Object.values(state.projects)) {
    for (const session of Object.values(project.sessions ?? {})) {
      if (session?.lastStatus === "working" && session.lastStatusAt) {
        const t = Date.parse(session.lastStatusAt);
        if (!Number.isNaN(t) && now - t > WORKING_IDLE_FALLBACK_MS) {
          if (liveBusyIds && session.id && liveBusyIds.has(session.id)) {
            session.lastStatusAt = nowIso; // still processing — keep it working
            changed = true;
            continue;
          }
          session.lastStatus = "idle";
          session.lastStatusAt = nowIso;
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
  });
}

// Extended cleanup — operates on the RAW state file (the aggregate hides
// missing-path rows) and removes missing-path AND stale/dead records.
// Returns the removed rows; the caller kills + forgets their PTYs.
export async function cleanupState() {
  return withStateWrite(async () => {
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
  });
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
