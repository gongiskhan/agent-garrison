import { describe, expect, it } from "vitest";
import path from "node:path";

const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

describe("shouldRespawnForTier — gateway tier-compare decision", () => {
  it("returns true when models differ", async () => {
    const { shouldRespawnForTier } = await import(path.join(LIB, "tier-compare.mjs"));
    expect(
      shouldRespawnForTier(
        { model: "claude-haiku-4-5" },
        { model: "claude-sonnet-4-6" }
      )
    ).toBe(true);
    expect(
      shouldRespawnForTier(
        { model: "claude-haiku-4-5" },
        { model: "claude-opus-4-7" }
      )
    ).toBe(true);
  });

  it("returns false when models match (even if effort/needs_testing differ)", async () => {
    const { shouldRespawnForTier } = await import(path.join(LIB, "tier-compare.mjs"));
    expect(
      shouldRespawnForTier(
        { model: "claude-sonnet-4-6", effort: "low" },
        { model: "claude-sonnet-4-6", effort: "high" }
      )
    ).toBe(false);
    expect(
      shouldRespawnForTier(
        { model: "claude-sonnet-4-6", needs_testing: true },
        { model: "claude-sonnet-4-6", needs_testing: false }
      )
    ).toBe(false);
  });

  it("returns false when either tier is missing", async () => {
    const { shouldRespawnForTier } = await import(path.join(LIB, "tier-compare.mjs"));
    expect(shouldRespawnForTier(null, { model: "claude-sonnet-4-6" })).toBe(false);
    expect(shouldRespawnForTier({ model: "claude-sonnet-4-6" }, null)).toBe(false);
    expect(shouldRespawnForTier(undefined, undefined)).toBe(false);
  });

  it("returns false when either model field is missing or non-string", async () => {
    const { shouldRespawnForTier } = await import(path.join(LIB, "tier-compare.mjs"));
    expect(shouldRespawnForTier({}, { model: "claude-sonnet-4-6" })).toBe(false);
    expect(shouldRespawnForTier({ model: "claude-sonnet-4-6" }, {})).toBe(false);
    expect(
      shouldRespawnForTier({ model: 42 as unknown as string }, { model: "claude-sonnet-4-6" })
    ).toBe(false);
  });
});
