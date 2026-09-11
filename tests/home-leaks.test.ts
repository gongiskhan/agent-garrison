import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { checkHomeLeaks, quarantineHomeLeaks } from "../src/lib/home-leaks";
import { contentHash } from "../src/lib/home-quarantine";
import { valueHash } from "../src/lib/home-ownership";
let root: string; let user: string; let gh: string;
async function write(ref: string, value: string) { const file = path.join(root, ref); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "home-leaks-")); user = path.join(root, "user"); gh = path.join(root, "garrison");
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", gh); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(gh, "runtime-homes/claude"));
  vi.stubEnv("GARRISON_USER_CLAUDE_HOME", user); vi.stubEnv("GARRISON_USER_CLAUDE_JSON", path.join(root, "user.json"));
  vi.stubEnv("GARRISON_USER_CODEX_HOME", path.join(root, "codex")); vi.stubEnv("GARRISON_USER_GEMINI_HOME", path.join(root, "gemini"));
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("reports clean user config without materialising a home", async () => {
  const report = await checkHomeLeaks(); expect(report).toMatchObject({ ok: true, leaks: [], sharedOwners: [] });
  expect((await fs.readdir(root))).toEqual([]);
});
it("finds owned files, tagged hooks, ledger MCPs, legacy names and legacy commands across runtimes", async () => {
  await write("user/skills/owned/SKILL.md", "owned");
  await write("garrison/global-composition/apm.lock.yaml", YAML.stringify({ dependencies: [{ repo_url: "_local/fitting", deployed_files: [".claude/skills/owned/SKILL.md"], deployed_file_hashes: { ".claude/skills/owned/SKILL.md": contentHash("owned") } }] }));
  await write("user/settings.json", JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:dev-env", hooks: [] }, { hooks: [{ command: "node /old/garrison-goal-stop.mjs" }] }, { hooks: [{ command: "my-hook" }] }] } }));
  const mcp = { command: "coord" };
  await write("user.json", JSON.stringify({ mcpServers: { coord: mcp, mine: { command: "mine" } } }));
  await write("garrison/global-composition/garrison-provenance.json", JSON.stringify({ "mcp:coord": { fittingId: "coord", surface: "mcp", lastWrittenHash: valueHash(mcp) } }));
  await write("codex/skills/autothing/SKILL.md", "legacy"); await write("gemini/commands/garrison-old.md", "old");
  const report = await checkHomeLeaks();
  expect(report.leaks).toHaveLength(6);
  expect(new Set(report.leaks.map(x => x.reason))).toEqual(new Set(["garrison-owned-not-shared", "legacy-name", "legacy-hook-command"]));
  const result = await quarantineHomeLeaks(); expect(result.report.ok).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(user, "settings.json"), "utf8")).hooks.Stop).toEqual([{ hooks: [{ command: "my-hook" }] }]);
  expect(JSON.parse(await fs.readFile(path.join(root, "user.json"), "utf8")).mcpServers).toEqual({ mine: { command: "mine" } });
  const removed = JSON.parse(await fs.readFile(path.join(result.quarantineDir, "removed.json"), "utf8")); expect(removed.items).toHaveLength(3);
});
it("keeps shared owners and their lock-owned legacy-named skills", async () => {
  const lock = { dependencies: [{ repo_url: "_local/basic-memory", deployed_files: [".claude/skills/garrison-memory", ".claude/skills/garrison-memory/SKILL.md"], deployed_file_hashes: { ".claude/skills/garrison-memory/SKILL.md": contentHash("shared") } }] };
  await write("user/skills/garrison-memory/SKILL.md", "shared"); await write("garrison/global-composition/apm.lock.yaml", YAML.stringify(lock)); await write("garrison/user-composition/apm.lock.yaml", YAML.stringify(lock));
  await write("user/settings.json", JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:basic-memory", hooks: [] }] } }));
  await write("user.json", JSON.stringify({ mcpServers: { "basic-memory": { command: "bm" } } }));
  await write("garrison/global-composition/garrison-provenance.json", JSON.stringify({ "mcp:basic-memory": { fittingId: "basic-memory", surface: "mcp" } }));
  await write("garrison/user-composition/shared-state.json", JSON.stringify({ version: 1, byRuntime: { "claude-code": ["basic-memory"], codex: [], gemini: [] }, at: "now" }));
  expect((await checkHomeLeaks()).ok).toBe(true);
});
it("never treats modified lock files or MCP entries as removable leaks", async () => {
  await write("user/skills/garrison-plan/SKILL.md", "my edits");
  await write("garrison/global-composition/apm.lock.yaml", YAML.stringify({ dependencies: [{ repo_url: "_local/garrison", deployed_files: [".claude/skills/garrison-plan/SKILL.md"], deployed_file_hashes: { ".claude/skills/garrison-plan/SKILL.md": contentHash("old") } }] }));
  await write("user.json", JSON.stringify({ mcpServers: { owned: { command: "my-command" } } }));
  await write("garrison/global-composition/garrison-provenance.json", JSON.stringify({ "mcp:owned": { fittingId: "old", surface: "mcp", lastWrittenHash: valueHash({ command: "old-command" }) } }));
  expect((await quarantineHomeLeaks()).report.ok).toBe(true);
  expect(await fs.readFile(path.join(user, "skills/garrison-plan/SKILL.md"), "utf8")).toBe("my edits");
});
