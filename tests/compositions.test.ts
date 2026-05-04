import { describe, expect, it } from "vitest";
import { computeCapabilityIssues } from "@/lib/compositions";
import type { LibraryEntry, GarrisonMetadata } from "@/lib/types";

function entry(
  id: string,
  faculty: GarrisonMetadata["faculty"],
  metadata: Partial<GarrisonMetadata>
): LibraryEntry {
  const fullMetadata: GarrisonMetadata = {
    faculty,
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: [],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 },
    ...metadata
  };
  return {
    id,
    name: id,
    faculty,
    repo: `local:${id}`,
    summary: id,
    platforms: ["claude-code"],
    ratings: {},
    metadata: fullMetadata
  };
}

describe("computeCapabilityIssues", () => {
  it("returns no issues for a composition with no selections", () => {
    expect(computeCapabilityIssues([])).toEqual([]);
  });

  it("flags a missing orchestrator dependency", () => {
    const issues = computeCapabilityIssues([
      entry("gateway", "gateway", {
        consumes: [{ kind: "orchestrator", cardinality: "one" }]
      })
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      fittingId: "gateway",
      code: "missing-required",
      kind: "orchestrator"
    });
  });

  it("vault consumption with no fitting provider is satisfied by the runtime synthetic", () => {
    const issues = computeCapabilityIssues([
      entry("memory", "memory", {
        consumes: [{ kind: "vault", cardinality: "optional-one" }]
      })
    ]);
    expect(issues).toEqual([]);
  });

  it("surfaces capability issues alongside otherwise-valid selections", () => {
    const issues = computeCapabilityIssues([
      entry("orch-a", "orchestrator", {
        provides: [{ kind: "orchestrator", name: "a" }]
      }),
      entry("orch-b", "orchestrator", {
        provides: [{ kind: "orchestrator", name: "b" }]
      })
    ]);
    expect(issues.some((issue) => issue.code === "ambiguous-singleton")).toBe(true);
  });
});
