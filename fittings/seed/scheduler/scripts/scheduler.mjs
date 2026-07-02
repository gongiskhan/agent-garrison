#!/usr/bin/env node
// Scheduler for Garrison.
// Stdlib-only. Cron grammar covers the patterns Phase 2 needs:
// "*", "*/N", single values, comma lists, and ranges (a-b) across all
// 5 fields. No '@yearly' style aliases, no seconds field.
//
// Usage:
//   node scheduler.mjs --probe                       # health check, prints "ok"
//   node scheduler.mjs list                          # JSON list of jobs
//   node scheduler.mjs add <id> <cron> <cmd>         # add or replace a job
//   node scheduler.mjs register <id> <cron> [flags] -- <cmd>
//        # idempotent registration for setup hooks; flags: --disabled,
//        # --description <d>, --type cron|listener, --integration <key>,
//        # --poll-ms <n>. PRESERVES the enable/disable choice on re-register.
//   node scheduler.mjs enable <id> | disable <id>    # toggle a job
//   node scheduler.mjs remove <id>                   # remove a job
//   node scheduler.mjs run-now <id>                  # run a job once, immediately
//   node scheduler.mjs tick                          # process jobs due this minute
//   node scheduler.mjs daemon [--health-port <n>]    # always-on: tick + supervise
//        # listeners until SIGTERM; serves /health. Platform-agnostic — any
//        # supervisor (systemd/Docker/PM2/launchd, see launchers/) keeps it up.
//
// Job execution: stdout/stderr appended to the log file with a header
// line per run; non-zero exits are recorded but don't stop the loop.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

// Machine-global scheduler state in ~/.garrison (NOT cwd-relative): jobs are
// registered by fitting setup hooks (cwd = the fitting dir) and fired by the
// io.garrison.scheduler launchd daemon (cwd = anywhere), so an absolute,
// per-machine location is the only thing all callers agree on. Override with
// GARRISON_SCHEDULER_JOBS / GARRISON_SCHEDULER_LOG.
const JOBS_FILE = process.env.GARRISON_SCHEDULER_JOBS
  ?? path.join(os.homedir(), ".garrison", "scheduler-jobs.json");
const LOG_FILE = process.env.GARRISON_SCHEDULER_LOG
  ?? path.join(os.homedir(), ".garrison", "scheduler.log");
const TICK_INTERVAL_MS = 60_000;
// Default port for the daemon's /health endpoint. Override with
// GARRISON_SCHEDULER_HEALTH_PORT or `daemon --health-port <n>`; a busy port is
// tolerated (logged, daemon continues without /health).
const DEFAULT_HEALTH_PORT = 7088;

