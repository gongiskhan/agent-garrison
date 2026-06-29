import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// B1 — the scheduler is a platform-agnostic always-on Node daemon: it fires cron
// jobs and supervises listeners with NO Claude Code dependency, serves /health,
// and shuts down gracefully on SIGTERM. These tests spawn the real daemon under
// a tmp jobs file (the only "Garrison" thing in scope is the .mjs + node).

const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEDULER = path.join(REPO_ROOT, "fittings", "seed", "scheduler", "scripts", "scheduler.mjs");
const HEALTH_PORT = 7991;

let tmpRoot: string;
let env: NodeJS.ProcessEnv;
let daemon: ChildProcess | null = null;

function cli(args: string[]): void {
  const r = spawnSync("node", [SCHEDULER, ...args], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scheduler ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-sched-daemon-"));
  env = {
    ...process.env,
    GARRISON_SCHEDULER_JOBS: path.join(tmpRoot, "jobs.json"),
    GARRISON_SCHEDULER_LOG: path.join(tmpRoot, "scheduler.log"),
    MARKER_PATH: path.join(tmpRoot, "marker.txt"),
    LISTENER_LOG: path.join(tmpRoot, "listener.log")
  };
});

afterEach(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill("SIGKILL");
  }
  daemon = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("scheduler daemon (B1)", () => {
  it("fires a cron job and serves /health with NO Claude Code in the env", async () => {
    cli(["add", "tick-marker", "* * * * *", "node -e \"require('fs').writeFileSync(process.env.MARKER_PATH,'ran')\""]);
    // Strip anything Claude-ish from the daemon env to prove independence.
    const cleanEnv = { ...env };
    for (const k of Object.keys(cleanEnv)) {
      if (/CLAUDE|ANTHROPIC/i.test(k)) delete cleanEnv[k];
    }
    daemon = spawn("node", [SCHEDULER, "daemon", "--health-port", String(HEALTH_PORT)], { env: cleanEnv });

    const fired = await waitFor(async () => {
      try {
        await fs.stat(env.MARKER_PATH as string);
        return true;
      } catch {
        return false;
      }
    }, 12000);
    expect(fired).toBe(true);

    // The cron loop and the HTTP listener come up independently, so the marker firing
    // does NOT imply /health is bound yet. Under parallel CPU load the listen() can lag
    // the first tick; poll until it answers (otherwise an unguarded fetch → ECONNREFUSED).
    let body: { status: string; pid: number } | null = null;
    const healthy = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`);
        if (res.status !== 200) return false;
        body = (await res.json()) as { status: string; pid: number };
        return true;
      } catch {
        return false;
      }
    }, 10000);
    expect(healthy).toBe(true);
    expect(body!.status).toBe("ok");
    expect(typeof body!.pid).toBe("number");
  }, 20000);

  it("shuts down gracefully (exit 0) on SIGTERM", async () => {
    daemon = spawn("node", [SCHEDULER, "daemon", "--health-port", String(HEALTH_PORT + 1)], { env });
    // Wait until /health is up so we know the daemon is fully running.
    const up = await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${HEALTH_PORT + 1}/health`);
        return r.status === 200;
      } catch {
        return false;
      }
    }, 10000);
    expect(up).toBe(true);

    const exitCode: number = await new Promise((resolve) => {
      daemon!.on("exit", (code) => resolve(code ?? -1));
      daemon!.kill("SIGTERM");
    });
    expect(exitCode).toBe(0);
  }, 20000);

  it("supervises a listener worker and restarts it on exit", async () => {
    // A listener whose command appends a line then exits — the supervisor should
    // restart it, so the log accrues multiple lines over a few seconds.
    cli([
      "register",
      "poller",
      "* * * * *",
      "--type",
      "listener",
      "--",
      "node -e \"require('fs').appendFileSync(process.env.LISTENER_LOG,'tick\\n')\""
    ]);
    daemon = spawn("node", [SCHEDULER, "daemon", "--health-port", String(HEALTH_PORT + 2)], { env });

    const restarted = await waitFor(async () => {
      try {
        const content = await fs.readFile(env.LISTENER_LOG as string, "utf8");
        return content.split("\n").filter(Boolean).length >= 2;
      } catch {
        return false;
      }
    }, 12000);
    expect(restarted).toBe(true);
  }, 20000);
});
