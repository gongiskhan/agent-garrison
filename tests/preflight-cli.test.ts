import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fittings", "seed", "preflight", "scripts", "cli.mjs");

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
