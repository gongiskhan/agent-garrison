import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

const baseMetadata = {
  faculty: "classifier" as const,
  cardinality_hint: "single" as const,
  component_shape: "skill" as const,
  platforms: ["claude-code"],
  verify: { command: "echo ok", expect: "ok" }
};

describe("x-garrison metadata", () => {
  it("accepts a valid classifier package", () => {
    const metadata = parseGarrisonMetadata({
      ...baseMetadata,
      config_schema: [
        {
          key: "tier_floor",
          type: "integer",
          default: 3,
          description: "Minimum tier"
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
        primitive: "classifier",
        cardinality_hint: "single",
        component_shape: "skill",
        platforms: ["claude-code"],
        verify: { command: "echo ok", expect: "ok" }
      });
      expect(metadata.faculty).toBe("classifier");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
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
      provides: [{ kind: "agent-skill", name: "tier-classifier" }]
    });
    expect(metadata.provides).toEqual([{ kind: "agent-skill", name: "tier-classifier" }]);
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
      provides: [{ kind: "agent-skill", name: "tier-classifier" }],
      consumes: [{ kind: "vault", cardinality: "optional-one" }]
    });
    expect(metadata.provides).toHaveLength(1);
    expect(metadata.consumes).toHaveLength(1);
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
        provides: [{ kind: "agent-skill" }]
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
