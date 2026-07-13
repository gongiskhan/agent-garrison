import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

// The six work-skill duty fittings (S3f1): each PROVIDES one build-discipline
// duty and OWNS the garrison skill that executes it (moved from garrison-skills).
// Unlike the fitting id, the owned skill keeps its garrison-<verb> name.
const cases = [
  { id: "duty-plan", duty: "plan", title: "Plan", skill: "garrison-plan", target: "cc-opus", effort: "high" },
  { id: "duty-implement", duty: "implement", title: "Implement", skill: "garrison-implement", target: "cc-opus", effort: "high" },
  { id: "duty-review", duty: "review", title: "Review", skill: "garrison-review", target: "cc-sonnet", effort: "medium" },
  { id: "duty-test", duty: "test", title: "Test", skill: "garrison-test", target: "cc-sonnet", effort: "medium" },
  { id: "duty-adversarial-test", duty: "adversarial-test", title: "Adversarial Test", skill: "garrison-adversarial-test", target: "cc-sonnet", effort: "high" },
  { id: "duty-walkthrough", duty: "walkthrough", title: "Walkthrough", skill: "garrison-walkthrough", target: "cc-opus", effort: "high" }
] as const;

describe("work-skill duty fittings (S3f1)", () => {
  it.each(cases)("$id parses as a building/skill fitting providing kind:duty ($duty)", async ({ id, duty }) => {
    const meta = await loadFitting(id);
    expect(meta.faculty).toBe("building");
    expect(meta.component_shape).toBe("skill");
    expect(meta.provides.filter((p) => p.kind === "duty")).toEqual([{ kind: "duty", name: duty }]);
  });

  it.each(cases)("$id declares a valid duty spec whose leaf cell owns $skill", async ({ id, duty, title, skill, target, effort }) => {
    const meta = await loadFitting(id);
    const spec = (meta.duties ?? []).find((d) => d.id === duty);
    expect(spec, `${id} should declare a duties[] spec for "${duty}"`).toBeTruthy();
    expect(spec!.title).toBe(title);
    expect(spec!.description.trim().length).toBeGreaterThan(0);
    expect(spec!.levels.length).toBeGreaterThanOrEqual(1);
    const leaf = spec!.levels[0];
    expect(leaf.cell, `${id} level 1 should be a leaf cell`).toBeTruthy();
    expect(leaf.sequence).toBeUndefined();
    expect(leaf.cell!.skill).toBe(skill);
    expect(leaf.cell!.target).toBe(target);
    expect(leaf.cell!.effort).toBe(effort);
  });

  it.each(cases)("$id owns its skill on disk and it matches the garrison-skills original", ({ id, skill }) => {
    const owned = path.join(SEED_DIR, id, ".apm", "skills", skill, "SKILL.md");
    const original = path.join(SEED_DIR, "garrison-skills", ".apm", "skills", skill, "SKILL.md");
    expect(existsSync(owned), `${id} should own .apm/skills/${skill}/SKILL.md`).toBe(true);
    // The move copies the content verbatim; garrison-skills still holds the original.
    expect(readFileSync(owned, "utf8")).toBe(readFileSync(original, "utf8"));
  });

  it.each(cases)("$id passes the validate-fitting pipeline", async ({ id }) => {
    const report = await validateFitting(path.join(SEED_DIR, id));
    const failed = report.checks.filter((c) => !c.passed);
    expect(failed, `failing checks: ${JSON.stringify(failed)}`).toEqual([]);
    expect(report.overall).toBe("pass");
  });
});
