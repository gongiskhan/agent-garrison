import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIMARY_RUNTIME,
  resolvePrimaryRuntime,
  buildPrimaryRuntimeEnv,
  deriveRuntimeTargets,
  mergeRuntimeTargets,
  type RuntimeEntry,
  type PolicyProvider
} from "@/lib/runtime-selection";
// @ts-ignore — pure .mjs (policy heart): providers are policy data (P2)
import { SEED_PROVIDERS } from "../fittings/seed/orchestrator/lib/policy-core.mjs";

const POLICY_PROVIDERS: PolicyProvider[] = SEED_PROVIDERS;
const providerById = (id: string) => POLICY_PROVIDERS.find((p) => p.id === id)!;

const ccRuntime: RuntimeEntry = {
  id: "claude-code-runtime",
  provides: [{ kind: "runtime", name: "claude-code" }],
  config: {}
};
const sdkRuntime: RuntimeEntry = {
  id: "agent-sdk-runtime",
  provides: [{ kind: "runtime", name: "agent-sdk" }],
  config: {}
};

describe("resolvePrimaryRuntime (S2)", () => {
  it("defaults to the Claude Code runtime when primary_runtime is unset, even with no composed runtimes", () => {
    const d = resolvePrimaryRuntime({ primaryRuntimeId: undefined, runtimeEntries: [] });
    expect(d.runtimeId).toBe(DEFAULT_PRIMARY_RUNTIME);
    expect(d.engine).toBe("claude-code");
    expect(d.isDefault).toBe(true);
    expect(d.config).toEqual({});
  });

  it("treats an empty/whitespace primary_runtime as the default", () => {
    const d = resolvePrimaryRuntime({ primaryRuntimeId: "   ", runtimeEntries: [ccRuntime] });
    expect(d.runtimeId).toBe(DEFAULT_PRIMARY_RUNTIME);
    expect(d.engine).toBe("claude-code");
  });

  it("derives the engine from the composed runtime's provides (agent-sdk as primary)", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "agent-sdk-runtime",
      runtimeEntries: [ccRuntime, sdkRuntime]
    });
    expect(d.runtimeId).toBe("agent-sdk-runtime");
    expect(d.engine).toBe("agent-sdk");
    expect(d.isDefault).toBe(false);
  });

  it("FAILS LOUD when the named primary runtime is not composed (never silently falls back)", () => {
    expect(() =>
      resolvePrimaryRuntime({ primaryRuntimeId: "agent-sdk-runtime", runtimeEntries: [ccRuntime] })
    ).toThrow(/not a composed Runtime-Faculty fitting/);
  });

  it("FAILS LOUD when the default runtime id is EXPLICITLY named but not composed (config not silently lost)", () => {
    // Unset → synthetic default is fine; but explicitly naming claude-code-runtime
    // while not composing it would silently drop its provider/model config.
    expect(() =>
      resolvePrimaryRuntime({ primaryRuntimeId: "claude-code-runtime", runtimeEntries: [] })
    ).toThrow(/not a composed Runtime-Faculty fitting/);
  });

  it("still synthesizes the implicit default when primary_runtime is unset and nothing is composed", () => {
    const d = resolvePrimaryRuntime({ primaryRuntimeId: undefined, runtimeEntries: [] });
    expect(d.isDefault).toBe(true);
    expect(d.engine).toBe("claude-code");
  });

  it("carries the primary fitting's selection config", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { model: "sonnet", provider: "ollama-local" } }]
    });
    expect(d.config).toEqual({ model: "sonnet", provider: "ollama-local" });
  });
});

describe("buildPrimaryRuntimeEnv (S2)", () => {
  const noSecrets = () => undefined;

  it("is behaviour-preserving for the default provider with no explicit model", () => {
    const d = resolvePrimaryRuntime({ primaryRuntimeId: undefined, runtimeEntries: [] });
    const { env, providerLaunch } = buildPrimaryRuntimeEnv(d, noSecrets, POLICY_PROVIDERS);
    expect(providerLaunch).toBe(false);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Does NOT clobber the existing GARRISON_MODEL default when no model is configured.
    expect(env.GARRISON_MODEL).toBeUndefined();
    expect(env.GARRISON_PRIMARY_RUNTIME).toBe("claude-code-runtime");
    expect(env.GARRISON_PRIMARY_ENGINE).toBe("claude-code");
  });

  it("overrides GARRISON_MODEL only when explicitly configured", () => {
    const d: ReturnType<typeof resolvePrimaryRuntime> = {
      runtimeId: "claude-code-runtime",
      engine: "claude-code",
      isDefault: true,
      config: { model: "sonnet" }
    };
    const { env } = buildPrimaryRuntimeEnv(d, noSecrets, POLICY_PROVIDERS);
    expect(env.GARRISON_MODEL).toBe("sonnet");
  });

  it("runs the Claude Code engine against ollama-local with a dummy token (no vault)", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "ollama-local" } }]
    });
    const { env, providerLaunch } = buildPrimaryRuntimeEnv(d, noSecrets, POLICY_PROVIDERS);
    expect(providerLaunch).toBe(true);
    expect(env.ANTHROPIC_BASE_URL).toBe(providerById("ollama-local").baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
    expect(env.GARRISON_PROVIDER).toBe("ollama-local");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("pulls the auth token from the vault for a cloud provider (deepseek)", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "deepseek" } }]
    });
    const { env, providerLaunch } = buildPrimaryRuntimeEnv(
      d,
      (k) => (k === "DEEPSEEK_API_KEY" ? "sk-deepseek-xyz" : undefined),
      POLICY_PROVIDERS
    );
    expect(providerLaunch).toBe(true);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-xyz");
  });

  it("FAILS LOUD when a cloud provider's vault key is missing or locked", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "zai-glm" } }]
    });
    expect(() => buildPrimaryRuntimeEnv(d, () => undefined, POLICY_PROVIDERS)).toThrow(/requires vault key ZAI_API_KEY/);
  });

  it("honors an explicit base_url override", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "ollama-local", base_url: "http://localhost:9999" } }]
    });
    const { env } = buildPrimaryRuntimeEnv(d, noSecrets, POLICY_PROVIDERS);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:9999");
  });

  it("throws on an unknown provider", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "made-up" } }]
    });
    expect(() => buildPrimaryRuntimeEnv(d, noSecrets, POLICY_PROVIDERS)).toThrow(/unknown provider "made-up"/);
  });
});

