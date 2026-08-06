import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  ensureComposition,
  getCompositionDirectory,
  refreshDefaultPrompts,
  writeComposition
} from "@/lib/compositions";

const IDS: string[] = [];

afterEach(async () => {
  await Promise.all(IDS.splice(0).map((id) => fs.rm(getCompositionDirectory(id), { recursive: true, force: true })));
});

function freshId() {
  const id = `identity-source-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

describe("composition identity source retirement", () => {
  it("ships no declared legacy identity source or Verity-bearing composition prompt", async () => {
    const compositionsDir = path.resolve(__dirname, "..", "compositions");
    const entries = await fs.readdir(compositionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const manifestPath = path.join(compositionsDir, entry.name, "apm.yml");
      let manifest: any;
      try {
        manifest = yaml.load(await fs.readFile(manifestPath, "utf8"));
      } catch {
        continue;
      }
      expect(
        manifest?.["x-garrison"]?.composition?.prompt_sources?.soul,
        `${entry.name} must not declare the retired soul prompt`
      ).toBeUndefined();
      const legacyPath = path.join(compositionsDir, entry.name, ".garrison", "prompts", "soul.md");
      try {
        const legacy = await fs.readFile(legacyPath, "utf8");
        expect(legacy, `${entry.name} must not carry the retired Verity identity`).not.toMatch(/\bVerity\b/);
        expect(legacy, `${entry.name} may only carry the transient migration sentinel`).toContain("Identity is authored under Orchestrator");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });

  it("scaffolds and refreshes only the Orchestrator prompt", async () => {
    const id = freshId();
    const dir = getCompositionDirectory(id);
    await ensureComposition(id);

    await expect(fs.access(path.join(dir, ".garrison", "prompts", "soul.md"))).rejects.toThrow();
    const manifest = yaml.load(await fs.readFile(path.join(dir, "apm.yml"), "utf8")) as any;
    expect(manifest["x-garrison"].composition.prompt_sources).toEqual({
      orchestrator: ".garrison/prompts/orchestrator.md"
    });

    const refreshed = await refreshDefaultPrompts(id);
    expect(refreshed).toEqual({
      orchestratorPath: path.join(dir, ".garrison", "prompts", "orchestrator.md")
    });
    await expect(fs.access(path.join(dir, ".garrison", "prompts", "soul.md"))).rejects.toThrow();
  });

  it("does not reintroduce a soul prompt source when a composition is rewritten", async () => {
    const id = freshId();
    await ensureComposition(id);
    await writeComposition(id, { name: "Identity source fixture", selections: {} });
    const manifest = yaml.load(
      await fs.readFile(path.join(getCompositionDirectory(id), "apm.yml"), "utf8")
    ) as any;
    expect(manifest["x-garrison"].composition.prompt_sources).toEqual({
      orchestrator: ".garrison/prompts/orchestrator.md"
    });
  });
});
