// The shell-side voice facts (docs/decisions/2026-09-garrison-app.md D22/D23,
// D31): which stationed fitting provides `kind: voice` (read off the capability
// graph, never a hardcoded id) and the capture token (read per request from the
// node's secret source through the same seam the runner uses). Synthetic
// entries and mocked modules only - nothing here touches ~/.garrison.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import type { ResolverInput } from "@/lib/capabilities";
import { StateApiError, StateUnavailableError } from "@/lib/state-client";

const activeConfig = vi.hoisted(() => ({ active_composition: "default" }));
const compositionMocks = vi.hoisted(() => ({
  readComposition: vi.fn(),
  selectedLibraryEntries: vi.fn()
}));
const vaultMocks = vi.hoisted(() => ({ vaultStatus: vi.fn(() => ({ unlocked: true })) }));
const syncMocks = vi.hoisted(() => ({ scopedSecretsViaAuthority: vi.fn() }));

vi.mock("@/lib/active-composition", () => ({ readActiveConfig: async () => activeConfig }));
vi.mock("@/lib/compositions", () => compositionMocks);
vi.mock("@/lib/vault", () => vaultMocks);
vi.mock("@/lib/composition-sync", () => syncMocks);

import {
  CAPTURE_TOKEN_SECRET,
  VOICE_FITTING_ID_ENV,
  VOICE_LOCKED,
  VOICE_SECRETS_UNREACHABLE,
  VOICE_TOKEN_DENIED,
  VOICE_TOKEN_UNSET,
  readCaptureToken,
  voiceEnvForEntry,
  voiceProviderId,
  voiceProviderIdFor,
  voiceToken,
  voiceTokenReason
} from "@/lib/voice-provider";

function entry(id: string, over: Record<string, unknown>): ResolverInput {
  return {
    id,
    metadata: parseGarrisonMetadata({
      faculty: "channels",
      cardinality_hint: "single",
      component_shape: "script",
      platforms: ["claude-code"],
      verify: { command: "echo ok", expect: "ok" },
      own_port: true,
      ...over
    })
  };
}

const captureService = entry("capture-service", {
  provides: [
    { kind: "channel", name: "capture-service", summary: "pendant + voice REST" },
    { kind: "voice", name: "capture-service", summary: "STT + TTS clips" },
    { kind: "connector", name: "voice", summary: "transcribe / synthesize" }
  ],
  consumes: [{ kind: "vault", cardinality: "one" }],
  connector: { auth: "api_key", actions: [{ name: "transcribe", description: "audio to text" }] },
  secret_scope: ["CAPTURE_TOKEN", "DEEPGRAM_API_KEY"]
});
const otherVoice = entry("other-voice", {
  provides: [{ kind: "voice", name: "other-voice", summary: "another synthesiser" }]
});
const devEnv = entry("dev-env", {
  faculty: "sessions",
  provides: [{ kind: "dev-env", name: "dev-env", summary: "terminal surface" }],
  consumes: [
    { kind: "vault", cardinality: "one" },
    { kind: "voice", cardinality: "optional-one" }
  ],
  secret_scope: ["CAPTURE_TOKEN"]
});
const monitor = entry("monitor", {
  faculty: "observability",
  provides: [{ kind: "monitor", name: "monitor", summary: "runtime log" }]
});

describe("voiceProviderIdFor", () => {
  it("names the one stationed fitting providing kind: voice, whatever its id", () => {
    expect(voiceProviderIdFor([captureService, devEnv, monitor])).toBe("capture-service");
    expect(voiceProviderIdFor([otherVoice, devEnv])).toBe("other-voice");
  });

  it("is null with no voice provider stationed", () => {
    expect(voiceProviderIdFor([devEnv, monitor])).toBeNull();
    expect(voiceProviderIdFor([])).toBeNull();
  });

  it("is null when two fittings provide voice (singleton kind - no coin toss)", () => {
    expect(voiceProviderIdFor([captureService, otherVoice, devEnv])).toBeNull();
  });
});

describe("voiceEnvForEntry", () => {
  it("projects GARRISON_VOICE_FITTING_ID only into fittings that consume voice", () => {
    expect(VOICE_FITTING_ID_ENV).toBe("GARRISON_VOICE_FITTING_ID");
    expect(voiceEnvForEntry(devEnv, "capture-service")).toEqual({ GARRISON_VOICE_FITTING_ID: "capture-service" });
    expect(voiceEnvForEntry(monitor, "capture-service")).toEqual({});
    // the provider itself does not consume voice
    expect(voiceEnvForEntry(captureService, "capture-service")).toEqual({});
  });

  it("projects nothing when there is no provider", () => {
    expect(voiceEnvForEntry(devEnv, null)).toEqual({});
  });
});

