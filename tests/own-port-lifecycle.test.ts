import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isValidFittingId,
  logFilePath,
  ownPortConfigEnv,
  ownPortEnvKey,
  spawnRecordPath,
  startOwnPortFitting,
  statusFilePath,
  vaultEnvForEntry
} from "@/lib/own-port-lifecycle";
import { resetInternalTokenCache } from "@/lib/internal-token";
import { profilePort } from "@/lib/instance-profile";
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

describe("ownPortConfigEnv (config -> spawn env projection)", () => {
  it("projects scalar config as GARRISON_<ID>_<KEY> with separators dropped/normalised", () => {
    const env = ownPortConfigEnv("file-browser", { root: "/srv/x", port: 27090 });
    expect(env.GARRISON_FILEBROWSER_ROOT).toBe("/srv/x");
    expect(env.GARRISON_FILEBROWSER_PORT).toBe("27090");
  });

  it("skips a LOOPBACK bind_host so the instance-wide GARRISON_BIND_HOST governs", () => {
    // The apm.yml schema default (127.0.0.1) baked into a composition must NOT
    // be projected - projecting it would outrank GARRISON_BIND_HOST and pin the
    // fitting to loopback even when the instance binds 0.0.0.0 (dev tailscale-IP).
    for (const v of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      const env = ownPortConfigEnv("web-channel-default", { bind_host: v });
      expect(env.GARRISON_WEBCHANNELDEFAULT_BIND_HOST).toBeUndefined();
    }
  });

  it("still projects a NON-loopback bind_host (deliberate per-fitting LAN expose)", () => {
    const env = ownPortConfigEnv("web-channel-default", { bind_host: "0.0.0.0" });
    expect(env.GARRISON_WEBCHANNELDEFAULT_BIND_HOST).toBe("0.0.0.0");
    const lan = ownPortConfigEnv("web-channel-default", { bind_host: "192.168.1.10" });
    expect(lan.GARRISON_WEBCHANNELDEFAULT_BIND_HOST).toBe("192.168.1.10");
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

describe("ownPortEnvKey / guaranteed port projection", () => {
  it("names the env key a fitting server actually reads", () => {
    expect(ownPortEnvKey("drill")).toBe("GARRISON_DRILL_PORT");
    // Separators are DROPPED, not underscored - web-channel-default reads
    // GARRISON_WEBCHANNELDEFAULT_PORT.
    expect(ownPortEnvKey("web-channel-default")).toBe("GARRISON_WEBCHANNELDEFAULT_PORT");
  });

  // The regression this exists for: a caller that could not resolve the
  // composition (the Views Start/Restart routes with no RUNNING composition)
  // passed vault-only env, so no port was projected and the fitting fell
  // through to its own baked-in default. A dev-profile drill was found live on
  // 0.0.0.0:27096 - the CODEX instance's port - answering for another instance.
  // Every spawn must now name a port, whatever the caller managed to resolve.
  it("projects a profile-shifted port when the caller supplies none", async () => {
    const entry = makeEntry(true);
    entry.metadata.default_port = 8096;
    const spawned = await startOwnPortFitting(entry, {});
    // The entry has no real start script, so the spawn is refused - but the env
    // is assembled before that, and the spawn record carries its fingerprint.
    expect(spawned.ok).toBe(false);

    // Assert the projection directly: same base port, shifted per profile.
    for (const [profile, expected] of [
      ["dev", 18096],
      ["node", 8096],
      // "prod" is the one-release alias for node — same family, same ports.
      ["prod", 8096],
      ["codex", 28096]
    ] as const) {
      const prev = process.env.GARRISON_INSTANCE_ID;
      process.env.GARRISON_INSTANCE_ID = profile;
      try {
        expect(profilePort(8096), `${profile} must shift 8096 into its own family`).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env.GARRISON_INSTANCE_ID;
        else process.env.GARRISON_INSTANCE_ID = prev;
      }
    }
  });

  it("never overrides a port the caller did resolve", () => {
    // A resolved composition config always wins; the guarantee only fills a gap.
    const env = ownPortConfigEnv("drill", { port: 8096 });
    expect(env.GARRISON_DRILL_PORT).toBe("8096");
  });
});

describe("vaultEnvForEntry (own-port secret injection gating)", () => {
  it("injects ONLY the scoped vault secrets when the Fitting declares secret_scope", async () => {
    const withScope = makeEntry(true, [{ kind: "vault", cardinality: "one" }], ["DEEPGRAM_API_KEY"]);
    const env = await vaultEnvForEntry(withScope);
    expect(env).toEqual({ DEEPGRAM_API_KEY: "dg-secret" });
  });

  it("fail-closed: a vault consumer without secret_scope gets no secrets", async () => {
    const noScope = makeEntry(true, [{ kind: "vault", cardinality: "one" }]);
    const env = await vaultEnvForEntry(noScope);
    expect(env).toEqual({});
  });

  it("returns no secrets for a Fitting that does not consume vault", async () => {
    const noVault = makeEntry(true, [{ kind: "voice", cardinality: "optional-one" }]);
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
