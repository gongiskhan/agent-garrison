#!/usr/bin/env node
// Garrison Outpost Worker — the remote half of pull-based dispatch (brief D1).
//
// Runs ON an outpost (a Mac), not on the host. Loop: poll the host for a card
// targeted at this machine, claim it, run it, heartbeat while working, report a
// terminal status, upload evidence.
//
// WHY PULL AND NOT PUSH
// The existing bridge has the host dial RPC down a WebSocket the Mac opened, with
// a 10s blocking ceiling. That cannot carry a real run, and it means the host must
// know when a machine is up. Pulling inverts both: the worker asks when IT is
// ready, work is never dispatched to a machine that is asleep, and a run is
// bounded by the lease rather than by an RPC timeout.
//
// DEPENDENCIES: the pinned Anthropic Agent SDK bundle installed beside this
// file. The worker never assumes a globally installed model CLI.
//
// Config (env):
//   GARRISON_DISPATCH_URL     required — host base URL (the tailnet address)
//   GARRISON_DISPATCH_TOKEN   required — this machine's pairing token
//   GARRISON_DISPATCH_MACHINE required — this machine's registry name
//   GARRISON_DISPATCH_POLL_SECONDS   optional, default 15
//   GARRISON_DISPATCH_WORKDIR        optional, default ~/.garrison-outpost/work

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_CONFIG = path.join(homedir(), ".garrison-outpost", "worker.json");
const WORKER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "1.1";

export function loadWorkerConfig({ argv = process.argv, env = process.env } = {}) {
  const at = argv.indexOf("--config");
  const configPath = env.GARRISON_DISPATCH_CONFIG || (at >= 0 ? argv[at + 1] : "") || DEFAULT_CONFIG;
  let disk = {};
  try {
    if (existsSync(configPath)) disk = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`worker config is unreadable at ${configPath}: ${error.message}`);
  }
  const get = (envKey, ...keys) => {
    if (typeof env[envKey] === "string" && env[envKey].trim()) return env[envKey].trim();
    for (const key of keys) if (typeof disk[key] === "string" && disk[key].trim()) return disk[key].trim();
    return "";
  };
  return {
    configPath,
    dispatchUrl: get("GARRISON_DISPATCH_URL", "dispatchUrl", "dispatch_url").replace(/\/+$/, ""),
    token: get("GARRISON_DISPATCH_TOKEN", "token"),
    machine: get("GARRISON_DISPATCH_MACHINE", "machine", "machineName", "machine_name"),
    workdir: get("GARRISON_DISPATCH_WORKDIR", "workdir") || path.join(homedir(), ".garrison-outpost", "work"),
    pollSeconds: Number(env.GARRISON_DISPATCH_POLL_SECONDS || disk.pollSeconds || disk.poll_seconds || 15)
  };
}

const CONFIG = loadWorkerConfig();
const HOST = CONFIG.dispatchUrl;
const TOKEN = CONFIG.token;
const MACHINE = CONFIG.machine;
const POLL_SECONDS = Number.isFinite(CONFIG.pollSeconds) && CONFIG.pollSeconds >= 2 ? CONFIG.pollSeconds : 15;
const WORKDIR = CONFIG.workdir;

// A fresh id per PROCESS. Ownership is (machine, workerId), so a restarted
// worker cannot keep beating on the claim its dead predecessor held — the host
// tells the old id to stop.
const WORKER_ID = `${MACHINE}-${randomUUID().slice(0, 8)}`;

// Hard cap on a single run. Without it a hung child holds the claim until the
// lease expires over and over, and the card ping-pongs between machines forever.
const MAX_RUN_MS = 60 * 60 * 1000;

let stopping = false;
let activeCancel = null;
let activeChild = null;
let activeJob = null;
let workerReadiness = { ready: false, runtimes: [], detail: "starting", error: null };

function log(...args) {
  console.log(`[outpost-worker ${MACHINE}]`, ...args);
}

