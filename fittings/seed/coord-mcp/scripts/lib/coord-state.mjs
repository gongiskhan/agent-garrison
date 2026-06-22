// coord-state — the ONE coordination-state source. The CLI (`coord status` /
// `coord state --json`), the agent digest, and the Coordination web view all call
// buildCoordState() so they can NEVER disagree (the UI can't show green while the
// CLI shows red). Fully JSON-serializable (no Maps) so the UI consumes it verbatim.
//
// Cost is parameterized so the per-prompt digest stays cheap:
//   { liveness:false, globalSessions:false } -> only this repo's locks/intents/
//     plans/leases (cheap file reads + one bounded lease fetch) — for the digest.
//   { liveness:true,  globalSessions:true  } -> + bd/agent_mail liveness + the
//     machine-wide session scan + hero verdict — for the CLI/UI.
//
// Performance: NEVER parses whole session JSONL files (documented to reach GBs) —
// stat mtime + tail the last bytes only; parse defensively.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recentIntents } from "./intent-store.mjs";
import { recentPlans } from "./plan-store.mjs";
import { beadsLiveness } from "./beads.mjs";
import { agentMailLiveness, fetchActiveLeases } from "./agentmail.mjs";
import { lookbackDays } from "./lookback.mjs";

const RECENT_MS = 30 * 60 * 1000; // RED "zero-write while active now" window
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000; // a session counts as "active" if touched in the last 3h
const MAX_SESSIONS = 60; // cap the payload (glanceable view, not a metrics dump)
const HEARTBEAT_FRESH_MS = 30 * 60 * 1000;

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function claudeHome() {
  const o = process.env.GARRISON_CLAUDE_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".claude");
}
function coordDir() {
  return path.join(garrisonHome(), "coord");
}
export function heartbeatLogPath() {
  return path.join(coordDir(), "heartbeat.log");
}

// Defensive tail: last complete JSON line of a (possibly huge) file.
export function tailLastJsonLine(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* partial trailing line */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Lossy decode of a Claude project dir name back to an approximate cwd.
export function decodeProjectDir(name) {
  return name.replace(/^-/, "/").replace(/-/g, "/");
}

// Heartbeat fires aggregated by session (the inject/read evidence).
function heartbeatBySession() {
  const map = {};
  let txt = "";
  try {
    txt = fs.readFileSync(heartbeatLogPath(), "utf8");
  } catch {
    return map;
  }
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const cur = map[o.session] || { fires: 0, lastTs: 0, conflicts: 0 };
      cur.fires += 1;
      cur.conflicts += o.conflicts || 0;
      const ts = new Date(o.ts).getTime();
      if (!Number.isNaN(ts) && ts > cur.lastTs) cur.lastTs = ts;
      map[o.session] = cur;
    } catch {
      /* skip */
    }
  }
  return map;
}

// Machine-wide active sessions (mtime within lookback), each tagged by repo + a
// plain-language flag. Expensive (scans ~/.claude/projects) — gated by opts.
function gatherSessions(now) {
  const projectsRoot = path.join(claudeHome(), "projects");
  const cutoff = now.getTime() - ACTIVE_WINDOW_MS; // "active" = touched recently, not the full lookback
  const hb = heartbeatBySession();
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(projectsRoot, dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(projectsRoot, dir, f);
      let mtime;
      try {
        mtime = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;
      const sessionId = f.replace(/\.jsonl$/, "");
      const last = tailLastJsonLine(fp);
      const repo = (last && last.cwd) || decodeProjectDir(dir);
      const gitBranch = (last && last.gitBranch) || "";
      const h = hb[sessionId] || { fires: 0, conflicts: 0, lastTs: 0 };
      const ageMinutes = Math.round((now.getTime() - mtime) / 60000);
      const recent = now.getTime() - mtime <= RECENT_MS;
      // RED only flags a CURRENTLY-active session with zero coord writes — the
      // false-confidence "I thought it was working" case. Older = idle.
      const flag = h.fires > 0 ? "active" : recent ? "red" : "idle";
      out.push({
        sessionId,
        repo,
        gitBranch,
        mtimeMs: mtime,
        ageMinutes,
        recent,
        fires: h.fires,
        conflicts: h.conflicts,
        flag
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, MAX_SESSIONS);
}

// All planning locks (machine-wide), each enriched with expired + waiters. Cheap.
function gatherLocks(now, focusRepo) {
  const dir = path.join(coordDir(), "plan-locks");
  const locks = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".waiters.json"));
  } catch {
    return locks;
  }
  for (const f of files) {
    let lock;
    try {
      lock = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!lock || !lock.repo) continue;
    let waiters = [];
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.json$/, ".waiters.json")), "utf8"));
      waiters = Object.entries(w).map(([session, v]) => ({
        session,
        since: v.since,
        summary: v.summary,
        waitMinutes: v.since ? Math.round((now.getTime() - new Date(v.since).getTime()) / 60000) : 0
      }));
    } catch {
      /* none */
    }
    const expired = !lock.expiresAt || new Date(lock.expiresAt).getTime() <= now.getTime();
    locks.push({
      repo: lock.repo,
      session: lock.session,
      summary: lock.summary || "",
      startedAt: lock.startedAt,
      expiresAt: lock.expiresAt,
      heldMinutes: lock.startedAt ? Math.round((now.getTime() - new Date(lock.startedAt).getTime()) / 60000) : 0,
      expired,
      isFocus: focusRepo ? lock.repo === focusRepo : false,
      waiters
    });
  }
  return locks;
}

