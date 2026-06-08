import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeHome,
  globalCompositionDir,
  globalCompositionClaudeLink
} from "@/lib/claude-home";
import {
  ensureClaudeSymlink,
  ensureGlobalComposition,
  writeGlobalApmManifest,
  apmInstall,
  readGlobalLock
} from "@/lib/global-composition";
import type { ApmRunner } from "@/lib/apm-exec";

let garrisonRoot: string;
let claudeRoot: string;
const tmpDirs: string[] = [];
let priorHome: string | undefined;
let priorClaude: string | undefined;

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = tmp("gar-gc-home-");
  claudeRoot = tmp("gar-gc-claude-");
  process.env.GARRISON_HOME = garrisonRoot;
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("ensureClaudeSymlink", () => {
  it("creates the .claude symlink to claudeHome, is idempotent, and repoints", async () => {
    const r1 = await ensureClaudeSymlink();
    expect(r1).toEqual({ created: true, repointed: false });
    const link = globalCompositionClaudeLink();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(claudeHome()));

    const r2 = await ensureClaudeSymlink();
    expect(r2).toEqual({ created: false, repointed: false });

    // Point claudeHome elsewhere -> the link must repoint, never delete the old target.
    const oldTarget = fs.realpathSync(claudeRoot);
    const claude2 = tmp("gar-gc-claude2-");
    process.env.GARRISON_CLAUDE_HOME = claude2;
    const r3 = await ensureClaudeSymlink();
    expect(r3).toEqual({ created: false, repointed: true });
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(claude2));
    expect(fs.existsSync(oldTarget)).toBe(true); // old ~/.claude untouched
  });
});

describe("writeGlobalApmManifest", () => {
  it("authors a parseable apm.yml whose dep path resolves to the fitting dir", async () => {
    const fittingDir = tmp("gar-gc-fitting-");
    fs.writeFileSync(path.join(fittingDir, "apm.yml"), "name: probe\n");

    await writeGlobalApmManifest([{ absPath: fittingDir }]);

    const manifest = yaml.load(
      fs.readFileSync(path.join(globalCompositionDir(), "apm.yml"), "utf8")
    ) as { target: string; dependencies: { apm: Array<{ path: string }> } };
    expect(manifest.target).toBe("claude");
    expect(manifest.dependencies.apm).toHaveLength(1);
    const dep = manifest.dependencies.apm[0];
    // The relative path resolves (from the composition dir) back to the fitting.
    expect(fs.existsSync(path.resolve(globalCompositionDir(), dep.path, "apm.yml"))).toBe(true);
  });

  it("ensureGlobalComposition seeds an empty apm.yml + the symlink", async () => {
    await ensureGlobalComposition();
    expect(fs.existsSync(path.join(globalCompositionDir(), "apm.yml"))).toBe(true);
    expect(fs.lstatSync(globalCompositionClaudeLink()).isSymbolicLink()).toBe(true);
  });
});

describe("apmInstall + readGlobalLock", () => {
  // A stub ApmRunner that models apm's verified behavior: deploy a skill THROUGH
  // the .claude symlink and write an apm.lock.yaml listing only that dep.
  const stubApm: ApmRunner = async (_args, cwd) => {
    const skillDir = path.join(cwd, ".claude", "skills", "foo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: foo\n---\n");
    fs.writeFileSync(
      path.join(cwd, "apm.lock.yaml"),
      [
        "dependencies:",
        "- repo_url: _local/foo",
        "  package_type: apm_package",
        "  deployed_files:",
        "  - .claude/skills/foo",
        "  deployed_file_hashes:",
        "    .claude/skills/foo: sha256:abc123",
        ""
      ].join("\n")
    );
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };

  it("deploys through the symlink and returns a normalized lock view", async () => {
    const lock = await apmInstall({ runApm: stubApm });

    expect(lock.allDeployedFiles.has("skills/foo")).toBe(true);
    expect(lock.deps).toHaveLength(1);
    expect(lock.deps[0].name).toBe("foo");
    expect(lock.deps[0].packageType).toBe("apm_package");
    expect(lock.deps[0].deployedHashes["skills/foo"]).toBe("sha256:abc123");

    // Write-through: the skill landed under the REAL claudeHome, link intact.
    expect(fs.existsSync(path.join(claudeHome(), "skills", "foo", "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(globalCompositionClaudeLink()).isSymbolicLink()).toBe(true);

    // readGlobalLock is a pure re-read of the same lock.
    const reread = await readGlobalLock();
    expect([...reread.allDeployedFiles]).toEqual(["skills/foo"]);
  });

  it("throws with apm's stderr when install fails", async () => {
    const failing: ApmRunner = async () => ({ ok: false, code: 1, stdout: "", stderr: "boom-detail" });
    await expect(apmInstall({ runApm: failing })).rejects.toThrow(/boom-detail/);
  });

  it("readGlobalLock returns an empty view when no lock exists yet", async () => {
    await ensureGlobalComposition();
    const lock = await readGlobalLock();
    expect(lock.deps).toEqual([]);
    expect(lock.allDeployedFiles.size).toBe(0);
  });
});
