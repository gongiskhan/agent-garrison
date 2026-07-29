// The scheduler tick's registration carries this INSTANCE's identity — and must never
// lose it again.
//
// Two separate defects put the prod tick out of action, and the second one bit
// immediately after deploying the fix for the first:
//   1. resolveGatewayUrl() defaulted to http://127.0.0.1:4777 — the DEV gateway. On
//      prod the tick pinged a foreign instance, found nothing, logged "gateway not
//      reachable" every 2 minutes, and dispatched/advanced/swept nothing. On dev the
//      literal was correct, so the whole failure was invisible in development.
//   2. `--setup` (the apm.yml hook, which has no gateway URL in scope) and the board
//      server (which does) BOTH call registerTick. The job command is persisted, so
//      the env-less setup registration silently overwrote the good one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore pure mjs
import { instanceEnvPrefix } from "../fittings/seed/kanban-loop/lib/instance-env.mjs";

// Non-literal specifier: tsc treats a pure .mjs import as `any` instead of erroring
// on missing declarations (the convention used by the other kanban tests).
const KANBAN_CLI_MODULE = "../fittings/seed/kanban-loop/scripts/kanban.mjs";
const BEATS_MODULE = "../fittings/seed/kanban-loop/lib/scheduler-beats.mjs";

const SAVED = { ...process.env };
let home: string;

