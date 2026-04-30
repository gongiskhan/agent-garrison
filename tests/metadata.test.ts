import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

describe("x-garrison metadata", () => {
  it("accepts a valid classifier package", () => {
    const metadata = parseGarrisonMetadata({
      primitive: "classifier",
      cardinality_hint: "single",
      component_shape: "skill",
      platforms: ["claude-code"],
      config_schema: [
        {
          key: "tier_floor",
          type: "integer",
          default: 3,
          description: "Minimum tier"
        }
      ],
      verify: {
        command: "echo ok",
        expect: "ok"
      }
    });

    expect(metadata.verify.timeout_ms).toBe(10000);
  });

  it("rejects shape mismatches at compose time", () => {
    expect(() =>
      parseGarrisonMetadata({
        primitive: "classifier",
        cardinality_hint: "single",
        component_shape: "script",
        platforms: ["claude-code"],
        verify: {
          command: "echo ok",
          expect: "ok"
        }
      })
    ).toThrow(/not accepted/);
  });

  it("rejects too many single-cardinality selections", () => {
    const metadata = parseGarrisonMetadata({
      primitive: "memory",
      cardinality_hint: "single",
      component_shape: "skill",
      platforms: ["claude-code"],
      verify: {
        command: "echo ok",
        expect: "ok"
      }
    });

    expect(() => validateSelection("memory", 2, [metadata, metadata])).toThrow(/accepts one/);
  });
});
