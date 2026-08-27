// Per-lane turn serialization (2026-08-07) - the de-PTY-ing of the gateway.
//
// The PTY-era gateway chained EVERY turn onto one global promise, so a long
// conversation turn on one warm session starved unrelated lanes: three
// run-killing incidents in one week (unauthenticated-gemini flood, curation
// backlog, a single 5-minute streaming chat turn that killed a 359-check drill
// run). Pinned here at the RoutedGateway seam:
//   - turns on DIFFERENT agent-sdk targets run concurrently;
//   - turns on the SAME warm session key still serialize (one session is one
//     conversation - interleaving sendTurn would corrupt it);
//   - an idle lane leaves no queue entry behind.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore -- pure .mjs routing layer
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function route(targetId: string, model: string) {
  return {
    targetId,
    target: { id: targetId, runtime: "agent-sdk", provider: "anthropic", model, promptMode: "coding", effort: null }
  };
}

function makeAdapter() {
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    sent: [] as string[],
    gates: new Map<string, { promise: Promise<unknown>; resolve: (v: unknown) => void }>()
  };
  const adapter = {
    resolveRoutedAssembly: (config: any) => ({
      ...config,
      systemPrompt: typeof config.appendSystemPrompt === "string" ? config.appendSystemPrompt : "",
      settingSources: [],
      tools: config.tools ?? [],
      allowedTools: config.allowedTools ?? [],
      disallowedTools: config.disallowedTools ?? [],
      mcpServers: config.mcpServers ?? {},
      strictMcpConfig: config.strictMcpConfig === true,
    }),
    spawn: async (args: any) => ({ id: `${args.model}`, model: args.model, alive: true, harness: { promptMode: args.promptMode } }),
    awaitReady: async () => {},
    sendTurn: async (session: any, message: string) => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.sent.push(message);
      session.__pending = state.gates.get(session.model)?.promise ?? Promise.resolve();
    },
    awaitResponse: async (session: any) => {
      await session.__pending;
      state.inFlight--;
      return { text: `reply from ${session.model}` };
    }
  };
  return { adapter, state };
}

function boot(adapter: any) {
  return new RoutedGateway({
    compositionDir: mkdtempSync(path.join(tmpdir(), "gar-conc-")),
    config: { taskTypes: [], tiers: [] },
    agentSdkAdapter: adapter,
    secrets: {},
    logFn: () => {}
  });
}

describe("per-lane turn serialization", () => {
  it("a slow turn on one target does not delay a turn on another target", async () => {
    const { adapter, state } = makeAdapter();
    const slow = deferred();
    state.gates.set("opus", { promise: slow.promise, resolve: slow.resolve as any });
    const gw = boot(adapter);

    const slowTurn = gw.runAgentSdkTurn(route("cc-opus", "opus"), "long conversation turn", null, {});
    const fastTurn = gw.runAgentSdkTurn(route("cc-sonnet-med", "sonnet"), "drill vision verify", null, {});

    // The fast lane must complete while the slow lane is still mid-turn.
    const fast = await fastTurn;
    expect(fast.reply).toBe("reply from sonnet");
    expect(state.inFlight).toBe(1); // opus still holds its lane
    expect(state.maxInFlight).toBe(2); // both lanes were genuinely in flight together

    slow.resolve(null);
    const done = await slowTurn;
    expect(done.reply).toBe("reply from opus");
  });

  it("turns on the same warm session key serialize in arrival order", async () => {
    const { adapter, state } = makeAdapter();
    const first = deferred();
    state.gates.set("opus", { promise: first.promise, resolve: first.resolve as any });
    const gw = boot(adapter);

    const turnA = gw.runAgentSdkTurn(route("cc-opus", "opus"), "first", null, {});
    // Give turn A the tick it needs to reach sendTurn before B enqueues.
    await new Promise((r) => setImmediate(r));
    state.gates.delete("opus");
    const turnB = gw.runAgentSdkTurn(route("cc-opus", "opus"), "second", null, {});

    await new Promise((r) => setImmediate(r));
    // B must NOT have sent while A is unresolved - one session, one conversation.
    expect(state.sent).toEqual(["first"]);
    expect(state.maxInFlight).toBe(1);

    first.resolve(null);
    await turnA;
    await turnB;
    expect(state.sent).toEqual(["first", "second"]);
    expect(state.maxInFlight).toBe(1);
  });

  it("an idle lane leaves no queue entry behind", async () => {
    const { adapter } = makeAdapter();
    const gw = boot(adapter);
    await gw.runAgentSdkTurn(route("cc-sonnet-med", "sonnet"), "one", null, {});
    // Cleanup is chained on the tail's settle - give it a microtask.
    await new Promise((r) => setImmediate(r));
    expect((gw as any)._laneQueues.size).toBe(0);
  });
});