async function loadJobs() {
  try {
    const raw = await fs.readFile(JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("jobs file is not an array");
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveJobs(jobs) {
  await fs.mkdir(path.dirname(JOBS_FILE), { recursive: true });
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2) + "\n");
}

function parseCron(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${parts.length}: "${cron}"`);
  }
  const ranges = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6]   // day of week
  ];
  return parts.map((spec, i) => parseField(spec, ranges[i][0], ranges[i][1], `field ${i}`));
}

function parseField(spec, lo, hi, label) {
  if (spec === "*") return { kind: "any" };
  if (spec.startsWith("*/")) {
    const step = Number(spec.slice(2));
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`${label}: invalid step "${spec}"`);
    }
    return { kind: "step", step, lo };
  }
  const values = new Set();
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) {
        throw new Error(`${label}: invalid range "${part}"`);
      }
      for (let v = a; v <= b; v++) values.add(v);
    } else {
      const v = Number(part);
      if (!Number.isInteger(v) || v < lo || v > hi) {
        throw new Error(`${label}: invalid value "${part}"`);
      }
      values.add(v);
    }
  }
  return { kind: "set", values };
}

function fieldMatches(field, value) {
  if (field.kind === "any") return true;
  if (field.kind === "step") return ((value - field.lo) % field.step) === 0;
  return field.values.has(value);
}

function cronMatches(parsed, date) {
  return fieldMatches(parsed[0], date.getMinutes())
    && fieldMatches(parsed[1], date.getHours())
    && fieldMatches(parsed[2], date.getDate())
    && fieldMatches(parsed[3], date.getMonth() + 1)
    && fieldMatches(parsed[4], date.getDay());
}

function minuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
}

async function appendLog(line) {
  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fs.appendFile(LOG_FILE, line + "\n");
}

async function runJob(job) {
  const startedAt = new Date().toISOString();
  await appendLog(`[${startedAt}] start ${job.id} :: ${job.command}`);
  return new Promise((resolve) => {
    // sh -c is the shell-evaluated execution path. Job commands are
    // user-authored (added via the `add` CLI) and trusted; this is the
    // same trust model as a user's own crontab entry.
    const child = spawn("/bin/sh", ["-c", job.command]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", async (code) => {
      const endedAt = new Date().toISOString();
      if (stdout.trim()) {
        for (const line of stdout.trimEnd().split(/\r?\n/)) {
          await appendLog(`  [${job.id}] stdout | ${line}`);
        }
      }
      if (stderr.trim()) {
        for (const line of stderr.trimEnd().split(/\r?\n/)) {
          await appendLog(`  [${job.id}] stderr | ${line}`);
        }
      }
      await appendLog(`[${endedAt}] end   ${job.id} exit=${code}`);
      resolve({ exit: code, stdout, stderr });
    });
    child.on("error", async (err) => {
      await appendLog(`[${new Date().toISOString()}] error ${job.id} :: ${err.message}`);
      resolve({ exit: -1, stdout, stderr: err.message });
    });
  });
}

async function tick(now = new Date()) {
  const jobs = await loadJobs();
  const currentMinute = minuteKey(now);
  const ran = [];
  for (const job of jobs) {
    if (job.enabled === false) continue;
    // Listener jobs are supervised as long-running workers (one per job), never
    // cron-fired — otherwise tick() would double-run them alongside the worker.
    if (job.type === "listener") continue;
    if (job.last_run_minute === currentMinute) continue;
    let parsed;
    try {
      parsed = parseCron(job.cron);
    } catch (err) {
      await appendLog(`[${new Date().toISOString()}] skip ${job.id}: ${err.message}`);
      continue;
    }
    if (!cronMatches(parsed, now)) continue;
    job.last_run = now.toISOString();
    job.last_run_minute = currentMinute;
    await saveJobs(jobs);
    const result = await runJob(job);
    ran.push({ id: job.id, exit: result.exit });
  }
  return ran;
}

// ── Listener supervision (ekoa pattern: one worker per polling trigger) ──────
// A job with type:"listener" is a long-running poller (e.g. an IMAP/board watch)
// the daemon keeps alive — distinct from a cron job that fires on schedule. The
// supervisor spawns one worker per enabled listener and restarts it on exit with
// exponential backoff, until shutdown.
const listenerWorkers = new Map(); // id -> live child
const listenerTimers = new Map(); // id -> pending restart timeout
let shuttingDown = false;

function spawnListener(job, backoffMs = 1000) {
  if (shuttingDown) return;
  // Guard against a double-spawn: a live worker already exists, or a restart
  // timer is about to fire one.
  if (listenerWorkers.has(job.id)) return;
  const pending = listenerTimers.get(job.id);
  if (pending) {
    clearTimeout(pending);
    listenerTimers.delete(job.id);
  }
  // detached:true puts the listener in its OWN process group (pgid == pid), so
  // shutdown can kill the whole subprocess TREE — `/bin/sh -c <command>` plus any
  // grandchildren the command spawns — not just the shell parent (which would
  // orphan the real worker).
  const child = spawn("/bin/sh", ["-c", job.command], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  listenerWorkers.set(job.id, child);
  child.stdout.on("data", (c) => { void appendLog(`  [listener ${job.id}] ${c.toString().trimEnd()}`); });
  child.stderr.on("data", (c) => { void appendLog(`  [listener ${job.id}] err | ${c.toString().trimEnd()}`); });
  child.on("exit", (code) => {
    listenerWorkers.delete(job.id);
    if (shuttingDown) return;
    void appendLog(`[${new Date().toISOString()}] listener ${job.id} exited code=${code}; restarting in ${backoffMs}ms`);
    // Track the restart timer so superviseListeners() won't also spawn one
    // (the double-spawn race) and shutdown can cancel it.
    const timer = setTimeout(() => {
      listenerTimers.delete(job.id);
      spawnListener(job, Math.min(backoffMs * 2, 60_000));
    }, backoffMs);
    listenerTimers.set(job.id, timer);
  });
}

// Kill a listener's entire process group (POSIX: negative pid), falling back to
// the single child on platforms/edge cases where the group signal fails.
function killListenerGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function superviseListeners() {
  const jobs = await loadJobs();
  for (const job of jobs) {
    if (job.type !== "listener" || job.enabled === false) continue;
    // Skip if a worker is live OR a restart is already scheduled.
    if (listenerWorkers.has(job.id) || listenerTimers.has(job.id)) continue;
    spawnListener(job);
  }
}

function startHealthServer(port, getState) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...getState() }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not-found" }));
  });
  server.on("error", (err) => {
    // A busy port is non-fatal — the daemon keeps ticking without /health.
    void appendLog(`[${new Date().toISOString()}] health server error: ${err.message}`);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

// A platform-agnostic always-on Node service: it ticks cron jobs and supervises
// listeners independent of Claude Code and of any one OS (systemd / Docker / PM2
// / launchd just supervise THIS process — see launchers/). SIGTERM/SIGINT do a
// graceful shutdown (stop listeners, close /health, exit 0).
async function daemon(opts = {}) {
  const healthPort =
    opts.healthPort ??
    (process.env.GARRISON_SCHEDULER_HEALTH_PORT ? Number(process.env.GARRISON_SCHEDULER_HEALTH_PORT) : DEFAULT_HEALTH_PORT);
  const startedAt = new Date().toISOString();
  let ticks = 0;
  // Declared before shutdown() so the handler can close it; assigned only after
  // the signal handlers are installed. A supervisor (or test) that sees /health
  // up may SIGTERM immediately - if the handlers were registered after the
  // server started listening, the default disposition would kill the process
  // mid-startup with a non-zero exit.
  let healthServer = null;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await appendLog(`[${new Date().toISOString()}] scheduler daemon ${signal} — graceful shutdown`);
    // Cancel any pending listener restart so we don't spawn during shutdown.
    for (const timer of listenerTimers.values()) clearTimeout(timer);
    listenerTimers.clear();
    healthServer?.close();
    // SIGTERM every listener, then WAIT for them to exit (bounded), so we never
    // orphan a child; SIGKILL any straggler past the grace window.
    const children = [...listenerWorkers.values()];
    for (const child of children) {
      killListenerGroup(child, "SIGTERM");
    }
    await Promise.race([
      Promise.all(
        children.map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise((res) => c.once("exit", res))))
      ),
      new Promise((res) => setTimeout(res, 5000))
    ]);
    for (const child of listenerWorkers.values()) {
      killListenerGroup(child, "SIGKILL");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  healthServer = startHealthServer(healthPort, () => ({
    startedAt,
    ticks,
    pid: process.pid,
    listeners: [...listenerWorkers.keys()]
  }));
  await appendLog(`[${startedAt}] scheduler daemon start (interval ${TICK_INTERVAL_MS}ms, health :${healthPort})`);

  await superviseListeners();
  while (!shuttingDown) {
    try {
      const ran = await tick();
      ticks += 1;
      if (ran.length > 0) {
        process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ran }) + "\n");
      }
      await superviseListeners();
    } catch (err) {
      await appendLog(`[${new Date().toISOString()}] tick error: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS));
  }
}

