// The scheduler on the mesh state service.
//
// What this pins, in order of how expensive the failure would be:
//
//  1. A job registered on one node is a ROW, not a file line, and the `target`
//     decides who sees it. A node-pinned job must never appear in another
//     node's tick — that is a Mac path firing on Linux.
//  2. A shared (`any`) job fired by two nodes in the same minute runs EXACTLY
//     ONCE. The lease is the gate, the occurrence ledger is the record.
//  3. Re-registration preserves the user's enable/disable choice, exactly as
//     the file store did — every fitting setup hook re-registers on every `up`.
//  4. A job whose `env_from` cannot be resolved on this node SKIPS, loudly,
//     naming the value. A job that silently does nothing is the failure class
//     the structured spec exists to kill (the prod tick dead for weeks on a dev
//     port literal).
//  5. `--tick --dry-run` prints the fully materialised command and runs nothing.
//
// The unenrolled file-store lane is covered by tests/scheduler-cli.test.ts and
// tests/scheduler-daemon.test.ts, which pass untouched: with GARRISON_STATE_URL
// unset and tests/setup.ts pinning GARRISON_HOME at an empty directory,
// discovery throws and the store falls back exactly as before.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startStateService } from "./state-service-harness";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEDULER = path.join(REPO_ROOT, "fittings", "seed", "scheduler", "scripts", "scheduler.mjs");
const JOB_STORE = path.join(REPO_ROOT, "fittings", "seed", "scheduler", "scripts", "lib", "job-store.mjs");

const NODE_A = "node-a";
const NODE_B = "node-b";

// A job that fires this minute wherever the tick runs.
const EVERY_MINUTE = "* * * * *";

let harness: Awaited<ReturnType<typeof startStateService>>;
let tmp: string;
let compositionDir: string;
let markerPath: string;
let logPath: string;
let tick: (now?: Date, opts?: { dryRun?: boolean }) => Promise<any>;
let createJobStore: (options?: Record<string, unknown>) => any;

const SAVED = { ...process.env };

function envFor(node: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GARRISON_STATE_URL: harness.url,
    GARRISON_STATE_TOKEN: harness.tokens[node],
    GARRISON_NODE_NAME: node
  };
}

/** Point THIS process's env at a node, so the imported tick() resolves as it. */
function becomeNode(node: string) {
  process.env.GARRISON_STATE_URL = harness.url;
  process.env.GARRISON_STATE_TOKEN = harness.tokens[node];
  process.env.GARRISON_NODE_NAME = node;
}

function storeFor(node: string) {
  return createJobStore({ env: envFor(node) });
}

async function clearJobs() {
  const store = storeFor(NODE_A);
  for (const job of await store.client.listSchedulerJobs()) {
    await store.removeJob(job.id);
  }
}

function cli(args: string[], node: string) {
  return execFileSync(process.execPath, [SCHEDULER, ...args], {
    env: envFor(node),
    encoding: "utf8"
  });
}

beforeAll(async () => {
  harness = await startStateService({ nodes: [NODE_A, NODE_B] });

  tmp = mkdtempSync(path.join(os.tmpdir(), "garrison-sched-state-"));
  markerPath = path.join(tmp, "marker.txt");
  logPath = path.join(tmp, "scheduler.log");

  // A composition tree holding one probe fitting, resolved the way a real
  // fitting-script job resolves: GARRISON_COMPOSITION_DIR/apm_modules/_local.
  compositionDir = path.join(tmp, "composition");
  const probeScripts = path.join(compositionDir, "apm_modules", "_local", "probe-fitting", "scripts");
  mkdirSync(probeScripts, { recursive: true });
  writeFileSync(
    path.join(probeScripts, "probe.mjs"),
    [
      "import fs from 'node:fs';",
      // One line per run, so "ran exactly once" is a line count and not a
      // last-writer-wins file that two runs would leave looking like one.
      "fs.appendFileSync(process.argv[2], `${process.pid} ${process.env.GARRISON_NODE_NAME ?? '-'}\\n`);"
    ].join("\n")
  );

  // LOG_FILE and GARRISON_HOME are read at module scope, so they must be set
  // BEFORE the first import of scheduler.mjs.
  process.env.GARRISON_SCHEDULER_LOG = logPath;
  process.env.GARRISON_SCHEDULER_JOBS = path.join(tmp, "unused-jobs.json");
  process.env.GARRISON_COMPOSITION_DIR = compositionDir;
  delete process.env.GARRISON_GATEWAY_URL;
  delete process.env.GARRISON_GATEWAY_PORT;

  ({ tick } = await import(SCHEDULER));
  ({ createJobStore } = await import(JOB_STORE));
}, 30_000);

