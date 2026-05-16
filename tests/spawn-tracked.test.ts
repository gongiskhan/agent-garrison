import { describe, expect, it, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  spawnTracked,
  logsDirForPid,
  garrisonLogsRoot,
  type MetaJson
} from "../src/lib/spawn";

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => null);
  }
});

describe("spawnTracked", () => {
  it("creates ~/.garrison/logs/<pid>/ with stdout.log, stderr.log, meta.json", async () => {
    const result = spawnTracked(
      "node",
      [
        "-e",
        "console.log('hello-stdout'); console.error('hello-stderr'); process.exit(0);"
      ],
      { env: { ...process.env, EXAMPLE_TOKEN: "should-redact", PLAIN_VAR: "keep" } },
      { spawnSite: "test:basic" }
    );

    expect(result.child.pid).toBeGreaterThan(0);
    dirsToClean.push(result.logsDir);

    await new Promise<void>((resolve) => result.child.on("close", () => resolve()));

    const stdout = await fsp.readFile(result.stdoutPath, "utf8");
    const stderr = await fsp.readFile(result.stderrPath, "utf8");
    const meta: MetaJson = JSON.parse(await fsp.readFile(result.metaPath, "utf8"));

    expect(stdout).toContain("hello-stdout");
    expect(stderr).toContain("hello-stderr");

    expect(meta.pid).toBe(result.child.pid);
    expect(meta.spawnSite).toBe("test:basic");
    expect(meta.command).toBe("node");
    expect(meta.args[0]).toBe("-e");
    expect(meta.shell).toBe(false);
    expect(meta.env.EXAMPLE_TOKEN).toBe("***REDACTED***");
    expect(meta.env.PLAIN_VAR).toBe("keep");
    expect(meta.parentPid).toBe(process.pid);
  });

  it("supports the shell-invocation form spawnTracked(cmd, options, meta)", async () => {
    const result = spawnTracked(
      "echo shell-form && >&2 echo shell-stderr",
      { shell: true, env: { ...process.env } },
      { spawnSite: "test:shell" }
    );

    expect(result.child.pid).toBeGreaterThan(0);
    dirsToClean.push(result.logsDir);

    await new Promise<void>((resolve) => result.child.on("close", () => resolve()));

    const stdout = await fsp.readFile(result.stdoutPath, "utf8");
    const stderr = await fsp.readFile(result.stderrPath, "utf8");
    const meta: MetaJson = JSON.parse(await fsp.readFile(result.metaPath, "utf8"));

    expect(stdout).toContain("shell-form");
    expect(stderr).toContain("shell-stderr");
    expect(meta.shell).toBe(true);
    expect(meta.args).toEqual([]);
  });

  it("redacts every variant of token/secret/key/password keys", async () => {
    const sensitive = {
      MY_API_TOKEN: "t",
      DATABASE_PASSWORD: "p",
      AWS_SECRET: "s",
      OPENAI_KEY: "k",
      TOKEN: "bare-token",
      SECRET: "bare-secret",
      KEY: "bare-key",
      NORMAL_CONFIG: "fine"
    };
    const result = spawnTracked(
      "node",
      ["-e", "process.exit(0)"],
      { env: { ...process.env, ...sensitive } },
      { spawnSite: "test:redact" }
    );
    dirsToClean.push(result.logsDir);
    await new Promise<void>((resolve) => result.child.on("close", () => resolve()));

    const meta: MetaJson = JSON.parse(await fsp.readFile(result.metaPath, "utf8"));
    expect(meta.env.MY_API_TOKEN).toBe("***REDACTED***");
    expect(meta.env.DATABASE_PASSWORD).toBe("***REDACTED***");
    expect(meta.env.AWS_SECRET).toBe("***REDACTED***");
    expect(meta.env.OPENAI_KEY).toBe("***REDACTED***");
    expect(meta.env.TOKEN).toBe("***REDACTED***");
    expect(meta.env.SECRET).toBe("***REDACTED***");
    expect(meta.env.KEY).toBe("***REDACTED***");
    expect(meta.env.NORMAL_CONFIG).toBe("fine");
  });

  it("places logs under ~/.garrison/logs/<pid>/", async () => {
    const result = spawnTracked(
      "node",
      ["-e", "process.exit(0)"],
      {},
      { spawnSite: "test:path" }
    );
    dirsToClean.push(result.logsDir);
    await new Promise<void>((resolve) => result.child.on("close", () => resolve()));

    expect(garrisonLogsRoot()).toBe(path.join(os.homedir(), ".garrison", "logs"));
    expect(result.logsDir).toBe(logsDirForPid(result.child.pid!));
    expect(result.logsDir.startsWith(garrisonLogsRoot())).toBe(true);
  });
});
