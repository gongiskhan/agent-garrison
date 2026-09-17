import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getUserQuartersState, runUserQuartersAction } from "@/lib/quarters-user";
import { runtimeConfigPath } from "@/lib/quarters-runtimes";
import { contentHash } from "@/lib/home-quarantine";
const fixtureId = `quarters-promote-fixture-${process.pid}`;
vi.mock("@/lib/active-composition", () => ({ resolveActiveComposition: async () => ({ id: `quarters-promote-fixture-${process.pid}` }) }));
import { getCompositionDirectory, readComposition, ensureComposition } from "@/lib/compositions";
import { capturedFittingsDir } from "@/lib/claude-home";
import { parseGarrisonMetadata } from "@/lib/metadata";
let root: string;
async function write(ref: string, value: string) { const file = path.join(root, ref); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "quarters-homes-"));
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", path.join(root, "garrison")); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(root, "garrison/runtime-homes/claude"));
  vi.stubEnv("GARRISON_USER_CLAUDE_HOME", path.join(root, "user")); vi.stubEnv("GARRISON_USER_CLAUDE_JSON", path.join(root, "user.json"));
  vi.stubEnv("GARRISON_USER_CODEX_HOME", path.join(root, "codex")); vi.stubEnv("GARRISON_USER_GEMINI_HOME", path.join(root, "gemini"));
  vi.stubEnv("CODEX_HOME", path.join(root, "garrison/runtime-homes/codex")); vi.stubEnv("GEMINI_CLI_HOME", path.join(root, "garrison/runtime-homes/gemini"));
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(getCompositionDirectory(fixtureId), { recursive: true, force: true }); });
it("lists Shared ownership and leaks without exposing config values", async () => {
  await write("user/skills/memory/SKILL.md", "shared"); await write("user/skills/my-notes/SKILL.md", "mine"); await write("user/skills/garrison-old/SKILL.md", "old");
  await write("garrison/user-composition/apm.lock.yaml", YAML.stringify({ dependencies: [{ repo_url: "_local/basic-memory", deployed_files: [".claude/skills/memory/SKILL.md"], deployed_file_hashes: { ".claude/skills/memory/SKILL.md": contentHash("shared") } }] }));
  await write("garrison/user-composition/shared-state.json", JSON.stringify({ version: 1, byRuntime: { "claude-code": ["basic-memory"], codex: [], gemini: [] }, at: "now" }));
  await write("user/settings.json", JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:basic-memory", hooks: [{ command: "private command" }] }] } }));
  await write("user.json", JSON.stringify({ mcpServers: { mine: { env: { SECRET: "private secret" } } } }));
  const state = await getUserQuartersState("claude-code");
  expect(state.rows.find(row => row.name === "memory")).toMatchObject({ sharedOwner: "basic-memory", canPromote: false });
  expect(state.rows.find(row => row.name === "garrison-old")?.leak?.reason).toBe("legacy-name");
  expect(state.rows.find(row => row.name === "my-notes")?.canPromote).toBe(true);
  expect(JSON.stringify(state)).not.toMatch(/private secret|private command/);
});
it("quarantines only the chosen current leak and refuses ordinary writes", async () => {
  await write("user/skills/garrison-first/SKILL.md", "first"); await write("user/skills/garrison-second/SKILL.md", "second"); await write("user/skills/mine/SKILL.md", "mine");
  await runUserQuartersAction("claude-code", "quarantine", "skill:skills/garrison-first");
  expect(await fs.readFile(path.join(root, "user/skills/garrison-second/SKILL.md"), "utf8")).toBe("second");
  await expect(fs.stat(path.join(root, "user/skills/garrison-first"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(runUserQuartersAction("claude-code", "quarantine", "skill:skills/mine")).rejects.toThrow("Only a reported leak");
  await expect(runUserQuartersAction("claude-code", "delete", "skill:skills/mine")).rejects.toThrow("read-only");
  expect(await fs.readFile(path.join(root, "user/skills/mine/SKILL.md"), "utf8")).toBe("mine");
});
it("maps native generic descriptors to Garrison homes and preserves explicit fixture paths", () => {
  expect(runtimeConfigPath("codex", "~/.codex/config.toml")).toBe(path.join(root, "garrison/runtime-homes/codex/config.toml"));
  expect(runtimeConfigPath("gemini", "~/.gemini/settings.json")).toBe(path.join(root, "garrison/runtime-homes/gemini/settings.json"));
  expect(runtimeConfigPath("codex", path.join(root, "explicit/config.toml"))).toBe(path.join(root, "explicit/config.toml"));
});
it("reads user Codex and Gemini registrations from their own config", async () => {
  await write("codex/config.toml", '[mcp_servers.mine]\ncommand = "codex-mine"\n');
  await write("gemini/settings.json", JSON.stringify({ mcpServers: { other: { command: "gemini-mine" } } }));
  expect((await getUserQuartersState("codex")).rows.map(row => row.name)).toEqual(["mine"]);
  expect((await getUserQuartersState("gemini")).rows.map(row => row.name)).toEqual(["other"]);
});

it("promotes a user primitive into a discoverable shared fitting without changing its bytes", async () => {
  vi.stubEnv("GARRISON_ASSUME_INSTALLED", "1");
  await write("user/skills/my-notes/SKILL.md", "# My notes\nOriginal user content.\n");
  await ensureComposition(fixtureId);
  const runApm = async (_args: string[], cwd: string) => {
    await fs.writeFile(path.join(cwd, "apm.lock.yaml"), YAML.stringify({ dependencies: [{ repo_url: "_local/my-notes", deployed_files: [".claude/skills/my-notes/SKILL.md"] }] }));
    return { ok: true, code: 0, stdout: "ok", stderr: "" };
  };
  const result = await runUserQuartersAction("claude-code", "promote", "skill:skills/my-notes", { runApm });
  expect(result).toMatchObject({ ok: true, fittingId: "my-notes" });
  const composition = await readComposition(fixtureId);
  expect(composition.selections.building).toContainEqual({ id: "my-notes", config: {}, shared: ["claude-code"] });
  const captured = YAML.parse(await fs.readFile(path.join(capturedFittingsDir(), "my-notes/apm.yml"), "utf8"));
  expect(parseGarrisonMetadata(captured["x-garrison"]).shared_default).toEqual(["claude-code"]);
  expect(await fs.readFile(path.join(root, "user/skills/my-notes/SKILL.md"), "utf8")).toBe("# My notes\nOriginal user content.\n");
});
