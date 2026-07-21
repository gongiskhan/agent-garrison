import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadProjectConfig,
  inferPortNeeds,
  inferDefaultBaseBranch,
  _resetProjectConfigCacheForTests
} from "@/lib/project-config";
import { execFileSync } from "node:child_process";

let tmpDir: string;

async function makeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-pc-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  await fsp.writeFile(path.join(dir, "README.md"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("project-config", () => {
  beforeEach(() => {
    _resetProjectConfigCacheForTests();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
    }
  });

  it("loads in-repo .garrison/project.yml when present", async () => {
    tmpDir = await makeRepo();
    await fsp.mkdir(path.join(tmpDir, ".garrison"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, ".garrison", "project.yml"),
      [
        "id: my-app",
        "name: My App",
        "portNeeds:",
        "  - name: frontend",
        "    default: 3000",
        "  - name: backend",
        "    default: 4000",
        "defaultBaseBranch: develop"
      ].join("\n")
    );

    const cfg = await loadProjectConfig(tmpDir);
    expect(cfg.id).toBe("my-app");
    expect(cfg.name).toBe("My App");
    expect(cfg.portNeeds).toEqual([
      { name: "frontend", default: 3000 },
      { name: "backend", default: 4000 }
    ]);
    expect(cfg.defaultBaseBranch).toBe("develop");
  });

  it("falls back to defaults when neither in-repo nor ~/.garrison/projects/*.yml exists", async () => {
    tmpDir = await makeRepo();
    const cfg = await loadProjectConfig(tmpDir);
    expect(cfg.name).toBe(path.basename(tmpDir));
    expect(cfg.defaultBaseBranch).toMatch(/^(main|master)$/);
  });

  it("caches loaded config for the same repoPath", async () => {
    tmpDir = await makeRepo();
    const a = await loadProjectConfig(tmpDir);
    const b = await loadProjectConfig(tmpDir);
    expect(a).toBe(b);
  });

  describe("inferPortNeeds", () => {
    it("returns empty when no package.json or .env", async () => {
      tmpDir = await makeRepo();
      expect(inferPortNeeds(tmpDir)).toEqual([]);
    });

    it("extracts PORT= from .env file", async () => {
      tmpDir = await makeRepo();
      await fsp.writeFile(path.join(tmpDir, ".env"), "PORT=8080\nFOO=bar\n");
      const needs = inferPortNeeds(tmpDir);
      expect(needs).toEqual([{ name: "port", default: 8080 }]);
    });

    it("extracts default Next/Vite ports from package.json scripts", async () => {
      tmpDir = await makeRepo();
      await fsp.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ scripts: { dev: "next dev" } })
      );
      const needs = inferPortNeeds(tmpDir);
      // Garrison's Next dev port is 27777 (commit 4aeb727 moved it off 3000).
      expect(needs.some((n) => n.default === 27777)).toBe(true);
    });
  });

  describe("inferDefaultBaseBranch", () => {
    it("returns the local main branch when no remote", async () => {
      tmpDir = await makeRepo();
      const branch = inferDefaultBaseBranch(tmpDir);
      expect(branch).toBe("main");
    });
  });
});
