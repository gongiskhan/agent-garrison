import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

const baseMetadata = {
  faculty: "memory" as const,
  cardinality_hint: "single" as const,
  component_shape: "skill" as const,
  platforms: ["claude-code"],
  verify: { command: "echo ok", expect: "ok" }
};

describe("x-garrison metadata", () => {
  it("accepts a valid role package", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      config_schema: [
        {
          key: "recency_window",
          type: "integer",
          default: 20,
          description: "Recency window"
        }
      ]
    });

    expect(metadata.verify.timeout_ms).toBe(10000);
  });

  it("rejects shape mismatches at compose time", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        component_shape: "script"
      })
    ).toThrow(/not accepted/);
  });

  it("rejects too many single-cardinality selections", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      faculty: "memory"
    });

    expect(() => validateSelection("memory", 2, [metadata, metadata])).toThrow(/accepts one/);
  });

  it("accepts the deprecated `primitive` alias and normalizes to `faculty`", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        primitive: "memory",
        cardinality_hint: "single",
        component_shape: "skill",
        platforms: ["claude-code"],
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("memory");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  it("folds a deprecated own-port faculty into its role (terminal -> sessions)", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        faculty: "terminal",
        cardinality_hint: "single",
        component_shape: "plugin",
        platforms: ["claude-code"],
        own_port: true,
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("sessions");
      expect(metadata.own_port).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  it("warns about both deprecations when a manifest uses primitive: monitor", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        primitive: "monitor",
        cardinality_hint: "single",
        component_shape: "plugin",
        platforms: ["claude-code"],
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("observability");
      expect(calls.length).toBe(2);
    } finally {
      console.warn = warn;
    }
  });
});

describe("ui contract v2 — views[]", () => {
  it("parses a v2 manifest with multiple views and placements", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      ui: {
        views: [
          { id: "list", placement: "faculty-tab", entry: "./ui/list.tsx", route: "/" },
          { id: "read", placement: "sidebar-surface", entry: "./ui/read.tsx", route: "/:id" }
        ]
      }
    });
    expect(metadata.ui?.views).toHaveLength(2);
    expect(metadata.ui?.views[0]).toEqual({
      id: "list",
      placement: "faculty-tab",
      entry: "./ui/list.tsx",
      route: "/"
    });
  });

  it("normalizes the deprecated ui.extension into a single faculty-tab view", () => {
    const warn = console.warn;
    const calls: unknown[] = [];
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const metadata = parseGarrisonMetadata({
        ...baseMetadata,
        ui: { extension: "./ui/Inspector.tsx" }
      });
      expect(metadata.ui?.views).toEqual([
        {
          id: "main",
          placement: "faculty-tab",
          entry: "./ui/Inspector.tsx",
          route: "/"
        }
      ]);
      expect(calls.length).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  it("rejects an unknown placement value", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        ui: {
          views: [
            { id: "x", placement: "modal", entry: "./ui/x.tsx", route: "/" }
          ]
        }
      })
    ).toThrow();
  });

  it("rejects an empty views array", () => {
    expect(() =>
      parseGarrisonMetadata({ ...baseMetadata, ui: { views: [] } })
    ).toThrow(/at least one view/);
  });

  it("rejects view ids that do not match the slug pattern", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        ui: {
          views: [
            { id: "1bad", placement: "faculty-tab", entry: "./ui/x.tsx", route: "/" }
          ]
        }
      })
    ).toThrow();
  });
});

describe("for_consumers field", () => {
  it("parses when a Fitting ships a for_consumers block", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      for_consumers: "Use this Faculty when in PM hat."
    });
    expect(metadata.for_consumers).toBe("Use this Faculty when in PM hat.");
  });

  it("is optional", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata });
    expect(metadata.for_consumers).toBeUndefined();
  });

  it("rejects values that exceed the 8 KB byte cap", () => {
    const oversized = "x".repeat(8 * 1024 + 1);
    expect(() =>
      parseGarrisonMetadata({ ...baseMetadata, for_consumers: oversized })
    ).toThrow(/for_consumers exceeds/);
  });
});

describe("capability provides/consumes", () => {
  it("defaults provides and consumes to empty arrays when absent", () => {
    const metadata = parseGarrisonMetadata({ ...baseMetadata });
    expect(metadata.provides).toEqual([]);
    expect(metadata.consumes).toEqual([]);
  });

  it("accepts a valid provides entry", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      provides: [{ kind: "memory-store", name: "garrison-memory" }]
    });
    expect(metadata.provides).toEqual([{ kind: "memory-store", name: "garrison-memory" }]);
  });

  it("accepts a valid consumes entry", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      consumes: [{ kind: "orchestrator", cardinality: "one" }]
    });
    expect(metadata.consumes).toEqual([{ kind: "orchestrator", cardinality: "one" }]);
  });

  it("accepts both provides and consumes together", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      provides: [{ kind: "memory-store", name: "garrison-memory" }],
      consumes: [{ kind: "vault", cardinality: "optional-one" }]
    });
    expect(metadata.provides).toHaveLength(1);
    expect(metadata.consumes).toHaveLength(1);
  });

  it("rejects a dropped capability kind (agent-skill was removed in the pivot)", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "agent-skill", name: "x" }]
      })
    ).toThrow(/agent-skill/);
  });

  it("rejects an unknown capability kind by name", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "channel-host", name: "slack" }]
      })
    ).toThrow(/channel-host/);
  });

  it("rejects a provides entry without a name", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        provides: [{ kind: "memory-store" }]
      })
    ).toThrow();
  });

  it("rejects a consumes entry with an invalid cardinality", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...baseMetadata,
        consumes: [{ kind: "orchestrator", cardinality: "many" }]
      })
    ).toThrow();
  });
});
