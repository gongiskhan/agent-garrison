// outpost config-sync — mirror the PORTABLE ~/.claude config subset from this
// Garrison host onto every configured outpost over rsync-over-SSH, so the
// Claude Code config on the host is reflected on all outposts.
//
// This is the piece provision-outpost.sh explicitly left as a TODO ("skills
// bundle — skipped"). The host is the single source of truth for config; each
// portable directory is MIRRORED (rsync --delete) so removing an item INSIDE a
// portable dir (e.g. retiring the autothing skill under skills/) propagates to
// the outposts. Deleting an entire portable dir on the host is skipped (not
// mirrored as an empty dir) - it is treated as "nothing to sync for that dir".
//
// Deliberately NOT synced: settings.json / plugins / mcp.json (machine-specific
// hook ports, absolute installPaths, model tokens), and everything ephemeral
// (projects/, sessions/, todos/, statsig/, logs/, credentials, the vault).
// Those are what made the old wholesale claude-share git sync churn and diverge.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
// Honor the repo's config-home convention: dev and prod point at DIFFERENT
// Claude config dirs (HARD RULE), so a bare ~/.claude would sync the wrong one.
export const CLAUDE_DIR =
  process.env.GARRISON_CLAUDE_DIR || process.env.GARRISON_CLAUDE_HOME || path.join(HOME, ".claude");
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
export const TARGETS_FILE = path.join(GARRISON_HOME, "outpost-sync-targets.json");

// The portable config subset. Directories are mirrored; files are copied.
export const PORTABLE_DIRS = ["skills", "commands", "agents", "rules", "output-styles"];
export const PORTABLE_FILES = ["CLAUDE.md"];

// rsync --exclude patterns applied to every directory transfer. Keeps
// machine/project-local noise and any skill-local state out of the mirror.
export const RSYNC_EXCLUDES = [
  ".git/",
  ".git",
  "node_modules/",
  ".DS_Store",
  "*.log",
  "state/",       // skill-improver/state and friends (matches claude-share .gitignore)
  ".serena/",
];

// ---------------------------------------------------------------------------
// SSH target validation (security-critical). A value beginning with "-" would
// be parsed by ssh/rsync's own getopt as an option (e.g. -oProxyCommand=<cmd>
// -> local RCE), and metacharacters must never reach a shell. spawn() uses no
// shell, and the user@host token is placed AFTER the -e/-o flags, but we still
// validate strictly and reject anything that isn't a plain username + host.
// ---------------------------------------------------------------------------
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const SSH_HOST_RE = /^(?!-)[A-Za-z0-9._-]{1,253}$|^[0-9a-fA-F:]{2,45}$/;
export const isValidSshTarget = (user, host) =>
  SSH_USER_RE.test(String(user || "")) && SSH_HOST_RE.test(String(host || ""));

const SSH_OPTS = [
  "ssh",
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
].join(" ");

/**
 * Build the argv for a single rsync transfer. Pure + exported for tests.
 * @param {{ claudeDir:string, user:string, host:string, kind:'dir'|'file', name:string }} spec
 * @returns {string[]} rsync argv (no shell)
 */
export function buildRsyncArgs({ claudeDir, user, host, kind, name }) {
  // Bracket IPv6 literals so rsync's host:path split doesn't break on the colons.
  const rhost = host.includes(":") ? `[${host}]` : host;
  const target = `${user}@${rhost}`;
  // No --mkpath here: that flag is rsync 3.2.3+ only and macOS outposts may ship
  // an older rsync (2.6.9) or openrsync. ensureRemoteDirs() pre-creates the
  // .claude/<dir> tree over ssh instead, keeping the flag set portable.
  const base = ["--timeout=30", "-e", SSH_OPTS];
  if (kind === "file") {
    // Single file: no --delete (would nuke siblings), preserve perms+times.
    return [...base, "-pt", path.join(claudeDir, name), `${target}:.claude/${name}`];
  }
  // Directory: MIRROR contents (trailing slashes), archive-ish without owner/
  // group (we cross users), keep safe internal symlinks, drop unsafe ones
  // (e.g. skills/cmux-* -> ../../.agents, which would be broken on the outpost).
  const excludes = RSYNC_EXCLUDES.flatMap((p) => ["--exclude", p]);
  return [
    ...base,
    "-rlpt",
    "--delete",
    "--safe-links",
    ...excludes,
    `${path.join(claudeDir, name)}/`,
    `${target}:.claude/${name}/`,
  ];
}

function runRsync(args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
    const done = (code, err) => {
      if (settled) return;
      settled = true;
      resolve({ code, out: out.trim(), error: err });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(124, "rsync timed out");
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { out += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); done(1, e.message); });
    child.on("close", (code) => { clearTimeout(timer); done(code ?? 1, code === 0 ? undefined : `rsync exit ${code}`); });
  });
}

/**
 * Pre-create the portable dir tree on the outpost so rsync (run WITHOUT --mkpath,
 * for old-rsync/openrsync compatibility) never fails on a missing parent. The dir
 * names are module constants, so the remote `mkdir -p` carries no user input.
 */
function ensureRemoteDirs(user, host, { timeoutMs = 20000 } = {}) {
  const rhost = host.includes(":") ? `[${host}]` : host;
  const target = `${user}@${rhost}`;
  const dirs = [".claude", ...PORTABLE_DIRS.map((d) => `.claude/${d}`)];
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    target,
    `mkdir -p ${dirs.join(" ")}`,
  ];
  return new Promise((resolve) => {
    let err = "";
    let settled = false;
    const done = (ok, error) => { if (!settled) { settled = true; resolve({ ok, error }); } };
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(false, "ssh mkdir timed out"); }, timeoutMs);
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); done(false, e.message); });
    child.on("close", (code) => { clearTimeout(timer); done(code === 0, code === 0 ? undefined : (err.trim() || `ssh exit ${code}`)); });
  });
}

