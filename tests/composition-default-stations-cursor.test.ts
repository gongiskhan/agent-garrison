// G5: the default composition stations cursor-runtime. Pins the three places
// that must move together for a runtime to be usable at all - the apm
// dependency (so `apm install` actually vendors it), the selection (so it is
// equipped), and a target naming its engine (so routing can reach it) - the
// same three-part shape codex/gemini/opencode already have.

import { describe, expect, it } from "vitest";
import { manifestToComposition } from "@/lib/compositions";
import { readYamlFile } from "@/lib/yaml";
import { compositionManifestPath } from "./helpers/shipped-compositions";

describe("the default composition stations cursor-runtime", () => {
  it("depends on the cursor-runtime fitting", async () => {
    const manifest = (await readYamlFile<Record<string, any>>(compositionManifestPath("default"))) ?? {};
    const apmDeps: Array<{ path: string }> = manifest.dependencies?.apm ?? [];
    expect(apmDeps.some((d) => d.path.endsWith("/cursor-runtime"))).toBe(true);
  });

  it("selects cursor-runtime under runtimes, with an auto model", async () => {
    const manifest = (await readYamlFile<Record<string, any>>(compositionManifestPath("default"))) ?? {};
    const runtimes: Array<{ id: string; config?: Record<string, unknown> }> =
      manifest["x-garrison"]?.composition?.selections?.runtimes ?? [];
    const cursor = runtimes.find((r) => r.id === "cursor-runtime");
    expect(cursor).toBeDefined();
    expect(cursor?.config?.model).toBe("auto");
  });

  it("declares a target whose runtime is the cursor engine", async () => {
    const manifest = await readYamlFile<Record<string, any>>(compositionManifestPath("default"));
    const composition = manifestToComposition("default", manifest as never);
    const cursorTargets = composition.targets.filter((t) => t.runtime === "cursor");
    expect(cursorTargets.length).toBeGreaterThan(0);
    expect(cursorTargets.some((t) => t.id === "cursor-local")).toBe(true);
  });
});
