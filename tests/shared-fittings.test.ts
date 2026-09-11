import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcileShared, type SharedSetup } from "../src/lib/shared-fittings";
import { readSharedState } from "../src/lib/home-ownership";
import type { Composition, LibraryEntry } from "../src/lib/types";
import type { ApmRunner } from "../src/lib/apm-exec";
let root: string; let composition: Composition;
const library = [{ id: "basic-memory", localPath: "fittings/seed/basic-memory", metadata: { setup: [] } }] as unknown as LibraryEntry[];
const apm: ApmRunner = async (_args, cwd) => { await fs.writeFile(path.join(cwd, "apm.lock.yaml"), "dependencies: []\n"); return { ok: true, code: 0, stdout: "", stderr: "" }; };
const setup: SharedSetup = async (_entry, _cwd, _config, env) => {
  if (env.GARRISON_SHARE_RUNTIMES.includes("claude-code")) {
    await fs.mkdir(env.GARRISON_CLAUDE_HOME, { recursive: true });
    await fs.writeFile(env.GARRISON_CLAUDE_JSON, JSON.stringify({ mcpServers: { "basic-memory": { command: "bm" } } }));
    await fs.writeFile(env.GARRISON_CLAUDE_SETTINGS_PATH, JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:basic-memory", hooks: [{ command: "capture" }] }] } }));
  }
  if (env.GARRISON_SHARE_RUNTIMES.includes("codex")) { await fs.mkdir(env.CODEX_HOME, { recursive: true }); await fs.writeFile(path.join(env.CODEX_HOME, "config.toml"), 'model = "mine"\n[mcp_servers.basic-memory]\ncommand = "bm"\n'); }
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-fittings-"));
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", path.join(root, "garrison")); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(root, "managed"));
  vi.stubEnv("GARRISON_USER_CLAUDE_HOME", path.join(root, "user")); vi.stubEnv("GARRISON_USER_CLAUDE_JSON", path.join(root, "user.json"));
  vi.stubEnv("GARRISON_USER_CODEX_HOME", path.join(root, "codex")); vi.stubEnv("GARRISON_USER_GEMINI_HOME", path.join(root, "gemini")); vi.stubEnv("GARRISON_ASSUME_INSTALLED", "1");
  composition = { id: "fixture", directory: path.join(root, "composition"), selections: { memory: [{ id: "basic-memory", config: {}, shared: ["claude-code", "codex"] }] } } as Composition;
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("shares only the selected runtimes, records ownership, and quarantines a native registration on unshare", async () => {
  const runSetup = vi.fn(setup);
  await reconcileShared(composition, { library, runApm: apm, runSetup });
  expect(runSetup.mock.calls[0][3]).toMatchObject({ GARRISON_SHARE_TARGET: "user", GARRISON_SHARE_RUNTIMES: "claude-code,codex", CODEX_HOME: path.join(root, "codex"), GARRISON_CLAUDE_HOME: path.join(root, "user") });
  expect((await readSharedState()).byRuntime.codex).toEqual(["basic-memory"]);
  composition.selections.memory![0].shared = ["claude-code"];
  const result = await reconcileShared(composition, { library, runApm: apm, runSetup });
  expect((await readSharedState()).byRuntime.codex).toEqual([]);
  expect(await fs.readFile(path.join(root, "codex/config.toml"), "utf8")).toBe('model = "mine"\n');
  expect(JSON.parse(await fs.readFile(path.join(result.quarantineDir, "removed.json"), "utf8")).items[0]).toMatchObject({ kind: "mcp", runtime: "codex", ref: "basic-memory" });
});
it("unsharing all strips only the fitting's owner-tagged hooks and keeps the user hook", async () => {
  await reconcileShared(composition, { library, runApm: apm, runSetup: setup });
  const file = path.join(root, "user/settings.json"); const config = JSON.parse(await fs.readFile(file, "utf8")); config.hooks.Stop.push({ hooks: [{ command: "my hook" }] }); await fs.writeFile(file, JSON.stringify(config));
  composition.selections.memory![0].shared = [];
  const result = await reconcileShared(composition, { library, runApm: apm, runSetup: setup });
  expect(result.hooksStripped).toBe(1);
  expect(JSON.parse(await fs.readFile(file, "utf8")).hooks.Stop).toEqual([{ hooks: [{ command: "my hook" }] }]);
  expect((await readSharedState()).byRuntime).toEqual({ "claude-code": [], codex: [], gemini: [] });
});
it("keeps the prior shared state when setup fails", async () => {
  const broken: SharedSetup = async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "fixture failure" });
  await expect(reconcileShared(composition, { library, runApm: apm, runSetup: broken })).rejects.toThrow("fixture failure");
  expect((await readSharedState()).at).toBe("");
});
