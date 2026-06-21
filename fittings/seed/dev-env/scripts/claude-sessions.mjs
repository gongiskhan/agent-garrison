// Readers over Claude Code's own on-disk session data — the substrate for the
// dev-env Agents (live) and History (past) panels and for liveness detection.
//
// Two sources, both owned by Claude Code (NOT Garrison):
//   ~/.claude/sessions/<pid>.json   — the LIVE registry: one tiny file per
//       running interactive `claude`, deleted on exit. Carries
//       { pid, sessionId, cwd, startedAt, procStart, status?, updatedAt?, kind? }.
//   ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl — the transcript per session;
//       latest `type:"ai-title"` entry is the human title; per-entry cwd/branch.
//
// This module is intentionally SELF-CONTAINED: state.mjs imports IT (DS2), so it
// must never import back from state.mjs (circular load + side effects). Path
// resolution is done at CALL time (not module load) so the test suite can point
// it at a sandbox via GARRISON_CLAUDE_HOME (or the finer-grained overrides).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── path resolution (call-time; sandbox-overridable) ───────────────────────
function claudeHome() {
  const h = process.env.GARRISON_CLAUDE_HOME && process.env.GARRISON_CLAUDE_HOME.trim();
  return h ? h : path.join(os.homedir(), ".claude");
}
function sessionsDir() {
  const o = process.env.GARRISON_CLAUDE_SESSIONS_DIR && process.env.GARRISON_CLAUDE_SESSIONS_DIR.trim();
  return o ? o : path.join(claudeHome(), "sessions");
}
function projectsDir() {
  // Mirrors @garrison/claude-pty paths.mjs (GARRISON_CLAUDE_PROJECTS_DIR), but
  // also honours GARRISON_CLAUDE_HOME so one env var sandboxes both readers.
  const o = process.env.GARRISON_CLAUDE_PROJECTS_DIR && process.env.GARRISON_CLAUDE_PROJECTS_DIR.trim();
  return o ? o : path.join(claudeHome(), "projects");
}

// ── liveness + internal-cwd filtering ──────────────────────────────────────
// process.kill(pid, 0) probes existence without signalling: throws ESRCH when
// the process is gone, EPERM when it's alive but not ours (still alive).
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

// Real start-time (epoch ms) lookup for a set of pids, one batched `ps`. Used to
// defeat same-boot pid reuse: a stale registry file revived by a reused pid has a
// process whose actual start time differs from the file's recorded `startedAt`.
// `ps -o lstart` prints LOCAL time, so Date.parse yields the correct instant to
// compare against `startedAt` (epoch ms) — a timezone-robust EPOCH compare, NOT a
// string compare. (Claude records procStart in UTC while ps prints local, so a
// string compare drops every live session — verified against the real registry.)
// Best-effort: if ps is unavailable the map is empty and verification is skipped.
// Injectable for tests.
function defaultStartTimeOf(pids) {
  const map = new Map();
  if (!pids.length) return map;
  try {
    const out = execFileSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      timeout: 2_000
    });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const epoch = Date.parse(m[2].trim());
      if (Number.isFinite(epoch)) map.set(Number(m[1]), epoch);
    }
  } catch {
    /* ps missing/blocked → graceful: no verification */
  }
  return map;
}

// Cwds that are Garrison's own machinery or a workspace container, not a real
// session worth listing as an Agent. Self-contained (no isBroadRoot import) to
// keep state.mjs ↔ claude-sessions.mjs acyclic; the broad-root set mirrors
// state.mjs's intent (~, ~/dev, ~/Projects). Note ~/.claude is deliberately NOT
// internal — a real `claude` editing its own config is a session the user wants.
export function isInternalCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return true;
  const home = os.homedir();
  if (cwd === home || cwd === path.join(home, "dev") || cwd === path.join(home, "Projects")) return true;
  const garrison = path.join(home, ".garrison");
  if (cwd === garrison || cwd.startsWith(garrison + path.sep)) return true; // exact root + descendants
  if (cwd.includes(path.sep + ".garrison" + path.sep)) return true; // a .garrison not under home (paranoia)
  if (cwd.includes("/compositions/default")) return true; // gateway / operative scratch
  return false;
}

