import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { resolveCapabilities } from "@/lib/capabilities";
import { readYamlFile } from "@/lib/yaml";
import {
  deriveViewDescriptors,
  formatInstanceRef,
  parseInstanceRef
} from "@/lib/view-instances";

// W4 gate — the Workspaces Fitting.
//
// Part 1: the workspace layout (pane refs + % geometry) survives a simulated
// restart through the REAL view-state store (sandbox GARRISON_HOME,
// vi.resetModules + fresh import — nothing in memory carries over, the read
// can only come from disk). Sentinel: WORKSPACE_LAYOUT_OK.
//
// Part 2: the seed manifest is self-consistent with the W1 mechanism — its
// x-garrison block parses, its one view derives from ui.views[], and its
// `view`/`any` consumption discovers every derived view provision in a
// fixture composition.

interface WorkspacePane {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function freshStore() {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__garrisonViewStateWrites;
  return await import("@/lib/view-state");
}

describe("workspace layout persistence (real store, simulated restart)", () => {
  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-workspaces-"));
    process.env.GARRISON_HOME = sandbox;
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("two referenced instances + geometry round-trip exactly (WORKSPACE_LAYOUT_OK)", async () => {
    const layout: { panes: WorkspacePane[] } = {
      panes: [
        { ref: "terminal-armory-default:main#sess-1", x: 0, y: 0, w: 50, h: 100 },
        { ref: "artifact-store:list", x: 50, y: 0, w: 50, h: 100 }
      ]
    };

    const before = await freshStore();
    await before.writeViewState("workspaces", "default", layout);

    // Simulated restart: fresh module instance, no in-memory carryover.
    const after = await freshStore();
    const result = await after.readViewState<{ panes: WorkspacePane[] }>(
      "workspaces",
      "default"
    );

    expect(result.exists).toBe(true);
    expect(result.envelope?.state).toEqual(layout);

    const restored = result.envelope!.state.panes;
    expect(restored.map((pane) => pane.ref)).toEqual([
      "terminal-armory-default:main#sess-1",
      "artifact-store:list"
    ]);
    expect(restored[0]).toMatchObject({ x: 0, y: 0, w: 50, h: 100 });
    expect(restored[1]).toMatchObject({ x: 50, y: 0, w: 50, h: 100 });

    // The refs the workspace persisted are real instance refs — they parse
    // and re-format canonically (the #default suffix stays omitted).
    const first = parseInstanceRef(restored[0].ref);
    expect(first).toEqual({
      fittingId: "terminal-armory-default",
      viewId: "main",
      instanceId: "sess-1"
    });
    const second = parseInstanceRef(restored[1].ref);
    expect(second).toEqual({
      fittingId: "artifact-store",
      viewId: "list",
      instanceId: "default"
    });
    expect(formatInstanceRef(first!)).toBe(restored[0].ref);
    expect(formatInstanceRef(second!)).toBe(restored[1].ref);

    console.log("WORKSPACE_LAYOUT_OK");
  });
});

describe("workspaces seed manifest — W1 self-consistency", () => {
  const manifestPath = path.resolve(
    __dirname,
    "..",
    "fittings",
    "seed",
    "workspaces",
    "apm.yml"
  );

  it("parses, derives its main view, and discovers views with cardinality any", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(manifestPath);
    expect(manifest, "fittings/seed/workspaces/apm.yml should exist").toBeTruthy();
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);

    expect(metadata.faculty).toBe("sessions");
    // The view is DERIVED from ui.views[] (the W1 mechanism) — workspaces
    // declares no provisions of its own.
    expect(metadata.provides).toEqual([]);
    expect(metadata.consumes).toContainEqual({ kind: "view", cardinality: "any" });

    const descriptors = deriveViewDescriptors("workspaces", metadata);
    expect(descriptors).toEqual([
      {
        fittingId: "workspaces",
        viewId: "main",
        surface: "embedded",
        placement: "sidebar-surface",
        route: "/"
      }
    ]);

    // Fixture composition: workspaces + one view-producing fitting. The
    // resolver must match workspaces' `view`/`any` consumption against every
    // derived view provision, with no errors.
    const providerMetadata = parseGarrisonMetadata({
      faculty: "sessions",
      cardinality_hint: "single",
      component_shape: "cli-skill",
      platforms: ["claude-code"],
      provides: [],
      consumes: [],
      verify: { command: "true", expect: "ok" },
      ui: {
        views: [
          { id: "list", placement: "sidebar-surface", entry: "./ui/List.tsx", route: "/" },
          { id: "view", placement: "sidebar-surface", entry: "./ui/View.tsx", route: "/:id" }
        ]
      }
    });

    const result = resolveCapabilities([
      { id: "artifact-store", metadata: providerMetadata },
      { id: "workspaces", metadata }
    ]);
    expect(result.ok).toBe(true);

    const consumer = result.graph.consumers.find(
      (c) => c.fittingId === "workspaces" && c.consumption.kind === "view"
    );
    expect(consumer).toBeTruthy();
    expect(consumer!.consumption.cardinality).toBe("any");
    const matchedNames = consumer!.matched.map((node) => node.provision.name).sort();
    expect(matchedNames).toEqual([
      "artifact-store:list",
      "artifact-store:view",
      "workspaces:main"
    ]);
  });
});
