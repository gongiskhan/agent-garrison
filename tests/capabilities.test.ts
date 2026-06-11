import { describe, expect, it } from "vitest";
import { resolveCapabilities, RUNTIME_FITTING_ID, type ResolverInput } from "@/lib/capabilities";
import type {
  CapabilityConsumption,
  CapabilityProvision,
  GarrisonMetadata
} from "@/lib/types";

function fitting(
  id: string,
  options: {
    provides?: CapabilityProvision[];
    consumes?: CapabilityConsumption[];
  } = {}
): ResolverInput {
  const metadata: GarrisonMetadata = {
    faculty: "memory",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: options.provides ?? [],
    consumes: options.consumes ?? [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
  };
  return { id, metadata };
}

describe("capability resolver", () => {
  it("returns ok with an empty graph for an empty selection", () => {
    const result = resolveCapabilities([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.consumers).toEqual([]);
      // The synthetic vault provider is always indexed.
      expect(result.graph.providers.has("vault")).toBe(true);
    }
  });

  it("a provider with no consumer resolves ok (unconsumed data-source)", () => {
    const result = resolveCapabilities([
      fitting("trello-data-source", {
        provides: [{ kind: "data-source", name: "trello" }],
        consumes: [{ kind: "vault", cardinality: "one" }]
      })
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.providers.has("data-source:trello")).toBe(true);
    }
  });

  it("matches a single provider against a single consumer", () => {
    const result = resolveCapabilities([
      fitting("orch", { provides: [{ kind: "orchestrator", name: "default" }] }),
      fitting("gateway", { consumes: [{ kind: "orchestrator" }] })
    ]);
    expect(result.ok).toBe(true);
  });

  it("emits missing-required when the consumer has no provider", () => {
    const result = resolveCapabilities([
      fitting("gateway", { consumes: [{ kind: "orchestrator" }] })
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ fittingId: "gateway", code: "missing-required" })
      ]);
    }
  });

  it("emits ambiguous-singleton when two fittings provide a singleton", () => {
    const result = resolveCapabilities([
      fitting("orch-a", { provides: [{ kind: "orchestrator", name: "a" }] }),
      fitting("orch-b", { provides: [{ kind: "orchestrator", name: "b" }] })
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const ambiguous = result.errors.filter((error) => error.code === "ambiguous-singleton");
      expect(ambiguous.length).toBeGreaterThanOrEqual(1);
      expect(ambiguous.map((error) => error.fittingId)).toContain("orch-b");
      expect(ambiguous.map((error) => error.fittingId)).not.toContain("orch-a");
    }
  });

  it("optional-one with zero providers is ok with empty matched", () => {
    const result = resolveCapabilities([
      fitting("memory", {
        consumes: [{ kind: "channel", cardinality: "optional-one" }]
      })
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const consumer = result.graph.consumers.find((c) => c.fittingId === "memory");
      expect(consumer?.matched).toEqual([]);
    }
  });

  it("optional-one with one provider matches that provider", () => {
    const result = resolveCapabilities([
      fitting("heartbeat", {
        provides: [{ kind: "channel", name: "loop-heartbeat" }]
      }),
      fitting("memory", {
        consumes: [{ kind: "channel", cardinality: "optional-one" }]
      })
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const consumer = result.graph.consumers.find((c) => c.fittingId === "memory");
      expect(consumer?.matched).toHaveLength(1);
      expect(consumer?.matched[0].fittingId).toBe("heartbeat");
    }
  });

  it("web-channel resolves with a voice provider (voice:deepgram, optional-one)", () => {
    const result = resolveCapabilities([
      fitting("deepgram-voice", { provides: [{ kind: "voice", name: "deepgram" }] }),
      fitting("web-channel-default", { consumes: [{ kind: "voice", cardinality: "optional-one" }] })
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const consumer = result.graph.consumers.find((c) => c.fittingId === "web-channel-default");
      expect(consumer?.matched).toHaveLength(1);
      expect(consumer?.matched[0].fittingId).toBe("deepgram-voice");
    }
  });

  it("web-channel resolves with no voice provider (voice is optional)", () => {
    const result = resolveCapabilities([
      fitting("web-channel-default", { consumes: [{ kind: "voice", cardinality: "optional-one" }] })
    ]);
    expect(result.ok).toBe(true);
  });

  it("voice is a singleton — two providers are ambiguous", () => {
    const result = resolveCapabilities([
      fitting("deepgram-voice", { provides: [{ kind: "voice", name: "deepgram" }] }),
      fitting("other-voice", { provides: [{ kind: "voice", name: "other" }] })
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "ambiguous-singleton" && e.kind === "voice")).toBe(true);
    }
  });

  it("optional-one with two providers emits too-many-for-optional", () => {
    const result = resolveCapabilities([
      fitting("a", { provides: [{ kind: "channel", name: "a" }] }),
      fitting("b", { provides: [{ kind: "channel", name: "b" }] }),
      fitting("memory", {
        consumes: [{ kind: "channel", cardinality: "optional-one" }]
      })
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ fittingId: "memory", code: "too-many-for-optional" })
      );
    }
  });

  it("any cardinality never errors regardless of provider count", () => {
    const zero = resolveCapabilities([
      fitting("k", { consumes: [{ kind: "channel", cardinality: "any" }] })
    ]);
    expect(zero.ok).toBe(true);

    const many = resolveCapabilities([
      fitting("a", { provides: [{ kind: "channel", name: "a" }] }),
      fitting("b", { provides: [{ kind: "channel", name: "b" }] }),
      fitting("c", { provides: [{ kind: "channel", name: "c" }] }),
      fitting("k", { consumes: [{ kind: "channel", cardinality: "any" }] })
    ]);
    expect(many.ok).toBe(true);
    if (many.ok) {
      const consumer = many.graph.consumers.find((c) => c.fittingId === "k");
      expect(consumer?.matched).toHaveLength(3);
    }
  });

  it("kind-only consumption matches any provision of that kind", () => {
    const result = resolveCapabilities([
      fitting("p", { provides: [{ kind: "channel", name: "tier-classifier" }] }),
      fitting("c", { consumes: [{ kind: "channel" }] })
    ]);
    expect(result.ok).toBe(true);
  });

  it("named consumption matches only same-name provisions", () => {
    const result = resolveCapabilities([
      fitting("p", { provides: [{ kind: "channel", name: "tier-classifier" }] }),
      fitting("c", { consumes: [{ kind: "channel", name: "summarizer" }] })
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ fittingId: "c", code: "missing-required" })
      );
    }
  });

  it("vault is always available even if no fitting provides it", () => {
    const result = resolveCapabilities([
      fitting("memory", { consumes: [{ kind: "vault", cardinality: "optional-one" }] })
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const consumer = result.graph.consumers.find((c) => c.fittingId === "memory");
      expect(consumer?.matched).toHaveLength(1);
      expect(consumer?.matched[0].fittingId).toBe(RUNTIME_FITTING_ID);
    }
  });
});
