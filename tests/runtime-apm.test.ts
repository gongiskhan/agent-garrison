import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareRuntimeApm, completeRuntimeApm, runtimeApmReady } from "@/lib/runtime-apm";
import { contentHash } from "@/lib/home-quarantine";
import type { Composition, LibraryEntry } from "@/lib/types";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-apm-")); vi.stubEnv("GARRISON_HOME", path.join(root, "garrison")); vi.stubEnv("GARRISON_CLAUDE_HOME", path.join(root, "managed")); vi.stubEnv("GARRISON_USER_CLAUDE_HOME", path.join(root, "user")); await fs.mkdir(path.join(root, "garrison/global-composition"), { recursive: true }); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("installs all selected package sources into the managed global project", async () => {
  const composition = { id: "fixture", selections: { building: [{ id: "skill-a", config: {} }, { id: "skill-b", config: {} }] } } as Composition;
  const library = ["skill-a", "skill-b"].map(id => ({ id, localPath: path.join(root, id) })) as LibraryEntry[];
  const prepared = await prepareRuntimeApm(composition, Promise.resolve(library));
  expect(prepared.selectedIds).toEqual(["skill-a", "skill-b"]);
  const manifest = YAML.parse(await fs.readFile(path.join(root, "garrison/global-composition/apm.yml"), "utf8"));
  expect(JSON.stringify(manifest.dependencies.apm)).toContain(path.join(root, "skill-a"));
  expect(JSON.stringify(manifest.dependencies.apm)).toContain(path.join(root, "skill-b"));
  expect(await fs.realpath(path.join(root, "garrison/global-composition/.claude"))).toBe(path.join(root, "managed"));
  await expect(fs.stat(path.join(root, "user"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("quarantines only unchanged obsolete managed files and retains extra children", async () => {
  const home = path.join(root, "managed/skills/old"); await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "SKILL.md"), "owned"); await fs.writeFile(path.join(home, "extra.md"), "extra"); await fs.writeFile(path.join(home, "changed.md"), "edited");
  await completeRuntimeApm({ compositionId: "fixture", selectedIds: [], previous: { allDeployedFiles: new Set(["skills/old/SKILL.md", "skills/old/changed.md"]), deps: [{ name: "old", deployedFiles: ["skills/old", "skills/old/SKILL.md", "skills/old/changed.md"], deployedHashes: { "skills/old/SKILL.md": contentHash("owned"), "skills/old/changed.md": contentHash("original") } }] } });
  await expect(fs.stat(path.join(home, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(home, "extra.md"), "utf8")).toBe("extra"); expect(await fs.readFile(path.join(home, "changed.md"), "utf8")).toBe("edited");
  const state = JSON.parse(await fs.readFile(path.join(root, "garrison/global-composition/active-fittings.json"), "utf8"));
  expect(state.quarantined).toEqual(["skills/old/SKILL.md"]); expect(state.leftModified).toEqual(["skills/old/changed.md"]);
});

it("requires deployed primitives before reusing a verified startup", async () => {
  const composition = { id: "fixture", selections: {} } as Composition;
  expect(await runtimeApmReady("fixture")).toBe(false);
  const prepared = await prepareRuntimeApm(composition, []);
  await fs.writeFile(path.join(root, "garrison/global-composition/apm.lock.yaml"), YAML.stringify({ dependencies: [{ repo_url: "_local/old", deployed_files: [".claude/skills/missing/SKILL.md"] }] }));
  await completeRuntimeApm(prepared);
  expect(await runtimeApmReady("fixture")).toBe(true);
  await fs.writeFile(path.join(root, "garrison/global-composition/apm.lock.yaml"), YAML.stringify({ dependencies: [{ repo_url: "_local/current", deployed_files: [".claude/skills/missing/SKILL.md"] }] }));
  expect(await runtimeApmReady("fixture")).toBe(false);
});

it("preserves pre-migration Quarters dependencies even when they are known library fittings", async () => {
  const source = path.join(root, "old-quarters-fitting");
  await fs.writeFile(path.join(root, "garrison/global-composition/apm.lock.yaml"), YAML.stringify({ dependencies: [{ repo_url: "_local/old", local_path: source, deployed_files: [] }] }));
  await prepareRuntimeApm({ id: "fixture", selections: {} } as Composition, [{ id: "old", localPath: source }] as LibraryEntry[]);
  const manifest = YAML.parse(await fs.readFile(path.join(root, "garrison/global-composition/apm.yml"), "utf8"));
  expect(JSON.stringify(manifest.dependencies.apm)).toContain(source);
});
