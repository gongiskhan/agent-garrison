import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs, no .d.mts (internal stage-b module)
import { planSwitch, buildLaunchEnv, buildRespawnOpts, MissingProviderKeyError, PROVIDERS } from "../fittings/seed/orchestrator/lib/stage-b.mjs";

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
    const env = buildLaunchEnv(opus, { baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-leak" }, secrets: {} });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // never bills against the API key
    expect(env.PATH).toBe("/bin");
  });

  it("ollama-local: base URL wired + dummy auth token, no vault key needed", () => {
    const env = buildLaunchEnv(ollama, { baseEnv: {}, secrets: {} });
    expect(env.ANTHROPIC_BASE_URL).toBe(PROVIDERS["ollama-local"].baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
  });

  it("cloud OSS (deepseek): base URL + vault key wired as ANTHROPIC_AUTH_TOKEN", () => {
    const env = buildLaunchEnv(deepseek, { baseEnv: {}, secrets: { DEEPSEEK_API_KEY: "sk-deepseek-xyz" } });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-xyz");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("cloud OSS with ABSENT key → loud MissingProviderKeyError (secret absent)", () => {
    expect(() => buildLaunchEnv(deepseek, { baseEnv: {}, secrets: {} })).toThrowError(MissingProviderKeyError);
    try {
      buildLaunchEnv(deepseek, { baseEnv: {}, secrets: {} });
    } catch (e: any) {
      expect(e.vaultLocked).toBe(false);
      expect(e.message).toContain("ABSENT");
    }
  });

  it("cloud OSS with LOCKED vault → loud MissingProviderKeyError (distinguishes locked)", () => {
    try {
      buildLaunchEnv(deepseek, { baseEnv: {}, secrets: null });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(MissingProviderKeyError);
      expect(e.vaultLocked).toBe(true);
      expect(e.message).toContain("LOCKED");
    }
  });

  it("buildRespawnOpts uses --continue + the target model + the provider env", () => {
    const opts = buildRespawnOpts(ollama, { compositionDir: "/tmp/x", appendSystemPromptFile: "/tmp/x/.garrison/assembled-system-prompt.md", baseEnv: {}, secrets: {} });
    expect(opts.continueSession).toBe(true);
    expect(opts.model).toBe("qwen2.5-coder");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe(PROVIDERS["ollama-local"].baseUrl);
  });
});