function requireConfig() {
  const missing = [];
  if (!HOST) missing.push("dispatchUrl");
  if (!TOKEN) missing.push("token");
  if (!MACHINE) missing.push("machine");
  if (missing.length) {
    console.error(`[outpost-worker] missing required config: ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function pulse(activity = activeJob ? "busy" : workerReadiness.ready ? "idle" : "degraded", detail = null) {
  return api("pulse", {
    protocolVersion: PROTOCOL_VERSION,
    workerVersion: WORKER_VERSION,
    activity,
    currentCardId: activeJob?.cardId || null,
    runtimes: workerReadiness.runtimes,
    ready: workerReadiness.ready,
    detail: detail || workerReadiness.detail || null,
    error: workerReadiness.error || null
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopActiveRun(reason = "stop requested") {
  log(reason);
  const cancel = activeCancel;
  const child = activeChild;
  if (typeof cancel === "function") {
    await Promise.race([
      Promise.resolve().then(() => cancel()).catch(() => {}),
      wait(5_000)
    ]);
  }
  if (child?.pid) {
    let exited = child.exitCode != null || child.signalCode != null;
    const onExit = new Promise((resolve) => {
      if (exited) return resolve(true);
      const done = () => { exited = true; resolve(true); };
      child.once("close", done);
      child.once("error", done);
    });
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { try { child.kill("SIGTERM"); } catch {} }
    const pid = child.pid;
    const killer = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }, 3000);
    killer.unref?.();
    await Promise.race([onExit, wait(5_000)]);
    clearTimeout(killer);
  }
  const deadline = Date.now() + 5_000;
  while ((activeCancel || activeChild) && Date.now() < deadline) await wait(25);
  return !activeCancel && !activeChild;
}

function streamSender(job) {
  let cursor = 0;
  let queue = Promise.resolve();
  const send = (channel, text) => {
    if (!text) return queue;
    if (channel === "journal" && Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) {
      return send("status", "a structured activity event exceeded 4 MiB and was omitted from live Watch; the durable evidence bundle is still retained");
    }
    // Bound each immutable wire event. Large child chunks are split without
    // changing byte order; event IDs remain contiguous for host deduplication.
    const step = channel === "journal" ? Math.max(1, text.length) : 48 * 1024;
    for (let offset = 0; offset < text.length; offset += step) {
      const chunk = text.slice(offset, offset + step);
      const eventId = ++cursor;
      queue = queue.then(async () => {
        const response = await api("stream", {
          cardId: job.cardId,
          runId: job.runId,
          eventId,
          channel,
          text: chunk,
          at: new Date().toISOString()
        });
        if (!response.ok) throw new Error(`stream event ${eventId} rejected (${response.status})`);
      }).catch((error) => log(`stream event ${eventId} failed: ${error.message}`));
    }
    return queue;
  };
  return { send, flush: () => queue, cursor: () => cursor };
}

async function api(endpoint, body, { timeoutMs = 20_000 } = {}) {
  const res = await fetch(`${HOST}/api/dispatch/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The token IS the identity. The host never trusts a machine name in the body.
      authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ machine: MACHINE, workerId: WORKER_ID, ...body }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// Run the job's command, capturing output. Deliberately through a shell: a stub
// command is written by a human as a shell one-liner, and the alternative (argv
// with no shell) silently breaks every pipeline. This runs code the HOST sent —
// which is exactly what an outpost is for, and why the token is the gate.
function runCommand(command, cwd, hooks = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        GARRISON_OUTPOST_MACHINE: MACHINE,
        ...(hooks.evidenceDir ? { GARRISON_OUTPOST_EVIDENCE_DIR: hooks.evidenceDir } : {})
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Make the child a process-group LEADER so the timeout path below can
      // kill(-pid) the whole tree. Without this the child shares our group:
      // kill(-pid) either fails outright or, worse, signals a group we did not
      // create — and a `sh -c` that spawned its own children would leave them
      // orphaned, still holding whatever port or lock the next run needs.
      detached: true
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    // Cap retained output. A runaway command must not exhaust the worker's heap
    // before its own timeout fires.
    const CAP = 1024 * 1024;
    child.stdout.on("data", (d) => {
      const text = d.toString();
      if (stdout.length < CAP) stdout += text;
      void hooks.onChunk?.("stdout", text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      if (stderr.length < CAP) stderr += text;
      void hooks.onChunk?.("stderr", text);
    });

    const timer = setTimeout(() => {
      // Kill the PROCESS GROUP: a shell -c that spawned children would otherwise
      // leave them orphaned and holding the port/lock the next run needs.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, MAX_RUN_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// Run an AGENTIC job through the exact runtime cell the host projected for this
// phase. The small adapter bundle validates that target and feeds the prompt to
// the SDK as structured input; arbitrary card text is never shell syntax.
async function runAgent(prompt, cwd, runtimeTarget, hooks = {}) {
  const { runResolvedTarget } = await import("./runtime-adapters.mjs");
  const timer = setTimeout(() => { void stopActiveRun("maximum runtime exceeded"); }, MAX_RUN_MS);
  try {
    return await runResolvedTarget(prompt, cwd, runtimeTarget, {
      onChunk: hooks.onChunk,
      onJournal: hooks.onJournal,
      isCancelled: hooks.isCancelled,
      evidenceDir: hooks.evidenceDir,
      onCancelHandle: (cancel) => { activeCancel = cancel; }
    });
  } finally {
    clearTimeout(timer);
    activeCancel = null;
  }
}

async function uploadEvidence(job, name, content) {
  try {
    const res = await api("evidence", {
      cardId: job.cardId,
      runId: job.runId,
      name,
      contentBase64: Buffer.from(content, "utf8").toString("base64")
    });
    if (!res.ok) log(`evidence ${name} rejected: ${res.status}`, res.body);
    return res.ok ? { name: res.body.name, bytes: res.body.bytes, sha256: res.body.sha256 } : null;
  } catch (err) {
    // Evidence is best-effort: losing a log must never turn a green run red.
    log(`evidence ${name} failed: ${err.message}`);
    return null;
  }
}

// The branch a dispatched card works on (brief D4, as decided).
//
// ONE LONG-LIVED BRANCH PER MACHINE — `dispatch/<machine>` — not one per card.
// Garrison creates no branches of its own (decision D10 removed worktrees and
// per-task branches entirely), so this is a deliberate, narrow exemption granted
// for dispatched work only. Do not generalise it.
//
// Why per-machine and not per-card: three machines editing one shared branch
// race on every push and rewrite each other's files mid-session, while one
// branch per card would multiply branches without bound. Per-machine gives each
// machine a stable place to land commits, bounded at one branch per machine,
// merged to main by the existing PR flow. Merging stays human — automatic
// merging is explicitly out of scope.
function dispatchBranchFor(machine) {
  // Slugged: a machine name is free text in the registry, and a branch name
  // cannot contain spaces, `~`, `^`, `:` or a trailing `.lock`.
  const slug = String(machine).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `dispatch/${slug || "outpost"}`;
}

// Memory freshness around a dispatched card (brief D5).
//
// PULL before the card so it starts from what the other machines have written;
// PUSH on terminal status so what this card wrote reaches them immediately
// instead of waiting for the nightly job.
//
// Two things the naive version gets wrong, both learned the hard way:
//   • The full sync also COMMITS AND PUSHES. Running it as the "pull" step would
//     publish whatever happens to be dirty in the vault at that instant —
//     another agent's in-flight writes, attributed to this card. Hence the
//     dedicated --pull mode.
//   • Exit 0 does NOT mean a sync happened: the single-instance lock returns 0
//     without touching git. --require-fresh turns that into exit 75 so a
//     genuinely skipped sync is visible rather than silently assumed.
//
// Best-effort by design: memory that is one cycle stale is a far smaller problem
// than refusing to run the card at all, so a failure here is logged and the run
// proceeds.
async function syncVaultMemory(mode) {
  const script = process.env.GARRISON_VAULT_SYNC_SCRIPT;
  if (!script) return { skipped: "no GARRISON_VAULT_SYNC_SCRIPT configured" };
  const result = await new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", `bash ${JSON.stringify(script)} --${mode} --require-fresh`], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    // A sync must never outlive the card it is bracketing.
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, output: out.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: err.message });
    });
  });
  if (result.exitCode === 75) log(`vault ${mode}: skipped (another sync held the lock)`);
  else if (result.exitCode !== 0) log(`vault ${mode} failed (continuing): ${result.output.slice(0, 200)}`);
  else log(`vault ${mode}: ok`);
  return result;
}

