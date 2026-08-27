// Every committed composition, checked end to end: parse -> selections resolve ->
// readiness -> no dangling target reference.
//
// This replaces the per-composition suites (glm, csg) that named one composition
// each. Those broke the moment their subject was retired, and they never covered a
// composition added later - the two failure modes a hardcoded list guarantees.
//
// The safety net is real and worth keeping generic: `listCompositions()` is
// deliberately tolerant - a composition whose apm.yml throws is returned as null
// and silently vanishes from the UI - so without a test like this a malformed
// manifest has nothing to fail against. And a composition can look converted while
// every duty still routes somewhere else, which is exactly the bug the dangling
// -reference check below would have caught on the day it shipped.

import { describe, expect, it } from "vitest";
import { shippedCompositionIds } from "./helpers/shipped-compositions";

const IDS = shippedCompositionIds();

describe("every shipped composition", () => {
  it("ships at least one", () => {
    // A zero-length loop below would pass vacuously and prove nothing.
    expect(IDS.length).toBeGreaterThan(0);
  });

  it.each(IDS)("%s parses, is schema 4, and resolves its selections against the library", async (id) => {
    const { readComposition, validateCompositionSelections, selectedLibraryEntries } = await import(
      "@/lib/compositions"
    );
    const composition = await readComposition(id);
    expect(composition.id).toBe(id);
    expect(composition.schema).toBe(4);
    await expect(validateCompositionSelections(composition.selections)).resolves.not.toThrow();
    const entries = await selectedLibraryEntries(composition.selections);
    // Every selected id must be a registered library entry - an unregistered one
    // throws "Unknown fitting" at up() time, not here, unless we check.
    const selectedIds = Object.values(composition.selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
      .sort();
    expect(entries.map((e) => e.id).sort()).toEqual(selectedIds);
  });

  it.each(IDS)("%s satisfies every readiness rule, with a clean duty graph", async (id) => {
    const { readComposition, selectedLibraryEntries } = await import("@/lib/compositions");
    const { resolveModel } = await import("@/lib/resolver");
    const composition = await readComposition(id);
    const entries = await selectedLibraryEntries(composition.selections);
    const model = resolveModel({
      fittings: entries.map((e) => ({ id: e.id, metadata: e.metadata })),
      compositionDuties: composition.duties,
      selectedDuties: composition.selectedDuties
    });
    expect(model.errors).toEqual([]);
    // Name the unmet rules rather than asserting a bare boolean, so a regression
    // says WHICH rule broke.
    expect(model.rules.filter((r) => !r.met).map((r) => r.rule.id)).toEqual([]);
    expect(model.ready).toBe(true);
  });

  it.each(IDS)("%s routes every duty cell to a declared target", async (id) => {
    const { readComposition } = await import("@/lib/compositions");
    const composition = await readComposition(id);
    const declared = new Set((composition.targets ?? []).map((target) => target.id));
    const referenced: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === "target" && typeof value === "string") referenced.push(value);
          else walk(value);
        }
      }
    };
    walk(composition.duties);
    expect(referenced.length, `${id} declares duties but references no target`).toBeGreaterThan(0);
    expect(referenced.filter((ref) => !declared.has(ref)), `${id} has dangling target references`).toEqual([]);
  });

  it.each(IDS)("%s names a primary runtime that is actually stationed", async (id) => {
    const { readComposition } = await import("@/lib/compositions");
    const { resolvePrimaryFromPolicy } = await import("@/lib/routing-primary");
    const { getCompositionDirectory } = await import("@/lib/compositions");
    const composition = await readComposition(id);
    const primary =
      (await resolvePrimaryFromPolicy(getCompositionDirectory(id))) ??
      composition.globalConfig.primary_runtime ??
      "claude-code-runtime";
    // The trap this pins: `primaryRuntime` names a FITTING id while a target's
    // `runtime` names an ENGINE. Putting the engine name in primaryRuntime fails
    // up() late, after install/setup/verify have all passed.
    const stationed = new Set((composition.selections.runtimes ?? []).map((entry) => entry.id));
    if (primary !== "claude-code-runtime") {
      expect(stationed.has(primary), `${id}: primaryRuntime "${primary}" is not stationed (have: ${[...stationed].join(", ")})`).toBe(true);
    }
  });
});
