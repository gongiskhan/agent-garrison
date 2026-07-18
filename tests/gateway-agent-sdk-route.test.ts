import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

// The committed gate for routing a live channel turn to the agent-sdk runtime
// (non-Anthropic model via the Claude Agent SDK) through the orchestrator. Drives
// the REAL RoutedGateway with a stubbed claude-code pool (classifier + operative)
// and an injected fake AgentSdkAdapter — proving: the orchestrator classifies →
// resolves to the agent-sdk target → logs runtime/provider/model → executes the
// turn on the SDK adapter (NOT the PTY operative) → returns the model's reply.

class FakeSession {
  cfg: any;
  keys: string[] = [];
  disposed = false;
  constructor(cfg: any) {
    this.cfg = cfg;
  }
  async runTurn({ message }: { message: string }) {
    if (/routing classifier/i.test(message)) {
      // a trivial factual question → T0-trivial / other → role "fast"
      const trivial = /(2 plus 2|capital of|quick:)/i.test(message);
      return {
        reply: JSON.stringify({ taskType: "other", tier: trivial ? "T0-trivial" : "T1-standard", matchedException: null }),
        sessionId: "fake-classifier",
      };
    }
    return { reply: "claude operative reply\n[route: x | rule: y | profile: z]", sessionId: "fake-operative" };
  }
  writeKeys(b: string) {
    this.keys.push(b);
  }
  isAlive() {
    return !this.disposed;
  }
  isDisposed() {
    return this.disposed;
  }
  getClaudeSessionId() {
    return "fake";
  }
  status() {
    return { model: this.cfg?.model };
  }
  dispose() {
    this.disposed = true;
  }
}

class FakeAgentSdkAdapter {
  id = "agent-sdk";
  spawned: any[] = [];
  turns: string[] = [];
  response: any = { text: "The capital of France is Paris.", toolUses: [], stoppedReason: null };
  async spawn(cfg: any) {
    this.spawned.push(cfg);
    return { alive: true, harness: { promptMode: cfg.promptMode }, sessionId: "agent-sdk-sess", config: cfg };
  }
  async awaitReady() {}
  async sendTurn(_s: any, text: string) {
    this.turns.push(text);
  }
  async awaitResponse() {
    return this.response;
  }
  async setEffort(s: any, effort: string) {
    s.effort = effort;
    s.effortApplied = true;
  }
  async teardown(s: any) {
    s.alive = false;
  }
}