async function executeJob(job) {
  activeJob = job;
  const stream = streamSender(job);
  const evidenceDir = path.join(WORKDIR, job.cardId, `evidence-${job.runId}`);
  await mkdir(evidenceDir, { recursive: true });
  await stream.send("status", `claimed by ${MACHINE} (${job.phase})`);
  await pulse("busy", `running ${job.cardId} at ${job.phase}`).catch(() => {});
  log(`claimed ${job.cardId} — ${job.title}`);
  let stopRequested = false;
  let cancellationRequested = false;
  let cancellationStopPromise = null;
  let materializeReport = null;
  let cwd = path.join(WORKDIR, job.cardId);
  await mkdir(cwd, { recursive: true });

  const heartbeat = async () => {
    try {
      const res = await api("heartbeat", { cardId: job.cardId, runId: job.runId, progress: "running" });
      if (res.body?.stop) {
        stopRequested = true;
        cancellationRequested ||= res.body.cancellation === true;
        cancellationStopPromise ||= stopActiveRun(`host requested stop: ${res.body.reason || "claim released"}`);
      }
    } catch (error) {
      log(`heartbeat failed (continuing): ${error.message}`);
    }
  };
  const beat = setInterval(heartbeat, 5_000);

  let result = { exitCode: -1, stdout: "", stderr: "run did not start" };
  try {
    await heartbeat();
    await syncVaultMemory("pull").catch((error) => log(`vault pull error: ${error.message}`));
    if (job.scope === "personal" && !job.project && !stopRequested) {
      await stream.send("status", "preparing managed personal workspace");
      const { ensureOutpostPersonalWorkspace } = await import("./personal-workspace.mjs");
      cwd = await ensureOutpostPersonalWorkspace({ configPath: CONFIG.configPath });
    } else if (job.loadout && !stopRequested) {
      await stream.send("status", `materializing Loadout ${job.loadout.id}`);
      const { materialize, materializationTranscript } = await import("./materialize.mjs");
      const projectsRoot = job.loadout.projects_root_override || path.join(homedir(), "dev");
      const materialized = await materialize(job.loadout, {
        projectsRoot,
        envContent: job.envContent ?? null,
        branch: dispatchBranchFor(MACHINE),
        log: (message) => {
          log(`  ${message}`);
          void stream.send("status", message);
        }
      });
      const secretValues = (job.envContent || "")
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.slice(line.indexOf("=") + 1).replace(/^'(.*)'$/, "$1"))
        .filter(Boolean);
      materializeReport = materializationTranscript(materialized, { secretValues });
      if (!materialized.ok) {
        result = { exitCode: -1, stdout: "", stderr: `environment materialization failed at "${materialized.failed}" for ${job.loadout.id}` };
      } else {
        cwd = materialized.target;
      }
    }

    if (result.stderr === "run did not start" && !stopRequested) {
      const hooks = {
        evidenceDir,
        isCancelled: () => stopRequested,
        onChunk: (channel, text) => stream.send(channel, text),
        onJournal: (event) => stream.send("journal", JSON.stringify(event))
      };
      if (job.run.kind === "command") {
        result = await runCommand(job.run.command, cwd, hooks);
      } else if (job.run.kind === "duty") {
        if (!job.runtimeTarget) throw new Error("host omitted the resolved runtime target");
        const evidenceInstruction = [
          job.run.prompt,
          "",
          "# Durable remote phase evidence",
          `Before your final response, write ${path.join(evidenceDir, `gate-status.${job.phase}.json`)} as JSON with status and next_phase.`,
          `If your transition is done, also write a non-empty ${path.join(evidenceDir, "evidence.md")} describing the tangible verification performed.`
        ].join("\n");
        result = await runAgent(evidenceInstruction, cwd, job.runtimeTarget, hooks);
      } else {
        result = { exitCode: -1, stdout: "", stderr: `unsupported run kind: ${job.run.kind}` };
      }
    }
  } catch (error) {
    result = { exitCode: -1, stdout: "", stderr: error.message || String(error) };
  } finally {
    clearInterval(beat);
    activeChild = null;
    activeCancel = null;
  }

  await stream.flush();
  const lines = String(result.stdout || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const requestedTransition = lines.length && job.validTransitions.includes(lines.at(-1)) ? lines.at(-1) : null;
  const transcript = [
    "# dispatched run",
    `run:     ${job.runId}`,
    `card:    ${job.cardId}`,
    `phase:   ${job.phase}`,
    `machine: ${MACHINE}`,
    `worker:  ${WORKER_ID}`,
    job.run.kind === "command" ? `command: ${job.run.command}` : `duty:    ${job.run.duty}`,
    `target:  ${job.runtimeTarget ? `${job.runtimeTarget.runtime}/${job.runtimeTarget.provider}/${job.runtimeTarget.model}` : "command"}`,
    `exit:    ${result.exitCode}`,
    "", "## stdout", result.stdout || "(empty)", "", "## stderr", result.stderr || "(empty)"
  ].join("\n");
  await writeFile(path.join(evidenceDir, "transcript.md"), transcript, { mode: 0o600 });

  const manifest = [];
  const retain = async (name, content) => {
    const uploaded = await uploadEvidence(job, name, content);
    if (uploaded) manifest.push(uploaded);
  };
  await retain("transcript.md", transcript);
  if (materializeReport) await retain("materialize.md", materializeReport);

  const gateName = `gate-status.${job.phase}.json`;
  let gateText = "";
  if (job.run.kind === "command" && result.exitCode === 0 && requestedTransition) {
    gateText = `${JSON.stringify({ status: "passed", next_phase: requestedTransition, command: true })}\n`;
  } else {
    gateText = await readFile(path.join(evidenceDir, gateName), "utf8").catch(() => "");
  }
  let gateAgrees = false;
  try {
    const gate = JSON.parse(gateText);
    gateAgrees = requestedTransition != null && [gate.next_phase, gate.nextPhase, gate.next].includes(requestedTransition);
  } catch {}
  if (gateText) await retain(gateName, gateText);

  if (requestedTransition === "done") {
    const finalEvidence = await readFile(path.join(evidenceDir, "evidence.md"), "utf8").catch(() => "");
    if (finalEvidence.trim()) await retain("evidence.md", finalEvidence);
  }

  if (stopRequested) {
    await stream.send("status", "remote process stopped locally; awaiting host cancellation acknowledgement; partial transcript retained");
    await stream.flush();
    const stopped = await (cancellationStopPromise || stopActiveRun("finalising host stop request"));
    let acknowledged = false;
    if (cancellationRequested && stopped) {
      for (let attempt = 1; attempt <= 3 && !acknowledged; attempt++) {
        try {
          const response = await api("cancel", {
            cardId: job.cardId,
            runId: job.runId,
            routingToken: job.routingToken,
            stopped: true,
            summary: "worker confirmed the remote process group stopped",
            logCursor: stream.cursor(),
            evidenceManifest: manifest
          }, { timeoutMs: 10_000 });
          acknowledged = response.ok;
          if (!response.ok) log(`cancellation acknowledgement rejected (${response.status})`, response.body);
        } catch (error) {
          log(`cancellation acknowledgement failed (attempt ${attempt}): ${error.message}`);
        }
        if (!acknowledged && attempt < 3) await wait(500);
      }
    }
    log(`abandoning ${job.cardId} — ${acknowledged ? "cancellation acknowledged" : "claim remains host-controlled"}, evidence retained`);
    activeJob = null;
    await pulse().catch(() => {});
    return;
  }

  const hasFinalEvidence = requestedTransition !== "done" || manifest.some((item) => item.name === "evidence.md");
  const succeeded = result.exitCode === 0 && requestedTransition != null && gateAgrees && hasFinalEvidence;
  const state = succeeded ? "done" : "failed";
  const failure = result.exitCode !== 0
    ? `exit ${result.exitCode}: ${(result.stderr || result.stdout || "run failed").trim().slice(0, 400)}`
    : !requestedTransition
      ? `the final line was not one of: ${job.validTransitions.join(", ")}`
      : !gateAgrees
        ? `missing or mismatched ${gateName}`
        : "terminal evidence.md is missing";
  const summary = succeeded ? lines.slice(0, -1).join("\n").trim().slice(-1000) || `completed ${job.phase}` : failure;

  if (succeeded) await syncVaultMemory("push").catch((error) => log(`vault push error: ${error.message}`));
  const response = await api("status", {
    cardId: job.cardId,
    runId: job.runId,
    routingToken: job.routingToken,
    phase: job.phase,
    state,
    requestedTransition,
    summary,
    exitCode: result.exitCode,
    sessionId: typeof result.sessionId === "string" ? result.sessionId : null,
    logCursor: stream.cursor(),
    evidenceManifest: manifest
  });
  if (!response.ok) log(`status report failed: ${response.status}`, response.body);
  else log(`${job.cardId} ${job.phase} → ${succeeded ? requestedTransition : "needs-attention"}`);
  activeJob = null;
  await pulse().catch(() => {});
}

