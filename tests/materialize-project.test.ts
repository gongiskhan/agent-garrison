import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore — worker bundle is dependency-free source ESM.
import { materialize } from "../fittings/seed/outpost-worker/scripts/materialize.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function remoteFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "outpost-materialize-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const projectsRoot = path.join(root, "projects");
  mkdirSync(source);
  mkdirSync(projectsRoot);
  execFileSync("git", ["-C", source, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", source, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
  writeFileSync(path.join(source, "README.md"), "fixture\n");
  execFileSync("git", ["-C", source, "add", "README.md"]);
  execFileSync("git", ["-C", source, "commit", "-qm", "fixture"]);
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  return {
    root,
    remote,
    projectsRoot,
    loadout: {
      id: "project",
      repo_remote: remote,
      default_branch: "main",
      setup_commands: ["touch setup-ran"],
      env_vars: [],
      verify_command: "test -f README.md"
    }
  };
}

describe("Outpost Loadout checkout isolation", () => {
  it("fails closed before setup when an existing checkout is dirty", async () => {
    const fixture = remoteFixture();
    const target = path.join(fixture.projectsRoot, fixture.loadout.id);
    execFileSync("git", ["clone", "-q", fixture.remote, target]);
    writeFileSync(path.join(target, "local-work.txt"), "do not overwrite\n");

    const result = await materialize(fixture.loadout, {
      projectsRoot: fixture.projectsRoot,
      branch: "dispatch/studio"
    });

    expect(result).toMatchObject({ ok: false, failed: "dirty checkout", target });
    expect(result.steps.find((step: any) => step.name === "branch")).toMatchObject({ ok: false, exitCode: 75 });
    expect(existsSync(path.join(target, "setup-ran"))).toBe(false);
    expect(execFileSync("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("main");
  });

  it("creates a clean machine branch from the authored remote default", async () => {
    const fixture = remoteFixture();
    const result = await materialize({ ...fixture.loadout, setup_commands: [] }, {
      projectsRoot: fixture.projectsRoot,
      branch: "dispatch/studio"
    });

    expect(result).toMatchObject({ ok: true, failed: null });
    expect(execFileSync("git", ["-C", result.target, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("dispatch/studio");
    expect(execFileSync("git", ["-C", result.target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(
      execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim()
    );
  });
});
