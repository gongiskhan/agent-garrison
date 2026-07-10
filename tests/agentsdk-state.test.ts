import { describe, it, expect } from "vitest";
import { getAgentSdkState } from "../src/lib/agentsdk-state";

describe("Quarters-AgentSDK state (sdk-quarters-ok)", () => {
  const state = getAgentSdkState();

  it("renders the six-provider table with capability records (incl. the Anthropic subscription)", () => {
    expect(state.providers.map((p) => p.id).sort()).toEqual(["anthropic", "deepseek", "llm-proxy", "minimax", "ollama-local", "zai-glm"]);
    const ds = state.providers.find((p) => p.id === "deepseek")!;
    expect(ds.capabilities).toMatchObject({ text: true, toolUse: true, mcp: false, image: false });
    expect(ds.vaultKey).toBe("DEEPSEEK_API_KEY");
    const ollama = state.providers.find((p) => p.id === "ollama-local")!;
    expect(ollama.capabilities.mcp).toBe(true);
    expect(ollama.needsKey).toBe(false);
  });

  it("surfaces each provider's auth mode (subscription / api-key / local)", () => {
    const byId = Object.fromEntries(state.providers.map((p) => [p.id, p]));
    expect(byId["anthropic"].authMode).toBe("subscription");
    expect(byId["anthropic"].baseUrl).toBe(null); // Anthropic default endpoint, no override
    expect(byId["anthropic"].needsKey).toBe(false);
    expect(byId["ollama-local"].authMode).toBe("local");
    expect(byId["deepseek"].authMode).toBe("api-key");
    expect(byId["zai-glm"].authMode).toBe("api-key");
    expect(byId["llm-proxy"].authMode).toBe("api-key");
  });

  it("shows THE HARNESS state for full vs lean", () => {
    expect(state.harness.full).toMatchObject({ preset: "claude_code", claudeMdLoaded: true, skillsMounted: true, loadsUserSettings: false });
    expect(state.harness.full.settingSources).toEqual(["project"]);
    expect(state.harness.lean).toMatchObject({ preset: null, claudeMdLoaded: false, skillsMounted: false });
    expect(state.harness.lean.settingSources).toEqual([]);
  });

  it("notes runtime freedom (D29) — no fence, Anthropic first-class", () => {
    expect(state).not.toHaveProperty("fence");
    expect(state.note).toMatch(/first-class/i);
  });

  it("surfaces the version pins (SDK + LiteLLM supply-chain)", () => {
    expect(state.sdkPin).toContain("0.3.179");
    expect(state.litellmPin.forbidden).toEqual(["1.82.7", "1.82.8"]);
    expect(state.litellmPin.max).toBe("1.82.6");
  });
});
