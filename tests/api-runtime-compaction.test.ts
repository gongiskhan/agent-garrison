import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore — pure .mjs
import { OpenAiAgentsAdapter } from "../fittings/seed/openai-agents-runtime/lib/openai-adapter.mjs";

// S1b (D3/D6) — the API-loop runtimes' summarize-and-rebuild compaction: OFF by
// default, and when enabled it summarizes at the loop boundary, resets its own
// session/context, seeds the next turn with the summary, and resets usedTokens.

function gen(messages: any[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

// A turn whose result reports `tokens` output tokens (drives usedTokens).
function agentTurn(tokens: number, text = "ok") {
  return [
    { type: "assistant", message: { content: [{ type: "text", text }] } },
    { type: "result", usage: { output_tokens: tokens, input_tokens: 0 } },
  ];
}

describe("agent-sdk summarize-and-rebuild", () => {
  it("does NOT rebuild when compaction is disabled, even far over threshold", async () => {
    const adapter = new AgentSdkAdapter({ createClient: async () => gen(agentTurn(500)) });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", compactContextWindow: 100, compactThresholdPct: 60, sessionId: "keep" });
    await adapter.sendTurn(s, "hi");
    const r = await adapter.awaitResponse(s);
    expect(s.rebuilds).toBe(0);
    expect(s.sessionId).toBe("keep");
    expect(s.usedTokens).toBe(500);
    expect(r.usedTokens).toBe(500); // S1a field preserved
  });

  it("rebuilds when enabled and over threshold: resets sessionId + usedTokens and seeds the next turn", async () => {
    const prompts: string[] = [];
    const adapter = new AgentSdkAdapter({
      createClient: async ({ prompt }: any) => {
        prompts.push(prompt);
        return gen(agentTurn(70));
      },
      summarize: async () => "SUMMARY-TEXT",
    });
    const s = await adapter.spawn({
      provider: "ollama-local",
      model: "m",
      compositionDir: "/tmp",
      compactEnabled: true,
      compactContextWindow: 100,
      compactThresholdPct: 60,
      sessionId: "resume-1",
    });
    await adapter.sendTurn(s, "first turn");
    const r1 = await adapter.awaitResponse(s);
    expect(s.rebuilds).toBe(1);
    expect(s.sessionId).toBeNull();
    expect(s.usedTokens).toBe(0);
    expect(r1.usedTokens).toBe(0);

    await adapter.sendTurn(s, "second turn");
    await adapter.awaitResponse(s);
    const last = prompts[prompts.length - 1];
    expect(last).toContain("SUMMARY-TEXT");
    expect(last).toContain("second turn");
    expect(prompts[0]).toBe("first turn"); // the first turn had no seed
  });

  it("falls back to the focus text as the seed when the summary call throws (never throws out)", async () => {
    const prompts: string[] = [];
    const adapter = new AgentSdkAdapter({
      createClient: async ({ prompt }: any) => {
        prompts.push(prompt);
        return gen(agentTurn(70));
      },
      summarize: async () => {
        throw new Error("summary boom");
      },
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", compactEnabled: true, compactContextWindow: 100, compactThresholdPct: 60 });
    await adapter.sendTurn(s, "first");
    await expect(adapter.awaitResponse(s)).resolves.toBeTruthy(); // no throw
    expect(s.rebuilds).toBe(1);
    await adapter.sendTurn(s, "second");
    await adapter.awaitResponse(s);
    const last = prompts[prompts.length - 1];
    // The generic focus-template variant (empty context) is the seed.
    expect(last).toContain("Compaction focus");
    expect(last).toContain("second");
    expect(last).not.toContain("Active card:"); // card lines dropped for empty context
  });
});

describe("openai-agents summarize-and-rebuild", () => {
  it("does NOT rebuild when disabled", async () => {
    const adapter = new OpenAiAgentsAdapter({ runAgent: async () => ({ finalOutput: "ok", newItems: [], history: [{}], usedTokens: 500 }) });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", compactContextWindow: 100, compactThresholdPct: 60 });
    await adapter.sendTurn(s, "hi");
    const r = await adapter.awaitResponse(s);
    expect(s.rebuilds).toBe(0);
    expect(s.thread).toEqual([{}]);
    expect(r.usedTokens).toBe(500);
  });

  it("rebuilds when enabled and over threshold: resets thread + usedTokens and seeds the next turn", async () => {
    const inputs: string[] = [];
    const adapter = new OpenAiAgentsAdapter({
      runAgent: async (params: any) => {
        inputs.push(params.input);
        return { finalOutput: "ok", newItems: [], history: [{ role: "assistant" }], usedTokens: 70 };
      },
      summarize: async () => "SUMMARY-TEXT",
    });
    const s = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp", compactEnabled: true, compactContextWindow: 100, compactThresholdPct: 60 });
    await adapter.sendTurn(s, "first turn");
    const r1 = await adapter.awaitResponse(s);
    expect(s.rebuilds).toBe(1);
    expect(s.thread).toBeNull();
    expect(s.usedTokens).toBe(0);
    expect(r1.usedTokens).toBe(0);

    await adapter.sendTurn(s, "second turn");
    await adapter.awaitResponse(s);
    const last = inputs[inputs.length - 1];
    expect(last).toContain("SUMMARY-TEXT");
    expect(last).toContain("second turn");
    expect(inputs[0]).toBe("first turn");
  });
});
