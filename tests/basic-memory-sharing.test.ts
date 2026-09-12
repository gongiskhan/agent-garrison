import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "basic-memory-sharing-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function run(runtimes: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["fittings/seed/basic-memory/scripts/share-setup.mjs"], { encoding: "utf8", env: {
    ...process.env, HOME: root, GARRISON_HOME: path.join(root, "garrison"), GARRISON_CLAUDE_HOME: path.join(root, "user"), GARRISON_CLAUDE_JSON: path.join(root, "user.json"), GARRISON_CLAUDE_SETTINGS_PATH: path.join(root, "user/settings.json"),
    GEMINI_CLI_HOME: path.join(root, "gemini"), CODEX_HOME: path.join(root, "codex"), BASIC_MEMORY_VAULT_DIR: path.join(root, "vault"), BASIC_MEMORY_BIN: "fixture-basic-memory", BASIC_MEMORY_BACKEND: "local", GARRISON_SHARE_TARGET: "user", GARRISON_SHARE_RUNTIMES: runtimes, ...extra
  } });
}
it("installs a selected JSON runtime and an owner-tagged hook without enrolling scheduler jobs", async () => {
  const result = run("claude-code"); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(path.join(root, "user.json"), "utf8")).mcpServers["basic-memory"]).toEqual({ command: "fixture-basic-memory", args: ["mcp"] });
  const settings = JSON.parse(await fs.readFile(path.join(root, "user/settings.json"), "utf8")); expect(settings.hooks.PreToolUse[0]._garrison).toBe("fitting:basic-memory");
  await expect(fs.stat(path.join(root, "garrison/scheduler-jobs.json"))).rejects.toThrow(); await expect(fs.stat(path.join(root, "gemini"))).rejects.toThrow();
});
it("does not touch unselected runtime config", async () => {
  const result = run("gemini"); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(path.join(root, "gemini/settings.json"), "utf8")).mcpServers["basic-memory"]).toBeDefined();
  await expect(fs.stat(path.join(root, "user"))).rejects.toThrow(); await expect(fs.stat(path.join(root, "user.json"))).rejects.toThrow();
});
it("preserves an existing user registration and unrelated settings", async () => {
  const bytes = '{ "theme": "mine", "mcpServers": { "basic-memory": { "command": "my-custom-memory" } } }\n'; await fs.writeFile(path.join(root, "user.json"), bytes);
  const result = run("claude-code"); expect(result.status, result.stderr).toBe(0); expect(await fs.readFile(path.join(root, "user.json"), "utf8")).toBe(bytes);
});
it("refuses malformed user config without replacing it", async () => {
  await fs.writeFile(path.join(root, "user.json"), "{broken"); expect(run("claude-code").status).not.toBe(0); expect(await fs.readFile(path.join(root, "user.json"), "utf8")).toBe("{broken");
});

it("selects the remote skill only when the user-composition ledger owns its current bytes", async () => {
  const ref = "skills/garrison-memory/SKILL.md", skill = path.join(root, "user", ref), ledger = path.join(root, "ledger.json");
  await fs.mkdir(path.dirname(skill), { recursive: true }); await fs.writeFile(skill, "owned local variant");
  const extra = { BASIC_MEMORY_BACKEND: "cortex", GARRISON_USER_PROVENANCE: ledger };
  await fs.writeFile(ledger, JSON.stringify({ [`file:claude-code:${ref}`]: { fittingId: "basic-memory", lastWrittenHash: createHash("sha256").update("owned local variant").digest("hex") } }));
  const result = run("claude-code", extra); expect(result.status, result.stderr).toBe(0);
  expect(await fs.readFile(skill, "utf8")).toContain("garrison-memory-backend: cortex");
  await fs.writeFile(skill, "user changes");
  expect(run("claude-code", extra).status).not.toBe(0);
  expect(await fs.readFile(skill, "utf8")).toBe("user changes");
});
