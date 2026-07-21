import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteJobCommands } from "../scripts/repoint-scheduler-jobs.mjs";

const SCRIPT = path.join(process.cwd(), "scripts", "repoint-scheduler-jobs.mjs");

describe("scheduler checkout detachment", () => {
  it("rewrites only exact installed-module prefixes and preserves job state", () => {
    const jobs = [
      {
        id: "kanban-tick",
        command: "node /old/compositions/default/apm_modules/_local/kanban-loop/scripts/kanban.mjs --tick",
        enabled: false,
        last_run: "2026-07-17T00:00:00.000Z"
      },
      { id: "unrelated", command: "node /somewhere/else/task.mjs", enabled: true }
    ];
    const result = rewriteJobCommands(
      jobs,
      "/old/compositions/default/apm_modules",
      "/new/compositions/default/apm_modules"
    );

    expect(result.changed).toBe(1);
    expect(result.jobs[0]).toMatchObject({
      enabled: false,
      last_run: "2026-07-17T00:00:00.000Z",
      command: "node /new/compositions/default/apm_modules/_local/kanban-loop/scripts/kanban.mjs --tick"
    });
    expect(result.jobs[1]).toEqual(jobs[1]);
  });

  it("is dry-run by default and applies atomically only with an explicit backup", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "garrison-scheduler-detach-"));
    const from = path.join(root, "old", "compositions", "default", "apm_modules");
    const to = path.join(root, "new", "compositions", "default", "apm_modules");
    const oldScript = path.join(from, "_local", "task", "run.mjs");
    const newScript = path.join(to, "_local", "task", "run.mjs");
    mkdirSync(path.dirname(oldScript), { recursive: true });
    mkdirSync(path.dirname(newScript), { recursive: true });
    writeFileSync(oldScript, "");
    writeFileSync(newScript, "");

    const file = path.join(root, "jobs.json");
    const backup = path.join(root, "jobs.before.json");
    const original = `${JSON.stringify([{ id: "task", command: `node ${oldScript}`, enabled: true }], null, 2)}\n`;
    writeFileSync(file, original);

    const baseArgs = ["--file", file, "--from", from, "--to", to, "--expect", "1"];
    const dryRun = JSON.parse(execFileSync("node", [SCRIPT, ...baseArgs], { encoding: "utf8" }));
    expect(dryRun.mode).toBe("dry-run");
    expect(readFileSync(file, "utf8")).toBe(original);

    const applied = JSON.parse(
      execFileSync("node", [SCRIPT, ...baseArgs, "--apply", "--backup", backup], {
        encoding: "utf8"
      })
    );
    expect(applied.mode).toBe("applied");
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].command).toBe(`node ${newScript}`);
  });
});
