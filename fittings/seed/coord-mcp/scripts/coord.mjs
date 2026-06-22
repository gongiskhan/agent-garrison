#!/usr/bin/env node
// coord — the coordination observability CLI. Proves the advisory coordination is
// not silently dead. Subcommands:
//   coord status         liveness + per-repo activity + planning-lock state
//   coord status --tail  tail the hook heartbeat log
//   coord canary         self-test the write->detect->inject chain (direct path)
//
// Performance: NEVER parses whole session JSONL files (documented to reach GBs).
// Uses stat mtime for liveness and tails only the last bytes; parses defensively.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(HOME, ".garrison");
}
function claudeHome() {
  const o = process.env.GARRISON_CLAUDE_HOME;
  return o && o.trim().length > 0 ? o : path.join(HOME, ".claude");
}
function coordDir() {
  return path.join(garrisonHome(), "coord");
}
function heartbeatLog() {
  return path.join(coordDir(), "heartbeat.log");
}

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`
};

// ---- lookback (re-derived; the CLI must not import test-only state) ----
function lookbackDays(now) {
  const d = now.getDay();
  if (d === 0 || d === 6) return 7;
  if (d === 1) return 5;
  return 3;
}

// ---- Layer 1: liveness ----
function beadsLiveness() {
  const start = Date.now();
  try {
    execFileSync("bd", ["version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 4000 });
    return { up: true, latencyMs: Date.now() - start };
  } catch {
    return { up: false };
  }
}
async function agentMailLiveness() {
  try {
    const { agentMailLiveness: live } = await import(path.join(__dirname, "lib", "agentmail.mjs"));
    return await live(2000);
  } catch {
    return { up: false, reason: "lib-error" };
  }
}

// ---- defensive JSONL tail (last complete line) ----
function tailLastJsonLine(file, bytes = 65536) {
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
        /* partial trailing line — keep going up */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Decode a Claude project dir name back to an approximate cwd (/. -> -, lossy).
function decodeProjectDir(name) {
  return name.replace(/^-/, "/").replace(/-/g, "/");
}

// ---- Layer 2: active sessions grouped by repo ----
function activeSessions(now) {
  const projectsRoot = path.join(claudeHome(), "projects");
  const cutoff = now.getTime() - lookbackDays(now) * 86400_000;
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const full = path.join(projectsRoot, dir);
    let files = [];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(full, f);
      let mtime;
      try {
        mtime = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue; // not active within lookback
      const sessionId = f.replace(/\.jsonl$/, "");
      const last = tailLastJsonLine(fp);
      const cwd = (last && last.cwd) || decodeProjectDir(dir);
      const gitBranch = (last && last.gitBranch) || "";
      out.push({ sessionId, repo: cwd, gitBranch, mtimeMs: mtime });
    }
  }
  return out;
}

// Heartbeat fires per session (from our own log — the inject/read evidence).
function heartbeatBySession() {
  const map = new Map();
  let txt = "";
  try {
    txt = fs.readFileSync(heartbeatLog(), "utf8");
  } catch {
    return map;
  }
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const cur = map.get(o.session) || { fires: 0, lastTs: 0, conflicts: 0 };
      cur.fires += 1;
      cur.conflicts += o.conflicts || 0;
      const ts = new Date(o.ts).getTime();
      if (ts > cur.lastTs) cur.lastTs = ts;
      map.set(o.session, cur);
    } catch {
      /* skip */
    }
  }
  return map;
}

// Intents per repo (from our intent store).
function intentCountByRepo() {
  const map = new Map();
  const dir = path.join(coordDir(), "intents");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return map;
  }
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
        map.set(o.repo, (map.get(o.repo) || 0) + 1);
      } catch {
        /* skip */
      }
    }
  }
  return map;
}

// ---- Layer 5: planning-lock state ----
function planLockState(now) {
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
    const wp = path.join(dir, f.replace(/\.json$/, ".waiters.json"));
    try {
      const w = JSON.parse(fs.readFileSync(wp, "utf8"));
      waiters = Object.entries(w).map(([session, v]) => ({ session, since: v.since, summary: v.summary }));
    } catch {
      /* none */
    }
    const expired = new Date(lock.expiresAt).getTime() <= now.getTime();
    locks.push({ ...lock, expired, waiters });
  }
  return locks;
}

const SILENT_THRESHOLD_MS = 10 * 60 * 1000; // active >10min with zero hook fires = RED

async function status() {
  const now = new Date();
  console.log(C.bold("\nCoordination status\n"));

  // Layer 1 — liveness
  console.log(C.bold("Liveness"));
  const beads = beadsLiveness();
  const am = await agentMailLiveness();
  console.log(`  Beads (bd CLI):   ${beads.up ? C.green("UP") : C.red("DOWN")}${beads.up ? C.dim(`  ${beads.latencyMs}ms`) : ""}`);
  console.log(`  agent_mail HTTP:  ${am.up ? C.green("UP") : C.red("DOWN")}${am.up ? C.dim(`  ${am.latencyMs}ms  ${am.url}`) : am.reason ? C.dim(`  (${am.reason})`) : ""}`);

  // Layer 2 — activity grouped by repo
  console.log(C.bold("\nActive sessions (by repo, within lookback)"));
  const sessions = activeSessions(now);
  const hb = heartbeatBySession();
  const intents = intentCountByRepo();
  if (!sessions.length) console.log(C.dim("  (no active sessions in the lookback window)"));
  const byRepo = new Map();
  for (const s of sessions) {
    if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
    byRepo.get(s.repo).push(s);
  }
  const RECENT_MS = 30 * 60 * 1000; // "currently active" window for the RED check
  for (const [repo, list] of byRepo) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs); // most-recent first
    console.log(`  ${C.bold(repo)}  ${C.dim(`(intents: ${intents.get(repo) || 0})`)}`);
    const shown = list.slice(0, 5);
    for (const s of shown) {
      const h = hb.get(s.sessionId) || { fires: 0, conflicts: 0 };
      const ageMin = Math.round((now.getTime() - s.mtimeMs) / 60000);
      const recent = now.getTime() - s.mtimeMs <= RECENT_MS;
      // RED only flags a CURRENTLY-active session with zero coord writes — the
      // "I thought it was working" silent-failure case. Older sessions are idle.
      let flag;
      if (h.fires > 0) flag = C.green(`${h.fires} hook fires`);
      else if (recent) flag = C.red("RED active now, ZERO coord writes");
      else flag = C.dim("idle (no coord activity)");
      console.log(`    ${s.sessionId.slice(0, 8)}  ${s.gitBranch || C.dim("-")}  active ${ageMin}m ago  ${flag}${h.conflicts ? C.yellow(`  ${h.conflicts} conflicts`) : ""}`);
    }
    if (list.length > shown.length) console.log(C.dim(`    +${list.length - shown.length} more`));
  }

  // Layer 5 — planning-lock state
  console.log(C.bold("\nPlanning locks"));
  const locks = planLockState(now);
  if (!locks.length) console.log(C.dim("  (no active planning locks)"));
  for (const l of locks) {
    const state = l.expired ? C.red(`STALE (expired ${l.expiresAt})`) : C.green("held");
    console.log(`  ${C.bold(l.repo)}  ${state}`);
    console.log(`    holder: ${l.session}  since ${l.startedAt}  ${C.dim(`"${(l.summary || "").slice(0, 80)}"`)}`);
    for (const w of l.waiters) {
      const waitMin = w.since ? Math.round((now.getTime() - new Date(w.since).getTime()) / 60000) : 0;
      console.log(`    waiting: ${w.session}  ${waitMin}m  ${waitMin > 15 ? C.red("(long wait)") : ""}`);
    }
  }
  console.log("");
}

function tailHeartbeat() {
  const lines = Number((process.argv.find((a) => a.startsWith("--lines=")) || "--lines=20").split("=")[1]) || 20;
  let txt = "";
  try {
    txt = fs.readFileSync(heartbeatLog(), "utf8");
  } catch {
    console.log(C.dim("(no heartbeat log yet — the coord hook has not fired)"));
    return;
  }
  const all = txt.split("\n").filter((l) => l.trim());
  console.log(C.bold(`\nHook heartbeat — last ${Math.min(lines, all.length)} of ${all.length}\n`));
  for (const line of all.slice(-lines)) {
    try {
      const o = JSON.parse(line);
      console.log(`  ${o.ts}  ${o.event}  ${(o.session || "").slice(0, 8)}  ${o.repo || ""}  conflicts=${o.conflicts}  bytes=${o.digestBytes}`);
    } catch {
      /* skip partial */
    }
  }
  if (!all.length) console.log(C.red("  many prompts but zero heartbeat entries — the hook is NOT wired"));
  console.log("");
}

async function canary() {
  const { runCanary } = await import(path.join(__dirname, "lib", "canary.mjs"));
  const res = await runCanary();
  if (res.ok) {
    console.log(C.green("\nCOORD-CANARY OK") + C.dim(`  (conflict surfaced in injected digest; ${res.detail})`));
    process.exit(0);
  } else {
    console.log(C.red(`\nCOORD-CANARY FAIL — ${res.error}`));
    process.exit(1);
  }
}

const cmd = process.argv[2];
(async () => {
  if (cmd === "status" && process.argv.includes("--tail")) tailHeartbeat();
  else if (cmd === "status") await status();
  else if (cmd === "canary") await canary();
  else {
    console.log("usage: coord status [--tail] | coord canary");
    process.exit(2);
  }
})();
