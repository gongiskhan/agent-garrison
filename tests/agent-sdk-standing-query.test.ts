import { describe, expect, it } from "vitest";
// @ts-ignore — the fitting intentionally exposes a plain ESM wrapper.
import { createSdkClient } from "../fittings/seed/agent-sdk-runtime/lib/sdk-client.mjs";
// @ts-ignore — provider adapter is plain ESM.
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore — protocol fixture is plain ESM so it can also be used by node probes.
import { FakeAgentSdkStandingProcess } from "./fixtures/fake-agent-sdk-standing-process.mjs";

class FixtureInputQueue {
  private values: any[] = [];
  private waiter: ((result: IteratorResult<any>) => void) | null = null;
  private closed = false;

  push(value: any) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close() {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
  }

  async next(): Promise<IteratorResult<any>> {
    if (this.values.length) return { done: false, value: this.values.shift() };
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => (this.waiter = resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function user(text: string) {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeStandingQuery {
  private values: any[] = [];
  private waiter: { resolve: (result: IteratorResult<any>) => void; reject: (error: Error) => void } | null = null;
  private ended = false;
  private input: any;
  interruptCount = 0;
  returnCount = 0;
  closeCount = 0;
  onInterrupt: (() => void | Promise<void>) | null = null;

  constructor(input: any) {
    this.input = input;
  }

  emit(value: any) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end() {
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ done: true, value: undefined });
    }
  }

  async next(): Promise<IteratorResult<any>> {
    if (this.values.length) return { done: false, value: this.values.shift() };
    if (this.ended) return { done: true, value: undefined };
    return new Promise((resolve, reject) => (this.waiter = { resolve, reject }));
  }

  async interrupt() {
    this.interruptCount += 1;
    await this.onInterrupt?.();
  }

  async return() {
    this.returnCount += 1;
    this.end();
    return { done: true, value: undefined };
  }

  close() {
    this.closeCount += 1;
    this.input.return?.();
    this.end();
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function standingAdapterFixture() {
  const inputs: any[] = [];
  const clients: FakeStandingQuery[] = [];
  const optionsSeen: any[] = [];
  const adapter = new AgentSdkAdapter({
    permissionRequestId: () => `permission-${inputs.length}`,
    createClient: async ({ prompt, options }: any) => {
      const client = new FakeStandingQuery(prompt);
      clients.push(client);
      optionsSeen.push(options);
      void (async () => {
        for await (const message of prompt) inputs.push(message);
      })();
      return client;
    },
  });
  return { adapter, inputs, clients, optionsSeen };
}

describe("pinned Agent SDK standing streaming-input wrapper", () => {
  it("stays open across idle, interrupts without return, reuses the query for later permission, and closes explicitly", async () => {
    const input = new FixtureInputQueue();
    const fixtureProcess = new FakeAgentSdkStandingProcess();
    let spawnOptions: any;
    const permissionCalls: any[] = [];
    const query = createSdkClient({
      prompt: input,
      options: {
        cwd: "/tmp",
        systemPrompt: "offline standing-query fixture",
        permissionMode: "default",
        maxTurns: 7,
        effort: "high",
        resume: "11111111-1111-4111-8111-111111111111",
        canUseTool: async (toolName: string, toolInput: any, options: any) => {
          permissionCalls.push({ toolName, toolInput, options });
          return { behavior: "allow", updatedInput: structuredClone(toolInput) };
        },
        spawnClaudeCodeProcess: (options: any) => {
          spawnOptions = options;
          return fixtureProcess;
        },
      },
    });

    const messages: any[] = [];
    const pump = (async () => {
      for await (const message of query) messages.push(message);
    })();
    const idleCount = () => messages.filter((message) =>
      message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle"
    ).length;

    input.push(user("turn one"));
    await waitFor(() => idleCount() === 1, "first idle");
    expect(fixtureProcess.inputEnded).toBe(false);

    input.push(user("turn two"));
    await waitFor(() => fixtureProcess.userMessages.length === 2, "second input");
    await expect(query.interrupt()).resolves.toBeUndefined();
    await waitFor(() => idleCount() === 2, "interrupted idle");
    expect(fixtureProcess.controlSubtypes).toContain("interrupt");
    expect(fixtureProcess.inputEnded).toBe(false);

    input.push(user("turn three"));
    await waitFor(() => idleCount() === 3, "third idle");
    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0]).toMatchObject({
      toolName: "Bash",
      toolInput: { command: "pwd" },
      options: { toolUseID: "tool-3" },
    });
    expect(fixtureProcess.permissionResponse).toMatchObject({
      subtype: "success",
      request_id: "permission-control-3",
      response: { behavior: "allow", updatedInput: { command: "pwd" } },
    });

    for (const turn of [1, 2, 3]) {
      const result = messages.findIndex((message) => message.uuid === `result-${turn}`);
      const postlude = messages.findIndex((message) => message.uuid === `suggestion-${turn}`);
      const idle = messages.findIndex((message) => message.uuid === `state-idle-${turn}`);
      expect(result).toBeGreaterThan(-1);
      expect(result).toBeLessThan(postlude);
      expect(postlude).toBeLessThan(idle);
    }
    expect(fixtureProcess.userMessages.map((message: any) => message.priority)).toEqual([undefined, undefined, undefined]);
    expect(spawnOptions.args).toEqual(expect.arrayContaining(["--max-turns", "7", "--effort", "high"]));
    const resumeIndex = spawnOptions.args.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(spawnOptions.args[resumeIndex + 1]).toBe("11111111-1111-4111-8111-111111111111");

    query.close();
    input.close();
    await pump;
    await waitFor(() => fixtureProcess.inputEnded, "explicit stdin close");

    // This fixture proves wrapper/control plumbing. A hermetic pinned-native
    // streamed-input probe additionally established that maxTurns is evaluated
    // per input and that the ordinary text path emits a result without an idle
    // marker; the adapter regressions below own that optional-idle boundary.
  });
});

describe("AgentSdkAdapter standing streaming-input turns", () => {
  it("opens a cold standing Query with the persisted SDK resume id and sends only the new input", async () => {
    const { adapter, inputs, clients, optionsSeen } = standingAdapterFixture();
    const session = await adapter.spawn({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      compositionDir: "/tmp",
      streamingInput: true,
      sessionId: "persisted-standing-session",
    });

    await adapter.sendTurn(session, "continue without duplicate context", {
      generationId: "generation-resume",
    });
    const response = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 1 && clients.length === 1, "resumed adapter input");
    expect(optionsSeen[0]).toMatchObject({ resume: "persisted-standing-session" });
    expect(inputs[0]).toEqual(user("continue without duplicate context"));

    clients[0].emit({
      type: "result",
      uuid: "result-resume",
      session_id: "persisted-standing-session",
      subtype: "success",
      result: "continued",
      usage: { output_tokens: 1 },
    });
    clients[0].emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: "idle-resume",
      session_id: "persisted-standing-session",
    });
    await expect(response).resolves.toMatchObject({ text: "continued" });
    await adapter.teardown(session);
  });

  it("reuses one Query, waits for idle after result/postlude, and binds later permissions and events to the current generation", async () => {
    const { adapter, inputs, clients, optionsSeen } = standingAdapterFixture();
    const session = await adapter.spawn({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      compositionDir: "/tmp",
      permissionMode: "default",
      streamingInput: true,
      maxTurns: 9,
      effort: "high",
    });

    const firstEvents: any[] = [];
    await adapter.sendTurn(session, "first", {
      turnId: "1",
      generationId: "generation-1",
      onEvent: (event: any) => firstEvents.push(event),
    });
    const firstResponse = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 1, "first adapter input");
    expect(inputs[0]).toEqual(user("first"));
    expect(inputs[0]).not.toHaveProperty("priority");
    expect(clients).toHaveLength(1);
    expect(optionsSeen[0]).toMatchObject({ maxTurns: 9, effort: "high", permissionMode: "default" });

    clients[0].emit({
      type: "assistant",
      uuid: "assistant-first",
      session_id: "standing-session",
      message: { content: [{ type: "text", text: "working first" }] },
    });
    clients[0].emit({
      type: "result",
      uuid: "result-first",
      session_id: "standing-session",
      subtype: "success",
      result: "done first",
      usage: { output_tokens: 2 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstEvents.flatMap((event) => event.blocks).some((block) => block.type === "turn_end")).toBe(false);
    await expect(adapter.sendTurn(session, "overlap", { generationId: "generation-overlap" })).rejects.toThrow(/already active/i);

    clients[0].emit({
      type: "prompt_suggestion",
      uuid: "suggestion-first",
      session_id: "standing-session",
      suggestion: "next",
    });
    clients[0].emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: "idle-first",
      session_id: "standing-session",
    });
    await expect(firstResponse).resolves.toMatchObject({ text: "done first", stoppedReason: null });
    expect(firstEvents.every((event) => event.generationId === "generation-1")).toBe(true);
    expect(firstEvents.flatMap((event) => event.blocks).map((block) => block.type)).toEqual([
      "text",
      "status",
      "turn_end",
    ]);

    const secondEvents: any[] = [];
    const permissionRequests: any[] = [];
    await adapter.sendTurn(session, "second", {
      turnId: "2",
      generationId: "generation-2",
      onEvent: (event: any) => secondEvents.push(event),
      onPermissionRequest: (request: any) => {
        permissionRequests.push(request);
        return "allow_once";
      },
    });
    const secondResponse = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 2, "second adapter input");
    const permissionResult = await optionsSeen[0].canUseTool("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-second",
    });
    expect(permissionRequests[0]).toMatchObject({
      generationId: "generation-2",
      requestId: "permission-2",
      toolUseId: "tool-second",
    });
    expect(permissionResult).toMatchObject({ behavior: "allow", updatedInput: { command: "pwd" } });

    clients[0].emit({
      type: "result",
      uuid: "result-second",
      session_id: "standing-session",
      subtype: "success",
      result: "done second",
      usage: { output_tokens: 1 },
    });
    clients[0].emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: "idle-second",
      session_id: "standing-session",
    });
    await expect(secondResponse).resolves.toMatchObject({ text: "done second" });
    expect(clients).toHaveLength(1);
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(secondEvents.every((event) => event.generationId === "generation-2")).toBe(true);
    expect(secondEvents[0].order).toBe(1);

    await adapter.teardown(session);
    expect(clients[0].closeCount).toBe(1);
    expect(clients[0].returnCount).toBe(0);
  });

  it("uses Query.interrupt for Stop, settles at idle as cancelled, and reuses the Query", async () => {
    const { adapter, inputs, clients } = standingAdapterFixture();
    const session = await adapter.spawn({
      provider: "anthropic",
      model: "sonnet",
      compositionDir: "/tmp",
      streamingInput: true,
    });
    const events: any[] = [];
    await adapter.sendTurn(session, "stop this", {
      generationId: "generation-stop",
      onEvent: (event: any) => events.push(event),
    });
    const response = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 1 && clients.length === 1, "interruptible input");
    clients[0].onInterrupt = async () => {
      clients[0].emit({
        type: "result",
        uuid: "result-stop",
        session_id: "standing-stop",
        subtype: "success",
        result: "partial",
        usage: { output_tokens: 1 },
      });
      clients[0].emit({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        uuid: "idle-stop",
        session_id: "standing-stop",
      });
    };
    await expect(Promise.all([adapter.cancel(session), adapter.cancel(session)])).resolves.toEqual([true, true]);
    await expect(response).resolves.toMatchObject({ text: "partial", stoppedReason: "cancelled" });
    expect(clients[0].interruptCount).toBe(1);
    expect(clients[0].returnCount).toBe(0);
    expect(events.flatMap((event) => event.blocks).at(-1)).toMatchObject({
      type: "turn_end",
      status: "cancelled",
      stopReason: "cancelled",
    });

    await adapter.sendTurn(session, "after stop", { generationId: "generation-after-stop" });
    const nextResponse = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 2, "post-interrupt input");
    clients[0].emit({
      type: "result",
      uuid: "result-after-stop",
      session_id: "standing-stop",
      subtype: "success",
      result: "reused",
      usage: { output_tokens: 1 },
    });
    clients[0].emit({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: "idle-after-stop",
      session_id: "standing-stop",
    });
    await expect(nextResponse).resolves.toMatchObject({ text: "reused", stoppedReason: null });
    expect(clients).toHaveLength(1);
    await adapter.teardown(session);
  });

  it("settles a quiet native-style result without idle and reuses the same Query", async () => {
    const { adapter, inputs, clients } = standingAdapterFixture();
    const session = await adapter.spawn({
      provider: "anthropic",
      model: "sonnet",
      compositionDir: "/tmp",
      streamingInput: true,
    });

    await adapter.sendTurn(session, "native result one", { generationId: "generation-native-1" });
    const firstResponse = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 1 && clients.length === 1, "first native-style input");
    clients[0].emit({
      type: "result",
      uuid: "result-native-1",
      session_id: "standing-native",
      subtype: "success",
      result: "first without idle",
      usage: { output_tokens: 1 },
    });
    await expect(firstResponse).resolves.toMatchObject({ text: "first without idle", stoppedReason: null });

    await adapter.sendTurn(session, "native result two", { generationId: "generation-native-2" });
    const secondResponse = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 2, "reused native-style input");
    clients[0].emit({
      type: "result",
      uuid: "result-native-2",
      session_id: "standing-native",
      subtype: "success",
      result: "second without idle",
      usage: { output_tokens: 1 },
    });
    await expect(secondResponse).resolves.toMatchObject({ text: "second without idle", stoppedReason: null });
    expect(clients).toHaveLength(1);
    await adapter.teardown(session);
  });

  it("does not claim cancellation when interrupt is rejected and requires generation authority before opening a Query", async () => {
    const { adapter, inputs, clients } = standingAdapterFixture();
    const session = await adapter.spawn({
      provider: "anthropic",
      model: "sonnet",
      compositionDir: "/tmp",
      streamingInput: true,
    });
    await expect(adapter.sendTurn(session, "missing generation")).rejects.toThrow(/requires a generation id/i);
    expect(clients).toHaveLength(0);

    const events: any[] = [];
    await adapter.sendTurn(session, "keep running", {
      generationId: "generation-running",
      onEvent: (event: any) => events.push(event),
    });
    const response = adapter.awaitResponse(session);
    await waitFor(() => inputs.length === 1 && clients.length === 1, "rejectable interrupt input");
    clients[0].onInterrupt = async () => {
      // Exercise the tight race: normal result/idle can already be queued when the
      // interrupt control promise rejects. Idle must await that rejection and keep
      // the outcome completed rather than trusting mere Stop intent.
      clients[0].emit({
        type: "result",
        uuid: "result-running",
        session_id: "standing-running",
        subtype: "success",
        result: "completed normally",
        usage: { output_tokens: 1 },
      });
      clients[0].emit({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        uuid: "idle-running",
        session_id: "standing-running",
      });
      throw new Error("control request rejected");
    };
    await expect(adapter.cancel(session)).resolves.toBe(false);
    await expect(response).resolves.toMatchObject({ text: "completed normally", stoppedReason: null });
    expect(events.flatMap((event) => event.blocks).at(-1)).toMatchObject({
      type: "turn_end",
      status: "completed",
    });
    await adapter.teardown(session);
  });

  it("rejects EOF before idle and closes a pending standing Query on teardown", async () => {
    const eof = standingAdapterFixture();
    const eofSession = await eof.adapter.spawn({
      provider: "anthropic",
      model: "sonnet",
      compositionDir: "/tmp",
      streamingInput: true,
    });
    const eofEvents: any[] = [];
    await eof.adapter.sendTurn(eofSession, "will eof", {
      generationId: "generation-eof",
      onEvent: (event: any) => eofEvents.push(event),
    });
    const eofResponse = eof.adapter.awaitResponse(eofSession);
    await waitFor(() => eof.inputs.length === 1, "EOF input");
    eof.clients[0].emit({ type: "result", uuid: "result-eof", subtype: "success", result: "not complete" });
    eof.clients[0].end();
    await expect(eofResponse).rejects.toThrow(/before turn settlement/i);
    expect(eof.clients[0].returnCount).toBe(0);
    expect(eofEvents.every((event) => event.generationId === "generation-eof")).toBe(true);
    expect(eofEvents.flatMap((event) => event.blocks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", kind: "runtime_error" }),
      expect.objectContaining({ type: "turn_end", status: "error" }),
    ]));

    const torn = standingAdapterFixture();
    const tornSession = await torn.adapter.spawn({
      provider: "anthropic",
      model: "sonnet",
      compositionDir: "/tmp",
      streamingInput: true,
    });
    await torn.adapter.sendTurn(tornSession, "pending", { generationId: "generation-teardown" });
    const tornResponse = torn.adapter.awaitResponse(tornSession);
    await waitFor(() => torn.inputs.length === 1, "teardown input");
    await torn.adapter.teardown(tornSession);
    await expect(tornResponse).rejects.toThrow(/torn down/i);
    expect(torn.clients[0].closeCount).toBe(1);
    expect(torn.clients[0].returnCount).toBe(0);
  });
});