afterAll(async () => {
  await harness?.stop();
  rmSync(tmp, { recursive: true, force: true });
  for (const key of [
    "GARRISON_STATE_URL",
    "GARRISON_STATE_TOKEN",
    "GARRISON_NODE_NAME",
    "GARRISON_SCHEDULER_LOG",
    "GARRISON_SCHEDULER_JOBS",
    "GARRISON_COMPOSITION_DIR",
    "GARRISON_GATEWAY_URL",
    "GARRISON_GATEWAY_PORT"
  ]) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key]!;
  }
});

beforeEach(async () => {
  await clearJobs();
  rmSync(markerPath, { force: true });
});

describe("scheduler job store — the state service", () => {
  it("uses the service when enrolled, and the legacy file when not", () => {
    expect(storeFor(NODE_A).mode).toBe("state");
    expect(storeFor(NODE_A).self).toBe(NODE_A);

    // An unenrolled machine keeps a working scheduler. This is the ONE
    // permitted file fallback, and it is what keeps every setup hook booting
    // on a box outside the mesh.
    const unenrolled = createJobStore({
      env: { GARRISON_HOME: tmp, GARRISON_SCHEDULER_JOBS: path.join(tmp, "unused-jobs.json") },
      log: () => {}
    });
    expect(unenrolled.mode).toBe("file");
    expect(unenrolled.fallbackReason).toMatch(/not enrolled/i);
  });

  it("filters by target: a node-pinned job is invisible to the other node", async () => {
    const a = storeFor(NODE_A);
    const b = storeFor(NODE_B);

    await a.saveJob("a-only", {
      id: "a-only",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_A}`,
      enabled: true,
      spec: { kind: "shell", command: "echo a" }
    });
    await b.saveJob("b-only", {
      id: "b-only",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_B}`,
      enabled: true,
      spec: { kind: "shell", command: "echo b" }
    });
    await a.saveJob("everyones", {
      id: "everyones",
      cron: EVERY_MINUTE,
      type: "cron",
      target: "any",
      enabled: true,
      spec: { kind: "fitting-script", fitting: "probe-fitting", script: "scripts/probe.mjs", args: [markerPath] }
    });

    expect((await a.loadJobs()).map((j: any) => j.id).sort()).toEqual(["a-only", "everyones"]);
    expect((await b.loadJobs()).map((j: any) => j.id).sort()).toEqual(["b-only", "everyones"]);
  });

  it("refuses a shell job that is not pinned to one node", async () => {
    // A baked shell string is by definition machine-specific: a Mac path must
    // never become firable on Linux by widening its target.
    await expect(
      storeFor(NODE_A).saveJob("bad", {
        id: "bad",
        cron: EVERY_MINUTE,
        type: "cron",
        target: "any",
        enabled: true,
        spec: { kind: "shell", command: "/opt/homebrew/bin/thing" }
      })
    ).rejects.toThrow(/shell-jobs-are-node-local/);
  });

  it("preserves the enable/disable choice across a re-register", async () => {
    const a = storeFor(NODE_A);
    const job = {
      id: "nightly",
      cron: "0 3 * * *",
      type: "cron",
      target: `node:${NODE_A}`,
      spec: { kind: "shell", command: "echo nightly" }
    };
    await a.saveJob("nightly", { ...job, enabled: false });
    expect((await a.getJob("nightly")).enabled).toBe(false);

    // A setup hook re-running on every `up` states no preference; the store
    // (and thus the write transaction) keeps the user's choice.
    await a.saveJob("nightly", { ...job, enabled: undefined });
    expect((await a.getJob("nightly")).enabled).toBe(false);

    // And an explicit enable still wins.
    await a.saveJob("nightly", { ...job, enabled: true });
    expect((await a.getJob("nightly")).enabled).toBe(true);
  });

  it("re-reads and retries exactly once when a racing registrar bumps the rev", async () => {
    const a = storeFor(NODE_A);
    const b = storeFor(NODE_B);
    const base = {
      cron: EVERY_MINUTE,
      type: "cron",
      target: "any",
      spec: { kind: "fitting-script", fitting: "probe-fitting", script: "scripts/probe.mjs", args: [markerPath] }
    };
    await a.saveJob("contended", { id: "contended", ...base, enabled: true });
    const stale = await a.getJob("contended");
    expect(stale.rev).toBeGreaterThan(0);

    // B writes, invalidating A's rev.
    await b.saveJob("contended", { id: "contended", ...base, description: "from b", enabled: true });

    // A writes against what it read; the precondition makes the race explicit
    // and the single retry re-READS rather than forcing.
    await a.saveJob("contended", { id: "contended", ...base, description: "from a", enabled: true });
    expect((await a.getJob("contended")).description).toBe("from a");
  });
});