// Test-local routing config: a profile that routes the "fast" role at an agent-sdk
// ollama target and others at claude-code/anthropic. Written to the scoped path so
// the gateway loads it.
const CONFIG = {
  version: 1,
  activeProfile: "demo",
  roles: ["expert", "standard", "fast", "image", "video", "review"],
  taskTypes: ["code", "review", "research", "image", "video", "writing", "ops", "other"],
  tiers: ["T0-trivial", "T1-standard", "T2-deep"],
  matrix: {
    defaults: { role: "standard" },
    columns: { "T2-deep": "expert" },
    rows: { other: { default: "standard", cells: { "T0-trivial": "fast" } } },
  },
  exceptions: [],
  discipline: {},
  continuations: [],
  targets: [
    { id: "sdk-ollama-chat", type: "runtime-target", runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:0.6b", promptMode: "lean" },
    { id: "cc-sonnet-med", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "sonnet", effort: "medium" },
    { id: "cc-opus-high", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "high" },
    { id: "classifier", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku", effort: "low", pinned: true },
  ],
  profiles: {
    demo: {
      preRoute: "on",
      roleMap: { expert: "cc-opus-high", standard: "cc-sonnet-med", fast: "sdk-ollama-chat", image: "cc-sonnet-med", video: "cc-sonnet-med", review: "cc-sonnet-med" },
    },
  },
};

function readDecisions(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function bootGateway() {
  const tmp = mkdtempSync(join(tmpdir(), "gar-asroute-"));
  mkdirSync(join(tmp, ".garrison"), { recursive: true });
  writeFileSync(join(tmp, ".garrison", "routing.json"), JSON.stringify(CONFIG), "utf8");
  const decisionsFile = join(tmp, ".garrison", "decisions.jsonl");
  const agentSdk = new FakeAgentSdkAdapter();
  const gw = await createRoutedGateway({
    compositionDir: tmp,
    config: CONFIG,
    decisionsFile,
    spawnFn: (cfg: any) => Promise.resolve(new FakeSession(cfg)),
    agentSdkAdapter: agentSdk,
    logFn: () => {},
  });
  gw.injectSettleMs = 1;
  await gw.start();
  return { gw, tmp, decisionsFile, agentSdk };
}

describe("Orchestrator routes a channel turn to the agent-sdk runtime (sdk-route-live-ok)", () => {
  it("trivial message → fast role → agent-sdk/ollama target; logged with runtime+provider+model; executed on the SDK adapter", async () => {
    const { gw, decisionsFile, agentSdk } = await bootGateway();
    try {
      const msg = "quick: what is the capital of France?";
      const pre = await gw.preRoute(msg);

      // resolved to the agent-sdk target, NOT a claude-code one
      expect(pre.route.targetId).toBe("sdk-ollama-chat");
      expect(pre.route.target.runtime).toBe("agent-sdk");
      expect(pre.route.role).toBe("fast");
      expect(gw.isAgentSdkTarget(pre.route)).toBe(true);
      // it did NOT switch the PTY operative (agent-sdk runs on its own session)
      expect(pre.plan.path).toBe("agent-sdk");

      // the decision log shows the RUNTIME, provider and model
      const decisions = readDecisions(decisionsFile);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ targetId: "sdk-ollama-chat", runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:0.6b" });

      // the turn executes on the agent-sdk adapter and returns the model's reply
      const r = await gw.runAgentSdkTurn(pre.route, msg);
      expect(r.runtime).toBe("agent-sdk");
      expect(r.provider).toBe("ollama-local");
      expect(r.model).toBe("qwen3:0.6b");
      expect(r.reply).toContain("Paris");
      // the adapter was spawned with the target's provider/model/promptMode (lean)
      expect(agentSdk.spawned[0]).toMatchObject({ provider: "ollama-local", model: "qwen3:0.6b", promptMode: "lean" });
      // the PTY operative was never asked to switch provider for this turn
      expect(gw.getOperativeSession().keys.join("")).toBe("");
    } finally {
      gw.shutdown();
    }
  });

  it("a hard message → expert role → claude-code/anthropic target (the PTY operative), not agent-sdk", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      const pre = await gw.preRoute("design a fault-tolerant multi-region caching architecture with consistency guarantees");
      expect(pre.route.target.runtime).toBe("claude-code");
      expect(pre.route.target.provider).toBe("anthropic-plan");
      expect(gw.isAgentSdkTarget(pre.route)).toBe(false);
      const decisions = readDecisions(decisionsFile);
      expect(decisions[0]).toMatchObject({ runtime: "claude-code", provider: "anthropic-plan" });
    } finally {
      gw.shutdown();
    }
  });

  it("an Agent SDK target left at runtime defaults gets the full harness and 12 turns", async () => {
    const { gw, agentSdk } = await bootGateway();
    try {
      await gw.runAgentSdkTurn(
        {
          targetId: "sdk-default",
          target: {
            id: "sdk-default",
            type: "runtime-target",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-haiku-4-5",
          },
        },
        "inspect the project and make the bounded change",
      );

      expect(agentSdk.spawned[0]).toMatchObject({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        promptMode: "full",
        maxTurns: 12,
      });
    } finally {
      gw.shutdown();
    }
  });

  it("returns a max-turn stop with the exact executed route/model/effort evidence intact", async () => {
    const { gw, agentSdk } = await bootGateway();
    try {
      agentSdk.response = {
        text: "Plan and gate written.",
        toolUses: [{ id: "gate", name: "Write" }],
        stoppedReason: "max_turns"
      };
      const result = await gw.runAgentSdkTurn(
        {
          targetId: "sdk-sonnet-full",
          target: {
            id: "sdk-sonnet-full",
            type: "runtime-target",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            effort: "medium",
            promptMode: "full",
            maxTurns: 24
          }
        },
        "write the durable Plan gate"
      );

      expect(result).toMatchObject({
        reply: "Plan and gate written.",
        route: "sdk-sonnet-full",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "medium",
        effortApplied: true,
        stoppedReason: "max_turns"
      });
      expect(agentSdk.spawned[0]).toMatchObject({ maxTurns: 24, effort: "medium" });
    } finally {
      gw.shutdown();
    }
  });
});
