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
// DEPENDENCIES: none. Node's built-in fetch and child_process only, so this can be
// dropped onto a bare Mac with nothing but node installed.
//
// Config (env):
//   GARRISON_DISPATCH_URL     required — host base URL (the tailnet address)
//   GARRISON_DISPATCH_TOKEN   required — this machine's pairing token
//   GARRISON_DISPATCH_MACHINE required — this machine's registry name
//   GARRISON_DISPATCH_POLL_SECONDS   optional, default 15
//   GARRISON_DISPATCH_WORKDIR        optional, default ~/.garrison-outpost/work

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HOST = (process.env.GARRISON_DISPATCH_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.GARRISON_DISPATCH_TOKEN || "";
const MACHINE = process.env.GARRISON_DISPATCH_MACHINE || "";
const POLL_SECONDS = Number(process.env.GARRISON_DISPATCH_POLL_SECONDS || 15);
const WORKDIR =
  process.env.GARRISON_DISPATCH_WORKDIR || path.join(homedir(), ".garrison-outpost", "work");

// A fresh id per PROCESS. Ownership is (machine, workerId), so a restarted
// worker cannot keep beating on the claim its dead predecessor held — the host
// tells the old id to stop.
const WORKER_ID = `${MACHINE}-${randomUUID().slice(0, 8)}`;

// Hard cap on a single run. Without it a hung child holds the claim until the
// lease expires over and over, and the card ping-pongs between machines forever.
const MAX_RUN_MS = 60 * 60 * 1000;

let stopping = false;

function log(...args) {
  console.log(`[outpost-worker ${MACHINE}]`, ...args);
}

function requireConfig() {
  const missing = [];
  if (!HOST) missing.push("GARRISON_DISPATCH_URL");
  if (!TOKEN) missing.push("GARRISON_DISPATCH_TOKEN");
  if (!MACHINE) missing.push("GARRISON_DISPATCH_MACHINE");
  if (missing.length) {
    console.error(`[outpost-worker] missing required config: ${missing.join(", ")}`);
    process.exit(2);
  }
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
function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: { ...process.env, GARRISON_OUTPOST_MACHINE: MACHINE },
      stdio: ["ignore", "pipe", "pipe"],
      // Make the child a process-group LEADER so the timeout path below can
      // kill(-pid) the whole tree. Without this the child shares our group:
      // kill(-pid) either fails outright or, worse, signals a group we did not
      // create — and a `sh -c` that spawned its own children would leave them
      // orphaned, still holding whatever port or lock the next run needs.
      detached: true
    });
    let stdout = "";
    let stderr = "";
    // Cap retained output. A runaway command must not exhaust the worker's heap
    // before its own timeout fires.
    const CAP = 1024 * 1024;
    child.stdout.on("data", (d) => {
      if (stdout.length < CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < CAP) stderr += d.toString();
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
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

async function uploadEvidence(cardId, name, content) {
  try {
    const res = await api("evidence", {
      cardId,
      name,
      contentBase64: Buffer.from(content, "utf8").toString("base64")
    });
    if (!res.ok) log(`evidence ${name} rejected: ${res.status}`, res.body);
    return res.ok;
  } catch (err) {
    // Evidence is best-effort: losing a log must never turn a green run red.
    log(`evidence ${name} failed: ${err.message}`);
    return false;
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
  log(`claimed ${job.cardId} — ${job.title}`);
  // Before anything else: ingest what the other machines know.
  await syncVaultMemory("pull").catch((err) => log(`vault pull error: ${err.message}`));
  let cwd = path.join(WORKDIR, job.cardId);
  await mkdir(cwd, { recursive: true });
  let materializeReport = null;

  let stopRequested = false;
  const beat = setInterval(async () => {
    try {
      const res = await api("heartbeat", { cardId: job.cardId, progress: "running" });
      if (res.body && res.body.stop) {
        // The host says this claim is no longer ours (reclaimed after a missed
        // lease, or a newer worker took over). Stop, so two machines never run
        // the same card at once.
        log(`heartbeat says stop: ${res.body.reason}`);
        stopRequested = true;
      }
    } catch (err) {
      // A transient network blip must NOT abandon a live run. The lease is
      // generous relative to the beat precisely so a few misses are survivable.
      log(`heartbeat failed (continuing): ${err.message}`);
    }
  }, Math.max(5, job.heartbeatSeconds || 30) * 1000);

  let result;
  try {
    // Materialize the project environment BEFORE the run (D2). Verify must pass
    // first, so a broken environment costs zero model tokens and reports as an
    // environment failure rather than as a mysterious run failure.
    if (job.loadout) {
      log(`materializing ${job.loadout.id} on ${dispatchBranchFor(MACHINE)}`);
      const { materialize, materializationTranscript } = await import("./materialize.mjs");
      const projectsRoot =
        job.loadout.projects_root_override || path.join(homedir(), "dev");
      const m = await materialize(job.loadout, {
        projectsRoot,
        envContent: job.envContent ?? null,
        branch: dispatchBranchFor(MACHINE),
        log: (msg) => log(`  ${msg}`)
      });
      // Mask any secret VALUE that a setup/verify step echoed. The values are in
      // memory here only because we just wrote them; they must not reach the
      // host's evidence store in the clear.
      const secretValues = (job.envContent || "")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.slice(l.indexOf("=") + 1).replace(/^'(.*)'$/, "$1"))
        .filter(Boolean);
      materializeReport = materializationTranscript(m, { secretValues });

      if (!m.ok) {
        clearInterval(beat);
        await uploadEvidence(job.cardId, "materialize.md", materializeReport);
        const summary = `environment materialization failed at "${m.failed}" for ${job.loadout.id}`;
        log(summary);
        await api("status", { cardId: job.cardId, state: "failed", summary, exitCode: -1 });
        return;
      }
      // The run happens IN the materialized checkout, not in the scratch dir.
      cwd = m.target;
    }

    if (job.run.kind !== "command") {
      result = {
        exitCode: -1,
        stdout: "",
        stderr: `unsupported run kind: ${job.run.kind}`
      };
    } else {
      result = await runCommand(job.run.command, cwd);
    }
  } finally {
    clearInterval(beat);
  }

  const transcript = [
    `# dispatched run`,
    `card:    ${job.cardId}`,
    `title:   ${job.title}`,
    `machine: ${MACHINE}`,
    `worker:  ${WORKER_ID}`,
    `command: ${job.run.kind === "command" ? job.run.command : "(n/a)"}`,
    `exit:    ${result.exitCode}`,
    ``,
    `## stdout`,
    result.stdout || "(empty)",
    ``,
    `## stderr`,
    result.stderr || "(empty)"
  ].join("\n");

  await writeFile(path.join(cwd, "transcript.md"), transcript, "utf8");

  if (stopRequested) {
    // Do not report: we no longer own the claim, and reporting would move a card
    // that belongs to another worker.
    log(`abandoning ${job.cardId} — claim lost`);
    return;
  }

  // Evidence BEFORE the terminal status, so a card that reaches done/failed on
  // the board always already has its transcript attached — never a terminal card
  // with evidence still in flight.
  await uploadEvidence(job.cardId, "transcript.md", transcript);
  if (materializeReport) await uploadEvidence(job.cardId, "materialize.md", materializeReport);

  const state = result.exitCode === 0 ? "done" : "failed";
  const summary =
    state === "done"
      ? (result.stdout.trim().split("\n").slice(-1)[0] || "completed").slice(0, 500)
      : `exit ${result.exitCode}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 400)}`;

  // Push what this card wrote BEFORE reporting terminal, so the moment the board
  // shows the card done, another machine picking up the follow-up already has
  // the memory it produced.
  await syncVaultMemory("push").catch((err) => log(`vault push error: ${err.message}`));

  const res = await api("status", { cardId: job.cardId, state, summary, exitCode: result.exitCode });
  if (!res.ok) log(`status report failed: ${res.status}`, res.body);
  else log(`${job.cardId} → ${state}`);
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

  // One cycle then exit. Two uses: a cron/launchd-interval deployment that
  // prefers a short-lived process over a resident daemon, and a bounded test
  // run (a loop that never returns cannot be asserted on).
  if (process.env.GARRISON_DISPATCH_ONCE === "1" || process.argv.includes("--once")) {
    log(`worker ${WORKER_ID} single cycle against ${HOST}`);
    await pollOnce();
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
      // A second signal is an operator insisting; honour it immediately.
      process.once(sig, () => process.exit(130));
    });
  }

  let consecutiveErrors = 0;
  while (!stopping) {
    let waitMs = POLL_SECONDS * 1000;
    try {
      const { backoffMs } = await pollOnce();
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
  log("stopped");
}

// Only run when executed directly, so the pure helpers can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith("worker.mjs")) {
  main().catch((err) => {
    console.error("[outpost-worker] fatal:", err);
    process.exit(1);
  });
}

export { runCommand, WORKER_ID };
