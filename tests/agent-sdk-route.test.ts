import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { resolveRoute } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// @ts-ignore
import { assertRouteCapability, capabilityRecord, CapabilityError } from "../fittings/seed/agent-sdk-runtime/lib/providers.mjs";

// A test-local routing config that points roles at agent-sdk targets — proves the
// resolver (which is provider-agnostic) routes to an agent-sdk runtime-target, and
// the orchestrator capability gate refuses an unsupported block. Kept test-local so
// the shipped routing.seed.json + its byte-stable compile tests are untouched.
// Typed `any` — a deliberately minimal test-local routing fixture (not the full
// RoutingConfig shape); resolveRoute only reads matrix/profiles/targets here.
const CONFIG: any = {
  version: 1,
  activeProfile: "balanced",
  roles: ["expert", "standard", "fast", "image", "video", "review"],
  matrix: {
    defaults: { role: "standard" },
    columns: { "T2-deep": "expert" },
    rows: { code: { default: "standard", cells: { "T0-trivial": "fast", "T2-deep": "expert" } } }
  },
  targets: [
    { id: "sdk-ollama-std", type: "runtime-target", runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:8b", promptMode: "full" },
    { id: "sdk-ollama-fast", type: "runtime-target", runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:0.6b", promptMode: "lean" },
    {
      id: "sdk-deepseek",
      type: "runtime-target",
      runtime: "agent-sdk",
      provider: "deepseek",
      model: "deepseek-chat",
      promptMode: "full",
      capabilities: { text: true, toolUse: true, image: false, document: false, webSearch: false, mcp: false }
    },
    { id: "cc-opus", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus" }
  ],
  profiles: {
    balanced: { roleMap: { expert: "cc-opus", standard: "cc-opus", fast: "cc-opus", image: "cc-opus", video: "cc-opus", review: "cc-opus" } },
    "sdk-economy": {
      roleMap: { expert: "sdk-ollama-std", standard: "sdk-ollama-std", fast: "sdk-ollama-fast", image: "sdk-ollama-std", video: "sdk-ollama-std", review: "sdk-ollama-std" }
    }
  }
};

describe("Orchestrator routing to agent-sdk + capability gating (sdk-route-live-ok: resolution + gating)", () => {
  it("a Profile roleMap pointing a role at {agent-sdk, ollama-local} resolves to the agent-sdk target", () => {
    const r = resolveRoute(CONFIG, "sdk-economy", { taskType: "code", tier: "T1-standard" });
    expect(r.role).toBe("standard");
    expect(r.targetId).toBe("sdk-ollama-std");
    expect(r.target).toMatchObject({ runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:8b", promptMode: "full" });
  });

  it("promptMode rides the target — a lean (fast/classification) role resolves to a lean agent-sdk target", () => {
    const r = resolveRoute(CONFIG, "sdk-economy", { taskType: "code", tier: "T0-trivial" });
    expect(r.role).toBe("fast");
    expect(r.target).toMatchObject({ runtime: "agent-sdk", provider: "ollama-local", promptMode: "lean" });
  });

  it("a capability-incompatible route (MCP role @ deepseek) is REFUSED", () => {
    const deepseek = CONFIG.targets.find((t: any) => t.id === "sdk-deepseek");
    expect(capabilityRecord(deepseek!)).toMatchObject({ mcp: false, image: false });
    expect(() => assertRouteCapability(deepseek, ["mcp"])).toThrow(CapabilityError);
    expect(() => assertRouteCapability(deepseek, ["image"])).toThrow(/does not serve/i);
  });

  it("an mcp-capable agent-sdk target passes; non-agent-sdk targets are not gated by this record", () => {
    const ollama = CONFIG.targets.find((t: any) => t.id === "sdk-ollama-std");
    const cc = CONFIG.targets.find((t: any) => t.id === "cc-opus");
    expect(assertRouteCapability(ollama, ["mcp", "tool_use"])!.mcp).toBe(true);
    expect(assertRouteCapability(cc, ["mcp"])).toBe(null); // claude-code carries no agent-sdk capability record
  });

  it("REDIRECT: given a required MCP block, the orchestrator skips deepseek and picks the capable target", () => {
    const candidates = CONFIG.targets.filter((t: any) => t.runtime === "agent-sdk");
    const required = ["mcp"];
    const capable = candidates.find((t: any) => {
      try {
        assertRouteCapability(t, required);
        return true;
      } catch {
        return false;
      }
    });
    expect(capable!.provider).toBe("ollama-local"); // deepseek (no MCP) is skipped, ollama is chosen
  });
});
