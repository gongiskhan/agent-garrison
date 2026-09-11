import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { reconcileHomes } from "../src/lib/homes-migration";
import { checkHomeLeaks } from "../src/lib/home-leaks";
import { contentHash } from "../src/lib/home-quarantine";
import type { ApmRunner } from "../src/lib/apm-exec";
import type { Composition, LibraryEntry } from "../src/lib/types";
let root: string; let gh: string; let user: string; let composition: Composition; let library: LibraryEntry[];
async function write(file: string, bytes: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
const apm: ApmRunner = async (_args, cwd) => {
  const manifest = YAML.parse(await fs.readFile(path.join(cwd, "apm.yml"), "utf8"));
  const deps = [];
  for (const input of manifest.dependencies.apm) {
    const name = path.basename(input.path); const source = path.join(input.path, ".apm/skills");
    const files: string[] = []; const hashes: Record<string, string> = {};
    for (const skill of await fs.readdir(source).catch(() => [])) {
      const ref = `skills/${skill}/SKILL.md`; const bytes = await fs.readFile(path.join(source, skill, "SKILL.md"), "utf8");
      await write(path.join(cwd, ".claude", ref), bytes); files.push(`.claude/skills/${skill}`, `.claude/${ref}`); hashes[`.claude/${ref}`] = contentHash(bytes);
    }
    deps.push({ repo_url: `_local/${name}`, local_path: input.path, deployed_files: files, deployed_file_hashes: hashes });
  }
  await write(path.join(cwd, "apm.lock.yaml"), YAML.stringify({ dependencies: deps }));
  return { ok: true, code: 0, stdout: "", stderr: "" };
};
const setup = async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "two-homes-migration-")); gh = path.join(root, "garrison"); user = path.join(root, "user");
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", gh); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(gh, "runtime-homes/claude")); vi.stubEnv("GARRISON_CLAUDE_JSON", path.join(gh, "runtime-homes/claude/.claude.json"));
  vi.stubEnv("GARRISON_USER_CLAUDE_HOME", user); vi.stubEnv("GARRISON_USER_CLAUDE_JSON", path.join(root, "user.json"));
  vi.stubEnv("GARRISON_USER_CODEX_HOME", path.join(root, "codex")); vi.stubEnv("GARRISON_USER_GEMINI_HOME", path.join(root, "gemini")); vi.stubEnv("GARRISON_ASSUME_INSTALLED", "1");
  const discipline = path.join(root, "fittings/discipline"); const bm = path.join(root, "fittings/basic-memory"); const coord = path.join(root, "fittings/coord-agentmail");
  for (const name of ["garrison-one", "garrison-two", "garrison-three", "garrison-modified"]) await write(path.join(discipline, ".apm/skills", name, "SKILL.md"), `original ${name}`);
  await write(path.join(bm, ".apm/skills/garrison-memory/SKILL.md"), "shared memory"); await fs.mkdir(coord, { recursive: true });
  const global = path.join(gh, "global-composition"); await fs.mkdir(global, { recursive: true }); await fs.mkdir(user); await fs.symlink(user, path.join(global, ".claude"));
  await write(path.join(global, "apm.yml"), YAML.stringify({ name: "old", dependencies: { apm: [{ path: discipline }] } })); await apm([], global);
  await write(path.join(user, "skills/garrison-modified/SKILL.md"), "my modified instructions"); await write(path.join(user, "skills/my-notes/SKILL.md"), "my notes"); await write(path.join(user, "skills/autothing/SKILL.md"), "legacy");
  await write(path.join(user, "settings.json"), JSON.stringify({ model: "my-model", hooks: { Stop: [{ _garrison: "fitting:basic-memory", hooks: [{ command: "memory" }] }, { _garrison: "fitting:dev-env", hooks: [{ command: "dev" }] }, { _garrison: true, hooks: [{ command: "old" }] }, { hooks: [{ command: "garrison-goal-stop" }] }, { hooks: [{ command: "my-hook" }] }] } }));
  await write(path.join(root, "user.json"), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { "coord-agentmail": { type: "http", url: "http://fixture/mcp" }, drill: { command: "old-drill" }, mine: { command: "mine" } } }));
  await write(path.join(global, "garrison-provenance.json"), JSON.stringify({ "mcp:coord-agentmail": { surface: "mcp", fittingId: "coord-agentmail" }, "mcp:drill": { surface: "mcp", fittingId: "drill" } }));
  await write(path.join(gh, "homes-inventory.json"), JSON.stringify({ at: "2026-09-11T00:00:00Z" }));
  library = [{ id: "basic-memory", localPath: bm, metadata: { setup: [] } }, { id: "coord-agentmail", localPath: coord, metadata: { setup: [] } }] as unknown as LibraryEntry[];
  composition = { id: "fixture", directory: path.join(root, "composition"), selections: { memory: [{ id: "basic-memory", config: {}, shared: ["claude-code", "codex"] }], coordination: [{ id: "coord-agentmail", config: {}, shared: ["claude-code"] }] } } as Composition;
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("migrates with quarantine, preserves user edits and shared primitives, and is idempotent", async () => {
  const notify = vi.fn(async () => undefined);
  const state = await reconcileHomes(composition, { runApm: apm, runSetup: setup, library, notify });
  expect(state.version).toBe(2); expect(state.report.leaks).toBe(0); expect(state.report.leftModified).toContain("skills/garrison-modified/SKILL.md");
  expect(await fs.readFile(path.join(gh, "runtime-homes/claude/skills/garrison-one/SKILL.md"), "utf8")).toBe("original garrison-one");
  expect(await fs.readFile(path.join(user, "skills/my-notes/SKILL.md"), "utf8")).toBe("my notes"); expect(await fs.readFile(path.join(user, "skills/garrison-modified/SKILL.md"), "utf8")).toBe("my modified instructions");
  expect(await fs.readFile(path.join(state.report.quarantineDir, "claude-code/skills/garrison-one/SKILL.md"), "utf8")).toBe("original garrison-one");
  expect(await fs.readFile(path.join(state.report.quarantineDir, "claude-code/skills/autothing/SKILL.md"), "utf8")).toBe("legacy");
  expect(JSON.parse(await fs.readFile(path.join(user, "settings.json"), "utf8")).hooks.Stop).toEqual([{ _garrison: "fitting:basic-memory", hooks: [{ command: "memory" }] }, { hooks: [{ command: "my-hook" }] }]);
  expect(JSON.parse(await fs.readFile(path.join(root, "user.json"), "utf8")).mcpServers).toEqual({ "coord-agentmail": { type: "http", url: "http://fixture/mcp" }, mine: { command: "mine" } });
  const removed = JSON.parse(await fs.readFile(path.join(state.report.quarantineDir, "removed.json"), "utf8")).items;
  expect(removed.find((item: { ref: string }) => item.ref === "drill").value).toEqual({ command: "old-drill" }); expect(removed).toHaveLength(4);
  expect((await checkHomeLeaks()).ok).toBe(true);
  const again = await reconcileHomes(composition, { runApm: apm, runSetup: setup, library, notify }); expect(again.report.moved).toBe(0); expect(notify).toHaveBeenCalledTimes(1);
});
it("does not clean any user config when the Garrison APM install fails", async () => {
  const settings = await fs.readFile(path.join(user, "settings.json")); const json = await fs.readFile(path.join(root, "user.json"));
  const failed: ApmRunner = async () => ({ ok: false, code: 1, stdout: "", stderr: "fixture install failure" });
  await expect(reconcileHomes(composition, { runApm: failed, runSetup: setup, library, notify: async () => undefined })).rejects.toThrow("fixture install failure");
  expect(await fs.readFile(path.join(user, "settings.json"))).toEqual(settings); expect(await fs.readFile(path.join(root, "user.json"))).toEqual(json);
  expect(await fs.readFile(path.join(user, "skills/garrison-one/SKILL.md"), "utf8")).toBe("original garrison-one");
  await expect(fs.stat(path.join(gh, "homes.json"))).rejects.toThrow();
});
it("retains the original snapshot and quarantine progress across a failed shared setup", async () => {
  const failed = async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "setup interrupted" });
  await expect(reconcileHomes(composition, { runApm: apm, runSetup: failed, library, notify: async () => undefined })).rejects.toThrow("setup interrupted");
  const journal = JSON.parse(await fs.readFile(path.join(gh, "homes-migration.json"), "utf8"));
  const state = await reconcileHomes(composition, { runApm: apm, runSetup: setup, library, notify: async () => undefined });
  expect(state.report.quarantineDir).toBe(journal.quarantineDir); expect(state.userConfigBackupDir).toBe(journal.backupDir); expect(state.report.moved).toBeGreaterThanOrEqual(4); expect(state.report.hooksStripped).toBe(3); expect(state.report.leaks).toBe(0);
});