async function pollOnce() {
  const res = await api("claim", {});
  if (res.status === 401) {
    // Pairing is wrong. Backing off hard beats hammering the host with a token
    // it will never accept.
    log("unauthorized — check GARRISON_DISPATCH_TOKEN / machine registration");
    return { backoffMs: 5 * 60 * 1000 };
  }
  if (res.status === 503) {
    log("host board unavailable");
    return { backoffMs: 60 * 1000 };
  }
  if (!res.ok) {
    log(`claim failed: ${res.status}`, res.body);
    return { backoffMs: 60 * 1000 };
  }
  if (!res.body.job) return { backoffMs: POLL_SECONDS * 1000 };

  await executeJob(res.body.job);
  // Immediately look for more work: a machine that just finished is the most
  // likely one to be free.
  return { backoffMs: 1000 };
}

async function main() {
  requireConfig();
  await mkdir(WORKDIR, { recursive: true });
  const { probeRuntimeAdapters } = await import("./runtime-adapters.mjs");
  workerReadiness = await probeRuntimeAdapters();
  await pulse(workerReadiness.ready ? "idle" : "degraded").catch((error) => {
    log(`initial readiness pulse failed: ${error.message}`);
  });
  if (!workerReadiness.ready) {
    log(`task runner degraded: ${workerReadiness.detail}${workerReadiness.error ? ` — ${workerReadiness.error}` : ""}`);
  }
  const pulseTimer = setInterval(() => {
    void pulse().catch((error) => log(`pulse failed: ${error.message}`));
  }, 15_000);

  // One cycle then exit. Two uses: a cron/launchd-interval deployment that
  // prefers a short-lived process over a resident daemon, and a bounded test
  // run (a loop that never returns cannot be asserted on).
  if (process.env.GARRISON_DISPATCH_ONCE === "1" || process.argv.includes("--once")) {
    log(`worker ${WORKER_ID} single cycle against ${HOST}`);
    if (workerReadiness.ready) await pollOnce();
    clearInterval(pulseTimer);
    log("cycle complete");
    return;
  }

  log(`worker ${WORKER_ID} polling ${HOST} every ${POLL_SECONDS}s`);

  // Signal handlers installed BEFORE the loop, matching the scheduler daemon's
  // discipline: a SIGTERM during the first poll must still exit cleanly.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} — stopping after the current cycle`);
      stopping = true;
      stopActiveRun(`${sig} — stopping active run`);
      // A second signal is an operator insisting; honour it immediately.
      process.once(sig, () => process.exit(130));
    });
  }

  let consecutiveErrors = 0;
  while (!stopping) {
    let waitMs = POLL_SECONDS * 1000;
    try {
      const { backoffMs } = workerReadiness.ready
        ? await pollOnce()
        : { backoffMs: 60_000 };
      waitMs = backoffMs;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      // Exponential backoff, capped. A host that is down (rebooting, redeploying)
      // must not be hammered once a second by three machines.
      waitMs = Math.min(60_000, 1000 * 2 ** Math.min(consecutiveErrors, 6));
      log(`poll error (${consecutiveErrors}), retrying in ${Math.round(waitMs / 1000)}s: ${err.message}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  clearInterval(pulseTimer);
  log("stopped");
}

// Only run when executed directly, so the pure helpers can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith("worker.mjs")) {
  main().catch((err) => {
    console.error("[outpost-worker] fatal:", err);
    process.exit(1);
  });
}

export { runCommand, WORKER_ID, executeJob };
