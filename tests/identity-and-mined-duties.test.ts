import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";
import { validateFitting } from "@/lib/validation";
import { resolveModel, type ResolverFittingInput } from "@/lib/resolver";
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

// S3f2a: the Identity Fitting (Gary) + the two mined-persona duty Fittings
// (discuss from James, develop from Joe). develop is COMPOSITE — its levels
// sequence the S3f1 leaf duties (plan/implement/review/test).
describe("identity + mined-persona duties (S3f2a)", () => {
  it("identity-gary parses as a modes/system-prompt fitting providing kind:identity (gary)", async () => {
    const meta = await loadFitting("identity-gary");
    expect(meta.faculty).toBe("modes");
    expect(meta.component_shape).toBe("system-prompt");
    expect(meta.provides).toEqual([{ kind: "identity", name: "gary" }]);
  });

  it("identity-gary's persona names Gary as the operative and resolves 'Hey Gary'", () => {
    const persona = readFileSync(
      path.join(SEED_DIR, "identity-gary", "payload", "persona.md"),
      "utf8"
    );
    expect(persona).toMatch(/Hey Gary/);
    // Gary IS the operative at rest, not a separate assistant it delegates to.
    expect(persona).toMatch(/You are Gary/);
    expect(persona.toLowerCase()).toContain("operative");
  });

  const dutyCases = [
    { id: "duty-discuss", duty: "discuss", title: "Discuss" },
    { id: "duty-develop", duty: "develop", title: "Develop" }
  ] as const;

  it.each(dutyCases)(
    "$id parses as a building/skill fitting providing kind:duty ($duty)",
    async ({ id, duty, title }) => {
      const meta = await loadFitting(id);
      expect(meta.faculty).toBe("building");
      expect(meta.component_shape).toBe("skill");
      expect(meta.provides.filter((p) => p.kind === "duty")).toEqual([
        { kind: "duty", name: duty }
      ]);
      const spec = (meta.duties ?? []).find((d) => d.id === duty);
      expect(spec, `${id} should declare a duties[] spec for "${duty}"`).toBeTruthy();
      expect(spec!.title).toBe(title);
      expect(spec!.levels.length).toBeGreaterThanOrEqual(1);
    }
  );

  it("duty-discuss levels bind the duty-discuss skill (leaf cells, two levels)", async () => {
    const meta = await loadFitting("duty-discuss");
    const spec = (meta.duties ?? []).find((d) => d.id === "discuss")!;
    expect(spec.levels.length).toBe(2);
    for (const level of spec.levels) {
      expect(level.cell, "discuss levels are leaf cells").toBeTruthy();
      expect(level.sequence).toBeUndefined();
      expect(level.cell!.skill).toBe("duty-discuss");
    }
    // level 1 quick (sonnet/medium), level 2 deep (opus/high)
    expect(spec.levels[0].cell!.target).toBe("cc-sonnet");
    expect(spec.levels[1].cell!.target).toBe("cc-opus");
  });

  it("duty-develop is COMPOSITE: level 2 sequences [plan, implement, review, test]", async () => {
    const meta = await loadFitting("duty-develop");
    const spec = (meta.duties ?? []).find((d) => d.id === "develop")!;
    expect(spec.levels.length).toBe(2);

    // level 1: quick fix — implement only, no cell.
    expect(spec.levels[0].cell).toBeUndefined();
    expect(spec.levels[0].sequence?.map((e) => e.duty)).toEqual(["implement"]);

    // level 2: the full build discipline, as an ordered sequence.
    expect(spec.levels[1].cell).toBeUndefined();
    expect(spec.levels[1].sequence?.map((e) => e.duty)).toEqual([
      "plan",
      "implement",
      "review",
      "test"
    ]);
  });

  it("resolveModel over the leaf duties + develop validates the graph with NO errors", async () => {
    const ids = ["duty-plan", "duty-implement", "duty-review", "duty-test", "duty-develop"];
    const fittings: ResolverFittingInput[] = await Promise.all(
      ids.map(async (id) => ({ id, metadata: await loadFitting(id) }))
    );

    const model = resolveModel({ fittings });

    // The composite develop's sequence refs (plan/implement/review/test) all
    // resolve and the graph is a DAG — zero duty-graph errors.
    expect(model.errors, `duty-graph errors: ${JSON.stringify(model.errors)}`).toEqual([]);
    expect(Object.keys(model.duties).sort()).toEqual([
      "develop",
      "implement",
      "plan",
      "review",
      "test"
    ]);
  });

  it.each([{ id: "identity-gary" }, { id: "duty-discuss" }, { id: "duty-develop" }])(
    "$id passes the validate-fitting pipeline",
    async ({ id }) => {
      const report = await validateFitting(path.join(SEED_DIR, id));
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed, `failing checks: ${JSON.stringify(failed)}`).toEqual([]);
      expect(report.overall).toBe("pass");
    }
  );
});
