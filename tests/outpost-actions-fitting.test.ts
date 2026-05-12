import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYamlFile } from "@/lib/yaml";
import { parseGarrisonMetadata } from "@/lib/metadata";
import type { GarrisonMetadata } from "@/lib/types";

const FITTING_DIR = path.resolve("fittings/seed/outpost-actions");

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadMetadata(): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(
    path.join(FITTING_DIR, "apm.yml")
  );
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("outpost-actions apm.yml", () => {
  it("parses without throwing", async () => {
    await expect(loadMetadata()).resolves.toBeTruthy();
  });

  it("faculty is skills", async () => {
    const md = await loadMetadata();
    expect(md.faculty).toBe("skills");
  });

  it("component_shape is skill", async () => {
    const md = await loadMetadata();
    expect(md.component_shape).toBe("skill");
  });

  it("provides agent-skill:outpost-actions", async () => {
    const md = await loadMetadata();
    expect(
      md.provides.some((p) => p.kind === "agent-skill" && p.name === "outpost-actions")
    ).toBe(true);
  });

  it("consumes outpost with cardinality: any", async () => {
    const md = await loadMetadata();
    expect(
      md.consumes.some((c) => c.kind === "outpost" && c.cardinality === "any")
    ).toBe(true);
  });

  it("for_consumers is under the 8 KB cap", async () => {
    const md = await loadMetadata();
    const forConsumers = md.for_consumers ?? "";
    expect(Buffer.byteLength(forConsumers, "utf8")).toBeLessThan(8 * 1024);
  });
});

describe("outpost-actions CLI exists", () => {
  it("outpost.py exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "outpost.py"))
    ).toBe(true);
  });

  it("scripts/setup.sh exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "setup.sh"))
    ).toBe(true);
  });

  it("scripts/verify.sh exists", () => {
    expect(
      fs.existsSync(path.join(FITTING_DIR, "scripts", "verify.sh"))
    ).toBe(true);
  });

  it("SKILL.md exists under .apm/skills/outpost-actions/", () => {
    expect(
      fs.existsSync(
        path.join(FITTING_DIR, ".apm", "skills", "outpost-actions", "SKILL.md")
      )
    ).toBe(true);
  });
});