// Read the live registry. Returns one row per ALIVE, non-internal, this-boot
// interactive `claude`, with a start-time match defeating same-boot pid reuse.
// `status`/`updatedAt` are passed through when present (newer Claude Code
// versions write them) but are SUPPLEMENTARY — busy/idle/waiting stays hook +
// claudeBusy() driven in state.mjs.
export function readLiveRegistry({ excludeCwd = isInternalCwd, startTimeOf = defaultStartTimeOf } = {}) {
  let files;
  try {
    files = fs.readdirSync(sessionsDir());
  } catch {
    return []; // no sessions dir yet
  }
  // A process that started before this boot cannot be running now — its registry
  // file is a crash/reboot leftover (the dominant stale case, exactly what
  // reboot-survival must not resurrect).
  const bootMs = Date.now() - os.uptime() * 1000;
  const STALE_SKEW_MS = 5_000;
  const START_SKEW_MS = 5_000; // tolerance for the reuse epoch compare (ps is second-precision)

  const candidates = []; // { row, pid, startedAt }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8"));
    } catch {
      continue; // unreadable / mid-write / not JSON
    }
    if (!j || typeof j !== "object") continue;
    const { pid, sessionId, cwd, startedAt } = j;
    if (!sessionId || !cwd) continue;
    // Integrity: a `<pid>.json` filename must agree with the JSON's pid (catches
    // a copied/renamed/foreign-pid file). Non-numeric names skip the check.
    const stem = f.slice(0, -".json".length);
    if (/^\d+$/.test(stem) && Number(stem) !== pid) continue;
    if (!isPidAlive(pid)) continue; // drop stale/dead pids
    if (typeof startedAt === "number" && startedAt < bootMs - STALE_SKEW_MS) continue; // pre-boot leftover
    if (excludeCwd && excludeCwd(cwd)) continue;
    candidates.push({
      pid,
      startedAt: typeof startedAt === "number" ? startedAt : null,
      row: {
        sessionId,
        cwd,
        pid,
        startedAt: typeof startedAt === "number" ? startedAt : null,
        status: typeof j.status === "string" ? j.status : null,
        updatedAt: typeof j.updatedAt === "number" ? j.updatedAt : null,
        kind: typeof j.kind === "string" ? j.kind : null
      }
    });
  }

  // Same-boot pid-reuse guard: for candidates that recorded a startedAt, compare
  // it to the process's ACTUAL start time (one batched ps, epoch-compared). A
  // mismatch beyond the skew means the pid was reused → the file is stale.
  const toVerify = candidates.filter((c) => typeof c.startedAt === "number");
  if (toVerify.length) {
    const actual = startTimeOf(toVerify.map((c) => c.pid));
    if (actual && actual.size) {
      return candidates
        .filter((c) => {
          if (typeof c.startedAt !== "number") return true;
          const a = actual.get(c.pid);
          return a == null || Math.abs(a - c.startedAt) <= START_SKEW_MS; // unknown → keep
        })
        .map((c) => c.row);
    }
  }
  return candidates.map((c) => c.row);
}

// ── transcript history reader ──────────────────────────────────────────────
const HEAD_BYTES = 8 * 1024; // first line(s): cwd/branch/start/first user msg
// Progressive backward windows for the latest ai-title (Claude rewrites it every
// turn, so it clusters near EOF). We try increasingly large tails, stopping as
// soon as one is found; the cap bounds work on a pathological multi-MB file.
const TITLE_SCAN_WINDOWS = [64 * 1024, 512 * 1024, 4 * 1024 * 1024];
const TITLE_SNIPPET_MAX = 80;
const MAX_CACHE = 2_000; // bound the mtime cache over a long-running server
const DEFAULT_MAX_SCAN = 20_000; // safety ceiling on files statted per call (logs if hit)

// mtime-keyed cache so large transcripts aren't re-parsed every poll.
const historyCache = new Map(); // absPath -> { mtimeMs, value }

function cacheSet(absPath, mtimeMs, value) {
  historyCache.set(absPath, { mtimeMs, value });
  if (historyCache.size > MAX_CACHE) {
    const excess = historyCache.size - MAX_CACHE;
    let i = 0;
    for (const k of historyCache.keys()) {
      if (i++ >= excess) break;
      historyCache.delete(k);
    }
  }
}

function* parseJsonLines(buf) {
  // Yield parseable whole lines. A partial fragment at a head/tail boundary (or
  // any non-JSON line) fails JSON.parse → skipped, so only complete records emit.
  const text = buf.toString("utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      yield JSON.parse(s);
    } catch {
      /* partial boundary line / non-JSON — skip */
    }
  }
}

function readChunk(fd, len, position) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, position);
  return b.subarray(0, n);
}

function latestAiTitleIn(buf) {
  let t = null;
  for (const e of parseJsonLines(buf)) {
    if (e.type === "ai-title" && typeof e.aiTitle === "string") t = e.aiTitle; // last wins
  }
  return t;
}

// The latest ai-title for a file, scanning progressively larger tails until one
// is found or the cap is exhausted. For a small (whole-file-in-head) read the
// head already holds it. A head ai-title on a big file is an OLD one — ignored.
function findLatestAiTitle(fd, size, headAiTitle) {
  if (size <= HEAD_BYTES) return headAiTitle;
  for (const w of TITLE_SCAN_WINDOWS) {
    const len = Math.min(size, w);
    const found = latestAiTitleIn(readChunk(fd, len, size - len));
    if (found) return found;
    if (len >= size) break; // whole file already scanned
  }
  return null;
}

