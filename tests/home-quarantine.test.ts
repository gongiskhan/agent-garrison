import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeQuarantine, contentHash, confinedHomePath, preservedHomeItems, readJsonObject } from "../src/lib/home-quarantine";

let root: string; let home: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "home-quarantine-")); home = path.join(root, "user");
  vi.stubEnv("HOME", root); vi.stubEnv("GARRISON_HOME", path.join(root, "garrison")); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(root, "managed"));
  await fs.mkdir(home);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("moves only an unchanged owned file, preserving its relative path and bytes", async () => {
  await fs.mkdir(path.join(home, "skills", "owned"), { recursive: true });
  await fs.writeFile(path.join(home, "skills", "owned", "SKILL.md"), "owned bytes\n");
  const q = new HomeQuarantine();
  expect(await q.move("claude-code", home, "skills/owned/SKILL.md", contentHash("owned bytes\n"))).toBe(true);
  expect(await fs.readFile(path.join(q.dir, "claude-code/skills/owned/SKILL.md"), "utf8")).toBe("owned bytes\n");
  expect(await q.move("claude-code", home, "skills/owned/SKILL.md")).toBe(false);
});
it("retains changed files and protects their parent from a legacy-name sweep", async () => {
  await fs.mkdir(path.join(home, "skills/garrison-plan"), { recursive: true });
  await fs.writeFile(path.join(home, "skills/garrison-plan/SKILL.md"), "my changes");
  const q = new HomeQuarantine();
  expect(await q.move("claude-code", home, "skills/garrison-plan/SKILL.md", contentHash("old"))).toBe(false);
  expect(await q.move("claude-code", home, "skills/garrison-plan")).toBe(false);
  expect(await fs.readFile(path.join(home, "skills/garrison-plan/SKILL.md"), "utf8")).toBe("my changes");
  expect((await preservedHomeItems())[0].ref).toBe("skills/garrison-plan/SKILL.md");
});
it("refuses traversal and symlinked parents but moves a leaf link without touching its target", async () => {
  const elsewhere = path.join(root, "elsewhere"); await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, "mine"), "untouched");
  await fs.symlink(elsewhere, path.join(home, "escape"));
  expect(() => confinedHomePath(home, "../elsewhere/mine")).toThrow();
  expect(() => confinedHomePath(home, "escape/mine")).toThrow();
  const q = new HomeQuarantine(); expect(await q.move("claude-code", home, "escape")).toBe(true);
  expect(await fs.readFile(path.join(elsewhere, "mine"), "utf8")).toBe("untouched");
});
it("records stripped JSON values verbatim before removal and preserves unrelated values", async () => {
  const file = path.join(home, "settings.json"); const group = { _garrison: "fitting:test", matcher: "*", hooks: [{ type: "command", command: "echo owned" }], custom: [1, false] };
  await fs.writeFile(file, JSON.stringify({ hooks: { Stop: [group] }, user: { keep: true } }));
  const q = new HomeQuarantine();
  await q.editJson(file, [{ runtime: "claude-code", kind: "hook", ref: "Stop#0", source: file, value: group }], draft => { draft.hooks.Stop = []; });
  expect((await readJsonObject<{ items: Array<{ value: unknown }> }>(path.join(q.dir, "removed.json"))).items[0].value).toEqual(group);
  expect(await readJsonObject(file)).toEqual({ hooks: { Stop: [] }, user: { keep: true } });
});
it("does not turn malformed config into an empty object", async () => {
  const file = path.join(home, "settings.json"); await fs.writeFile(file, "{broken");
  await expect(readJsonObject(file)).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("{broken");
});
