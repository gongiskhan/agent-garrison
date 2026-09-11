import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApmRunner } from "../src/lib/apm-exec";
import { installSharedApm } from "../src/lib/shared-apm";
import { HomeQuarantine, contentHash } from "../src/lib/home-quarantine";
let root: string; let user: string; let fitting: string;
const apm: ApmRunner = async (_args, cwd) => {
  const manifest = YAML.parse(await fs.readFile(path.join(cwd, "apm.yml"), "utf8"));
  const deps = [];
  for (const input of manifest.dependencies.apm) {
    const payload = await fs.readFile(path.join(input.path, "payload.md"));
    const file = path.join(cwd, ".claude/skills/shared/SKILL.md"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, payload);
    deps.push({ repo_url: "_local/shared", local_path: input.path, deployed_files: [".claude/skills/shared", ".claude/skills/shared/SKILL.md"], deployed_file_hashes: { ".claude/skills/shared/SKILL.md": contentHash(payload) } });
  }
  if (deps.length) await fs.writeFile(path.join(cwd, "apm.lock.yaml"), YAML.stringify({ dependencies: deps }));
  return { ok: true, code: 0, stdout: "", stderr: "" };
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-apm-")); user = path.join(root, "user"); fitting = path.join(root, "fitting");
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", path.join(root, "garrison")); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(root, "managed")); vi.stubEnv("GARRISON_USER_CLAUDE_HOME", user); vi.stubEnv("GARRISON_ASSUME_INSTALLED", "1");
  await fs.mkdir(fitting); await fs.writeFile(path.join(fitting, "payload.md"), "package");
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("previews before touching user config and blocks an unowned collision", async () => {
  await fs.mkdir(path.join(user, "skills/shared"), { recursive: true }); await fs.writeFile(path.join(user, "skills/shared/SKILL.md"), "mine");
  const run = vi.fn(apm);
  await expect(installSharedApm([{ absPath: fitting }], { runApm: run, quarantine: new HomeQuarantine() })).rejects.toThrow("left untouched");
  expect(run).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(user, "skills/shared/SKILL.md"), "utf8")).toBe("mine");
});
it("installs and quarantines unchanged shared files when the set becomes empty", async () => {
  await installSharedApm([{ absPath: fitting }], { runApm: apm, quarantine: new HomeQuarantine() });
  const q = new HomeQuarantine(); const lock = await installSharedApm([], { runApm: apm, quarantine: q });
  expect(lock.deps).toEqual([]); expect(await fs.readFile(path.join(q.dir, "claude-code/skills/shared/SKILL.md"), "utf8")).toBe("package");
});
it("retains a user's edit on unshare instead of moving or deleting it", async () => {
  await installSharedApm([{ absPath: fitting }], { runApm: apm, quarantine: new HomeQuarantine() });
  await fs.writeFile(path.join(user, "skills/shared/SKILL.md"), "edited"); const q = new HomeQuarantine();
  await installSharedApm([], { runApm: apm, quarantine: q });
  expect(q.leftModified).toContain("skills/shared/SKILL.md"); expect(await fs.readFile(path.join(user, "skills/shared/SKILL.md"), "utf8")).toBe("edited");
});
