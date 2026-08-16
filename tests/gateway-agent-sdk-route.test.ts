import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
// @ts-ignore — pure .mjs routing layer
import { createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
import { writeGatewayV4ExecutionModel } from "./helpers/gateway-v4-fixture";

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
  turnHooks: any[] = [];
  eventsToEmit: any[] = [];
  response: any = { text: "The capital of France is Paris.", toolUses: [], stoppedReason: null };
  async spawn(cfg: any) {
    this.spawned.push(cfg);
    return { alive: true, harness: { promptMode: cfg.promptMode }, sessionId: "agent-sdk-sess", config: cfg };
  }
  async awaitReady() {}
  async sendTurn(_s: any, text: string, hooks: any = {}) {
    this.turns.push(text);
    this.turnHooks.push(hooks);
    for (const event of this.eventsToEmit) hooks.onEvent?.(event);
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

  it("forwards the structured event callback and stable turn id to the adapter unchanged", async () => {
    const { gw, agentSdk } = await bootGateway();
    try {
      const events = [
        { id: "evt-1", type: "block_delta", block: { type: "text", text: "first" } },
        { id: "evt-2", type: "tool_result", block: { type: "tool_result", toolUseId: "tool-1", content: "ok" } }
      ];
      const received: any[] = [];
      const onEvent = (event: any) => received.push(event);
      agentSdk.eventsToEmit = events;

      await gw.runAgentSdkTurn(
        {
          targetId: "sdk-events",
          target: {
            id: "sdk-events",
            type: "runtime-target",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-haiku-4-5"
          }
        },
        "emit two fixture events",
        undefined,
        { onEvent, turnId: "17" }
      );

      expect(agentSdk.turnHooks).toHaveLength(1);
      expect(agentSdk.turnHooks[0].onEvent).toBe(onEvent);
      expect(agentSdk.turnHooks[0].turnId).toBe("17");
      expect(received).toEqual(events);
      expect(received[0]).toBe(events[0]);
      expect(received[1]).toBe(events[1]);
    } finally {
      gw.shutdown();
    }
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForGateway(port: number, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`gateway exited ${child.exitCode}: ${stderr.join("")}`);
    let health: { pty_status?: string; error?: string } | null = null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      health = await response.json() as { pty_status?: string; error?: string };
    } catch {
      /* listener not ready */
    }
    if (health?.pty_status === "ready") return;
    if (health?.pty_status === "failed") throw new Error(health.error ?? "gateway failed to start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway did not become ready: ${stderr.join("")}`);
}

function parseSse(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split(/\n\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame && !frame.startsWith(":"))
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      return { event, data: JSON.parse(data) };
    });
}

describe("/chat/stream structured Agent SDK event forwarding", () => {
  it("emits opaque session_event payloads immediately and in callback order beside legacy frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-sdk-events-"));
    const agentSdkDir = join(dir, "agent-sdk-runtime");
    const runtimeStub = join(dir, "runtime-stub.mjs");
    const stderr: string[] = [];
    let child: ChildProcess | undefined;
    try {
      mkdirSync(join(dir, ".garrison"), { recursive: true });
      mkdirSync(join(agentSdkDir, "lib"), { recursive: true });
      const childConfig = {
        ...CONFIG,
        targets: [
          ...CONFIG.targets,
          { id: "cc-haiku-low", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku", effort: "low" },
          { id: "dispatch-fast", type: "runtime-target", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", pinned: true }
        ]
      };
      writeFileSync(join(dir, ".garrison", "routing.json"), JSON.stringify(childConfig), "utf8");
      const kanbanRoot = join(dir, "kanban-loop");
      writeGatewayV4ExecutionModel(dir, kanbanRoot);
      writeFileSync(
        runtimeStub,
        `class StubSession {
  constructor(config) { this.config = config; this.disposed = false; }
  async runTurn({ message }) {
    if (/routing classifier/i.test(String(message))) {
      return { reply: JSON.stringify({ taskType: "other", tier: "T0-trivial", matchedException: null }), sessionId: "classifier" };
    }
    return { reply: "operative unused", sessionId: "operative" };
  }
  writeKeys() {}
  isAlive() { return !this.disposed; }
  isDisposed() { return this.disposed; }
  getClaudeSessionId() { return "stub-session"; }
  status() { return { model: this.config?.model }; }
  dispose() { this.disposed = true; }
}
export async function spawnFn(config) { return new StubSession(config); }
`,
        "utf8"
      );
      writeFileSync(
        join(agentSdkDir, "lib", "agent-sdk-adapter.mjs"),
        `export class AgentSdkAdapter {
  async spawn(config) {
    return { alive: true, config, harness: { promptMode: config.promptMode }, sessionId: "sdk-stream-session" };
  }
  async awaitReady() {}
  async sendTurn(session, message, hooks = {}) {
    session.message = String(message ?? "");
    if (session.config.model === "claude-haiku-4-5") return;
    hooks.onEvent?.({ id: "evt-1", type: "block_delta", turnId: hooks.turnId, block: { type: "text", text: "alpha" }, nested: { keep: [1, "two", false] } });
    hooks.onText?.("legacy reply");
    hooks.onTool?.({ name: "Read", id: "tool-1" });
    hooks.onEvent?.({ id: "evt-2", type: "tool_result", turnId: hooks.turnId, block: { type: "tool_result", toolUseId: "tool-1", content: "ok" } });
  }
  async awaitResponse(session) {
    if (session.config.model === "claude-haiku-4-5") {
      return { text: JSON.stringify({ duty: "other", level: 1, confidence: "high", clarity: "clear", reason: "fixture" }), toolUses: [], stoppedReason: null };
    }
    return { text: "legacy reply", toolUses: [{ name: "Read", id: "tool-1" }], stoppedReason: null };
  }
  async teardown(session) { session.alive = false; }
  async cancel() { return true; }
}
`,
        "utf8"
      );

      const port = await freePort();
      child = spawn(process.execPath, [join(process.cwd(), "fittings/seed/http-gateway/scripts/gateway-pty.mjs")], {
        env: {
          ...process.env,
          GARRISON_GATEWAY_HOST: "127.0.0.1",
          GARRISON_GATEWAY_PORT: String(port),
          GARRISON_COMPOSITION_DIR: dir,
          GARRISON_HOME: dir,
          GARRISON_KANBAN_DIR: kanbanRoot,
          GARRISON_AGENT_SDK_DIR: agentSdkDir,
          GARRISON_GATEWAY_RUNTIME_STUB: runtimeStub,
          GARRISON_GATEWAY_NO_LISTEN: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout?.resume();
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      await waitForGateway(port, child, stderr);

      const response = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: name the capital of France",
          channel: "web",
          thread: "thread-events",
          turnSeq: 17,
          routing: { target: "sdk-ollama-chat" }
        })
      });
      expect(response.status).toBe(200);
      const frames = parseSse(await response.text());
      const sessionEvents = frames.filter((frame) => frame.event === "session_event");
      expect(sessionEvents.map((frame) => frame.data)).toEqual([
        { id: "evt-1", type: "block_delta", turnId: "17", block: { type: "text", text: "alpha" }, nested: { keep: [1, "two", false] } },
        { id: "evt-2", type: "tool_result", turnId: "17", block: { type: "tool_result", toolUseId: "tool-1", content: "ok" } }
      ]);

      const firstEvent = frames.findIndex((frame) => frame.event === "session_event" && frame.data.id === "evt-1");
      const chunk = frames.findIndex((frame) => frame.event === "chunk");
      const activity = frames.findIndex((frame) => frame.event === "activity");
      const secondEvent = frames.findIndex((frame) => frame.event === "session_event" && frame.data.id === "evt-2");
      const done = frames.findIndex((frame) => frame.event === "done");
      expect(firstEvent).toBeGreaterThan(-1);
      expect(firstEvent).toBeLessThan(chunk);
      expect(chunk).toBeLessThan(activity);
      expect(activity).toBeLessThan(secondEvent);
      expect(secondEvent).toBeLessThan(done);
      expect(frames[chunk].data).toMatchObject({ text: "legacy reply", replace: true });
      expect(frames[activity].data).toMatchObject({ kind: "tool", name: "Read", id: "tool-1" });
      expect(frames[done].data).toMatchObject({ reply: "legacy reply", runtime: "agent-sdk" });
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
