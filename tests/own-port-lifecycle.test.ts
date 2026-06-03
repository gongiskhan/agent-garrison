import { describe, expect, it, vi } from "vitest";
import { isOperativeBound, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import type { CapabilityConsumption, GarrisonMetadata, LibraryEntry, FacultyId } from "@/lib/types";

// Mock the vault so the positive injection path is testable without touching
// the real data/vault.json.
vi.mock("@/lib/vault", () => ({
  readVaultSecrets: vi.fn(async () => [{ key: "DEEPGRAM_API_KEY", value: "dg-secret" }])
}));

function makeEntry(
  faculty: FacultyId,
  lifecycle?: "operative-bound" | "detached",
  consumes: CapabilityConsumption[] = []
): LibraryEntry {
  const metadata: GarrisonMetadata = {
    faculty,
    cardinality_hint: "single",
    component_shape: "plugin",
    platforms: ["claude-code"],
    config_schema: [],
    provides: [],
    consumes,
    verify: { command: "true", expect: "ok", timeout_ms: 10000 },
    lifecycle
  };
  return {
    id: `${faculty}-test`,
    name: faculty,
    faculty,
    repo: "local:test",
    localPath: `fittings/seed/${faculty}-test`,
    summary: "test",
    platforms: ["claude-code"],
    ratings: {},
    metadata
  };
}

describe("own-port lifecycle classification", () => {
  it("defaults own-port Fittings to operative-bound", () => {
    expect(isOperativeBound(makeEntry("terminal"))).toBe(true);
    expect(isOperativeBound(makeEntry("session-view"))).toBe(true);
    expect(isOperativeBound(makeEntry("worktree-management"))).toBe(true);
    expect(isOperativeBound(makeEntry("screen-share"))).toBe(true);
    expect(isOperativeBound(makeEntry("outposts"))).toBe(true);
    expect(isOperativeBound(makeEntry("monitor"))).toBe(true);
    expect(isOperativeBound(makeEntry("web-channel"))).toBe(true);
    expect(isOperativeBound(makeEntry("browser"))).toBe(true);
  });

  it("honours explicit detached opt-out", () => {
    expect(isOperativeBound(makeEntry("terminal", "detached"))).toBe(false);
    expect(isOperativeBound(makeEntry("monitor", "detached"))).toBe(false);
  });

  it("honours explicit operative-bound (same as default)", () => {
    expect(isOperativeBound(makeEntry("terminal", "operative-bound"))).toBe(true);
  });

  it("returns false for non-own-port Faculties even when lifecycle is set", () => {
    expect(isOperativeBound(makeEntry("soul"))).toBe(false);
    expect(isOperativeBound(makeEntry("memory"))).toBe(false);
    expect(isOperativeBound(makeEntry("gateway"))).toBe(false);
    expect(isOperativeBound(makeEntry("channels", "operative-bound"))).toBe(false);
  });
});

describe("vaultEnvForEntry (own-port secret injection gating)", () => {
  it("injects vault secrets only when the Fitting consumes vault", async () => {
    const withVault = makeEntry("voice", undefined, [{ kind: "vault", cardinality: "one" }]);
    const env = await vaultEnvForEntry(withVault);
    expect(env).toEqual({ DEEPGRAM_API_KEY: "dg-secret" });
  });

  it("returns no secrets for a Fitting that does not consume vault", async () => {
    const noVault = makeEntry("web-channel", undefined, [{ kind: "voice", cardinality: "optional-one" }]);
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