async function main(argv) {
  if (argv[0] === "--probe") {
    try {
      await loadJobs();
      console.log("ok");
      return 0;
    } catch (err) {
      console.error(`probe failed: ${err.message}`);
      return 1;
    }
  }

  const cmd = argv[0];

  if (cmd === "list") {
    const jobs = await loadJobs();
    process.stdout.write(JSON.stringify({ jobs_file: JOBS_FILE, jobs }, null, 2) + "\n");
    return 0;
  }

  if (cmd === "add") {
    const [, id, cron, ...rest] = argv;
    if (!id || !cron || rest.length === 0) {
      console.error("usage: scheduler.mjs add <id> <cron> <command...>");
      return 2;
    }
    try { parseCron(cron); }
    catch (err) { console.error(`invalid cron: ${err.message}`); return 1; }
    const command = rest.join(" ");
    const jobs = await loadJobs();
    const next = jobs.filter((j) => j.id !== id);
    next.push({ id, cron, command, enabled: true });
    await saveJobs(next);
    console.log(`added ${id}`);
    return 0;
  }

  if (cmd === "remove") {
    const id = argv[1];
    if (!id) { console.error("usage: scheduler.mjs remove <id>"); return 2; }
    const jobs = await loadJobs();
    const next = jobs.filter((j) => j.id !== id);
    await saveJobs(next);
    console.log(`removed ${id} (was ${jobs.length - next.length === 1 ? "present" : "absent"})`);
    return 0;
  }

  if (cmd === "run-now") {
    const id = argv[1];
    if (!id) { console.error("usage: scheduler.mjs run-now <id>"); return 2; }
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) { console.error(`job not found: ${id}`); return 1; }
    const result = await runJob(job);
    console.log(`ran ${id} exit=${result.exit}`);
    return result.exit === 0 ? 0 : 1;
  }

  // register: idempotent registration used by fitting setup hooks. Unlike `add`,
  // it (a) supports --disabled / --description / --type / --integration /
  // --poll-ms flags, (b) takes the command after a `--` separator, and (c)
  // PRESERVES the user's enable/disable choice on re-registration — so a setup
  // hook that re-runs every `up` never clobbers an explicit `enable`.
  if (cmd === "register") {
    const [, id, cron, ...rest] = argv;
    if (!id || !cron) {
      console.error("usage: scheduler.mjs register <id> <cron> [--disabled] [--description <d>] [--type cron|listener] [--integration <key>] [--poll-ms <n>] -- <command...>");
      return 2;
    }
    const sepIdx = rest.indexOf("--");
    const flagArgs = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const commandParts = sepIdx === -1 ? [] : rest.slice(sepIdx + 1);
    let disabled = false;
    let description;
    let type = "cron";
    let integration;
    let pollMs;
    for (let i = 0; i < flagArgs.length; i++) {
      const f = flagArgs[i];
      if (f === "--disabled") disabled = true;
      else if (f === "--description") description = flagArgs[++i];
      else if (f === "--type") type = flagArgs[++i];
      else if (f === "--integration") integration = flagArgs[++i];
      else if (f === "--poll-ms") pollMs = Number(flagArgs[++i]);
    }
    const command = commandParts.join(" ");
    if (!command) { console.error("register requires a command after `--`"); return 2; }
    if (type === "cron") {
      try { parseCron(cron); }
      catch (err) { console.error(`invalid cron: ${err.message}`); return 1; }
    }
    const jobs = await loadJobs();
    const existing = jobs.find((j) => j.id === id);
    // Preserve the existing enable/disable choice on re-register; a NEW job uses
    // !--disabled.
    const enabled = existing ? existing.enabled !== false : !disabled;
    const job = { id, cron, command, enabled, type };
    if (description !== undefined) job.description = description;
    if (integration !== undefined) job.integration = integration;
    if (pollMs !== undefined) job.poll_interval_ms = pollMs;
    if (existing?.last_run) job.last_run = existing.last_run;
    if (existing?.last_run_minute) job.last_run_minute = existing.last_run_minute;
    const next = jobs.filter((j) => j.id !== id);
    next.push(job);
    await saveJobs(next);
    console.log(`registered ${id} (${enabled ? "enabled" : "disabled"})`);
    return 0;
  }

  if (cmd === "enable" || cmd === "disable") {
    const id = argv[1];
    if (!id) { console.error(`usage: scheduler.mjs ${cmd} <id>`); return 2; }
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) { console.error(`job not found: ${id}`); return 1; }
    job.enabled = cmd === "enable";
    await saveJobs(jobs);
    console.log(`${cmd === "enable" ? "enabled" : "disabled"} ${id}`);
    return 0;
  }

  if (cmd === "tick") {
    const ran = await tick();
    process.stdout.write(JSON.stringify({ ran }) + "\n");
    return 0;
  }

  if (cmd === "daemon") {
    const portIdx = argv.indexOf("--health-port");
    const opts = portIdx !== -1 ? { healthPort: Number(argv[portIdx + 1]) } : {};
    await daemon(opts);
    return 0;
  }

  console.error(`unknown command: ${cmd ?? "(none)"}`);
  console.error("commands: --probe | list | add | register | enable | disable | remove | run-now | tick | daemon [--health-port <n>]");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(err.stack ?? err.message); process.exit(1); }
);