describe("tick on the mesh", () => {
  it("runs a shared job exactly once when two nodes fire the same occurrence", async () => {
    await storeFor(NODE_A).saveJob("shared-probe", {
      id: "shared-probe",
      cron: EVERY_MINUTE,
      type: "cron",
      target: "any",
      enabled: true,
      spec: {
        kind: "fitting-script",
        fitting: "probe-fitting",
        script: "scripts/probe.mjs",
        args: [markerPath],
        env_from: ["garrison_home"]
      }
    });

    // Both nodes tick the SAME occurrence, concurrently. tick() resolves its
    // node synchronously before its first await, so flipping the env between
    // the two un-awaited calls really does produce two racing nodes.
    const now = new Date();
    becomeNode(NODE_A);
    const runA = tick(now);
    becomeNode(NODE_B);
    const runB = tick(now);
    const [ranA, ranB] = await Promise.all([runA, runB]);

    const ran = [...ranA, ...ranB];
    expect(ran).toEqual([{ id: "shared-probe", exit: 0 }]);

    const lines = readFileSync(markerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    // The ledger is the durable record: one started row, closed with its exit.
    const runs = await storeFor(NODE_A).client.listSchedulerRuns("shared-probe");
    expect(runs).toHaveLength(1);
    expect(runs[0].exit).toBe(0);
    expect(runs[0].endedAt).toBeTruthy();
  }, 30_000);

  it("skips a job whose env_from cannot be resolved on this node, naming the value", async () => {
    await storeFor(NODE_A).saveJob("needs-gateway", {
      id: "needs-gateway",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_A}`,
      enabled: true,
      spec: {
        kind: "fitting-script",
        fitting: "probe-fitting",
        script: "scripts/probe.mjs",
        args: [markerPath],
        env_from: ["gateway_url"]
      }
    });

    becomeNode(NODE_A);
    const ran = await tick(new Date());

    expect(ran).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("skip needs-gateway");
    expect(log).toContain("gateway_url -> GARRISON_GATEWAY_URL");

    // And nothing was recorded as started — a skipped job must not look like a
    // job that ran and produced nothing.
    const runs = await storeFor(NODE_A).client.listSchedulerRuns("needs-gateway");
    expect(runs).toEqual([]);
  }, 30_000);

  it("does not fire another node's job", async () => {
    await storeFor(NODE_B).saveJob("b-probe", {
      id: "b-probe",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_B}`,
      enabled: true,
      spec: { kind: "fitting-script", fitting: "probe-fitting", script: "scripts/probe.mjs", args: [markerPath] }
    });

    becomeNode(NODE_A);
    expect(await tick(new Date())).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  }, 30_000);
});

