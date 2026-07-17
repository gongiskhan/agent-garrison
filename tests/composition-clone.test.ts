import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  cloneComposition,
  compositionClonePathAllowed
} from "@/lib/composition-clone";
import { getCompositionDirectory } from "@/lib/compositions";

const SOURCE_ID = `clone-source-${process.pid}`;
const TARGET_ID = `clone-target-${process.pid}`;
const SOURCE_DIR = getCompositionDirectory(SOURCE_ID);
const TARGET_DIR = getCompositionDirectory(TARGET_ID);

async function writeSource(): Promise<void> {
  await fs.rm(SOURCE_DIR, { recursive: true, force: true });
  await fs.rm(TARGET_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(SOURCE_DIR, ".garrison", "prompts"), { recursive: true });
  const manifest = {
    name: SOURCE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: SOURCE_ID,
        name: "Clone Source",
        selections: {},
        duties: [
          {
            id: "implement",
            title: "Implement",
            description: "implement a change",
            levels: [{ description: "standard", cell: { effort: "medium" } }]
          }
        ],
        selected_duties: ["implement"],
        targets: [],
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
        }
      }
    }
  };
  await fs.writeFile(path.join(SOURCE_DIR, "apm.yml"), yaml.dump(manifest), "utf8");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "prompts", "orchestrator.md"), "authored prompt\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "prompts", "soul.md"), "authored soul\n");
  await fs.writeFile(
    path.join(SOURCE_DIR, ".garrison", "routing.json"),
    `${JSON.stringify({ policyVersion: 2, primaryRuntime: "codex-runtime", targets: [] }, null, 2)}\n`
  );
  await fs.writeFile(path.join(SOURCE_DIR, "profile.md"), "custom composition file\n");
  await fs.writeFile(path.join(SOURCE_DIR, "local.yml"), "global_config:\n  projects_root: ~/dev\n");

  // Known install/run products that must never leak into a clone.
  await fs.mkdir(path.join(SOURCE_DIR, "apm_modules", "_local"), { recursive: true });
  await fs.writeFile(path.join(SOURCE_DIR, "apm_modules", "_local", "installed"), "generated");
  await fs.mkdir(path.join(SOURCE_DIR, ".claude"), { recursive: true });
  await fs.writeFile(path.join(SOURCE_DIR, ".claude", "settings.json"), "{}");
  await fs.writeFile(path.join(SOURCE_DIR, ".env"), "SECRET=do-not-copy\n");
  await fs.writeFile(path.join(SOURCE_DIR, "apm.lock.yaml"), "generated: true\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "policy.json"), "{}");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "decisions.jsonl"), "{}\n");
  await fs.writeFile(path.join(SOURCE_DIR, ".garrison", "operative-session-id"), "old-session");
}

beforeEach(writeSource);
afterAll(async () => {
  await fs.rm(SOURCE_DIR, { recursive: true, force: true });
  await fs.rm(TARGET_DIR, { recursive: true, force: true });
});

describe("cloneComposition", () => {
  it("preserves authored composition config and excludes generated runtime state", async () => {
    const clone = await cloneComposition({
      sourceId: SOURCE_ID,
      id: TARGET_ID,
      name: "Codex Build Crew"
    });

    expect(clone.id).toBe(TARGET_ID);
    expect(clone.name).toBe("Codex Build Crew");
    expect(clone.selectedDuties).toEqual(["implement"]);

    const raw = yaml.load(await fs.readFile(path.join(TARGET_DIR, "apm.yml"), "utf8")) as {
      "x-garrison": { composition: { id: string; name: string } };
    };
    expect(raw["x-garrison"].composition).toMatchObject({ id: TARGET_ID, name: "Codex Build Crew" });
    expect(await fs.readFile(path.join(TARGET_DIR, ".garrison", "prompts", "orchestrator.md"), "utf8")).toBe(
      "authored prompt\n"
    );
    expect(JSON.parse(await fs.readFile(path.join(TARGET_DIR, ".garrison", "routing.json"), "utf8"))).toMatchObject({
      primaryRuntime: "codex-runtime"
    });
    expect(await fs.readFile(path.join(TARGET_DIR, "profile.md"), "utf8")).toContain("custom composition");
    expect(await fs.readFile(path.join(TARGET_DIR, "local.yml"), "utf8")).toContain("projects_root");

    for (const rel of [
      "apm_modules",
      ".claude",
      ".env",
      "apm.lock.yaml",
      ".garrison/policy.json",
      ".garrison/decisions.jsonl",
      ".garrison/operative-session-id"
    ]) {
      await expect(fs.access(path.join(TARGET_DIR, rel))).rejects.toThrow();
    }
  });

  it("rejects duplicate ids without changing the existing clone", async () => {
    await cloneComposition({ sourceId: SOURCE_ID, id: TARGET_ID, name: "First Clone" });
    await expect(
      cloneComposition({ sourceId: SOURCE_ID, id: TARGET_ID, name: "Second Clone" })
    ).rejects.toThrow(/already exists/);
    const clone = yaml.load(await fs.readFile(path.join(TARGET_DIR, "apm.yml"), "utf8")) as {
      "x-garrison": { composition: { name: string } };
    };
    expect(clone["x-garrison"].composition.name).toBe("First Clone");
  });

  it("documents the authored/generated path boundary", () => {
    expect(compositionClonePathAllowed(".garrison/routing.json")).toBe(true);
    expect(compositionClonePathAllowed(".garrison/prompts/orchestrator.md")).toBe(true);
    expect(compositionClonePathAllowed(".garrison/policy.json")).toBe(false);
    expect(compositionClonePathAllowed("apm_modules/_local/runtime")).toBe(false);
  });
});
