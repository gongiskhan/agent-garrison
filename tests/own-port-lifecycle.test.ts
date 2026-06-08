import { describe, expect, it, vi } from "vitest";
import { isOperativeBound, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import type { CapabilityConsumption, GarrisonMetadata, LibraryEntry } from "@/lib/types";

// Mock the vault so the positive injection path is testable without touching
// the real data/vault.json.
vi.mock("@/lib/vault", () => ({
  readVaultSecrets: vi.fn(async () => [{ key: "DEEPGRAM_API_KEY", value: "dg-secret" }])
}));

// Own-port is now declared per-Fitting via the `own_port` metadata flag (a role
// like `sessions` mixes own-port and non-own-port Fittings), so the test entry
// sets own_port directly rather than inferring it from the Faculty.
function makeEntry(
  ownPort: boolean,
  lifecycle?: "operative-bound" | "detached",
  consumes: CapabilityConsumption[] = []
): LibraryEntry {
  const metadata: GarrisonMetadata = {
    faculty: "sessions",
    cardinality_hint: "single",
    component_shape: "plugin",
    platforms: ["claude-code"],
    config_schema: [],
    provides: [],
    consumes,
    verify: { command: "true", expect: "ok", timeout_ms: 10000 },
    own_port: ownPort,
    lifecycle
  };
  return {
    id: ownPort ? "own-port-test" : "plain-test",
    name: "test",
    faculty: "sessions",
    repo: "local:test",
    localPath: "fittings/seed/own-port-test",
    summary: "test",
    platforms: ["claude-code"],
    ratings: {},
    metadata
  };
}

describe("own-port lifecycle classification", () => {
  it("defaults own-port Fittings to operative-bound", () => {
    expect(isOperativeBound(makeEntry(true))).toBe(true);
  });

  it("honours explicit detached opt-out", () => {
    expect(isOperativeBound(makeEntry(true, "detached"))).toBe(false);
  });

  it("honours explicit operative-bound (same as default)", () => {
    expect(isOperativeBound(makeEntry(true, "operative-bound"))).toBe(true);
  });

  it("returns false for non-own-port Fittings even when lifecycle is set", () => {
    expect(isOperativeBound(makeEntry(false))).toBe(false);
    expect(isOperativeBound(makeEntry(false, "operative-bound"))).toBe(false);
  });
});

describe("vaultEnvForEntry (own-port secret injection gating)", () => {
  it("injects vault secrets only when the Fitting consumes vault", async () => {
    const withVault = makeEntry(true, undefined, [{ kind: "vault", cardinality: "one" }]);
    const env = await vaultEnvForEntry(withVault);
    expect(env).toEqual({ DEEPGRAM_API_KEY: "dg-secret" });
  });

  it("returns no secrets for a Fitting that does not consume vault", async () => {
    const noVault = makeEntry(true, undefined, [{ kind: "voice", cardinality: "optional-one" }]);
    const env = await vaultEnvForEntry(noVault);
    expect(env).toEqual({});
  });
});

describe("fittingId validation", () => {
  it("accepts well-formed ids", () => {
    expect(isValidFittingId("monitor-default")).toBe(true);
    expect(isValidFittingId("worktree-management-sequoias")).toBe(true);
    expect(isValidFittingId("a")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isValidFittingId("")).toBe(false);
    expect(isValidFittingId("-leading-dash")).toBe(false);
    expect(isValidFittingId("with spaces")).toBe(false);
    expect(isValidFittingId("../escape")).toBe(false);
    expect(isValidFittingId("with/slash")).toBe(false);
  });
});
