import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOperativeBound,
  isValidFittingId,
  logFilePath,
  spawnRecordPath,
  startOwnPortFitting,
  statusFilePath,
  vaultEnvForEntry
} from "@/lib/own-port-lifecycle";
import { resetInternalTokenCache } from "@/lib/internal-token";
import type { CapabilityConsumption, GarrisonMetadata, LibraryEntry } from "@/lib/types";

// Mock the vault so the positive injection path is testable without touching
// the real data/vault.json. Per-connector scoping (A2): vaultEnvForEntry now
// calls scopedSecrets(scope) and delivers only the declared secrets.
vi.mock("@/lib/vault", () => ({
  scopedSecrets: vi.fn(async (scope: string[]) =>
    scope.includes("DEEPGRAM_API_KEY") ? [{ key: "DEEPGRAM_API_KEY", value: "dg-secret" }] : []
  )
}));
vi.mock("@/lib/vault-audit", () => ({
  recordVaultAccess: vi.fn(async () => {})
}));

// Own-port is now declared per-Fitting via the `own_port` metadata flag (a role
// like `sessions` mixes own-port and non-own-port Fittings), so the test entry
// sets own_port directly rather than inferring it from the Faculty.
function makeEntry(
  ownPort: boolean,
  lifecycle?: "operative-bound" | "detached",
  consumes: CapabilityConsumption[] = [],
  secretScope?: string[]
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
    lifecycle,
    ...(secretScope ? { secret_scope: secretScope } : {})
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

describe("startOwnPortFitting internal-token mint", () => {
  let ghome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    ghome = mkdtempSync(path.join(os.tmpdir(), "garrison-oplt-"));
    prevHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = ghome;
    resetInternalTokenCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = prevHome;
    resetInternalTokenCache();
    rmSync(ghome, { recursive: true, force: true });
  });

  it("mints ~/.garrison/internal-token (0600) before any spawn attempt", async () => {
    // Consumers (automations engine, drill) read this file directly at call
    // time and send "" when absent - every token-gated backend route then
    // 403s. A refused start still exercises the mint, keeping this hermetic.
    const result = await startOwnPortFitting(makeEntry(false));
    expect(result.ok).toBe(false);
    const tokenFile = path.join(ghome, "internal-token");
    expect(existsSync(tokenFile)).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe("vaultEnvForEntry (own-port secret injection gating)", () => {
  it("injects ONLY the scoped vault secrets when the Fitting declares secret_scope", async () => {
    const withScope = makeEntry(true, undefined, [{ kind: "vault", cardinality: "one" }], ["DEEPGRAM_API_KEY"]);
    const env = await vaultEnvForEntry(withScope);
    expect(env).toEqual({ DEEPGRAM_API_KEY: "dg-secret" });
  });

  it("fail-closed: a vault consumer without secret_scope gets no secrets", async () => {
    const noScope = makeEntry(true, undefined, [{ kind: "vault", cardinality: "one" }]);
    const env = await vaultEnvForEntry(noScope);
    expect(env).toEqual({});
  });

  it("returns no secrets for a Fitting that does not consume vault", async () => {
    const noVault = makeEntry(true, undefined, [{ kind: "voice", cardinality: "optional-one" }]);
    const env = await vaultEnvForEntry(noVault);
    expect(env).toEqual({});
  });
});

describe("spawn record placement", () => {
  const priorHome = process.env.GARRISON_HOME;

  beforeEach(() => {
    process.env.GARRISON_HOME = "/tmp/garrison-spawn-record-test";
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
  });

  it("lives in a spawn/ SUBDIR of the status dir, honouring GARRISON_HOME", () => {
    expect(spawnRecordPath("deepgram-voice")).toBe(
      path.join("/tmp/garrison-spawn-record-test", "ui-fittings", "spawn", "deepgram-voice.json")
    );
    // Never a sibling of the flat <id>.json status files — the *.json status
    // enumeration must be unable to mistake a spawn record for a status file.
    expect(path.dirname(spawnRecordPath("deepgram-voice"))).not.toBe(
      path.dirname(statusFilePath("deepgram-voice"))
    );
    expect(path.dirname(path.dirname(spawnRecordPath("deepgram-voice")))).toBe(
      path.dirname(statusFilePath("deepgram-voice"))
    );
  });

  it("logFilePath sits beside the status file, honouring GARRISON_HOME (the logs route reads it)", () => {
    expect(logFilePath("deepgram-voice")).toBe(
      path.join("/tmp/garrison-spawn-record-test", "ui-fittings", "deepgram-voice.log")
    );
    expect(path.dirname(logFilePath("deepgram-voice"))).toBe(
      path.dirname(statusFilePath("deepgram-voice"))
    );
  });
});

describe("fittingId validation", () => {
  it("accepts well-formed ids", () => {
    expect(isValidFittingId("monitor-default")).toBe(true);
    expect(isValidFittingId("dev-env")).toBe(true);
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
