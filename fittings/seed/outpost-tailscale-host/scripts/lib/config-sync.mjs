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
// ADOPT-BEFORE-DELETE (the outpost's own Quarters changes survive). A pure
// `--delete` mirror silently destroyed anything installed on an OUTPOST: a skill
// promoted into that machine's ~/.claude (Quarters) was wiped by the next heal,
// ~10 minutes later, with no record anywhere. Observed live - `scroll-world` and
// taste's two skills were deleted four times in one afternoon on dev-madrid.
//
// So before mirroring a directory we ask rsync (dry-run) which top-level entries
// `--delete` WOULD remove on that outpost, and split them by ORIGIN using the
// per-target `mirrored` ledger (the entries this host last pushed there):
//
//   in the ledger  -> the HOST retired it. Mirror the deletion, as before.
//   not in ledger  -> it ORIGINATED on the outpost, after the last sync (had it
//                     existed before, the previous mirror would already have
//                     deleted it). Pull it back into THIS host's ~/.claude -
//                     i.e. read it back into Quarters, where reconcile.ts picks
//                     it up as a loose primitive - and let the mirror then
//                     propagate it to every other outpost.
//
// Adoption is per TOP-LEVEL entry (one skill dir, one command file), never a
// nested file: inside an entry the host stays authoritative, so a host-side edit
// that removes a file from a shared skill still propagates. With no ledger yet
// (a target added before this change, or whose first sync has not landed) every
// remote-only entry is adopted - the safe direction is never to destroy.
// Set GARRISON_OUTPOST_SYNC_STRICT_MIRROR=1 to restore the old pure-mirror
// behaviour.
//
// Deliberately NOT synced: settings.json / plugins / mcp.json (machine-specific
// hook ports, absolute installPaths, model tokens), and everything ephemeral
// (projects/, sessions/, todos/, statsig/, logs/, credentials, the vault).
// Those are what made the old wholesale claude-share git sync churn and diverge.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, lstatSync, readdirSync } from "node:fs";
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

/**
 * Build the argv for a DRY-RUN of the directory mirror, itemized, so we can read
 * off exactly which paths `--delete` would remove on the outpost. Same flag set
 * as the real transfer (identical include/exclude semantics) plus --dry-run and
 * --itemize-changes; nothing is written on either side.
 * @param {{ claudeDir:string, user:string, host:string, name:string }} spec
 * @returns {string[]} rsync argv (no shell)
 */
export function buildDeleteProbeArgs({ claudeDir, user, host, name }) {
  return [
    ...buildRsyncArgs({ claudeDir, user, host, kind: "dir", name }),
    "--dry-run",
    "--itemize-changes",
  ];
}

/**
 * Parse `*deleting <path>` lines out of an itemized rsync dry-run and reduce
 * them to the set of TOP-LEVEL entry names under the synced directory. rsync
 * emits one line per path (`*deleting   scroll-world/SKILL.md`,
 * `*deleting   scroll-world/`), so the first path segment is the entry.
 * Pure + exported for tests.
 * @param {string} out raw rsync stdout+stderr
 * @returns {string[]} unique top-level entry names, in first-seen order
 */