describe("voiceProviderId (active composition)", () => {
  beforeEach(() => {
    compositionMocks.readComposition.mockReset();
    compositionMocks.selectedLibraryEntries.mockReset();
  });

  it("resolves the provider from the active composition's stationed entries", async () => {
    compositionMocks.readComposition.mockResolvedValue({ id: "default", selections: { channels: ["capture-service"] } });
    compositionMocks.selectedLibraryEntries.mockResolvedValue([
      { id: "capture-service", metadata: captureService.metadata },
      { id: "dev-env", metadata: devEnv.metadata }
    ]);
    await expect(voiceProviderId()).resolves.toBe("capture-service");
    expect(compositionMocks.readComposition).toHaveBeenCalledWith("default");
  });

  it("is null when nothing stationed provides voice, and when the composition cannot be read", async () => {
    compositionMocks.readComposition.mockResolvedValue({ id: "default", selections: {} });
    compositionMocks.selectedLibraryEntries.mockResolvedValue([{ id: "dev-env", metadata: devEnv.metadata }]);
    await expect(voiceProviderId()).resolves.toBeNull();

    compositionMocks.readComposition.mockRejectedValue(new Error("no such composition"));
    await expect(voiceProviderId()).resolves.toBeNull();
  });
});

describe("voiceToken", () => {
  beforeEach(() => {
    syncMocks.scopedSecretsViaAuthority.mockReset();
    vaultMocks.vaultStatus.mockReset().mockReturnValue({ unlocked: true });
  });

  it("asks the node's secret source for exactly CAPTURE_TOKEN and returns its value", async () => {
    syncMocks.scopedSecretsViaAuthority.mockResolvedValue({
      source: "authority",
      values: { CAPTURE_TOKEN: "cap-token" },
      missing: []
    });
    await expect(voiceToken()).resolves.toBe("cap-token");
    expect(syncMocks.scopedSecretsViaAuthority).toHaveBeenCalledWith([CAPTURE_TOKEN_SECRET]);
    expect(CAPTURE_TOKEN_SECRET).toBe("CAPTURE_TOKEN");
    await expect(readCaptureToken()).resolves.toEqual({ token: "cap-token", reason: null });
  });

  it("is null, as not sealed, when the source answers without the key or with an empty one", async () => {
    syncMocks.scopedSecretsViaAuthority.mockResolvedValue({ source: "authority", values: {}, missing: ["CAPTURE_TOKEN"] });
    await expect(voiceToken()).resolves.toBeNull();
    await expect(voiceTokenReason()).resolves.toBe(VOICE_TOKEN_UNSET);

    syncMocks.scopedSecretsViaAuthority.mockResolvedValue({ source: "local-vault", values: { CAPTURE_TOKEN: "" }, missing: [] });
    await expect(readCaptureToken()).resolves.toEqual({ token: null, reason: VOICE_TOKEN_UNSET });
  });

  it("names a refusing authority and an unreachable one apart from a locked local vault", async () => {
    syncMocks.scopedSecretsViaAuthority.mockRejectedValue(
      new StateApiError(403, { error: "secrets-denied", denied: ["CAPTURE_TOKEN"] })
    );
    await expect(readCaptureToken()).resolves.toEqual({ token: null, reason: VOICE_TOKEN_DENIED });

    syncMocks.scopedSecretsViaAuthority.mockRejectedValue(new StateUnavailableError("http://127.0.0.1:1", new Error("ECONNREFUSED")));
    await expect(readCaptureToken()).resolves.toEqual({ token: null, reason: VOICE_SECRETS_UNREACHABLE });

    // A standalone box: the local vault threw. Locked when it is locked ...
    vaultMocks.vaultStatus.mockReturnValue({ unlocked: false });
    syncMocks.scopedSecretsViaAuthority.mockRejectedValue(new Error("Vault is locked"));
    await expect(readCaptureToken()).resolves.toEqual({ token: null, reason: VOICE_LOCKED });
    // ... and the token simply not there when it is open and still threw.
    vaultMocks.vaultStatus.mockReturnValue({ unlocked: true });
    await expect(readCaptureToken()).resolves.toEqual({ token: null, reason: VOICE_TOKEN_UNSET });
  });
});
