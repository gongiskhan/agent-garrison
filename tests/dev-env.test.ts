import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities, type ResolverInput } from "@/lib/capabilities";
import { OWN_PORT_VIEW_ID, deriveViewDescriptors } from "@/lib/view-instances";
import { readComposition } from "@/lib/compositions";
import { readLibrary } from "@/lib/library";
import type { GarrisonMetadata } from "@/lib/types";
import { readYamlFile } from "@/lib/yaml";

// Dev Env consolidation gate (2026-06-11). The dev-env Fitting replaced
// terminal-armory-default + worktree-management-sequoias +
// session-view-sequoias (and Workspaces was deleted outright). This test
// pins: the manifest parses, the new singleton kind resolves, the own-port
// view derives, and the default composition carries no provider of the
// dropped kinds.

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");
const DROPPED_KINDS = ["terminal-session", "worktree", "session-view"];

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadDevEnv(): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(path.join(SEED_DIR, "dev-env", "apm.yml"));
  expect(manifest).toBeTruthy();
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("dev-env Fitting", () => {
  it("manifest parses and provides exactly one dev-env capability", async () => {
    const metadata = await loadDevEnv();
    expect(metadata.faculty).toBe("sessions");
    expect(metadata.own_port).toBe(true);
    expect(metadata.default_port).toBe(27086);
    const devEnvProvisions = metadata.provides.filter((p) => p.kind === "dev-env");
    expect(devEnvProvisions).toEqual([{ kind: "dev-env", name: "dev-env" }]);
    expect(metadata.provides).toHaveLength(1);
  });

  it("deriveViewDescriptors yields the own-port main view", async () => {
    const metadata = await loadDevEnv();
    const descriptors = deriveViewDescriptors("dev-env", metadata);
    expect(descriptors).toEqual([
      expect.objectContaining({
        fittingId: "dev-env",
        viewId: OWN_PORT_VIEW_ID,
        surface: "own-port"
      })
    ]);
  });

  it("two dev-env providers fail resolution as ambiguous-singleton", async () => {
    const metadata = await loadDevEnv();
    const inputs: ResolverInput[] = [
      { id: "dev-env", metadata },
      { id: "dev-env-2", metadata }
    ];
    const result = resolveCapabilities(inputs);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ambiguous-singleton failure");
    expect(result.errors.map((e) => e.code)).toContain("ambiguous-singleton");
  });

  it("the default composition resolves with no provider of the dropped kinds", async () => {
    const composition = await readComposition("default");
    const library = await readLibrary();
    const byId = new Map(library.map((entry) => [entry.id, entry]));
    const inputs: ResolverInput[] = [];
    for (const selections of Object.values(composition.selections)) {
      for (const selection of selections ?? []) {
        const entry = byId.get(selection.id);
        if (entry) inputs.push({ id: entry.id, metadata: entry.metadata });
      }
    }
    expect(inputs.map((i) => i.id)).toContain("dev-env");
    const result = resolveCapabilities(inputs);
    if (!result.ok) {
      throw new Error(`default composition must resolve: ${JSON.stringify(result.errors, null, 2)}`);
    }
    for (const input of inputs) {
      for (const provision of input.metadata.provides) {
        expect(
          DROPPED_KINDS,
          `${input.id} still provides dropped kind ${provision.kind}`
        ).not.toContain(provision.kind);
      }
    }
  });
});