/**
 * Sync the portable config subset to one target. Returns a per-item summary.
 * @param {{ name?:string, sshUser:string, sshHost:string }} target
 * @param {{ claudeDir?:string, at?:string }} [opts]
 */
export async function syncTarget(target, opts = {}) {
  const claudeDir = opts.claudeDir || CLAUDE_DIR;
  const at = opts.at || new Date().toISOString();
  const user = target.sshUser;
  const host = target.sshHost;
  if (!isValidSshTarget(user, host)) {
    return { name: target.name, ok: false, at, error: "invalid ssh user or host", items: [] };
  }

  // Discover what exists locally FIRST, so an outpost with nothing to sync (and
  // the test sandbox) never pays for an ssh round-trip.
  const dirs = PORTABLE_DIRS.filter((n) => safeIsDir(path.join(claudeDir, n)));
  const files = PORTABLE_FILES.filter((n) => existsSync(path.join(claudeDir, n)));
  if (dirs.length === 0 && files.length === 0) {
    return { name: target.name, ok: true, at, error: undefined, items: [] };
  }

  // One ssh round-trip to pre-create the dir tree (replaces --mkpath). If we
  // cannot even reach the outpost, fail the whole target with the ssh error
  // rather than emitting one identical rsync failure per item.
  const prep = await ensureRemoteDirs(user, host);
  if (!prep.ok) {
    return { name: target.name, ok: false, at, error: prep.error || "could not reach outpost over ssh", items: [] };
  }

  const items = [];
  let ok = true;
  for (const name of dirs) {
    const r = await runRsync(buildRsyncArgs({ claudeDir, user, host, kind: "dir", name }));
    const itemOk = r.code === 0;
    ok = ok && itemOk;
    items.push({ name, ok: itemOk, error: itemOk ? undefined : (r.error || r.out || "failed") });
  }
  for (const name of files) {
    const r = await runRsync(buildRsyncArgs({ claudeDir, user, host, kind: "file", name }));
    const itemOk = r.code === 0;
    ok = ok && itemOk;
    items.push({ name, ok: itemOk, error: itemOk ? undefined : (r.error || r.out || "failed") });
  }

  const firstErr = items.find((i) => !i.ok)?.error;
  return { name: target.name, ok, at, error: ok ? undefined : (firstErr || "sync failed"), items };
}

function safeIsDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Target registry — ~/.garrison/outpost-sync-targets.json
// { "<machine>": { name, sshUser, sshHost, addedAt, lastSyncAt, lastSyncOk, lastError } }
// ---------------------------------------------------------------------------

export function readTargets(file = TARGETS_FILE) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeTargets(map, file = TARGETS_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function upsertTarget({ name, sshUser, sshHost }, file = TARGETS_FILE) {
  if (!isValidSshTarget(sshUser, sshHost)) {
    throw new Error("invalid ssh user or host");
  }
  const key = String(name || sshHost).trim();
  if (!key) throw new Error("target name required");
  const map = readTargets(file);
  const prev = map[key] || {};
  map[key] = {
    ...prev,
    name: key,
    sshUser,
    sshHost,
    addedAt: prev.addedAt || new Date().toISOString(),
  };
  writeTargets(map, file);
  return map[key];
}

export function removeTarget(name, file = TARGETS_FILE) {
  const map = readTargets(file);
  const key = String(name || "").trim();
  if (!(key in map)) return false;
  delete map[key];
  writeTargets(map, file);
  return true;
}

function recordSync(name, result, file = TARGETS_FILE) {
  const map = readTargets(file);
  if (!map[name]) return;
  map[name] = {
    ...map[name],
    lastSyncAt: result.at,
    lastSyncOk: result.ok,
    lastError: result.ok ? undefined : (result.error || "sync failed"),
  };
  writeTargets(map, file);
}

// Serialize ALL sync operations. The watcher (debounced), the periodic healer,
// a manual POST /sync and the per-provision initial sync can otherwise overlap,
// running two `rsync --delete` into the same remote .claude/<dir>/ at once
// (interleaved delete/write, spurious failures). Chaining them keeps at most one
// sync in flight; the debounce already coalesces watcher bursts so the queue
// never grows unbounded.
let syncChain = Promise.resolve();
function serialize(task) {
  const next = syncChain.then(task, task);
  syncChain = next.catch(() => {});
  return next;
}

async function doSyncAll(opts) {
  const file = opts.file || TARGETS_FILE;
  const map = readTargets(file);
  const names = Object.keys(map);
  const at = new Date().toISOString();
  const results = [];
  for (const name of names) {
    const t = map[name];
    const r = await syncTarget({ name, sshUser: t.sshUser, sshHost: t.sshHost }, { claudeDir: opts.claudeDir, at });
    recordSync(name, r, file);
    results.push(r);
  }
  return { at, count: names.length, ok: results.every((r) => r.ok), results };
}

async function doSyncOne(name, opts) {
  const file = opts.file || TARGETS_FILE;
  const map = readTargets(file);
  const t = map[name];
  if (!t) return { name, ok: false, error: "no such target", items: [] };
  const r = await syncTarget({ name, sshUser: t.sshUser, sshHost: t.sshHost }, { claudeDir: opts.claudeDir });
  recordSync(name, r, file);
  return r;
}

/** Sync every registered target; persist per-target lastSync status. Serialized. */
export function syncAll(opts = {}) {
  return serialize(() => doSyncAll(opts));
}

/** Sync a single named target; persist its lastSync status. Serialized. */
export function syncOne(name, opts = {}) {
  return serialize(() => doSyncOne(name, opts));
}