// All recent intents (machine-wide) within lookback, newest first.
function gatherIntents(now) {
  const dir = path.join(coordDir(), "intents");
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  const cutoff = now.getTime() - lookbackDays(now) * 86400_000;
  for (const f of files) {
    let txt = "";
    try {
      txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        const ts = new Date(o.ts).getTime();
        if (!Number.isNaN(ts) && ts >= cutoff) out.push(o);
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return out;
}

// Derive the one-second hero verdict. Honest: degraded/down dominate green.
export function deriveHeroVerdict({ liveness, sessions, locks, recentHeartbeat }) {
  const beadsUp = liveness ? Boolean(liveness.beads && liveness.beads.up) : null;
  const agentMailUp = liveness ? Boolean(liveness.agentMail && liveness.agentMail.up) : null;
  const activeSessions = sessions.filter((s) => s.recent).length;
  const redSessions = sessions.filter((s) => s.flag === "red").length;
  const staleLocks = locks.filter((l) => l.expired).length;
  const reasons = [];

  // Server health
  if (liveness) {
    if (!beadsUp && !agentMailUp) {
      return {
        overall: "down",
        reasons: ["Beads CLI and agent_mail are both DOWN — coordination infrastructure is unavailable."],
        details: { beadsUp, agentMailUp, activeSessions, redSessions, staleLocks, recentHeartbeat }
      };
    }
    if (!beadsUp) reasons.push("Beads CLI is DOWN.");
    if (!agentMailUp) reasons.push("agent_mail server is DOWN.");
  }
  if (redSessions > 0) reasons.push(`${redSessions} session(s) running with ZERO coordination writes — may be working blind.`);
  if (staleLocks > 0) reasons.push(`${staleLocks} stale planning lock(s) past TTL.`);
  if (liveness && activeSessions > 0 && recentHeartbeat === false) reasons.push(`${activeSessions} active session(s) but no recent hook injections — the coordination hook may not be firing.`);

  if (reasons.length > 0) {
    return { overall: "degraded", reasons, details: { beadsUp, agentMailUp, activeSessions, redSessions, staleLocks, recentHeartbeat } };
  }
  if (liveness && activeSessions === 0) {
    return { overall: "idle", reasons: ["Coordination servers are up; no sessions are currently active."], details: { beadsUp, agentMailUp, activeSessions, redSessions, staleLocks, recentHeartbeat } };
  }
  return {
    overall: "live-and-used",
    reasons: [`${activeSessions} active session(s) coordinating; servers up; locks healthy.`],
    details: { beadsUp, agentMailUp, activeSessions, redSessions, staleLocks, recentHeartbeat }
  };
}

function hasRecentHeartbeat(now) {
  const hb = heartbeatBySession();
  for (const v of Object.values(hb)) if (now.getTime() - v.lastTs <= HEARTBEAT_FRESH_MS) return true;
  return false;
}

// Hook heartbeat summary for the view's "is the hook firing?" element: last
// injection time + size + recent fire count. Reads the log tail defensively.
function gatherHeartbeatSummary(now) {
  let txt = "";
  try {
    txt = fs.readFileSync(heartbeatLogPath(), "utf8");
  } catch {
    return { lastTs: null, lastBytes: null, firesInWindow: 0, total: 0, fresh: false };
  }
  const lines = txt.split("\n").filter((l) => l.trim());
  let last = null;
  for (let i = lines.length - 1; i >= 0 && !last; i--) {
    try {
      last = JSON.parse(lines[i]);
    } catch {
      /* partial */
    }
  }
  let firesInWindow = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (now.getTime() - new Date(o.ts).getTime() <= HEARTBEAT_FRESH_MS) firesInWindow += 1;
    } catch {
      /* skip */
    }
  }
  const lastTs = last ? last.ts : null;
  return {
    lastTs,
    lastBytes: last ? last.digestBytes : null,
    firesInWindow,
    total: lines.length,
    fresh: lastTs ? now.getTime() - new Date(lastTs).getTime() <= HEARTBEAT_FRESH_MS : false
  };
}

// THE source. focusRepo scopes leases + flags the primary repo; sessions/locks/
// intents are machine-wide so the view can group by repo.
export async function buildCoordState(focusRepo, now = new Date(), opts = {}) {
  const { liveness = true, globalSessions = true, leases = true } = opts;

  let live = null;
  if (liveness) {
    live = { beads: beadsLiveness(), agentMail: await agentMailLiveness() };
  }
  const sessions = globalSessions ? gatherSessions(now) : [];
  const locks = gatherLocks(now, focusRepo);
  const intents = gatherIntents(now);
  let leaseList = [];
  if (leases) {
    try {
      leaseList = await fetchActiveLeases(focusRepo);
    } catch {
      leaseList = [];
    }
  }
  const recentHeartbeat = liveness ? hasRecentHeartbeat(now) : null;

  const state = {
    repo: focusRepo,
    timestamp: now.toISOString(),
    lookbackDays: lookbackDays(now),
    liveness: live,
    sessions,
    locks,
    recentIntents: intents,
    recentPlans: recentPlans(focusRepo, now),
    leases: leaseList
  };
  if (liveness && globalSessions) {
    state.heartbeat = gatherHeartbeatSummary(now);
    state.heroVerdict = deriveHeroVerdict({ liveness: live, sessions, locks, recentHeartbeat });
  }
  return state;
}
