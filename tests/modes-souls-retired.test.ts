// S3f2b (D7, acceptance 6): the multi-face `modes` seed fitting and the six soul-*
// seed fittings are retired from the library — replaced by the single-persona
// identity fitting (identity-gary). This locks that state in:
//   1. the retired seed dirs are gone and the library lists none of them;
//   2. identity-gary is present and provides kind:identity (the persona names Gary);
//   3. the `modes` faculty + capability kind SURVIVE the fitting's removal (the
//      identity fitting still occupies the modes role, and the orchestrator still
//      consumes modes at optional-one — now satisfied by ZERO providers).
import path from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";
import { resolveCapabilities } from "@/lib/capabilities";
import { getFaculty } from "@/lib/faculties";
import { capabilityKinds, singletonCapabilityKinds, facultyIds } from "@/lib/types";

const ROOT = path.resolve(__dirname, "..");
const SEED_DIR = path.join(ROOT, "fittings", "seed");

const RETIRED = ["modes", "soul", "soul-architect", "soul-assistant", "soul-companion", "soul-engineer", "soul-researcher"];

interface RawManifest {
  "x-garrison"?: unknown;
}

describe("modes + soul fittings retired (S3f2b, D7 acceptance 6)", () => {
  it("no `modes` and no `soul` / `soul-*` seed dirs remain under fittings/seed", () => {
    const seeds = new Set(readdirSync(SEED_DIR));
    for (const id of RETIRED) {
      expect(seeds.has(id), `fittings/seed/${id} must be retired`).toBe(false);
      expect(existsSync(path.join(SEED_DIR, id))).toBe(false);
    }
    // guard against any other soul-* seed sneaking back in
    const stragglers = [...seeds].filter((s) => s === "soul" || s.startsWith("soul-"));
    expect(stragglers, "no soul/* seed fittings").toEqual([]);
  });

  it("the curated library lists none of the retired fittings", () => {
    const lib = JSON.parse(readFileSync(path.join(ROOT, "data", "library.json"), "utf8")) as Array<{ id: string }>;
    const ids = new Set(lib.map((e) => e.id));
    for (const id of RETIRED) {
      expect(ids.has(id), `library entry ${id} must be de-listed`).toBe(false);
    }
  });

  it("identity-gary is present and provides kind:identity (gary), occupying the modes role", async () => {
    const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, "identity-gary", "apm.yml"));
    expect(manifest, "identity-gary should have an apm.yml").toBeTruthy();
    const meta = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(meta.faculty).toBe("modes");
    expect(meta.component_shape).toBe("system-prompt");
    expect(meta.provides).toEqual([{ kind: "identity", name: "gary" }]);
  });

  it("Hey Gary — the identity persona names Gary as the operative", () => {
    const persona = readFileSync(path.join(SEED_DIR, "identity-gary", "payload", "persona.md"), "utf8");
    expect(persona).toMatch(/Hey Gary/);
    expect(persona).toMatch(/You are Gary/);
    expect(persona.toLowerCase()).toContain("operative");
  });
});

describe("the modes faculty + capability kind survive the fitting's retirement", () => {
  it("modes stays a registered faculty and singleton capability kind (identity-gary's home)", () => {
    expect(facultyIds).toContain("modes");
    expect(capabilityKinds).toContain("modes");
    expect(singletonCapabilityKinds).toContain("modes");
    const faculty = getFaculty("modes");
    expect(faculty.cardinality).toBe("single");
    expect(faculty.shapes).toContain("system-prompt");
  });

  it("the orchestrator resolves with ZERO modes providers (consumes modes at optional-one)", () => {
    const orchestratorMeta = parseGarrisonMetadata({
      faculty: "orchestrator",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "orchestrator", name: "orchestrator" }],
      consumes: [{ kind: "modes", cardinality: "optional-one" }],
      verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
    });
    // Post-retirement, no fitting provides kind:modes — optional-one is satisfied by none.
    const resolved = resolveCapabilities([{ id: "orchestrator", metadata: orchestratorMeta }]);
    expect(resolved.ok).toBe(true);

    // A second modes provider must still trip the singleton guard (the kind is unchanged).
    const modesMeta = parseGarrisonMetadata({
      faculty: "modes",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "modes", name: "modes" }],
      verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
    });
    const dup = resolveCapabilities([
      { id: "orchestrator", metadata: orchestratorMeta },
      { id: "modes-a", metadata: modesMeta },
      { id: "modes-b", metadata: modesMeta }
    ]);
    expect(dup.ok).toBe(false);
  });
});
