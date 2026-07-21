import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs, no .d.mts (internal stage-b module)
import { planSwitch, buildLaunchEnv, buildRespawnOpts, MissingProviderKeyError } from "../fittings/seed/orchestrator/lib/stage-b.mjs";
// @ts-ignore — pure .mjs (policy heart)
import { SEED_PROVIDERS, validateProviders, compilePolicy } from "../fittings/seed/orchestrator/lib/policy-core.mjs";

// P2: providers are policy data — every launch-env call supplies the policy's
// providers section (the migration-seeded list here).
const PROVIDERS_LIST = SEED_PROVIDERS;
const providerById = (id: string) => PROVIDERS_LIST.find((p: any) => p.id === id)!;

const opus = { id: "cc-opus-high", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "high" };
const haiku = { id: "cc-haiku-low", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku", effort: "low" };
const ollama = { id: "cc-ollama-qwen", type: "runtime-target", runtime: "claude-code", provider: "ollama-local", model: "qwen2.5-coder", effort: "medium" };
const deepseek = { id: "cc-deepseek", type: "runtime-target", runtime: "claude-code", provider: "deepseek", model: "deepseek-chat", effort: "medium" };
const opusSoulB = { ...opus, soul: "architect" };

describe("Stage B switch planning (MR1d — model-switch-ok path)", () => {
  it("same provider+soul, different model/effort → slash-inject (verdict works)", () => {
    const p = planSwitch(opus, haiku);
    expect(p.path).toBe("slash-inject");
    expect(p.injections).toEqual(["/model haiku", "/effort low"]);
  });

  it("identical target → noop", () => {
    expect(planSwitch(opus, { ...opus }).path).toBe("noop");
  });

  it("no live session → respawn-resume (cold spawn of target)", () => {
    expect(planSwitch(null, haiku).path).toBe("respawn-resume");
  });

  it("provider change → respawn-resume (launch-fixed)", () => {
    const p = planSwitch(opus, ollama);
    expect(p.path).toBe("respawn-resume");
    expect(p.reasons.join(" ")).toContain("provider anthropic-plan→ollama-local");
  });

  it("soul change → respawn-resume (launch-fixed)", () => {
    const p = planSwitch(opus, opusSoulB);
    expect(p.path).toBe("respawn-resume");
    expect(p.reasons.join(" ")).toContain("soul");
  });

  it("fallback mode (slash-inject does NOT work) → model/effort change respawns", () => {
    const p = planSwitch(opus, haiku, { slashInjectWorks: false });
    expect(p.path).toBe("respawn-resume");
    expect(p.reasons.join(" ")).toContain("respawn-fallback");
  });
});

describe("Stage B launch env (MR1d — provider-launch-ok)", () => {
  it("anthropic-plan: NO base URL, NO key, strips ANTHROPIC_API_KEY (Max billing safety)", () => {
    const env = buildLaunchEnv(opus, { baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-leak" }, secrets: {}, providers: PROVIDERS_LIST });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // never bills against the API key
    expect(env.PATH).toBe("/bin");
  });

  it("ollama-local: base URL wired + dummy auth token, no vault key needed", () => {
    const env = buildLaunchEnv(ollama, { baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST });
    expect(env.ANTHROPIC_BASE_URL).toBe(providerById("ollama-local").baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
  });

  it("cloud OSS (deepseek): base URL + vault key wired as ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildLaunchEnv(deepseek, { baseEnv: {}, secrets: { DEEPSEEK_API_KEY: "sk-deepseek-xyz" }, providers: PROVIDERS_LIST });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-xyz");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("cloud OSS with ABSENT key → loud MissingProviderKeyError (secret absent)", () => {
    expect(() => buildLaunchEnv(deepseek, { baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST })).toThrowError(MissingProviderKeyError);
    try {
      buildLaunchEnv(deepseek, { baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST });
    } catch (e: any) {
      expect(e.vaultLocked).toBe(false);
      expect(e.message).toContain("ABSENT");
    }
  });

  it("cloud OSS with LOCKED vault → loud MissingProviderKeyError (distinguishes locked)", () => {
    try {
      buildLaunchEnv(deepseek, { baseEnv: {}, secrets: null, providers: PROVIDERS_LIST });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(MissingProviderKeyError);
      expect(e.vaultLocked).toBe(true);
      expect(e.message).toContain("LOCKED");
    }
  });

  it("buildRespawnOpts uses --continue + the target model + the provider env", () => {
    const opts = buildRespawnOpts(ollama, { compositionDir: "/tmp/x", appendSystemPromptFile: "/tmp/x/.garrison/assembled-system-prompt.md", baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST });
    expect(opts.continueSession).toBe(true);
    expect(opts.model).toBe("qwen2.5-coder");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe(providerById("ollama-local").baseUrl);
  });
});

// P2 — providers as policy data: the loud paths and the policy pass-through.
describe("providers as policy data (P2)", () => {
  it("no providers section supplied → loud error naming the fix (never a silent fallback)", () => {
    expect(() => buildLaunchEnv(opus, { baseEnv: {}, secrets: {} })).toThrowError(/no providers section supplied/);
  });

  it("unknown provider id → loud error listing the known ids", () => {
    expect(() =>
      buildLaunchEnv({ ...opus, provider: "nope" }, { baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST })
    ).toThrowError(/unknown provider "nope".*anthropic-plan/);
  });

  it("migration seeds resolve byte-identically to the historical registry", () => {
    // anthropic-plan: empty env delta; ollama: base URL + dummy token;
    // deepseek/zai: base URL + vault key as AUTH_TOKEN. (The fifth id,
    // "anthropic", is the agent-sdk spelling of the Max OAuth path.)
    expect(PROVIDERS_LIST.map((p: any) => p.id)).toEqual([
      "anthropic-plan", "anthropic", "ollama-local", "deepseek", "zai-glm"
    ]);
    const zai = buildLaunchEnv({ provider: "zai-glm" } as any, { baseEnv: {}, secrets: { ZAI_API_KEY: "zk" }, providers: PROVIDERS_LIST });
    expect(zai.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(zai.ANTHROPIC_AUTH_TOKEN).toBe("zk");
  });

  it("validateProviders rejects duplicates, bad kinds, and null baseUrl on non-plan kinds", () => {
    expect(validateProviders([{ id: "x", kind: "cloud-oss", baseUrl: null }]).join(" ")).toMatch(/baseUrl is required/);
    expect(validateProviders([{ id: "x", kind: "weird", baseUrl: "http://h" }]).join(" ")).toMatch(/unknown kind/);
    expect(
      validateProviders([
        { id: "x", kind: "local", baseUrl: "http://h" },
        { id: "x", kind: "local", baseUrl: "http://h" }
      ]).join(" ")
    ).toMatch(/duplicate id/);
  });

  it("compilePolicy carries providers into the compiled policy and rejects targets on unknown providers", () => {
    const base: any = {
      version: 2,
      activeProfile: "p",
      profiles: { p: { matrix: { defaults: {}, columns: {}, rows: {} } } },
      targets: [{ id: "t1", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus" }]
    };
    const pol = compilePolicy(base);
    expect(pol.providers.map((p: any) => p.id)).toContain("deepseek");
    const bad = { ...base, providers: SEED_PROVIDERS, targets: [{ id: "t2", type: "runtime-target", runtime: "claude-code", provider: "ghost", model: "opus" }] };
    expect(() => compilePolicy(bad)).toThrowError(/unknown provider "ghost"/);
  });
});

// Ratchet for the S2 fresh-review finding: the stage-b resolver must never
// infer the Max-OAuth plan path from a kindless null-baseUrl entry (symmetry
// with the buildPrimaryRuntimeEnv hardening in 7e19e34).
describe("resolveProviderSpec malformed-entry loudness (S2 ratchet)", () => {
  it("kindless null-baseUrl provider throws instead of masquerading as the plan path", () => {
    const providers = [{ id: "mystery" }] as any[];
    expect(() =>
      buildLaunchEnv({ provider: "mystery" } as any, { baseEnv: {}, secrets: {}, providers })
    ).toThrowError(/provider "mystery" is malformed: no kind and no baseUrl/);
  });

  it("an explicit anthropic-plan kind with null baseUrl remains the clean plan path", () => {
    const providers = [{ id: "my-plan", kind: "anthropic-plan", baseUrl: null }] as any[];
    const env = buildLaunchEnv({ provider: "my-plan" } as any, { baseEnv: { ANTHROPIC_API_KEY: "x" }, secrets: {}, providers });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ── RUNTIME-ACCOUNTS-V1: account pin on routed plan targets ──────────────────
describe("buildLaunchEnv account pin (RUNTIME-ACCOUNTS-V1)", () => {
  const TOKEN = "sk-ant-oat01-test-token-work1";
  const opusWork1 = { ...opus, account: "work1" };

  it("plan target with account → token vars from ANTHROPIC_ACCOUNT__<name>, API key masked", () => {
    const env = buildLaunchEnv(opusWork1 as any, {
      baseEnv: { PATH: "/bin" },
      secrets: { ANTHROPIC_ACCOUNT__work1: TOKEN },
      providers: PROVIDERS_LIST
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.GARRISON_ACCOUNT).toBe("work1");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("named account with no vault token throws MissingProviderKeyError (locked and absent)", () => {
    expect(() =>
      buildLaunchEnv(opusWork1 as any, { baseEnv: {}, secrets: {}, providers: PROVIDERS_LIST })
    ).toThrowError(MissingProviderKeyError);
    expect(() =>
      buildLaunchEnv(opusWork1 as any, { baseEnv: {}, secrets: null, providers: PROVIDERS_LIST })
    ).toThrowError(MissingProviderKeyError);
  });

  it("plan target WITHOUT account inherits the launching session's pin (soul-switch respawn keeps the account)", () => {
    const env = buildLaunchEnv(opus as any, {
      baseEnv: { GARRISON_ACCOUNT: "work1", ANTHROPIC_AUTH_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      secrets: {},
      providers: PROVIDERS_LIST
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.GARRISON_ACCOUNT).toBe("work1");
  });

  it("a third-party target never inherits an account pin (no cross-account leak)", () => {
    const env = buildLaunchEnv(deepseek as any, {
      baseEnv: { GARRISON_ACCOUNT: "work1", ANTHROPIC_AUTH_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      secrets: { DEEPSEEK_API_KEY: "sk-deepseek-xyz" },
      providers: PROVIDERS_LIST
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-xyz");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GARRISON_ACCOUNT).toBeUndefined();
  });

  it("plan target with NO account and NO inherited pin stays the clean ambient-login path", () => {
    const env = buildLaunchEnv(opus as any, {
      baseEnv: { ANTHROPIC_AUTH_TOKEN: "stray-token-without-account-marker" },
      secrets: {},
      providers: PROVIDERS_LIST
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GARRISON_ACCOUNT).toBeUndefined();
  });
});
