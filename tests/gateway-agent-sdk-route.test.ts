import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
// @ts-ignore — pure .mjs routing layer
import { AGENT_SDK_SESSION_CAP, createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
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
  teardowns: any[] = [];
  cancels: any[] = [];
  response: any = { text: "The capital of France is Paris.", toolUses: [], stoppedReason: null };
  async spawn(cfg: any) {
    this.spawned.push(cfg);
    return {
      id: `sdk-session-${this.spawned.length}`,
      alive: true,
      streamingInput: cfg.streamingInput === true,
      harness: { promptMode: cfg.promptMode },
      sessionId: "agent-sdk-sess",
      config: cfg,
    };
  }
  async awaitReady() {}
  /** Accumulated reply text this adapter streams through onText, as the real one
   *  does while the turn runs (before its canonical terminal event). */
  textToStream: string | null = null;
  async sendTurn(_s: any, text: string, hooks: any = {}) {
    this.turns.push(text);
    this.turnHooks.push(hooks);
    if (this.textToStream) hooks.onText?.(this.textToStream);
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
    this.teardowns.push(s);
    s.alive = false;
  }
  async cancel(s: any) {
    this.cancels.push(s);
    return true;
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

  it("publishes final observed route attribution before forwarding the canonical terminal", async () => {
    const { gw, agentSdk } = await bootGateway();
    try {
      const terminal = {
        id: 'terminal:["generation-final-route"]',
        role: "assistant",
        ts: 100,
        order: 9,
        revision: 1,
        blocks: [{
          type: "turn_end",
          status: "completed",
          subtype: "success",
          reason: "completed",
          stopReason: "end_turn",
          terminalReason: "completed",
        }],
      };
      const fallback = {
        id: 'retry:["generation-final-route","fallback"]',
        role: "assistant",
        ts: 99,
        order: 8,
        revision: 1,
        blocks: [{
          type: "retry",
          kind: "model_fallback",
          fromModel: "claude-primary",
          toModel: "claude-fallback",
          attempt: 1,
          reason: "provider refusal",
        }],
      };
      agentSdk.eventsToEmit = [fallback, terminal];
      agentSdk.response = {
        text: "fallback answer",
        toolUses: [],
        stoppedReason: null,
        terminalStatus: "completed",
        failure: null,
        sessionId: "sdk-observed-final",
      };
      const order: string[] = [];
      const observations: any[] = [];
      const signature = {
        target: "sdk-final-route",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-primary",
        account: null,
        accountSource: null,
        projectPath: null,
      };
      const result = await gw.runAgentSdkTurn(
        {
          targetId: "sdk-final-route",
          target: {
            id: "sdk-final-route",
            type: "runtime-target",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-primary",
          },
        },
        "observe fallback",
        undefined,
        {
          generationId: "generation-final-route",
          routeSession: {
            epoch: 1,
            signature,
            boundaryReason: "initial",
            disposition: "new",
            hadPrior: false,
          },
          onRouteSession: (value: any) => {
            observations.push(value);
            if (value.model === "claude-fallback") order.push("route-final");
          },
          onEvent: (event: any) => {
            if (event.blocks?.some((block: any) => block.type === "turn_end")) order.push("terminal");
          },
        },
      );
      expect(order.at(-1)).toBe("terminal");
      expect(order.slice(0, -1)).not.toHaveLength(0);
      expect(order.slice(0, -1).every((entry) => entry === "route-final")).toBe(true);
      expect(observations.at(-1)).toMatchObject({
        model: "claude-fallback",
        sessionId: "sdk-observed-final",
        sessionEpoch: 1,
        spawnSignature: signature,
      });
      expect(result).toMatchObject({
        model: "claude-fallback",
        session_id: "sdk-observed-final",
        terminalStatus: "completed",
        failure: null,
        sessionEpoch: 1,
        spawnSignature: signature,
      });
    } finally {
      gw.shutdown();
    }
  });

  it("never re-emits a streamed reply after the canonical terminal event", async () => {
    // A streamed lane already delivered its text through onText. Repeating it
    // after `awaitResponse` puts a substantive frame AFTER the turn's terminal
    // event, which a strict channel must reject: live, that turned every
    // completed Web turn into `gateway_stream_protocol_error` with an empty
    // durable reply while the answer was visibly on screen.
    const { gw, agentSdk } = await bootGateway();
    try {
      agentSdk.textToStream = "streamed answer";
      agentSdk.eventsToEmit = [{
        id: 'terminal:["generation-no-late-chunk"]',
        role: "assistant",
        ts: 100,
        order: 4,
        revision: 1,
        blocks: [{
          type: "turn_end",
          status: "completed",
          subtype: "success",
          reason: "completed",
          stopReason: "end_turn",
          terminalReason: "completed",
        }],
      }];
      agentSdk.response = {
        text: "streamed answer",
        toolUses: [],
        stoppedReason: null,
        terminalStatus: "completed",
        failure: null,
        sessionId: "sdk-no-late-chunk",
      };
      const frames: string[] = [];
      const chunks: string[] = [];
      await gw.runAgentSdkTurn(
        {
          targetId: "sdk-no-late-chunk",
          target: { id: "sdk-no-late-chunk", type: "runtime-target", runtime: "agent-sdk", provider: "anthropic", model: "claude-primary" },
        },
        "stream then settle",
        (text: string) => { frames.push("chunk"); chunks.push(text); },
        {
          generationId: "generation-no-late-chunk",
          routeSession: {
            epoch: 1,
            signature: {
              target: "sdk-no-late-chunk",
              runtime: "agent-sdk",
              provider: "anthropic",
              model: "claude-primary",
              account: null,
              accountSource: null,
              projectPath: null,
            },
            boundaryReason: "initial",
            disposition: "new",
            hadPrior: false,
          },
          onRouteSession: () => {},
          onEvent: (event: any) => {
            if (event.blocks?.some((block: any) => block.type === "turn_end")) frames.push("terminal");
          },
        },
      );
      expect(chunks).toEqual(["streamed answer"]);
      expect(frames).toEqual(["chunk", "terminal"]);
    } finally {
      gw.shutdown();
    }
  });

  it("still emits the full reply once for a lane that never streamed", async () => {
    const { gw, agentSdk } = await bootGateway();
    try {
      agentSdk.textToStream = null;
      agentSdk.eventsToEmit = [];
      agentSdk.response = { text: "unstreamed answer", toolUses: [], stoppedReason: null, sessionId: "sdk-unstreamed" };
      const chunks: string[] = [];
      await gw.runAgentSdkTurn(
        {
          targetId: "sdk-unstreamed",
          target: { id: "sdk-unstreamed", type: "runtime-target", runtime: "agent-sdk", provider: "anthropic", model: "claude-primary" },
        },
        "no streaming here",
        (text: string) => chunks.push(text),
        { generationId: "generation-unstreamed" },
      );
      expect(chunks).toEqual(["unstreamed answer"]);
    } finally {
      gw.shutdown();
    }
  });

  it("opts only a stable streamed session into standing input and reuses its warm adapter session", async () => {
    const { gw, agentSdk } = await bootGateway();
    const route = {
      targetId: "sdk-standing",
      target: {
        id: "sdk-standing",
        type: "runtime-target",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "high",
        maxTurns: 17,
      },
    };
    try {
      await gw.runAgentSdkTurn(route, "first", undefined, {
        sessionKey: "thread-standing",
        streamingInput: true,
        generationId: "generation-first",
      });
      await gw.runAgentSdkTurn(route, "second", undefined, {
        sessionKey: "thread-standing",
        streamingInput: true,
        generationId: "generation-second",
      });

      expect(agentSdk.spawned).toHaveLength(1);
      expect(agentSdk.spawned[0]).toMatchObject({
        streamingInput: true,
        maxTurns: 17,
        effort: "high",
      });
      expect(agentSdk.turns).toEqual(["first", "second"]);
      expect(agentSdk.turnHooks.map((hooks) => hooks.generationId)).toEqual([
        "generation-first",
        "generation-second",
      ]);

      await gw.runAgentSdkTurn(route, "ordinary", undefined, {
        sessionKey: "thread-ordinary",
        generationId: "generation-ordinary",
      });
      await gw.runAgentSdkTurn(route, "threadless flag", undefined, {
        streamingInput: true,
        generationId: "generation-threadless",
      });
      expect(agentSdk.spawned).toHaveLength(3);
      expect(agentSdk.spawned[1]).not.toHaveProperty("streamingInput");
      expect(agentSdk.spawned[2]).not.toHaveProperty("streamingInput");
      await expect(gw.runAgentSdkTurn(route, "missing generation", undefined, {
        sessionKey: "thread-malformed",
        streamingInput: true,
      })).rejects.toThrow(/requires a generation id/i);
      expect(agentSdk.spawned).toHaveLength(3);
    } finally {
      gw.shutdown();
    }
  });

  it("tears down rather than interrupts a standing Query when its warm session is evicted", async () => {
    const { gw, agentSdk } = await bootGateway();
    const route = {
      targetId: "sdk-standing-eviction",
      target: {
        id: "sdk-standing-eviction",
        type: "runtime-target",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-haiku-4-5",
      },
    };
    try {
      for (let index = 0; index <= AGENT_SDK_SESSION_CAP; index += 1) {
        await gw.runAgentSdkTurn(route, `turn ${index}`, undefined, {
          sessionKey: `thread-${index}`,
          streamingInput: true,
          generationId: `generation-${index}`,
        });
      }
      expect(agentSdk.spawned).toHaveLength(AGENT_SDK_SESSION_CAP + 1);
      expect(agentSdk.teardowns.map((session) => session.id)).toEqual(["sdk-session-1"]);
      expect(agentSdk.cancels).toEqual([]);
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
    const visionCallScript = join(dir, "vision-call.mjs");
    const visionImage = join(dir, "vision-image.bin");
    const visionStarted = join(dir, "vision-started");
    const operativeMessages = join(dir, "operative-messages.jsonl");
    const claudeProjectsDir = join(dir, "claude-projects");
    const transcriptDir = join(claudeProjectsDir, dir.replace(/[/.]/g, "-"));
    const stderr: string[] = [];
    let child: ChildProcess | undefined;
    try {
      mkdirSync(join(dir, ".garrison"), { recursive: true });
      mkdirSync(join(agentSdkDir, "lib"), { recursive: true });
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(visionImage, "bounded image fixture", "utf8");
      writeFileSync(
        visionCallScript,
        `import fs from "node:fs";
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const spec = JSON.parse(raw);
if (!Array.isArray(spec.images) || spec.images.length !== 1) process.exit(2);
fs.writeFileSync(process.env.GARRISON_TEST_VISION_STARTED, "started");
await new Promise((resolve) => setTimeout(resolve, 1200));
process.stdout.write(JSON.stringify({ ok: true, text: "vision completed" }));
`,
        "utf8",
      );
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
        `import fs from "node:fs";
class StubSession {
  constructor(config) { this.config = config; this.disposed = false; this.handle = {}; }
  async runTurn({ message }) {
    if (/routing classifier/i.test(String(message))) {
      return { reply: JSON.stringify({ taskType: "other", tier: "T0-trivial", matchedException: null }), sessionId: "classifier" };
    }
    if (/web console exact bytes probe/i.test(String(message))) {
      fs.appendFileSync(process.env.GARRISON_TEST_OPERATIVE_MESSAGES, JSON.stringify({ message }) + "\\n");
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
        `export { resolveRoutedAgentSdkAssembly } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs")).href)};
import fs from "node:fs";
import path from "node:path";
let nextSession = 0;
export class AgentSdkAdapter {
  async spawn(config) {
    const generatedSessionId = "sdk-stream-session-" + (++nextSession);
    return { alive: true, config, harness: { promptMode: config.promptMode }, sessionId: config.sessionId ?? generatedSessionId };
  }
  async awaitReady() {}
  async sendTurn(session, message, hooks = {}) {
    session.message = String(message ?? "");
    delete session.echoReply;
    if (session.config.model === "claude-haiku-4-5") {
      // Keep the routed lane unresolved long enough for the HTTP test to issue
      // an exact interrupt after the open frame but before registerStop exists.
      if (/pre-stop latch/i.test(session.message)) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return;
    }
    if (/gateway context continuity probe/i.test(session.message)) {
      session.echoReply = session.message;
      hooks.onText?.(session.echoReply);
      return;
    }
    if (/gateway recovery orphan/i.test(session.message)) {
      hooks.onText?.("orphan partial");
      await new Promise((resolve) => { session.releaseRecoveryOrphan = resolve; });
      return;
    }
    const questionMatch = session.message.match(/question stream ([AB])/i);
    if (questionMatch) {
      const owner = questionMatch[1].toUpperCase();
      const transcript = path.join(process.env.GARRISON_TEST_TRANSCRIPT_DIR, session.sessionId + ".jsonl");
      const event = {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "question-" + owner.toLowerCase(),
            name: "AskUserQuestion",
            input: { questions: [{ question: "Question for " + owner + "?", options: [{ label: "Yes" }] }] }
          }]
        }
      };
      fs.appendFileSync(transcript, JSON.stringify(event) + "\\n");
      // A deliberately finishes first. B remains live after A's cleanup so a
      // module-global save/restore cursor would lose or misroute B's ownership.
      if (owner === "A") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1400));
        event.message.content[0].id = "question-b-late";
        event.message.content[0].input.questions[0].question = "Still B after A completed?";
        fs.appendFileSync(transcript, JSON.stringify(event) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    if (session.config.streamingInput !== true) {
      throw new Error("streamed Web turn did not opt into standing input");
    }
    if (/permission flow/i.test(session.message)) {
      if (session.config.permissionMode !== "default") throw new Error("permission mode was not interactive");
      const request = {
        type: "permission_request",
        requestId: "request-live",
        generationId: hooks.generationId,
        toolUseId: "tool-live",
        name: "Bash",
        input: "{\\"command\\":\\"pwd\\"}",
        inputComplete: true,
        suggestionsComplete: true,
        suggestions: [{ type: "addRules", destination: "session", rules: ["Bash(pwd)"] }],
        status: "pending"
      };
      const eventId = "permission:" + JSON.stringify([hooks.generationId, request.requestId]);
      const decisionPromise = Promise.resolve(hooks.onPermissionRequest(request, { signal: new AbortController().signal }));
      hooks.onEvent?.({ id: eventId, role: "assistant", ts: 1000, turnId: hooks.turnId, order: 1, revision: 1, blocks: [request] });
      const decision = await decisionPromise;
      hooks.onEvent?.({ id: eventId, role: "assistant", ts: 1000, turnId: hooks.turnId, order: 1, revision: 2, blocks: [{ ...request, status: "resolved", decision }] });
      session.permissionReply = "permission " + decision;
      hooks.onText?.(session.permissionReply);
      return;
    }
    hooks.onEvent?.({ id: "evt-1", type: "block_delta", turnId: hooks.turnId, block: { type: "text", text: "alpha" }, nested: { keep: [1, "two", false] } });
    hooks.onText?.("legacy reply");
    hooks.onTool?.({ name: "Read", id: "tool-1" });
    hooks.onEvent?.({ id: "evt-2", type: "tool_result", turnId: hooks.turnId, block: { type: "tool_result", toolUseId: "tool-1", content: "ok" } });
  }
  async awaitResponse(session) {
    if (/gateway typed failure/i.test(session.message)) {
      const error = new Error("bounded gateway failure");
      error.code = "fixture_gateway_failed";
      error.kind = "execution";
      error.retryable = false;
      throw error;
    }
    if (session.config.model === "claude-haiku-4-5") {
      return { text: JSON.stringify({ duty: "other", level: 1, confidence: "high", clarity: "clear", reason: "fixture" }), toolUses: [], stoppedReason: null };
    }
    if (session.echoReply) return { text: session.echoReply, toolUses: [], stoppedReason: null };
    if (session.permissionReply) return { text: session.permissionReply, toolUses: [{ name: "Bash", id: "tool-live" }], stoppedReason: null };
    return { text: "legacy reply", toolUses: [{ name: "Read", id: "tool-1" }], stoppedReason: null };
  }
  async teardown(session) { session.alive = false; }
  async cancel(session) {
    session.releaseRecoveryOrphan?.();
    return true;
  }
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
          GARRISON_CALL_SCRIPT: visionCallScript,
          GARRISON_TEST_VISION_STARTED: visionStarted,
          GARRISON_TEST_OPERATIVE_MESSAGES: operativeMessages,
          GARRISON_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          GARRISON_TEST_TRANSCRIPT_DIR: transcriptDir,
          GARRISON_GATEWAY_RUNTIME_STUB: runtimeStub,
          GARRISON_ACCOUNT: "",
          GARRISON_GATEWAY_NO_LISTEN: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout?.resume();
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      await waitForGateway(port, child, stderr);

      // The rich console is an explicit view onto the standing operative, not a
      // generated/routed Web thread. Preserve every admitted byte and bypass all
      // route, duty, skill, workflow, and carryover prompt annotations.
      const exactConsoleMessage = " \tweb console exact bytes probe\r\nline two  \n";
      const consoleResponse = await fetch(`http://127.0.0.1:${port}/claude/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: exactConsoleMessage }),
      });
      expect(consoleResponse.status).toBe(202);
      await expect(consoleResponse.json()).resolves.toEqual({ ack: true });
      const consoleDeadline = Date.now() + 2_000;
      while (!existsSync(operativeMessages) && Date.now() < consoleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(operativeMessages)).toBe(true);
      const admittedConsoleMessages = readFileSync(operativeMessages, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).message);
      expect(admittedConsoleMessages).toEqual([exactConsoleMessage]);

      const response = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: name the capital of France",
          channel: "web",
          thread: "thread-events",
          inputId: "input-events",
          turnSeq: 17,
          routing: { target: "sdk-ollama-chat" }
        })
      });
      expect(response.status).toBe(200);
      const frames = parseSse(await response.text());
      const streamGenerationId = frames.find((frame) => frame.event === "open")?.data.generationId;
      expect(streamGenerationId).toBeTruthy();
      const sessionEvents = frames.filter((frame) => frame.event === "session_event");
      const pendingRoute = frames.find((frame) => frame.event === "route");
      expect(pendingRoute?.data).toMatchObject({
        route: "sdk-ollama-chat",
        runtime: "agent-sdk",
        pending: true,
      });
      for (const field of ["sessionDisposition", "sessionBoundaryReason", "sessionEpoch", "spawnSignature"]) {
        expect(pendingRoute?.data).not.toHaveProperty(field);
      }
      const routeEvents = sessionEvents.filter((frame) => frame.data.id === `route:${streamGenerationId}`);
      expect(routeEvents).toHaveLength(3);
      expect(routeEvents.map((frame) => frame.data.revision)).toEqual([1, 2, 3]);
      expect(new Set(routeEvents.map((frame) => frame.data.ts)).size).toBe(1);
      expect(routeEvents.every((frame) => frame.data.order === 0)).toBe(true);
      expect(routeEvents[0].data.blocks).toEqual([
        expect.objectContaining({
          type: "route",
          attribution: expect.objectContaining({
            route: "sdk-ollama-chat",
            runtime: "agent-sdk",
            model: "qwen3:0.6b",
          }),
        }),
      ]);
      expect(routeEvents[0].data.blocks[0].attribution).not.toHaveProperty("sessionDisposition");
      expect(routeEvents[0].data.blocks[0].attribution).not.toHaveProperty("sessionEpoch");
      expect(routeEvents[0].data.blocks[0].attribution).not.toHaveProperty("spawnSignature");
      expect(routeEvents[1].data.blocks).toEqual([
        expect.objectContaining({
          type: "route",
          attribution: expect.objectContaining({
            sessionDisposition: "new",
            sessionBoundaryReason: "initial",
            sessionEpoch: 1,
            spawnSignature: expect.objectContaining({
              version: 2,
              target: "sdk-ollama-chat",
              runtime: "agent-sdk",
              provider: "ollama-local",
              model: "qwen3:0.6b",
              account: null,
              accountSource: null,
              projectPath: null,
              assembly: expect.stringMatching(/^a1:[a-f0-9]{64}$/),
            }),
          }),
        }),
      ]);
      expect(routeEvents[2].data.blocks[0].attribution.sessionId).toMatch(/^sdk-stream-session-/);
      const runtimeSessionEvents = sessionEvents.filter((frame) => /^evt-/.test(frame.data.id));
      expect(runtimeSessionEvents.map((frame) => frame.data)).toEqual([
        { id: "evt-1", type: "block_delta", turnId: "17", block: { type: "text", text: "alpha" }, nested: { keep: [1, "two", false] }, generationId: streamGenerationId },
        { id: "evt-2", type: "tool_result", turnId: "17", block: { type: "tool_result", toolUseId: "tool-1", content: "ok" }, generationId: streamGenerationId }
      ]);
      const generationBoundEvents = new Set(["route", "chunk", "activity", "session_event", "error", "done"]);
      for (const frame of frames.filter((candidate) => generationBoundEvents.has(candidate.event))) {
        expect(frame.data.generationId, frame.event).toBe(streamGenerationId);
      }

      const firstEvent = frames.findIndex((frame) => frame.event === "session_event" && frame.data.id === "evt-1");
      const finalRouteEvent = frames.reduce(
        (last: number, frame: any, index: number) =>
          frame.event === "session_event" && frame.data.id === `route:${streamGenerationId}` ? index : last,
        -1,
      );
      const chunk = frames.findIndex((frame) => frame.event === "chunk");
      const activity = frames.findIndex((frame) => frame.event === "activity");
      const secondEvent = frames.findIndex((frame) => frame.event === "session_event" && frame.data.id === "evt-2");
      const done = frames.findIndex((frame) => frame.event === "done");
      expect(firstEvent).toBeGreaterThan(-1);
      expect(finalRouteEvent).toBeLessThan(firstEvent);
      expect(firstEvent).toBeLessThan(chunk);
      expect(chunk).toBeLessThan(activity);
      expect(activity).toBeLessThan(secondEvent);
      expect(secondEvent).toBeLessThan(done);
      expect(frames[chunk].data).toMatchObject({ text: "legacy reply", replace: true });
      expect(frames[activity].data).toMatchObject({ kind: "tool", name: "Read", id: "tool-1" });
      expect(frames[done].data).toMatchObject({
        reply: "legacy reply",
        runtime: "agent-sdk",
        sessionDisposition: "new",
        sessionBoundaryReason: "initial",
        sessionEpoch: 1,
        spawnSignature: expect.objectContaining({ target: "sdk-ollama-chat", model: "qwen3:0.6b" }),
      });

      // Legacy callers may still try to send `context`; the gateway ignores it.
      // First, warm, restart-boundary, and resume paths all preserve user bytes.
      let contextRouteSession: any = null;
      const contextTurn = async (
        message: string,
        context: string,
        turnSeq: number,
        extra: Record<string, unknown> = {},
      ) => {
        const contextResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message,
            context,
            channel: "web",
            thread: "thread-context-continuity",
            inputId: `input-context-${turnSeq}`,
            turnSeq,
            routing: { target: "sdk-ollama-chat" },
            ...(contextRouteSession ? { routeSession: contextRouteSession } : {}),
            ...extra,
          }),
        });
        expect(contextResponse.status).toBe(200);
        const done = parseSse(await contextResponse.text()).find((frame) => frame.event === "done")?.data;
        contextRouteSession = { epoch: done.sessionEpoch, signature: done.spawnSignature };
        return done;
      };
      const exactFirstContextMessage = " \tquick: gateway context continuity probe first\n ";
      const firstContext = await contextTurn(
        exactFirstContextMessage,
        "durable context before first",
        171,
      );
      expect(firstContext).toMatchObject({
        reply: exactFirstContextMessage,
        sessionDisposition: "new",
        sessionBoundaryReason: "initial",
        sessionEpoch: 1,
      });
      const secondContext = await contextTurn(
        "quick: gateway context continuity probe second",
        "durable context through first",
        172,
      );
      expect(secondContext).toMatchObject({
        reply: "quick: gateway context continuity probe second",
        sessionDisposition: "warm",
        sessionBoundaryReason: null,
        sessionEpoch: 1,
      });
      const recoveryContext = await contextTurn(
        "quick: gateway context continuity probe after durable barrier",
        "durable context excluding uncertain turn",
        173,
        { agentSdkNewGeneration: true },
      );
      expect(recoveryContext).toMatchObject({
        reply: "quick: gateway context continuity probe after durable barrier",
        sessionDisposition: "new",
        sessionBoundaryReason: "restart-recovery",
        sessionEpoch: 2,
      });

      const compatibleResumeRouteSession = {
        epoch: frames[done].data.sessionEpoch,
        signature: frames[done].data.spawnSignature,
      };
      const resumeTurn = async (
        thread: string,
        model: string,
        turnSeq: number,
        routeSession?: Record<string, unknown>,
      ) => {
        const resumeResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: `quick: gateway context continuity probe resume ${turnSeq}`,
            context: "durable history already stored by the SDK",
            channel: "web",
            thread,
            inputId: `input-resume-${turnSeq}`,
            turnSeq,
            routing: { target: "sdk-ollama-chat" },
            ...(routeSession ? { routeSession } : {}),
            agentSdkResume: {
              sessionId: "persisted-native-session",
              route: "sdk-ollama-chat",
              runtime: "agent-sdk",
              provider: "ollama-local",
              model,
              effort: null,
              account: null,
              accountSource: null,
              projectPath: null,
              spawnSignature: compatibleResumeRouteSession.signature,
            },
          }),
        });
        expect(resumeResponse.status).toBe(200);
        const resumeFrames = parseSse(await resumeResponse.text());
        return resumeFrames.find((frame) => frame.event === "done")?.data;
      };
      // M7 native resume is accepted only when the host also supplies the exact
      // signed route/assembly identity. A legacy journal id on its own cannot
      // prove that system prompt, tools, MCP, and settings remain compatible.
      const nativeResume = await resumeTurn(
        "thread-native-resume",
        "qwen3:0.6b",
        173,
        compatibleResumeRouteSession,
      );
      expect(nativeResume).toMatchObject({
        reply: "quick: gateway context continuity probe resume 173",
        session_id: "persisted-native-session",
      });

      const legacyResume = await resumeTurn("thread-legacy-resume", "qwen3:0.6b", 174);
      expect(legacyResume.reply).toBe("quick: gateway context continuity probe resume 174");
      expect(legacyResume.session_id).not.toBe("persisted-native-session");

      // A model mismatch is an explicit new conversation generation. The old
      // journal id is ignored and the new boundary keeps the admitted text exact.
      const incompatibleResume = await resumeTurn("thread-incompatible-resume", "other-model", 175);
      expect(incompatibleResume.reply).toBe("quick: gateway context continuity probe resume 175");
      expect(incompatibleResume.session_id).not.toBe("persisted-native-session");

      // A dead Web owner can leave a standing Query with non-durable input in its
      // journal. Exact recovery must stop it, hold the generation through cache
      // teardown, and tombstone that journal so the successor starts clean.
      const recoveryBaseResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: gateway context continuity probe recovery base",
          context: "durable recovery base",
          channel: "web",
          thread: "thread-host-recovery",
          inputId: "input-recovery-base",
          turnSeq: 175,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      const recoveryBaseDone = parseSse(await recoveryBaseResponse.text())
        .find((frame) => frame.event === "done")!.data;
      expect(recoveryBaseDone.session_id).toBeTruthy();

      const orphanResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: gateway recovery orphan",
          context: "durable recovery base",
          channel: "web",
          thread: "thread-host-recovery",
          inputId: "input-recovery-orphan",
          turnSeq: 176,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      const orphanReader = orphanResponse.body!.getReader();
      const orphanDecoder = new TextDecoder();
      let orphanRaw = "";
      while (!orphanRaw.includes("orphan partial")) {
        const chunk = await orphanReader.read();
        if (chunk.done) break;
        orphanRaw += orphanDecoder.decode(chunk.value, { stream: true });
      }
      const liveRecovery = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-host-recovery", inputId: "input-recovery-orphan" }),
      });
      expect(liveRecovery.status).toBe(200);
      expect(await liveRecovery.json()).toMatchObject({ state: "running" });
      const recover = await fetch(`http://127.0.0.1:${port}/chat/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-host-recovery", inputId: "input-recovery-orphan" }),
      });
      expect(recover.status).toBe(200);
      expect(await recover.json()).toMatchObject({ stopped: true });
      while (true) {
        const chunk = await orphanReader.read();
        if (chunk.done) break;
        orphanRaw += orphanDecoder.decode(chunk.value, { stream: true });
      }
      orphanRaw += orphanDecoder.decode();
      expect(parseSse(orphanRaw).find((frame) => frame.event === "done")?.data)
        .toMatchObject({ stoppedByUser: true });

      let recoveryReleased = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: "thread-host-recovery", inputId: "input-recovery-orphan" }),
        });
        if (status.status === 404) {
          recoveryReleased = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(recoveryReleased).toBe(true);

      const successorResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: gateway context continuity probe recovery successor",
          context: "durable history excluding orphan",
          channel: "web",
          thread: "thread-host-recovery",
          inputId: "input-recovery-successor",
          turnSeq: 177,
          routing: { target: "sdk-ollama-chat" },
          agentSdkResume: {
            sessionId: recoveryBaseDone.session_id,
            route: "sdk-ollama-chat",
            runtime: "agent-sdk",
            provider: "ollama-local",
            model: "qwen3:0.6b",
            effort: null,
            account: null,
            accountSource: null,
            projectPath: null,
            spawnSignature: recoveryBaseDone.spawnSignature,
          },
        }),
      });
      const successorDone = parseSse(await successorResponse.text())
        .find((frame) => frame.event === "done")!.data;
      expect(successorDone.reply).toBe("quick: gateway context continuity probe recovery successor");
      expect(successorDone.session_id).not.toBe(recoveryBaseDone.session_id);

      // Full control-plane proof over the real child gateway: callback
      // registration publishes pending, the exact HTTP tuple releases it, then
      // the same durable event id revises before the terminal frame.
      const permissionResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: permission flow",
          channel: "web",
          thread: "thread-permission",
          inputId: "input-permission",
          turnSeq: 18,
          routing: { target: "sdk-ollama-chat" }
        })
      });
      expect(permissionResponse.status).toBe(200);
      const reader = permissionResponse.body!.getReader();
      const decoder = new TextDecoder();
      let permissionRaw = "";
      while (!/"status":"pending"[^\n]*\n\n/.test(permissionRaw)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        permissionRaw += decoder.decode(chunk.value, { stream: true });
      }
      const pendingFrames = parseSse(permissionRaw);
      const opened = pendingFrames.find((frame) => frame.event === "open")!;
      const pending = pendingFrames.find((frame) =>
        frame.event === "session_event" && frame.data.blocks?.[0]?.status === "pending"
      )!;
      expect(opened.data.generationId).toBeTruthy();
      expect(pending.data.blocks[0]).toMatchObject({
        requestId: "request-live",
        generationId: opened.data.generationId,
        inputComplete: true,
        suggestionsComplete: true,
      });

      const wrong = await fetch(`http://127.0.0.1:${port}/chat/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-permission",
          generationId: "generation-wrong",
          requestId: "request-live",
          decision: "allow_once",
        }),
      });
      expect(wrong.status).toBe(409);
      const allowed = await fetch(`http://127.0.0.1:${port}/chat/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-permission",
          generationId: opened.data.generationId,
          requestId: "request-live",
          decision: "allow_always",
        }),
      });
      expect(allowed.status).toBe(200);

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        permissionRaw += decoder.decode(chunk.value, { stream: true });
      }
      permissionRaw += decoder.decode();
      const permissionFrames = parseSse(permissionRaw);
      const permissionEvents = permissionFrames.filter((frame) =>
        frame.event === "session_event" && frame.data.blocks?.[0]?.type === "permission_request"
      );
      expect(permissionEvents.map((frame) => [
        frame.data.id,
        frame.data.revision,
        frame.data.blocks[0].status,
        frame.data.blocks[0].decision ?? null,
      ])).toEqual([
        [pending.data.id, 1, "pending", null],
        [pending.data.id, 2, "resolved", "allow_always"],
      ]);
      expect(permissionFrames.findIndex((frame) => frame.event === "session_event" && frame.data.revision === 2))
        .toBeLessThan(permissionFrames.findIndex((frame) => frame.event === "done"));
      expect(permissionFrames.find((frame) => frame.event === "done")?.data)
        .toMatchObject({ reply: "permission allow_always", runtime: "agent-sdk" });
      for (const frame of permissionFrames.filter((candidate) => generationBoundEvents.has(candidate.event))) {
        expect(frame.data.generationId, frame.event).toBe(opened.data.generationId);
      }

      // Two Web turns run concurrently on distinct warm SDK sessions and write
      // AskUserQuestion tool uses into their own transcripts. Each SSE stream
      // must see only its owner; A intentionally completes first while B remains
      // active, pinning cleanup/ownership independently of completion order.
      const startQuestionStream = (owner: "A" | "B") => fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `quick: question stream ${owner}`,
          channel: "web",
          thread: `thread-question-${owner.toLowerCase()}`,
          inputId: `input-question-${owner.toLowerCase()}`,
          turnSeq: owner === "A" ? 30 : 31,
          dutyKey: `CARD-${owner}:discuss`,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      const [questionAResponse, questionBResponse] = await Promise.all([
        startQuestionStream("A"),
        startQuestionStream("B"),
      ]);
      expect(questionAResponse.status).toBe(200);
      expect(questionBResponse.status).toBe(200);
      const completionOrder: string[] = [];
      const [questionARaw, questionBRaw] = await Promise.all([
        questionAResponse.text().then((raw) => { completionOrder.push("A"); return raw; }),
        questionBResponse.text().then((raw) => { completionOrder.push("B"); return raw; }),
      ]);
      expect(completionOrder).toEqual(["A", "B"]);
      const questionAFrames = parseSse(questionARaw);
      const questionBFrames = parseSse(questionBRaw);
      expect(questionAFrames.filter((frame) => frame.event === "tool").map((frame) => frame.data.tool_use_id))
        .toEqual(["question-a"]);
      expect(questionBFrames.filter((frame) => frame.event === "tool").map((frame) => frame.data.tool_use_id))
        .toEqual(["question-b", "question-b-late"]);

      // Real generation-control race: `open` is flushed while the fixture's
      // dispatcher is deliberately paused, before the routed lane registers a
      // primitive. A same-thread stream is rejected before SSE headers, the exact
      // interrupt latches, and the eventual lane registration unwinds the turn.
      const latchedResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: pre-stop latch",
          channel: "web",
          thread: "thread-overlap",
          inputId: "input-overlap",
          turnSeq: 19,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      expect(latchedResponse.status).toBe(200);
      const latchedReader = latchedResponse.body!.getReader();
      const latchedDecoder = new TextDecoder();
      let latchedRaw = "";
      while (!latchedRaw.includes("event: open\n")) {
        const chunk = await latchedReader.read();
        if (chunk.done) break;
        latchedRaw += latchedDecoder.decode(chunk.value, { stream: true });
      }
      const latchedOpen = parseSse(latchedRaw).find((frame) => frame.event === "open")!;
      expect(latchedOpen.data.generationId).toBeTruthy();

      const recoveredGeneration = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-overlap", inputId: "input-overlap" }),
      });
      expect(recoveredGeneration.status).toBe(200);
      expect(await recoveredGeneration.json()).toMatchObject({
        inputId: "input-overlap",
        threadId: "thread-overlap",
        generationId: latchedOpen.data.generationId,
        state: "starting",
      });
      const foreignInput = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-overlap", inputId: "input-foreign" }),
      });
      expect(foreignInput.status).toBe(409);
      expect(await foreignInput.json()).toMatchObject({ code: "thread_input_generation_conflict" });

      const overlap = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: second direct turn",
          channel: "web",
          thread: "thread-overlap",
          inputId: "input-overlap-second",
          turnSeq: 20,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      expect(overlap.status).toBe(409);
      expect(overlap.headers.get("content-type")).toContain("application/json");
      expect(await overlap.json()).toMatchObject({ code: "thread_generation_conflict" });

      const wrongInterrupt = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-overlap", generationId: "generation-wrong" }),
      });
      expect(wrongInterrupt.status).toBe(409);
      const exactInterrupt = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-overlap",
          generationId: latchedOpen.data.generationId,
        }),
      });
      expect(exactInterrupt.status).toBe(202);
      expect(await exactInterrupt.json()).toMatchObject({ ok: true, state: "pending-stop" });

      while (true) {
        const chunk = await latchedReader.read();
        if (chunk.done) break;
        latchedRaw += latchedDecoder.decode(chunk.value, { stream: true });
      }
      latchedRaw += latchedDecoder.decode();
      const latchedFrames = parseSse(latchedRaw);
      expect(latchedFrames.find((frame) => frame.event === "error")).toBeUndefined();
      for (const frame of latchedFrames.filter((candidate) => candidate.event === "route")) {
        expect(frame.data.sessionDisposition ?? null).toBeNull();
        expect(frame.data.sessionEpoch ?? null).toBeNull();
        expect(frame.data.spawnSignature ?? null).toBeNull();
      }
      for (const frame of latchedFrames.filter((candidate) => candidate.event === "session_event")) {
        const route = frame.data?.blocks?.find((block: any) => block?.type === "route");
        if (!route) continue;
        expect(route.attribution).not.toHaveProperty("sessionDisposition");
        expect(route.attribution).not.toHaveProperty("sessionEpoch");
        expect(route.attribution).not.toHaveProperty("spawnSignature");
      }
      expect(latchedFrames.find((frame) => frame.event === "done")?.data).toMatchObject({
        generationId: latchedOpen.data.generationId,
        stoppedByUser: true,
        stoppedReason: "user-interrupt",
      });
      const releasedGeneration = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-overlap", inputId: "input-overlap" }),
      });
      expect(releasedGeneration.status).toBe(404);

      const failedResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: gateway typed failure",
          channel: "web",
          thread: "thread-typed-failure",
          inputId: "input-typed-failure",
          turnSeq: 201,
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      expect(failedResponse.status).toBe(200);
      const failedFrames = parseSse(await failedResponse.text());
      const failedRouteIndex = failedFrames.findIndex((frame) =>
        frame.event === "session_event" && frame.data.blocks?.[0]?.type === "route");
      const failedTerminalIndex = failedFrames.findIndex((frame) =>
        frame.event === "session_event" && frame.data.blocks?.some((block: any) => block.type === "turn_end"));
      const failedLegacyIndex = failedFrames.findIndex((frame) => frame.event === "error");
      expect(failedFrames.find((frame) => frame.event === "done")).toBeUndefined();
      expect(failedTerminalIndex).toBeGreaterThan(failedRouteIndex);
      expect(failedLegacyIndex).toBeGreaterThan(failedTerminalIndex);
      expect(failedFrames[failedTerminalIndex].data.blocks).toEqual([
        expect.objectContaining({
          type: "error",
          source: "gateway",
          kind: "execution",
          code: "fixture_gateway_failed",
          text: "bounded gateway failure",
          retryable: false,
        }),
        expect.objectContaining({ type: "turn_end", status: "error", reason: "fixture_gateway_failed" }),
      ]);
      expect(failedFrames[failedLegacyIndex].data).toMatchObject({
        error: "bounded gateway failure",
        source: "gateway",
        kind: "execution",
        code: "fixture_gateway_failed",
        retryable: false,
        failure: expect.objectContaining({ code: "fixture_gateway_failed" }),
      });
      const releasedFailure = await fetch(`http://127.0.0.1:${port}/chat/generation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "thread-typed-failure", inputId: "input-typed-failure" }),
      });
      expect(releasedFailure.status).toBe(404);

      // The native Ollama vision subprocess has no supported cancellation seam.
      // Once its marker proves inference is in flight, exact Stop must report a
      // lane-specific 409 (and Retry must really retry), never a pending 202.
      const visionResponse = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "quick: inspect this image",
          channel: "web",
          thread: "thread-vision-stop",
          inputId: "input-vision-stop",
          turnSeq: 21,
          images: [visionImage],
          routing: { target: "sdk-ollama-chat" },
        }),
      });
      expect(visionResponse.status).toBe(200);
      const visionReader = visionResponse.body!.getReader();
      const visionDecoder = new TextDecoder();
      let visionRaw = "";
      while (!visionRaw.includes("event: open\n")) {
        const chunk = await visionReader.read();
        if (chunk.done) break;
        visionRaw += visionDecoder.decode(chunk.value, { stream: true });
      }
      const visionOpen = parseSse(visionRaw).find((frame) => frame.event === "open")!;
      expect(visionOpen.data.generationId).toBeTruthy();
      const visionDeadline = Date.now() + 3000;
      while (!existsSync(visionStarted) && Date.now() < visionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(visionStarted)).toBe(true);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stop = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "thread-vision-stop",
            generationId: visionOpen.data.generationId,
          }),
        });
        expect(stop.status).toBe(409);
        expect(await stop.json()).toMatchObject({
          ok: false,
          error: "cancel-primitive-did-not-stop",
          lane: "ollama-native",
        });
      }

      while (true) {
        const chunk = await visionReader.read();
        if (chunk.done) break;
        visionRaw += visionDecoder.decode(chunk.value, { stream: true });
      }
      visionRaw += visionDecoder.decode();
      const visionFrames = parseSse(visionRaw);
      expect(visionFrames.find((frame) => frame.event === "error")).toBeUndefined();
      expect(visionFrames.find((frame) => frame.event === "done")?.data).toMatchObject({
        generationId: visionOpen.data.generationId,
        reply: "vision completed",
        runtime: "ollama-native",
      });
      expect(visionFrames.find((frame) => frame.event === "done")?.data)
        .not.toHaveProperty("stoppedByUser");

      const malformedInterrupt = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(malformedInterrupt.status).toBe(400);
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
