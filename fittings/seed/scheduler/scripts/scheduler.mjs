#!/usr/bin/env node
// Scheduler for Garrison.
// Stdlib-only. Cron grammar covers the patterns Phase 2 needs:
// "*", "*/N", single values, comma lists, and ranges (a-b) across all
// 5 fields. No '@yearly' style aliases, no seconds field.
//
// Usage:
//   node scheduler.mjs --probe                  # health check, prints "ok"
//   node scheduler.mjs list                     # JSON list of jobs
//   node scheduler.mjs add <id> <cron> <cmd>    # add or replace a job
//   node scheduler.mjs remove <id>              # remove a job
//   node scheduler.mjs run-now <id>             # run a job once, immediately
//   node scheduler.mjs tick                     # process jobs due for the current minute
//   node scheduler.mjs daemon                   # tick every minute until killed
//
// Job execution: stdout/stderr appended to the log file with a header
// line per run; non-zero exits are recorded but don't stop the loop.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
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

async function daemon() {
  await appendLog(`[${new Date().toISOString()}] scheduler daemon start (interval ${TICK_INTERVAL_MS}ms)`);
  while (true) {
    try {
      const ran = await tick();
      if (ran.length > 0) {
        process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ran }) + "\n");
      }
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

  if (cmd === "tick") {
    const ran = await tick();
    process.stdout.write(JSON.stringify({ ran }) + "\n");
    return 0;
  }

  if (cmd === "daemon") {
    await daemon();
    return 0;
  }

  console.error(`unknown command: ${cmd ?? "(none)"}`);
  console.error("commands: --probe | list | add | remove | run-now | tick | daemon");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(err.stack ?? err.message); process.exit(1); }
);
