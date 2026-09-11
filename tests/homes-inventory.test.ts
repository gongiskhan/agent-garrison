import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { captureHomesInventory, compareHomesInventory } from "@/lib/homes-inventory";
import { emptySharedSet } from "@/lib/home-ownership";
import { preserveModified } from "@/lib/home-quarantine";
let root: string;
async function write(ref: string, value: string) { const file = path.join(root, ref); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "homes-inventory-"));
  for (const [key, value] of Object.entries({ HOME: root, GARRISON_HOME: path.join(root, "garrison"), GARRISON_CLAUDE_HOME: path.join(root, "managed"), GARRISON_USER_CLAUDE_HOME: path.join(root, "user"), GARRISON_USER_CLAUDE_JSON: path.join(root, "user.json"), GARRISON_USER_CODEX_HOME: path.join(root, "codex"), GARRISON_USER_GEMINI_HOME: path.join(root, "gemini") })) vi.stubEnv(key, value);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("inventories owner-tagged hooks and legacy skills without storing hook commands", async () => {
  await write("user/settings.json", JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:basic-memory", hooks: [{ command: "private-command-with-credentials" }] }] } }));
  await write("user/skills/garrison-old/SKILL.md", "private skill content");
  const inventory = await captureHomesInventory();
  expect(inventory.items).toHaveLength(2); expect(inventory.items.find(item => item.kind === "hook")?.owner).toBe("basic-memory");
  const stored = await fs.readFile(path.join(root, "garrison/homes-inventory.json"), "utf8");
  expect(stored).not.toMatch(/private-command|private skill/); expect((await fs.stat(path.join(root, "garrison/homes-inventory.json"))).mode & 0o777).toBe(0o600);
  expect((await compareHomesInventory(inventory, { ...emptySharedSet(), "claude-code": ["basic-memory"] })).retainedShared).toHaveLength(1);
});
it("distinguishes removed, modified and still unresolved inventory items", async () => {
  await write("user/skills/garrison-old/SKILL.md", "old"); await write("user/skills/garrison-edit/SKILL.md", "edit");
  const inventory = await captureHomesInventory({ write: false });
  await fs.rename(path.join(root, "user/skills/garrison-old"), path.join(root, "quarantined"));
  await preserveModified("claude-code", path.join(root, "user"), "skills/garrison-edit/SKILL.md");
  const compared = await compareHomesInventory(inventory, emptySharedSet());
  expect(compared.expected).toBe(2); expect(compared.removed).toHaveLength(1); expect(compared.leftModified).toHaveLength(1); expect(compared.unresolved).toEqual([]);
});