export function parseDeletedEntries(out) {
  const entries = [];
  for (const line of String(out || "").split("\n")) {
    const m = /^\*deleting\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    // Strip any leading "./" and take the first path segment.
    const rel = m[1].replace(/^\.\//, "");
    const entry = rel.split("/")[0];
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

// An adoptable entry name is read off a REMOTE machine's filesystem and then
// embedded in an rsync remote spec (`user@host:.claude/<dir>/<entry>`), which
// rsync hands to the remote shell, and used as a LOCAL destination path. So it
// is untrusted input on both ends: reject anything that could traverse out of
// the portable dir (`..`, a slash), be parsed as an option by rsync's getopt (a
// leading `-`), or reach a shell (quotes, $, ;, backticks, whitespace, glob).
// Anything not matching is not adopted AND suppresses the mirror for that dir -
// refusing to delete is always the safe direction.
const SAFE_ENTRY_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
export const isSafeEntry = (entry) =>
  typeof entry === "string" &&
  entry.length > 0 &&
  entry.length <= 255 &&
  entry !== "." &&
  entry !== ".." &&
  SAFE_ENTRY_RE.test(entry);

/**
 * Build the argv that PULLS one top-level entry back from the outpost into this
 * host's ~/.claude (adoption). No --delete and no trailing slashes: rsync copies
 * `<entry>` itself into the local directory, which works for both a skill dir
 * and a single command/rule file.
 * @param {{ claudeDir:string, user:string, host:string, name:string, entry:string }} spec
 * @returns {string[]} rsync argv (no shell)
 */
export function buildAdoptArgs({ claudeDir, user, host, name, entry }) {
  if (!isSafeEntry(entry)) throw new Error(`unsafe entry name: ${entry}`);
  const rhost = host.includes(":") ? `[${host}]` : host;
  const target = `${user}@${rhost}`;
  const excludes = RSYNC_EXCLUDES.flatMap((p) => ["--exclude", p]);
  return [
    "--timeout=30",
    "-e", SSH_OPTS,
    "-rlpt",
    "--safe-links",
    ...excludes,
    `${target}:.claude/${name}/${entry}`,
    `${path.join(claudeDir, name)}/`,
  ];
}

/**
 * Split the entries a mirror would delete into the ones the HOST retired (mirror
 * the deletion) and the ones that ORIGINATED on the outpost (adopt them back).
 * An entry that exists locally is never in either list - rsync would not be
 * deleting it. Pure + exported for tests.
 * `unsafe` collects outpost-originated entries whose NAME we refuse to handle
 * (see isSafeEntry); the caller must skip the mirror for that dir rather than
 * let --delete remove something it could not adopt.
 * @param {string[]} deleted top-level entries the dry-run would remove
 * @param {string[]|undefined} previouslyMirrored ledger for this target+dir
 * @returns {{ retired:string[], adopt:string[], unsafe:string[] }}
 */
export function classifyDeletions(deleted, previouslyMirrored) {
  // No ledger (target predates this change, or its first sync never landed):
  // we cannot prove the host ever owned these, so never destroy them.
  const ledger = Array.isArray(previouslyMirrored) ? previouslyMirrored : null;
  const retired = [];
  const adopt = [];
  const unsafe = [];
  for (const entry of deleted) {
    // A ledger hit is the host's OWN entry name, already proven safe by having
    // been pushed from here — retiring it needs no adoption and no pull.
    if (ledger && ledger.includes(entry)) retired.push(entry);
    else if (isSafeEntry(entry)) adopt.push(entry);
    else unsafe.push(entry);
  }
  return { retired, adopt, unsafe };
}

/** Top-level entry names inside a local portable dir (the ledger we record). */
export function localEntries(claudeDir, name) {
  try {
    return readdirSync(path.join(claudeDir, name)).sort();
  } catch {
    return [];
  }
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

/** Pure-mirror mode: no adoption, `--delete` wins (the pre-adoption behaviour). */
export const strictMirror = () => process.env.GARRISON_OUTPOST_SYNC_STRICT_MIRROR === "1";

/**
 * Sync the portable config subset to one target. Returns a per-item summary.
 * @param {{ name?:string, sshUser:string, sshHost:string }} target
 * @param {{ claudeDir?:string, at?:string, mirrored?:Record<string,string[]>,
 *           runRsync?:(args:string[])=>Promise<{code:number,out:string,error?:string}>,
 *           ensureRemoteDirs?:(user:string,host:string)=>Promise<{ok:boolean,error?:string}> }} [opts]
 *   opts.mirrored is the target's ledger from the last successful sync:
 *   { <portable dir>: [top-level entries this host pushed] }.
 *   opts.runRsync / opts.ensureRemoteDirs are seams for tests (same shape as the
 *   module-private defaults), so the adopt/mirror orchestration is exercisable
 *   without ssh — mirroring the injectable ApmRunner convention in src/lib.
 */
export async function syncTarget(target, opts = {}) {
  const claudeDir = opts.claudeDir || CLAUDE_DIR;
  const at = opts.at || new Date().toISOString();
  const prevMirrored = opts.mirrored && typeof opts.mirrored === "object" ? opts.mirrored : {};
  const rsync = opts.runRsync || runRsync;
  const prepDirs = opts.ensureRemoteDirs || ensureRemoteDirs;
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
  const prep = await prepDirs(user, host);
  if (!prep.ok) {
    return { name: target.name, ok: false, at, error: prep.error || "could not reach outpost over ssh", items: [] };
  }

  const items = [];
  const mirrored = {};
  let ok = true;
  for (const name of dirs) {
    // ADOPT phase — pull back anything the mirror would delete that this host
    // never pushed (it originated on the outpost, i.e. a Quarters change made
    // there since the last sync). Best-effort: a probe or pull failure must not
    // fail the sync, but it MUST suppress the mirror for that dir, or the very
    // deletion we were trying to avoid happens anyway.
    let adopted = [];
    let adoptFailed = false;
    if (!strictMirror()) {
      const probe = await rsync(buildDeleteProbeArgs({ claudeDir, user, host, name }));
      if (probe.code === 0) {
        const { adopt, unsafe } = classifyDeletions(parseDeletedEntries(probe.out), prevMirrored[name]);
        if (unsafe.length) adoptFailed = true;
        for (const entry of adopt) {
          const pull = await rsync(buildAdoptArgs({ claudeDir, user, host, name, entry }));
          if (pull.code === 0) adopted.push(entry);
          else adoptFailed = true;
        }
      } else {
        // Could not determine what would be deleted — do not mirror this dir
        // blind, or --delete may destroy an un-probed outpost-side addition.
        adoptFailed = true;
      }
    }
    if (adoptFailed) {
      ok = false;
      items.push({
        name,
        ok: false,
        adopted: adopted.length ? adopted : undefined,
        error: "could not adopt outpost-side changes; mirror skipped to avoid deleting them",
      });
      continue;
    }

    const r = await rsync(buildRsyncArgs({ claudeDir, user, host, kind: "dir", name }));
    const itemOk = r.code === 0;
    ok = ok && itemOk;
    // Ledger AFTER adoption, so an adopted entry counts as host-owned from now
    // on and a later host-side removal of it propagates normally.
    if (itemOk) mirrored[name] = localEntries(claudeDir, name);
    items.push({
      name,
      ok: itemOk,
      adopted: adopted.length ? adopted : undefined,
      error: itemOk ? undefined : (r.error || r.out || "failed"),
    });
  }
  for (const name of files) {
    const r = await rsync(buildRsyncArgs({ claudeDir, user, host, kind: "file", name }));
    const itemOk = r.code === 0;
    ok = ok && itemOk;
    items.push({ name, ok: itemOk, error: itemOk ? undefined : (r.error || r.out || "failed") });
  }

  const firstErr = items.find((i) => !i.ok)?.error;
  const adopted = items.flatMap((i) => (i.adopted ?? []).map((e) => `${i.name}/${e}`));
  return {
    name: target.name,
    ok,
    at,
    error: ok ? undefined : (firstErr || "sync failed"),
    items,
    mirrored,
    adopted,
  };
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
  // Merge the per-dir ledger rather than replacing it: a dir whose mirror failed
  // this round reports nothing, and dropping its entries would make every one of
  // them look outpost-originated (and so adoptable) on the next pass.
  const mirrored = { ...(map[name].mirrored || {}), ...(result.mirrored || {}) };
  map[name] = {
    ...map[name],
    lastSyncAt: result.at,
    lastSyncOk: result.ok,
    lastError: result.ok ? undefined : (result.error || "sync failed"),
    mirrored,
    lastAdopted: result.adopted?.length ? result.adopted : undefined,
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
    const r = await syncTarget(
      { name, sshUser: t.sshUser, sshHost: t.sshHost },
      {
        claudeDir: opts.claudeDir,
        at,
        mirrored: t.mirrored,
        runRsync: opts.runRsync,
        ensureRemoteDirs: opts.ensureRemoteDirs,
      }
    );
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
  const r = await syncTarget(
    { name, sshUser: t.sshUser, sshHost: t.sshHost },
    {
      claudeDir: opts.claudeDir,
      mirrored: t.mirrored,
      runRsync: opts.runRsync,
      ensureRemoteDirs: opts.ensureRemoteDirs,
    }
  );
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