function userMessageSnippet(entry) {
  const msg = entry && entry.message;
  if (!msg) return null;
  let text = null;
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    const part = msg.content.find((p) => p && p.type === "text" && typeof p.text === "string");
    text = part ? part.text : null;
  }
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine || oneLine.startsWith("<")) return null; // skip command/tool envelopes like <command-name>
  return oneLine.length > TITLE_SNIPPET_MAX ? oneLine.slice(0, TITLE_SNIPPET_MAX - 1) + "…" : oneLine;
}

// Cheap per-file metadata. Head holds cwd/branch/start + first-user fallback;
// the LATEST ai-title is read from the tail (it is rewritten every turn, so it
// lives near the end). For a huge file whose initial tail window has no ai-title,
// the tail is lazily expanded once before falling back to the user snippet.
function readTranscriptMeta(absPath, sessionId, mtimeMs) {
  const cached = historyCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let fd;
  let value = null;
  try {
    fd = fs.openSync(absPath, "r");
    const { size } = fs.fstatSync(fd);

    const head = readChunk(fd, Math.min(size, HEAD_BYTES), 0);
    let cwd = null;
    let gitBranch = null;
    let startedAt = null;
    let firstUserSnippet = null;
    let headAiTitle = null;
    for (const e of parseJsonLines(head)) {
      if (cwd == null && typeof e.cwd === "string") cwd = e.cwd;
      if (gitBranch == null && typeof e.gitBranch === "string") gitBranch = e.gitBranch;
      if (startedAt == null && typeof e.timestamp === "string") startedAt = e.timestamp;
      if (e.type === "ai-title" && typeof e.aiTitle === "string") headAiTitle = e.aiTitle;
      if (firstUserSnippet == null && e.type === "user") firstUserSnippet = userMessageSnippet(e);
    }

    const latestAiTitle = findLatestAiTitle(fd, size, headAiTitle);
    if (cwd == null && size > HEAD_BYTES) {
      // cwd is normally on the first line; only fall to the tail if the head missed it.
      const tailLen = Math.min(size, TITLE_SCAN_WINDOWS[0]);
      for (const e of parseJsonLines(readChunk(fd, tailLen, size - tailLen))) {
        if (typeof e.cwd === "string") { cwd = e.cwd; break; }
      }
    }

    // first-user is the deliberate fallback for a GENUINELY title-less session —
    // the progressive scan above makes an unsampled latest ai-title non-material.
    const title = latestAiTitle || firstUserSnippet || null;
    value = { sessionId, cwd, gitBranch, title, startedAt, lastActivityAt: mtimeMs };
  } catch {
    value = null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  cacheSet(absPath, mtimeMs, value);
  return value;
}

// List past sessions from the transcript store, newest first. Recency is taken
// from each FILE's mtime (a transcript is appended in place, which does NOT bump
// its parent dir's mtime — so dir mtime is the wrong signal). stat is cheap; the
// expensive content read is bounded to the top `limit`. `maxScan` is a safety
// ceiling that LOGS if hit rather than silently truncating. Filtering out
// currently-live / open-as-tab sessions is the CONSUMER's job (server.mjs).
export function listHistory({ windowDays = 30, limit = 100, maxScan = DEFAULT_MAX_SCAN } = {}) {
  const root = projectsDir();
  let rootDir;
  try {
    rootDir = fs.opendirSync(root);
  } catch {
    return [];
  }
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
  const candidates = []; // { absPath, sessionId, mtimeMs }
  let scanned = 0;
  let truncated = false;
  // Incremental iteration (opendir/readSync) so the maxScan budget bounds the
  // directory enumeration too, not just the stat calls — a transcript append
  // does not bump its parent dir's mtime, so FILE mtime is the only correct
  // recency signal and every in-budget file must be statted.
  try {
    let dirent;
    outer: while ((dirent = rootDir.readSync()) !== null) {
      if (!dirent.isDirectory()) continue;
      const dir = path.join(root, dirent.name);
      let sub;
      try {
        sub = fs.opendirSync(dir);
      } catch {
        continue;
      }
      try {
        let fent;
        while ((fent = sub.readSync()) !== null) {
          if (!fent.name.endsWith(".jsonl")) continue;
          if (scanned >= maxScan) {
            truncated = true;
            break outer;
          }
          scanned++;
          const absPath = path.join(dir, fent.name);
          let st;
          try {
            st = fs.statSync(absPath);
          } catch {
            continue;
          }
          if (st.mtimeMs < cutoff) continue;
          candidates.push({ absPath, sessionId: fent.name.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs });
        }
      } finally {
        sub.closeSync();
      }
    }
  } finally {
    rootDir.closeSync();
  }
  if (truncated) {
    console.warn(`[dev-env] listHistory: scan budget ${maxScan} reached — history may be incomplete`);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const c of candidates.slice(0, limit)) {
    const meta = readTranscriptMeta(c.absPath, c.sessionId, c.mtimeMs);
    if (meta) out.push(meta);
  }
  return out;
}
