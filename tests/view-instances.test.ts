import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCapabilities, type ResolverInput } from "@/lib/capabilities";
import { renderCapabilitiesBlock } from "@/lib/runner";
import {
  DEFAULT_INSTANCE_ID,
  OWN_PORT_VIEW_ID,
  deriveViewDescriptors,
  deriveViewProvisions,
  formatInstanceRef,
  isValidInstanceId,
  parseInstanceRef
} from "@/lib/view-instances";
import { listInstanceIds, viewStateFile } from "@/lib/view-state";
import type { GarrisonMetadata, LibraryEntry } from "@/lib/types";

// W1 gate — stable view-instance identity + the derived `view` capability.
// (fittingId, viewId, instanceId) addressing, resolver-side derivation from
// ui.views[]/own_port, and the no-prompt-pollution invariant.

function metadata(overrides: Partial<GarrisonMetadata> = {}): GarrisonMetadata {
  return {
    faculty: "sessions",
    cardinality_hint: "single",
    component_shape: "cli",
    platforms: ["claude-code"],
    config_schema: [],
    provides: [],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 },
    ...overrides
  };
}

describe("instance ref codec", () => {
  it("round-trips a non-default instance ref", () => {
    const ref = { fittingId: "dev-env", viewId: "main", instanceId: "sess-2" };
    expect(parseInstanceRef(formatInstanceRef(ref))).toEqual(ref);
  });

  it("omits the default instance id and parses it back", () => {
    const ref = { fittingId: "artifact-store", viewId: "list", instanceId: DEFAULT_INSTANCE_ID };
    expect(formatInstanceRef(ref)).toBe("artifact-store:list");
    expect(parseInstanceRef("artifact-store:list")).toEqual(ref);
  });

  it("rejects malformed and traversal-shaped refs", () => {
    expect(parseInstanceRef("no-view-separator")).toBeNull();
    expect(parseInstanceRef(":view")).toBeNull();
    expect(parseInstanceRef("fitting:")).toBeNull();
    expect(parseInstanceRef("fitting:view#../../etc/passwd")).toBeNull();
    expect(parseInstanceRef("fit/ting:view")).toBeNull();
  });

  it("validates path-safe instance ids", () => {
    expect(isValidInstanceId("sess-2")).toBe(true);
    expect(isValidInstanceId(".hidden")).toBe(false);
    expect(isValidInstanceId("a/b")).toBe(false);
    expect(isValidInstanceId("a..b")).toBe(false);
  });

  it("refuses traversal-shaped ids at the path-builder boundary too", () => {
    expect(() => viewStateFile("ok-fitting", "../escape")).toThrow(/invalid instance id/);
    expect(() => viewStateFile("../escape", "ok")).toThrow(/invalid fitting id/);
  });
});

describe("view descriptor + provision derivation", () => {
  it("derives one embedded descriptor per ui.view", () => {
    const md = metadata({
      ui: {
        views: [
          { id: "list", placement: "sidebar-surface", entry: "./ui/A.tsx", route: "/" },
          { id: "view", placement: "sidebar-surface", entry: "./ui/B.tsx", route: "/:id" }
        ]
      }
    });
    const descriptors = deriveViewDescriptors("artifact-store", md);
    expect(descriptors).toEqual([
      expect.objectContaining({ fittingId: "artifact-store", viewId: "list", surface: "embedded" }),
      expect.objectContaining({ fittingId: "artifact-store", viewId: "view", surface: "embedded" })
    ]);
  });

  it("derives a single own-port surface view", () => {
    const descriptors = deriveViewDescriptors("dev-env", metadata({ own_port: true }));
    expect(descriptors).toEqual([
      expect.objectContaining({
        fittingId: "dev-env",
        viewId: OWN_PORT_VIEW_ID,
        surface: "own-port"
      })
    ]);
  });

  it("derives nothing for a fitting with no views", () => {
    expect(deriveViewDescriptors("plain", metadata())).toEqual([]);
    expect(deriveViewProvisions("plain", metadata())).toEqual([]);
  });

  it("names provisions <fittingId>:<viewId>", () => {
    const provisions = deriveViewProvisions(
      "documents",
      metadata({
        ui: { views: [{ id: "read", placement: "sidebar-surface", entry: "./ui/R.tsx", route: "/:id" }] }
      })
    );
    expect(provisions).toEqual([{ kind: "view", name: "documents:read" }]);
  });
});

describe("resolver exposes derived view capability", () => {
  const selection: ResolverInput[] = [
    {
      id: "artifact-store",
      metadata: metadata({
        provides: [{ kind: "artifact-store", name: "default" }],
        ui: {
          views: [{ id: "list", placement: "sidebar-surface", entry: "./ui/A.tsx", route: "/" }]
        }
      })
    },
    {
      id: "dev-env",
      metadata: metadata({
        provides: [{ kind: "dev-env", name: "dev-env" }],
        own_port: true
      })
    },
    {
      id: "view-consumer",
      metadata: metadata({ consumes: [{ kind: "view", cardinality: "any" }] })
    }
  ];

  it("a `view` consumer with cardinality any discovers every produced view without hardcoding", () => {
    const result = resolveCapabilities(selection);
    expect(result.ok).toBe(true);
    const consumer = result.graph.consumers.find((c) => c.fittingId === "view-consumer");
    expect(consumer).toBeTruthy();
    const matchedNames = consumer!.matched.map((node) => node.provision.name).sort();
    expect(matchedNames).toEqual(["artifact-store:list", "dev-env:main"]);
  });

  it("a named view consumption targets one fitting's view", () => {
    const result = resolveCapabilities([
      ...selection.slice(0, 2),
      {
        id: "view-consumer",
        metadata: metadata({ consumes: [{ kind: "view", name: "artifact-store:list" }] })
      }
    ]);
    expect(result.ok).toBe(true);
    const consumer = result.graph.consumers.find((c) => c.fittingId === "view-consumer");
    expect(consumer!.matched).toHaveLength(1);
    expect(consumer!.matched[0].fittingId).toBe("artifact-store");
  });

  it("backward compat: compositions without view consumers resolve exactly as before", () => {
    const result = resolveCapabilities(selection.slice(0, 2));
    expect(result.ok).toBe(true);
    expect(result.graph.providers.get("dev-env")).toHaveLength(1);
    expect(result.graph.providers.get("artifact-store")).toHaveLength(1);
  });

  it("derived view provisions never leak into the assembled prompt's capabilities block", () => {
    const entries = selection.slice(0, 2).map(
      (input): LibraryEntry => ({
        id: input.id,
        name: input.id,
        faculty: input.metadata.faculty,
        repo: "local",
        summary: `${input.id} summary`,
        platforms: ["claude-code"],
        ratings: {},
        metadata: input.metadata
      })
    );
    const block = renderCapabilitiesBlock(entries);
    expect(block).toContain("artifact-store:default");
    expect(block).toContain("dev-env:dev-env");
    expect(block).not.toContain("view:");
  });
});

describe("instance enumeration from the view-state dir", () => {
  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-view-instances-"));
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

  it("returns [] for a fitting that has never persisted", async () => {
    expect(await listInstanceIds("dev-env")).toEqual([]);
  });

  it("lists one id per *.json file, sorted, ignoring non-instance files", async () => {
    const dir = path.join(sandbox, "view-state", "dev-env");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sess-2.json"), "{}");
    writeFileSync(path.join(dir, "default.json"), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "ignore me");
    writeFileSync(path.join(dir, ".tmp-half-write.json"), "{}");
    expect(await listInstanceIds("dev-env")).toEqual(["default", "sess-2"]);
  });
});
