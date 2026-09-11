import { expect, it } from "vitest";
import fs from "node:fs/promises";
import YAML from "yaml";
import { selectedFittingSchema, defaultConfigForEntry, validateCompositionSelections, applyLocalOverlay, manifestToComposition } from "../src/lib/compositions";
import { parseGarrisonMetadata } from "../src/lib/metadata";
import { readLibrary } from "../src/lib/library";

it("accepts explicit sharing and rejects unknown or repeated runtime ids", async () => {
  const selection = { id: "basic-memory", config: {}, shared: ["claude-code", "codex"] };
  expect(selectedFittingSchema.parse(selection)).toEqual(selection);
  expect(() => selectedFittingSchema.parse({ ...selection, shared: ["unknown"] })).toThrow();
  expect(() => selectedFittingSchema.parse({ ...selection, shared: ["codex", "codex"] })).toThrow();
  await expect(validateCompositionSelections({ memory: [{ ...selection, shared: ["unknown"] as never }] })).rejects.toThrow();
});
it("uses the two declared sharing hints only when a fitting is selected", async () => {
  const library = await readLibrary();
  for (const [id, shared] of [["basic-memory", ["claude-code", "codex"]], ["coord-agentmail", ["claude-code"]]] as const) {
    const raw = YAML.parse(await fs.readFile(`fittings/seed/${id}/apm.yml`, "utf8"));
    expect(parseGarrisonMetadata(raw["x-garrison"]).shared_default).toEqual(shared);
    const entry = library.find(e => e.id === id);
    if (entry) expect(defaultConfigForEntry(entry).shared).toEqual(shared);
  }
});

it("preserves sharing through local config overlays and rejects bad sharing on a full composition read", () => {
  const manifest = { name: "fixture", "x-garrison": { composition: { id: "fixture", name: "Fixture", schema: 4, selections: { memory: [{ id: "basic-memory", config: { backend: "local" }, shared: ["claude-code", "codex"] as const }] } } } };
  const merged = applyLocalOverlay(manifest as never, { selections: { memory: [{ id: "basic-memory", config: { backend: "cortex" }, shared: ["gemini"] }] } });
  const result = manifestToComposition("fixture", merged);
  expect(result.selections.memory?.[0]).toEqual({ id: "basic-memory", config: { backend: "cortex" }, shared: ["claude-code", "codex"] });
  const bad = structuredClone(manifest);
  (bad["x-garrison"].composition.selections.memory[0] as any).shared = ["unrecognized"];
  expect(() => manifestToComposition("fixture", bad as never)).toThrow();
});

it("authors explicit sharing in the default composition without adding a fitting", async () => {
  const seed = YAML.parse(await fs.readFile("compositions/default/apm.yml", "utf8"));
  const selected = Object.values(seed["x-garrison"].composition.selections).flat() as Array<{ id: string; shared?: string[] }>;
  expect(selected.find(s => s.id === "basic-memory")?.shared).toEqual(["claude-code", "codex"]);
  // Coordination is not stationed in this node's composition; its hint applies on add.
  expect(selected.find(s => s.id === "coord-agentmail")).toBeUndefined();
});
