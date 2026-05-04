import { describe, expect, it } from "vitest";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

describe("x-garrison metadata", () => {
  it("accepts a valid classifier package", () => {
    const metadata = parseGarrisonMetadata({
      faculty: "classifier",
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
        faculty: "classifier",
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
      faculty: "memory",
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
        verify: {
          command: "echo ok",
          expect: "ok"
        }
      });
      expect(metadata.faculty).toBe("classifier");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });
});
