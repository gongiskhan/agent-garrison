import { describe, it, expect } from "vitest";
import { getAgentSdkState } from "../src/lib/agentsdk-state";

describe("Quarters-AgentSDK state (sdk-quarters-ok)", () => {
  const state = getAgentSdkState();

  it("renders the 5-provider table with capability records", () => {
    expect(state.providers.map((p) => p.id).sort()).toEqual(["deepseek", "llm-proxy", "minimax", "ollama-local", "zai-glm"]);
    const ds = state.providers.find((p) => p.id === "deepseek")!;
    expect(ds.capabilities).toMatchObject({ text: true, toolUse: true, mcp: false, image: false });
    expect(ds.vaultKey).toBe("DEEPSEEK_API_KEY");
    const ollama = state.providers.find((p) => p.id === "ollama-local")!;
    expect(ollama.capabilities.mcp).toBe(true);
    expect(ollama.needsKey).toBe(false);
  });

  it("every provider's resolved base URL is non-Anthropic (fence not blocked)", () => {
    expect(state.providers.every((p) => p.blocked === false)).toBe(true);
  });

  it("shows THE HARNESS state for full vs lean", () => {
    expect(state.harness.full).toMatchObject({ preset: "claude_code", claudeMdLoaded: true, skillsMounted: true, loadsUserSettings: false });
    expect(state.harness.full.settingSources).toEqual(["project"]);
    expect(state.harness.lean).toMatchObject({ preset: null, claudeMdLoaded: false, skillsMounted: false });
    expect(state.harness.lean.settingSources).toEqual([]);
  });

  it("shows THE FENCE state — default-deny verdicts computed by the real fence", () => {
    const byLabel = Object.fromEntries(state.fence.demos.map((d) => [d.label, d]));
    expect(state.fence.demos.find((d) => /no base URL/.test(d.label))!.blocked).toBe(true);
    expect(state.fence.demos.find((d) => /non-Anthropic base URL/.test(d.label))!.blocked).toBe(false);
    expect(state.fence.demos.find((d) => /no acceptApiBilling/.test(d.label))!.blocked).toBe(true);
    expect(state.fence.demos.find((d) => /WITH acceptApiBilling/.test(d.label))!.blocked).toBe(false);
    expect(state.fence.demos.find((d) => /#217/.test(d.label))!.blocked).toBe(true);
    expect(byLabel).toBeTruthy();
    expect(state.fence.defaultDeny).toBe(true);
  });

  it("surfaces the version pins (SDK + LiteLLM supply-chain)", () => {
    expect(state.sdkPin).toContain("0.3.179");
    expect(state.litellmPin.forbidden).toEqual(["1.82.7", "1.82.8"]);
    expect(state.litellmPin.max).toBe("1.82.6");
  });
});
