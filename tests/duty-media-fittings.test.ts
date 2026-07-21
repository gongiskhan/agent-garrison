import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";
import { validateFitting } from "@/lib/validation";
import type { GarrisonMetadata } from "@/lib/types";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadFitting(id: string): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, id, "apm.yml"));
  expect(manifest, `fitting ${id} should have an apm.yml`).toBeTruthy();
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

// The two MEDIA duty fittings (S3f3): duty-video wraps the existing walkthrough
// recorder; duty-image documents the simplest working image path. Both are
// `research` (Research & Media) fittings owning a skill and providing kind:duty.
const cases = [
  { id: "duty-video", duty: "video", title: "Video" },
  { id: "duty-image", duty: "image", title: "Image" }
] as const;

describe("MEDIA duty fittings (S3f3)", () => {
  it.each(cases)("$id parses and provides its duty ($duty)", async ({ id, duty }) => {
    const meta = await loadFitting(id);
    expect(meta.faculty).toBe("research");
    expect(meta.component_shape).toBe("skill");
    // provides exactly the one duty, named for the duty id
    const dutyProvisions = meta.provides.filter((p) => p.kind === "duty");
    expect(dutyProvisions).toEqual([{ kind: "duty", name: duty }]);
  });

  it.each(cases)("$id declares a valid duty spec matching its provision", async ({ id, duty, title }) => {
    const meta = await loadFitting(id);
    const spec = (meta.duties ?? []).find((d) => d.id === duty);
    expect(spec, `${id} should declare a duties[] spec for "${duty}"`).toBeTruthy();
    expect(spec!.title).toBe(title);
    expect(spec!.description.trim().length).toBeGreaterThan(0);
    // at least one leaf level, whose cell owns the fitting's skill (skill name === duty id)
    expect(spec!.levels.length).toBeGreaterThanOrEqual(1);
    const leaf = spec!.levels[0];
    expect(leaf.cell, `${id} level should be a leaf cell`).toBeTruthy();
    expect(leaf.cell!.skill).toBe(id);
  });

  it.each(cases)("$id owns its skill on disk at .apm/skills/$id/SKILL.md", ({ id }) => {
    expect(existsSync(path.join(SEED_DIR, id, ".apm", "skills", id, "SKILL.md"))).toBe(true);
  });

  it.each(cases)("$id passes the validate-fitting pipeline", async ({ id }) => {
    const report = await validateFitting(path.join(SEED_DIR, id));
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed, `failing checks: ${JSON.stringify(failed)}`).toEqual([]);
    expect(report.overall).toBe("pass");
  });
});
