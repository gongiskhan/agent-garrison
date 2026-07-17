// App-under-test lifecycle for direct Drill runs: is the Book's app URL
// serving, and if not, start it THROUGH THE PROJECT'S RUN SKILL - a headless
// Claude Code session in the project root told to invoke .claude/skills/
// run-<project> and leave the app serving. Drill itself never learns how to
// boot any particular app; the run skill is the single authority for that
// (same locality principle as for_consumers over Orchestrator hardcoding).
//
// One job per project root at a time, in-memory; the agent transcript streams
// to <garrison-home>/drill/app-start/<project>.log for debuggability. No
// model/effort pins - the agent session inherits the user's defaults.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { findRunSkill } from "./projects.mjs";
import { drillHomeDir } from "./runs-store.mjs";

const jobs = new Map(); // root -> job

function logDir() {
  return path.join(drillHomeDir(), "app-start");
}

// Basename + a hash of the FULL root: distinct roots sharing a basename must
// never share a log file (a second job's truncate under the first agent's
// live append fd merges their sentinel streams).
function safeName(root) {
  const base = path.basename(root).replace(/[^A-Za-z0-9_-]/g, "") || "project";
  return `${base}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

// Any HTTP response counts as reachable - a 500 still means the app process
// is serving. Non-http(s) URLs (the data: fixtures) have nothing to start.
export async function urlReachable(url, timeoutMs = 1500) {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(url, { signal: ctl.signal, redirect: "manual" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startPrompt(root, skill) {
  return [
    `You are starting the app under test for a Drill QA run.`,
    `Project root: ${root}`,
    `Invoke the "${skill}" skill (.claude/skills/${skill}/SKILL.md in this repo) and follow it to get the app running and serving.`,
    `- If the app is already up and healthy, do not restart it - just report it.`,
    `- Start long-running processes detached/backgrounded with output to a log file, so they keep serving after you exit.`,
    `- When the app is reachable, print as the FINAL line exactly: APP_URL=<base url>`,
    `- If you cannot get it serving, print as the final line exactly: APP_FAILED=<one-line reason>`
  ].join("\n");
}

function parseSentinel(logText) {
  const urls = [...logText.matchAll(/^APP_URL=(\S+)\s*$/gm)];
  const fails = [...logText.matchAll(/^APP_FAILED=(.+)$/gm)];
  return {
    url: urls.length ? urls[urls.length - 1][1] : null,
    failed: fails.length ? fails[fails.length - 1][1].trim() : null
  };
}

async function logTail(file, bytes = 2000) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
}

export function publicJob(job) {
  if (!job) return null;
  const { proc, ...rest } = job;
  return rest;
}

export function getJob(root) {
  return jobs.get(root) ?? null;
}

// A hostile/broken env value must degrade to the default, not to a NaN
// deadline that never trips.
function defaultTimeoutMs() {
  const t = Number(process.env.DRILL_APP_START_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 240000;
}

// Kick (or return the already-running) start job for `root`. `bookUrl` is the
// Book's configured app URL - when set it is the readiness probe; when empty
// the agent's APP_URL sentinel fills it in via onUrl. Resolution happens in a
// detached poll loop; callers watch GET /api/app/status.
export async function startApp({ root, bookUrl, onUrl, timeoutMs = defaultTimeoutMs() }) {
  const existing = jobs.get(root);
  if (existing && existing.status === "starting") return existing;

  const skill = findRunSkill(root);
  const startedAt = new Date().toISOString();
  if (!skill) {
    const job = {
      root, skill: null, status: "failed", startedAt, endedAt: startedAt, url: null, logFile: null,
      error: `no run-* skill under ${path.join(root, ".claude", "skills")} - add one (run-${path.basename(root)}) or start the app yourself and set the app URL in the Drill Book`
    };
    jobs.set(root, job);
    return job;
  }

  // Registered BEFORE any await: two concurrent kicks for the same root must
  // not both pass the in-flight guard and spawn two agent sessions.
  const job = { root, skill, status: "starting", startedAt, endedAt: null, url: bookUrl || null, logFile: null, error: null, agentPid: null, agentExited: null, proc: null };
  jobs.set(root, job);
  const finish = (status, patch = {}) => {
    Object.assign(job, patch, { status, endedAt: new Date().toISOString() });
  };

  let logStream;
  try {
    await fs.mkdir(logDir(), { recursive: true });
    // Timestamped per job: a re-kick must not truncate a file a still-alive
    // previous agent holds open in append mode.
    job.logFile = path.join(logDir(), `${safeName(root)}-${Date.now()}.log`);
    await fs.writeFile(job.logFile, `[drill app-start] ${startedAt} skill=${skill} root=${root}\n`, "utf8");
    logStream = await fs.open(job.logFile, "a");
  } catch (err) {
    // Must not leave the placeholder stuck in "starting" - it would block
    // every future kick for this root.
    finish("failed", { error: err.message });
    return job;
  }
  const closeLog = () => logStream.close().catch(() => {});

  const bin = process.env.DRILL_AGENT_CMD || "claude";
  const proc = spawn(bin, ["-p", startPrompt(root, skill), "--permission-mode", "bypassPermissions"], {
    cwd: root,
    stdio: ["ignore", logStream.fd, logStream.fd],
    env: process.env
  });
  job.proc = proc;
  job.agentPid = proc.pid;
  // 'error' (e.g. binary not on PATH) never fires 'exit', so both handlers
  // close the log handle (close is idempotent-guarded by the catch). A
  // signal death passes code=null - record it as "signal:<name>" so the
  // exited check below still trips (a killed agent must fail fast, not sit
  // "starting" until the deadline).
  proc.on("error", (err) => { closeLog(); finish("failed", { error: `${bin}: ${err.message}` }); });
  proc.on("exit", (code, signal) => { job.agentExited = code ?? `signal:${signal}`; closeLog(); });

  const deadline = Date.now() + timeoutMs;
  (async () => {
    while (job.status === "starting") {
      // Capture the exit flag BEFORE reading the log: if it is already set,
      // the agent's final writes (a late APP_URL/APP_FAILED line) are on
      // disk, so the exit check below never races a print-and-exit into a
      // false "exited before the app came up".
      const exitedAtRead = job.agentExited;
      const text = await logTail(job.logFile, 64000);
      const sentinel = parseSentinel(text);
      if (sentinel.failed) {
        finish("failed", { error: sentinel.failed });
        break;
      }
      // The Book URL is authoritative when set; otherwise adopt the agent's.
      const probeUrl = bookUrl || sentinel.url;
      if (probeUrl && (await urlReachable(probeUrl))) {
        if (!bookUrl && sentinel.url && onUrl) await onUrl(sentinel.url).catch(() => {});
        finish("ready", { url: probeUrl });
        break;
      }
      if (Date.now() > deadline) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish("failed", { error: `app not reachable after ${Math.round(timeoutMs / 1000)}s (see log)` });
        break;
      }
      // A non-zero agent exit with no APP_URL sentinel is a hard failure. A
      // zero exit keeps polling until the deadline - the app may still be
      // finishing its boot after the agent reported and left.
      if (exitedAtRead !== null && exitedAtRead !== 0 && !sentinel.url) {
        finish("failed", { error: `agent session ended (exit ${exitedAtRead}) before the app came up (see log)` });
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })().catch((err) => finish("failed", { error: err.message }));

  return job;
}
