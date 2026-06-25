import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEDULER = path.join(REPO_ROOT, "fittings", "seed", "scheduler", "scripts", "scheduler.mjs");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runScheduler(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [SCHEDULER, ...args], {
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

describe("scheduler.mjs CLI", () => {
  let tmpRoot: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-scheduler-"));
    env = {
      GARRISON_SCHEDULER_JOBS: path.join(tmpRoot, "jobs.json"),
      GARRISON_SCHEDULER_LOG: path.join(tmpRoot, "scheduler.log"),
      MARKER_PATH: path.join(tmpRoot, "marker.txt")
    };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("register creates a disabled job and tick skips it", async () => {
    const command = "node -e \"require('fs').writeFileSync(process.env.MARKER_PATH, 'ran')\"";
    const registered = await runScheduler([
      "register",
      "improver-nightly",
      "* * * * *",
      "--disabled",
      "--description",
      "proposal",
      "--",
      command
    ], env);
    expect(registered.exitCode).toBe(0);
    expect(registered.stdout).toContain("registered improver-nightly (disabled)");

    const list = await runScheduler(["list"], env);
    const jobs = JSON.parse(list.stdout).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "improver-nightly", enabled: false, description: "proposal" });

    const tick = await runScheduler(["tick"], env);
    expect(tick.exitCode).toBe(0);
    expect(JSON.parse(tick.stdout).ran).toEqual([]);
    await expect(fs.stat(env.MARKER_PATH)).rejects.toThrow();
  });

  it("enable allows a registered job to run, and later register preserves that choice", async () => {
    const command = "node -e \"require('fs').writeFileSync(process.env.MARKER_PATH, 'ran')\"";
    await runScheduler(["register", "improver-nightly", "* * * * *", "--disabled", "--", command], env);

    const enabled = await runScheduler(["enable", "improver-nightly"], env);
    expect(enabled.exitCode).toBe(0);
    await runScheduler(["register", "improver-nightly", "* * * * *", "--disabled", "--", command], env);

    const list = await runScheduler(["list"], env);
    expect(JSON.parse(list.stdout).jobs[0].enabled).toBe(true);

    const tick = await runScheduler(["tick"], env);
    expect(tick.exitCode).toBe(0);
    expect(JSON.parse(tick.stdout).ran).toEqual([{ id: "improver-nightly", exit: 0 }]);
    expect(await fs.readFile(env.MARKER_PATH, "utf8")).toBe("ran");
  });
});