function writeJobs(jobs: unknown[]) {
  writeFileSync(join(home, "scheduler-jobs.json"), JSON.stringify(jobs), "utf8");
}
function readJobs(): any[] {
  return JSON.parse(readFileSync(join(home, "scheduler-jobs.json"), "utf8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kanban-tick-reg-"));
  process.env.GARRISON_HOME = home;
  delete process.env.GARRISON_GATEWAY_URL;
  delete process.env.GARRISON_GATEWAY_PORT;
  delete process.env.GARRISON_KANBAN_DIR;
});
afterEach(() => {
  for (const k of ["GARRISON_HOME", "GARRISON_GATEWAY_URL", "GARRISON_GATEWAY_PORT", "GARRISON_KANBAN_DIR"]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

describe("instanceEnvPrefix — the tick job carries this instance's identity", () => {
  it("bakes the gateway URL, home and kanban dir into the command", () => {
    process.env.GARRISON_GATEWAY_URL = "http://127.0.0.1:5777";
    process.env.GARRISON_KANBAN_DIR = "/home/x/.garrison/kanban-loop";
    const prefix = instanceEnvPrefix();
    expect(prefix).toContain("GARRISON_GATEWAY_URL='http://127.0.0.1:5777'");
    expect(prefix).toContain(`GARRISON_HOME='${home}'`);
    expect(prefix).toContain("GARRISON_KANBAN_DIR='/home/x/.garrison/kanban-loop'");
  });

  it("derives the URL from GARRISON_GATEWAY_PORT when only the port is set", () => {
    process.env.GARRISON_GATEWAY_PORT = "5777";
    expect(instanceEnvPrefix()).toContain("GARRISON_GATEWAY_URL='http://127.0.0.1:5777'");
  });

  it("emits NO gateway entry rather than guessing one — there is no safe default port", () => {
    const prefix: string[] = instanceEnvPrefix();
    expect(prefix.some((p) => p.startsWith("GARRISON_GATEWAY_URL="))).toBe(false);
    // and specifically never the dev gateway, which is what broke prod
    expect(prefix.join(" ")).not.toContain("4777");
  });

  it("carries the outpost daemon URL too — the engine's affinity resolver has no fallback", () => {
    process.env.GARRISON_KANBANLOOP_OUTPOST_HOST_URL = "http://127.0.0.1:4702";
    try {
      expect(instanceEnvPrefix()).toContain("GARRISON_KANBANLOOP_OUTPOST_HOST_URL='http://127.0.0.1:4702'");
    } finally {
      delete process.env.GARRISON_KANBANLOOP_OUTPOST_HOST_URL;
    }
  });

  it("drops a value containing a quote rather than trying to escape it into `sh -c`", () => {
    process.env.GARRISON_KANBAN_DIR = "/home/o'brien/.garrison/kanban-loop";
    expect(instanceEnvPrefix().join(" ")).not.toContain("o'brien");
  });
});

describe("registerTick — never downgrades a working registration", () => {
  it("KEEPS an existing job that carries a gateway URL when none is in scope", async () => {
    const good =
      "GARRISON_GATEWAY_URL='http://127.0.0.1:5777' GARRISON_HOME='/home/x/.garrison' node /x/kanban.mjs --tick";
    writeJobs([{ id: "kanban-tick", cron: "*/2 * * * *", command: good, enabled: true }]);

    // No gateway URL in scope — exactly the apm.yml setup hook's situation.
    // @ts-ignore pure .mjs, no declarations
    const { registerTick } = await import(KANBAN_CLI_MODULE);
    await registerTick();

    const job = readJobs().find((j) => j.id === "kanban-tick");
    expect(job.command).toBe(good); // untouched: the setup hook may not clobber it
  });

  it("DOES register when the existing job has no gateway URL (nothing to lose)", async () => {
    writeJobs([{ id: "kanban-tick", cron: "*/2 * * * *", command: "node /x/kanban.mjs --tick", enabled: true }]);
    process.env.GARRISON_GATEWAY_URL = "http://127.0.0.1:5777";

    // @ts-ignore pure .mjs, no declarations
    const { registerTick } = await import(KANBAN_CLI_MODULE);
    await registerTick();

    const job = readJobs().find((j) => j.id === "kanban-tick");
    expect(job.command).toContain("GARRISON_GATEWAY_URL='http://127.0.0.1:5777'");
  });
});

// `node scripts/kanban.mjs --setup` is the apm.yml setup hook: if it exits non-zero,
// `up` ABORTS. No vitest previously loaded that module graph, so a defect reachable
// only through the CLI's own imports could not be caught — and one was introduced
// while fixing the tick: making scheduler-beats.mjs dynamically import kanban.mjs
// (which statically imports scheduler-beats) created a cycle that never settles, so
// the process exited 13 mid-setup and a live `up` failed with
// "setup failed for kanban-loop: exit 13". This runs the real entrypoint.
describe("syncListBeat — the Test beat never downgrades either", () => {
  it("KEEPS an existing beat that carries a gateway URL when none is in scope", async () => {
    const good =
      "GARRISON_GATEWAY_URL='http://127.0.0.1:5777' node /x/kanban.mjs --tick-list test";
    writeJobs([{ id: "kanban-test-beat", cron: "0 */5 * * *", command: good, enabled: true }]);

    // @ts-ignore pure .mjs, no declarations
    const { syncListBeat } = await import(BEATS_MODULE);
    const res = await syncListBeat(
      { id: "test", trigger: "scheduler-beat", beatCron: "0 */5 * * *" },
      { log: () => {} }
    );

    expect(res.action).toBe("kept");
    expect(readJobs().find((j) => j.id === "kanban-test-beat").command).toBe(good);
  });
});

describe("kanban.mjs --setup — the apm.yml hook actually completes", () => {
  it("exits 0 and registers both the tick and the Test beat with this instance's identity", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("../fittings/seed/kanban-loop/scripts/kanban.mjs", import.meta.url));

    const run = spawnSync(process.execPath, [cli, "--setup"], {
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...process.env,
        GARRISON_HOME: home,
        GARRISON_KANBAN_DIR: join(home, "kanban-loop"),
        GARRISON_GATEWAY_URL: "http://127.0.0.1:5777"
      }
    });

    expect(
      run.status,
      `--setup must exit 0 or \`up\` aborts.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    ).toBe(0);

    const jobs = readJobs();
    expect(jobs.find((j) => j.id === "kanban-tick")?.command).toContain(
      "GARRISON_GATEWAY_URL='http://127.0.0.1:5777'"
    );
    // The Test list is scheduler-beat: its beat must carry the same instance identity.
    expect(jobs.find((j) => j.id === "kanban-test-beat")?.command).toContain(
      "GARRISON_GATEWAY_URL='http://127.0.0.1:5777'"
    );
  }, 120_000);
});
