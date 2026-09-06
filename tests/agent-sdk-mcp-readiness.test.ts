import { describe, expect, it, vi } from "vitest";
// @ts-ignore — runtime helper is plain ESM.
import { createMcpReadyQuery } from "../fittings/seed/agent-sdk-runtime/lib/mcp-readiness.mjs";
// @ts-ignore — runtime adapter is plain ESM.
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";

function fixture(statuses: () => Promise<any[]>) {
  const admitted: any[] = [];
  const controls = { closed: 0, interrupted: 0 };
  const factory = ({ prompt }: any) => {
    const output = (async function* () {
      for await (const message of prompt) {
        admitted.push(message);
        yield { type: "result", subtype: "success", result: "ready", usage: { input_tokens: 0, output_tokens: 0 } };
      }
    })();
    return Object.assign(output, {
      mcpServerStatus: statuses,
      close() { controls.closed++; },
      interrupt() { controls.interrupted++; },
    });
  };
  return { factory, admitted, controls };
}

describe("SDK configured MCP admission", () => {
  it("holds the original prompt until every configured server connects", async () => {
    let connect: (status: any[]) => void = () => {};
    let calls = 0;
    const fx = fixture(async () => ++calls === 1
      ? [{ name: "garrison", status: "connected" }, { name: "basic-memory", status: "pending" }]
      : new Promise((resolve) => { connect = resolve; }));
    const client = createMcpReadyQuery(fx.factory, { prompt: "exact user text", options: { mcpServers: { garrison: {}, "basic-memory": {} } } }, { pollMs: 1 });
    const first = client.next();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(fx.admitted).toEqual([]);
    connect([{ name: "garrison", status: "connected" }, { name: "basic-memory", status: "connected" }]);
    expect((await first).value.result).toBe("ready");
    expect(fx.admitted[0].message).toEqual({ role: "user", content: "exact user text" });
    await client.interrupt();
    expect(fx.controls.interrupted).toBe(1);
    await client.return();
  });

  it.each(["failed", "needs-auth", "disabled"])("fails clearly on %s without submitting input", async (status) => {
    const fx = fixture(async () => [{ name: "basic-memory", status }]);
    const client = createMcpReadyQuery(fx.factory, { prompt: "private prompt", options: { mcpServers: { "basic-memory": {} } } });
    await expect(client.next()).rejects.toThrow(`basic-memory: ${status}`);
    expect(fx.admitted).toEqual([]);
    expect(fx.controls.closed).toBeGreaterThan(0);
  });

  it("bounds a hung status control request and names the pending server", async () => {
    const fx = fixture(() => new Promise(() => {}));
    const client = createMcpReadyQuery(fx.factory, { prompt: "never sent", options: { mcpServers: { "basic-memory": {} } } }, { timeoutMs: 20 });
    await expect(client.next()).rejects.toThrow(/timed out.*basic-memory: pending.*no prompt was sent/);
    expect(fx.admitted).toEqual([]);
  });

  it("does not publish native server exception payloads in startup errors", async () => {
    const fx = fixture(async () => { throw new Error("transport-private-token-and-payload"); });
    const client = createMcpReadyQuery(fx.factory, { prompt: "never sent", options: { mcpServers: { "basic-memory": {} } } });
    await expect(client.next()).rejects.toThrow("could not verify configured MCP server readiness (basic-memory: pending); no prompt was sent");
    expect(fx.admitted).toEqual([]);
  });

  it.each(["return", "interrupt", "close"])("%s cancels pending admission even if status later connects", async (control) => {
    let connect: (status: any[]) => void = () => {};
    const fx = fixture(() => new Promise((resolve) => { connect = resolve; }));
    const client = createMcpReadyQuery(fx.factory, { prompt: "cancelled text", options: { mcpServers: { "basic-memory": {} } } });
    const reading = expect(client.next()).rejects.toMatchObject({ name: "AbortError" });
    await client[control]();
    connect([{ name: "basic-memory", status: "connected" }]);
    await reading;
    expect(fx.admitted).toEqual([]);
  });

  it("leaves tool-free classifiers on the original synchronous Query path", () => {
    const query = {};
    const factory = vi.fn(() => query);
    expect(createMcpReadyQuery(factory, { prompt: "classify", options: { mcpServers: null } })).toBe(query);
    expect(factory).toHaveBeenCalledWith({ prompt: "classify", options: { mcpServers: null } });
  });

  it.each([false, true])("adapter Stop during MCP startup drops cancelled input and accepts a fresh turn (streaming=%s)", async (streamingInput) => {
    let startupCalls = 0;
    let clients = 0;
    const fx = fixture(async () => {
      startupCalls++;
      return [{ name: "basic-memory", status: clients === 1 ? "pending" : "connected" }];
    });
    const adapter = new AgentSdkAdapter({ createClient: (args: any) => {
      clients++;
      return createMcpReadyQuery(fx.factory, args, { pollMs: 1 });
    } });
    const session = await adapter.spawn({ provider: "anthropic", model: "claude-sonnet-4-6", compositionDir: "/tmp", streamingInput, mcpServers: { "basic-memory": { command: "fixture" } } });
    await adapter.sendTurn(session, "cancelled first input", { generationId: "cancelled-generation" });
    const cancelled = adapter.awaitResponse(session);
    await vi.waitFor(() => expect(startupCalls).toBeGreaterThan(0));
    expect(await adapter.cancel(session)).toBe(true);
    await expect(cancelled).resolves.toMatchObject({ stoppedReason: "cancelled", terminalStatus: "cancelled" });
    if (streamingInput) await vi.waitFor(() => expect(session.standingClient).toBeNull());
    expect(fx.admitted).toEqual([]);
    await adapter.sendTurn(session, "fresh input", { generationId: "fresh-generation" });
    await expect(adapter.awaitResponse(session)).resolves.toMatchObject({ text: "ready" });
    expect(fx.admitted.map((message) => message.message.content)).toEqual(streamingInput ? [[{ type: "text", text: "fresh input" }]] : ["fresh input"]);
    await adapter.teardown(session);
  });
});