describe("deriveRuntimeTargets (S3)", () => {
  const codexRuntime: RuntimeEntry = { id: "codex-runtime", provides: [{ kind: "runtime", name: "codex" }] };
  const geminiRuntime: RuntimeEntry = { id: "gemini-runtime", provides: [{ kind: "runtime", name: "gemini" }] };

  it("derives a runtime-target for a claude-code runtime carrying its provider/model", () => {
    const [t] = deriveRuntimeTargets([{ ...ccRuntime, config: { provider: "ollama-local", model: "qwen2.5-coder" } }]);
    expect(t).toMatchObject({
      id: "fitted-claude-code-runtime",
      type: "runtime-target",
      runtime: "claude-code",
      provider: "ollama-local",
      model: "qwen2.5-coder",
      derivedFrom: "claude-code-runtime"
    });
  });

  it("defaults a claude-code target's provider/model when unconfigured", () => {
    const [t] = deriveRuntimeTargets([ccRuntime]);
    expect(t.provider).toBe("anthropic-plan");
    expect(t.model).toBe("opus");
  });

  it("derives secondary targets for non-claude-code engines (agent-sdk/codex/gemini)", () => {
    const targets = deriveRuntimeTargets([sdkRuntime, codexRuntime, geminiRuntime]);
    expect(targets.map((t) => [t.type, t.runtime])).toEqual([
      ["secondary", "agent-sdk"],
      ["secondary", "codex"],
      ["secondary", "gemini"]
    ]);
    expect(targets.every((t) => t.id.startsWith("fitted-"))).toBe(true);
  });

  it("returns nothing when no runtimes are composed", () => {
    expect(deriveRuntimeTargets([])).toEqual([]);
  });
});

describe("mergeRuntimeTargets (S3)", () => {
  it("appends derived targets, leaving the config a no-op when there are none", () => {
    const config = { targets: [{ id: "cc-opus-high", type: "runtime-target" as const, runtime: "claude-code" }] };
    expect(mergeRuntimeTargets(config, [])).toBe(config);
  });

  it("adds derived targets and dedupes by id (hand-seeded target wins)", () => {
    const seeded = { id: "fitted-claude-code-runtime", type: "runtime-target" as const, runtime: "claude-code", model: "sonnet" };
    const config = { targets: [seeded] };
    const derived = deriveRuntimeTargets([ccRuntime]); // also id "fitted-claude-code-runtime"
    const merged = mergeRuntimeTargets(config, derived);
    // The seeded target is preserved (model "sonnet"), not overwritten by the derived "opus".
    expect(merged.targets).toHaveLength(1);
    expect(merged.targets[0]).toBe(seeded);
  });

  it("appends a genuinely new derived target alongside seeds", () => {
    const config = { targets: [{ id: "cc-opus-high", type: "runtime-target" as const, runtime: "claude-code" }] };
    const merged = mergeRuntimeTargets(config, deriveRuntimeTargets([sdkRuntime]));
    expect(merged.targets.map((t) => t.id)).toEqual(["cc-opus-high", "fitted-agent-sdk-runtime"]);
  });
});

// Ratchet guards for the S2 codex findings: the loud paths must stay loud.
describe("buildPrimaryRuntimeEnv loud paths (S2 ratchet)", () => {
  it("throws on a missing providers section EVEN for the default anthropic-plan path", () => {
    const d = resolvePrimaryRuntime({ primaryRuntimeId: undefined, runtimeEntries: [ccRuntime] });
    expect(() => buildPrimaryRuntimeEnv(d, () => undefined, [] as PolicyProvider[])).toThrow(
      /no providers section supplied/
    );
  });

  it("a malformed non-plan provider with null baseUrl throws (never silently the plan path)", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "broken-cloud" } }]
    });
    const providers: PolicyProvider[] = [{ id: "broken-cloud", kind: "cloud-oss", baseUrl: null }];
    expect(() => buildPrimaryRuntimeEnv(d, () => undefined, providers)).toThrow(/requires a base URL/);
  });

  it("an explicit base_url override rescues a configurable entry", () => {
    const d = resolvePrimaryRuntime({
      primaryRuntimeId: "claude-code-runtime",
      runtimeEntries: [{ ...ccRuntime, config: { provider: "broken-cloud", base_url: "http://proxy:4000" } }]
    });
    const providers: PolicyProvider[] = [{ id: "broken-cloud", kind: "cloud-oss", baseUrl: null, dummyToken: "t" }];
    const { env, providerLaunch } = buildPrimaryRuntimeEnv(d, () => undefined, providers);
    expect(providerLaunch).toBe(true);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy:4000");
  });
});
