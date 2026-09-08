import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const FITTING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fittings", "seed", "preflight");
const CLI = path.join(FITTING, "scripts", "cli.mjs");
const PROBE = path.join(FITTING, "scripts", "probe.mjs");

// GARRISON_APP_URL is pinned to an unreachable host so no test ever shells out
// to the instance script or touches a live app.
function run(args: string[], env: Record<string, string> = {}, cwd = os.tmpdir()) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GARRISON_APP_URL: "http://preflight-cli-fixture.invalid", ...env }
  });
}

function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "preflight-cli-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(root, "fittings", "seed"), { recursive: true });
  mkdirSync(path.join(root, "compositions", "c1"), { recursive: true });
  writeFileSync(path.join(root, "data", "library.json"), "[]\n");
  writeFileSync(path.join(root, "compositions", "c1", "apm.yml"), "selections:\n  runtime:\n    - id: nothing\n");
  return root;
}

describe("Preflight CLI entry point", () => {
  // B1: the doctor lives inside the repo it diagnoses, so it must find the root
  // from its own location. It used to walk up from the CALLER's cwd, which made
  // every invocation by absolute path from elsewhere fail outright.
  it("locates the repo from its own location, not the caller's cwd", () => {
    const res = run(["--checks", "kind-vocabulary"]);
    expect(res.stdout).not.toContain("Could not locate the Garrison repo root");
    expect(res.stdout).toContain("kind-vocabulary");
  });

  // B7: a sweep flips runner status, may run `apm install` and runs every setup
  // hook. It used to fall back to compositions[0] — whatever sorts first.
  it("refuses --sweep without an explicit --composition", () => {
    const root = fixtureRepo();
    const res = run(["--sweep"], { GARRISON_PREFLIGHT_REPO_ROOT: root });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--sweep requires --composition");
  });

  it("names the compositions it will not choose between", () => {
    const root = fixtureRepo();
    const res = run(["--sweep"], { GARRISON_PREFLIGHT_REPO_ROOT: root });
    expect(res.stderr).toContain("c1");
  });

  // Exit code is the contract for any caller chaining on it.
  it("exits 1 when a finding fails and 0 when none do", () => {
    const root = fixtureRepo();
    const clean = run(["--checks", "kind-vocabulary"], { GARRISON_PREFLIGHT_REPO_ROOT: root });
    expect(clean.status).toBe(0);
    const broken = run(["--checks", "kind-vocabulary"], { GARRISON_PREFLIGHT_REPO_ROOT: path.join(root, "nope") });
    expect(broken.status).toBe(1);
  });
});

// The probe is the runner's verify hook: a wrong answer here fails every up()
// of any composition that stations preflight. It checks the port the fitting
// will ACTUALLY bind, which means it must tell "already running (fine)" apart
// from "someone else has my port (fatal)".
describe("Preflight probe", () => {
  const open: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  });

  function serve(handler: http.RequestListener = (_q, s) => s.end()) {
    return new Promise<number>((resolve) => {
      const s = http.createServer(handler);
      open.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });
  }

  // Deliberately ASYNC: the fixture health server lives in this process, and
  // spawnSync would block the event loop that has to accept the probe's
  // connection -- the probe would then time out and read every fixture as a
  // foreign process.
  const probe = (env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [PROBE, "--probe"], { env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });

  const homeWithRecord = (port: number, pid: number) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "preflight-probe-"));
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(path.join(home, "ui-fittings", "preflight.json"), JSON.stringify({ fittingId: "preflight", port, pid }));
    return home;
  };

  it("passes when the configured port is free", async () => {
    const res = await probe({ GARRISON_PREFLIGHT_PORT: "0" });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
  });

  it("fails when a foreign process holds the configured port", async () => {
    const port = await serve();
    const res = await probe({ GARRISON_PREFLIGHT_PORT: String(port) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("is not preflight");
  });

  // The restart case: verify runs while this fitting is already listening.
  it("passes when the holder is this fitting's own recorded process", async () => {
    const pid = 424242;
    const port = await serve((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ ok: true, pid }));
    });
    const res = await probe({ GARRISON_PREFLIGHT_PORT: String(port), GARRISON_HOME: homeWithRecord(port, pid) });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
  });

  // A health endpoint answering with a pid nobody recorded is not proof of
  // ownership -- refuse rather than assume.
  it("refuses a health responder whose pid does not match the record", async () => {
    const port = await serve((_q, s) => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(JSON.stringify({ ok: true, pid: 111 }));
    });
    const res = await probe({ GARRISON_PREFLIGHT_PORT: String(port), GARRISON_HOME: homeWithRecord(port, 999) });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("records");
  });
});