describe("--tick --dry-run", () => {
  it("prints the fully materialised command per due job and runs nothing", async () => {
    await storeFor(NODE_A).saveJob("dry-probe", {
      id: "dry-probe",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_A}`,
      enabled: true,
      spec: {
        kind: "fitting-script",
        fitting: "probe-fitting",
        script: "scripts/probe.mjs",
        args: [markerPath],
        env_from: ["garrison_home", "composition_dir"]
      }
    });

    const out = JSON.parse(cli(["--tick", "--dry-run"], NODE_A));
    expect(out.dryRun).toBe(true);
    expect(out.node).toBe(NODE_A);
    expect(out.store).toBe("state");
    expect(out.due).toHaveLength(1);

    const { command } = out.due[0];
    expect(command).toContain(`GARRISON_HOME='${process.env.GARRISON_HOME}'`);
    expect(command).toContain(`GARRISON_COMPOSITION_DIR='${compositionDir}'`);
    expect(command).toContain(
      path.join(compositionDir, "apm_modules", "_local", "probe-fitting", "scripts", "probe.mjs")
    );
    expect(command).toContain(markerPath);

    // A dry run consults no ledger and leaves no trace.
    expect(existsSync(markerPath)).toBe(false);
    expect(await storeFor(NODE_A).client.listSchedulerRuns("dry-probe")).toEqual([]);
  }, 30_000);

  it("names the unresolvable job in the skipped list instead of printing a guess", async () => {
    await storeFor(NODE_A).saveJob("dry-missing", {
      id: "dry-missing",
      cron: EVERY_MINUTE,
      type: "cron",
      target: `node:${NODE_A}`,
      enabled: true,
      spec: {
        kind: "fitting-script",
        fitting: "probe-fitting",
        script: "scripts/probe.mjs",
        args: [markerPath],
        env_from: ["gateway_url"]
      }
    });

    const out = JSON.parse(cli(["--tick", "--dry-run"], NODE_A));
    expect(out.due).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].id).toBe("dry-missing");
    expect(out.skipped[0].missing).toEqual(["gateway_url -> GARRISON_GATEWAY_URL"]);
  }, 30_000);
});

describe("CLI compatibility on the mesh", () => {
  it("register / list / enable / remove keep their contract, with target defaulting to this node", async () => {
    const registered = cli(
      ["register", "hooked", EVERY_MINUTE, "--disabled", "--description", "from a setup hook", "--", "echo hooked"],
      NODE_A
    );
    expect(registered).toContain("registered hooked (disabled)");

    const listed = JSON.parse(cli(["list"], NODE_A));
    expect(listed.store).toBe("state");
    expect(listed.node).toBe(NODE_A);
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]).toMatchObject({
      id: "hooked",
      cron: EVERY_MINUTE,
      enabled: false,
      target: `node:${NODE_A}`,
      // The legacy `command` projection setup hooks still grep for.
      command: "echo hooked",
      description: "from a setup hook"
    });

    // A re-register from the same hook must not clobber an explicit enable.
    expect(cli(["enable", "hooked"], NODE_A)).toContain("enabled hooked");
    expect(cli(["register", "hooked", EVERY_MINUTE, "--disabled", "--", "echo hooked"], NODE_A)).toContain(
      "registered hooked (enabled)"
    );
    expect(JSON.parse(cli(["list"], NODE_A)).jobs[0].enabled).toBe(true);

    // The other node cannot see it, but CAN address it by id.
    expect(JSON.parse(cli(["list"], NODE_B)).jobs).toEqual([]);
    expect(JSON.parse(cli(["list", "--target", "all"], NODE_B)).jobs).toHaveLength(1);

    expect(cli(["remove", "hooked"], NODE_A)).toContain("removed hooked (was present)");
    expect(cli(["remove", "hooked"], NODE_A)).toContain("removed hooked (was absent)");
  }, 30_000);

  it("--probe answers ok against the service", () => {
    expect(cli(["--probe"], NODE_A).trim()).toBe("ok");
  });

  it("round-trips the listener flags, which have no column of their own", () => {
    // --integration and --poll-ms are not fields the service knows; they ride
    // inside the spec. Losing them would leave loop-heartbeat registered as a
    // listener the supervisor polls at the wrong cadence — silently.
    cli(
      ["register", "poller", "*/7 * * * *", "--type", "listener", "--integration", "imap", "--poll-ms", "5000", "--", "node /x/hb.mjs"],
      NODE_A
    );
    const job = JSON.parse(cli(["list"], NODE_A)).jobs.find((j: any) => j.id === "poller");
    expect(job).toMatchObject({
      type: "listener",
      integration: "imap",
      poll_interval_ms: 5000,
      command: "node /x/hb.mjs"
    });
  }, 30_000);

  it("run-now fires a job on demand without a lease or a ledger gate", async () => {
    await storeFor(NODE_A).saveJob("manual", {
      id: "manual",
      cron: "0 3 * * *",
      type: "cron",
      target: "any",
      enabled: true,
      spec: { kind: "fitting-script", fitting: "probe-fitting", script: "scripts/probe.mjs", args: [markerPath] }
    });

    // Twice, deliberately: manual means manual.
    cli(["run-now", "manual"], NODE_A);
    cli(["run-now", "manual"], NODE_A);
    expect(readFileSync(markerPath, "utf8").trim().split("\n")).toHaveLength(2);
  }, 30_000);
});
