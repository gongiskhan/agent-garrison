import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-restart-reconcile-"));
process.env.GARRISON_HOME = TMP_HOME;

// Both modules freeze GARRISON_HOME at import time and must share one store.
// @ts-ignore dependency-free fitting JavaScript intentionally has no full .d.ts.
const threads: any = await import("../packages/talk/src/threads.mjs");
// @ts-ignore dependency-free fitting JavaScript intentionally has no full .d.ts.
const server: any = await import("../packages/talk/src/server.mjs");
const {
  startServer,
  agentSdkResumeFromThread,
  agentSdkNewGenerationFromThread,
  bindRecoveredEventsToThread,
} = server;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const SIGNED_OPUS_ASSEMBLY = {
  version: 2,
  target: "claude-opus",
  runtime: "agent-sdk",
  provider: "anthropic",
  model: "claude-opus-4-1",
  account: null,
  accountSource: null,
  projectPath: null,
  assembly: `a1:${"e".repeat(64)}`,
};

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

type GatewayTurn = { body: any; response: http.ServerResponse; generationId: string };
let gateway: http.Server;
const gatewayTurns: GatewayTurn[] = [];
const gatewayInterrupts: any[] = [];
const gatewayRecoveries: any[] = [];
const startingGenerationLookups: any[] = [];
let startingLookupEnabled = false;
let startingClaimLive = true;
let knownClaimLive = true;
let knownRecoveryAttempts = 0;
let retryClaimLive = true;
let retryLookupAttempts = 0;
const webServers: http.Server[] = [];

beforeAll(async () => {
  gateway = http.createServer(async (req, res) => {
    if (req.url === "/chat/generation" && req.method === "POST") {
      const body = await readBody(req);
      startingGenerationLookups.push(body);
      res.setHeader("content-type", "application/json");
      if (body.inputId === "known-active-input") {
        if (knownClaimLive) {
          res.statusCode = 200;
          res.end(JSON.stringify({
            ok: true,
            threadId: body.threadId,
            inputId: body.inputId,
            generationId: "known-old-generation",
            lane: "agent-sdk",
            state: "running",
          }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({
            ok: false,
            error: "input generation is unavailable",
            code: "input_generation_unavailable",
          }));
        }
      } else if (body.inputId === "retry-active-input") {
        retryLookupAttempts += 1;
        if (retryLookupAttempts === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "gateway ownership index unavailable" }));
        } else if (retryLookupAttempts === 2) {
          res.statusCode = 409;
          res.end(JSON.stringify({
            ok: false,
            error: "thread belongs to another input",
            code: "thread_input_generation_conflict",
          }));
        } else if (retryClaimLive) {
          res.statusCode = 200;
          res.end(JSON.stringify({
            ok: true,
            threadId: body.threadId,
            inputId: body.inputId,
            generationId: "retry-old-generation",
            lane: "agent-sdk",
            state: "running",
          }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({
            ok: false,
            error: "input generation is unavailable",
            code: "input_generation_unavailable",
          }));
        }
      } else if (!startingLookupEnabled) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "gateway ownership index unavailable" }));
      } else if (startingClaimLive) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          threadId: body.threadId,
          inputId: body.inputId,
          generationId: "starting-old-generation",
          lane: "agent-sdk",
          state: "running",
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({
          ok: false,
          error: "input generation is unavailable",
          code: "input_generation_unavailable",
        }));
      }
      return;
    }
    if (req.url === "/chat/recover" && req.method === "POST") {
      const body = await readBody(req);
      gatewayRecoveries.push(body);
      res.setHeader("content-type", "application/json");
      if (body.inputId === "known-active-input") {
        knownRecoveryAttempts += 1;
        if (knownRecoveryAttempts === 1) {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: "cancel primitive did not stop" }));
        } else {
          knownClaimLive = false;
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, stopped: true, generationId: "known-old-generation" }));
        }
        return;
      }
      if (body.inputId === "retry-active-input") {
        retryClaimLive = false;
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, stopped: true, generationId: "retry-old-generation" }));
        return;
      }
      if (body.inputId === "starting-active-input") {
        startingClaimLive = false;
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, stopped: true, generationId: "starting-old-generation" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "input_generation_unavailable" }));
      return;
    }
    if (req.url === "/chat/interrupt" && req.method === "POST") {
      const body = await readBody(req);
      gatewayInterrupts.push(body);
      res.setHeader("content-type", "application/json");
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "restart recovery must use exact input ownership" }));
      return;
    }
    if (req.url === "/chat/stream" && req.method === "POST") {
      const body = await readBody(req);
      const generationId = `generation-successor-${gatewayTurns.length + 1}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      gatewayTurns.push({ body, response: res, generationId });
      res.write(sse("open", { generationId, ts: Date.now() }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  for (const turn of gatewayTurns) {
    try { turn.response.end(); } catch {}
  }
  for (const server of webServers) {
    await closeServer(server);
  }
  await closeServer(gateway);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("Web process-restart input reconciliation", () => {
  it("atomically fails uncertain ownership, cancels controls, and preserves the queued tail", async () => {
    const threadId = "restart-store-contract";
    await threads.ensureThread({ id: threadId, nowIso: "2026-08-16T10:00:00.000Z" });
    await threads.appendMessages(threadId, [{
      role: "assistant",
      text: "older durable SDK reply",
      route: {
        route: "claude-opus",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-opus-4-1",
        sessionId: "prior-sdk-session",
        spawnSignature: SIGNED_OPUS_ASSEMBLY,
      },
    }], { nowIso: "2026-08-16T09:59:59.000Z" });
    await threads.setThreadSession(threadId, "prior-sdk-session");
    expect(agentSdkResumeFromThread(await threads.getThread(threadId))).toMatchObject({
      sessionId: "prior-sdk-session",
    });
    await threads.admitThreadInput(threadId, {
      message: "uncertain side effect",
      clientRequestId: "restart-store-active",
    }, { inputId: "restart-store-input", nowIso: "2026-08-16T10:00:01.000Z" });
    await threads.claimNextThreadInput(threadId, { nowIso: "2026-08-16T10:00:02.000Z" });
    // B is admitted while A is already active. Its eventual user-message
    // timestamp must be promotion time, not this admission time, so A's journal
    // events cannot be grouped under the queued successor.
    await threads.admitThreadInput(threadId, {
      message: "safe successor",
      clientRequestId: "restart-store-successor",
    }, { inputId: "restart-store-next", nowIso: "2026-08-16T10:00:03.000Z" });
    await threads.bindThreadInputGeneration(
      threadId,
      "restart-store-input",
      "restart-store-generation",
      { nowIso: "2026-08-16T10:00:04.000Z" },
    );
    await threads.markThreadInputStopping(
      threadId,
      "restart-store-input",
      "restart-store-generation",
      { nowIso: "2026-08-16T10:00:05.000Z" },
    );
    await threads.appendSessionEvent(threadId, {
      id: "restart-permission",
      role: "assistant",
      ts: 1_787_000_000_000,
      turnId: "restart-store-input",
      generationId: "restart-store-generation",
      order: 0,
      revision: 3,
      blocks: [{
        type: "permission_request",
        requestId: "restart-request",
        generationId: "restart-store-generation",
        name: "Bash",
        input: "{\"command\":\"do-side-effect\"}",
        inputComplete: true,
        suggestionsComplete: true,
        status: "pending",
      }],
    });

    const reconciled = await threads.reconcileInterruptedThreadInputs({
      nowIso: "2026-08-16T10:01:00.000Z",
    });
    expect(reconciled.find((entry: any) => entry.threadId === threadId)).toMatchObject({
      failedInputs: [{
        inputId: "restart-store-input",
        state: "failed",
        generationId: "restart-store-generation",
        interruptedState: "stopping",
      }],
      recoveryInputs: [{
        inputId: "restart-store-input",
        generationId: "restart-store-generation",
        interruptedState: "stopping",
      }],
      queuedInputs: [{ inputId: "restart-store-next", state: "queued", position: 1 }],
    });

    // These facts come from one renamed JSON snapshot; no split receipt/message/
    // control update is observable after the reconciliation promise resolves.
    const stored = threads._readThreadSync(threadId);
    expect(stored.pendingInputs).toMatchObject([{ inputId: "restart-store-next", state: "queued" }]);
    expect(stored.inputReceipts).toMatchObject([{
      inputId: "restart-store-input",
      state: "failed",
      generationId: "restart-store-generation",
      startedAt: "2026-08-16T10:00:02.000Z",
    }]);
    expect(stored.inputRecoveryBlocks).toMatchObject([{
      inputId: "restart-store-input",
      interruptedState: "stopping",
      generationId: "restart-store-generation",
    }]);
    expect(stored.messages.filter((message: any) =>
      message.role === "assistant" && message.turnId === "restart-store-input"
    )).toEqual([expect.objectContaining({
      text: "",
      route: expect.objectContaining({
        stoppedReason: expect.stringContaining("not replayed"),
      }),
      agentSdkResumeBarrier: true,
    })]);
    expect(stored.messages.find((message: any) =>
      message.role === "user" && message.turnId === "restart-store-input"
    )?.ts).toBe("2026-08-16T10:00:02.000Z");
    expect(agentSdkResumeFromThread(stored)).toBeNull();
    expect(agentSdkNewGenerationFromThread(stored)).toBe(true);
    expect(stored.sessionEvents[0]).toMatchObject({
      id: "restart-permission",
      revision: 4,
      blocks: [{ type: "permission_request", status: "cancelled", reason: expect.stringContaining("not replayed") }],
    });

    // The durable ownership marker, not process memory, keeps the successor
    // unclaimable. Re-running startup neither duplicates the failure nor bumps the
    // cancelled permission revision.
    expect(await threads.claimNextThreadInput(threadId)).toBeNull();
    await threads.reconcileInterruptedThreadInputs({ nowIso: "2026-08-16T10:02:00.000Z" });
    const repeated = await threads.getThread(threadId);
    expect(repeated.messages.filter((message: any) =>
      message.role === "assistant" && message.turnId === "restart-store-input"
    )).toHaveLength(1);
    expect(repeated.sessionEvents[0].revision).toBe(4);

    expect(await threads.clearThreadInputRecoveryBlock(threadId, "restart-store-input")).toBe(true);
    expect(await threads.claimNextThreadInput(threadId, {
      nowIso: "2026-08-16T10:03:00.000Z",
    })).toMatchObject({
      inputId: "restart-store-next",
      state: "starting",
    });
    expect((await threads.getThread(threadId)).messages.find((message: any) =>
      message.role === "user" && message.turnId === "restart-store-next"
    )?.ts).toBe("2026-08-16T10:03:00.000Z");
    expect(bindRecoveredEventsToThread(await threads.getThread(threadId), [{
      id: "journal-event-from-active-a",
      ts: Date.parse("2026-08-16T10:01:00.000Z"),
      blocks: [],
    }])[0].turnId).toBe("restart-store-input");
    await threads.appendMessages(threadId, [{
      role: "assistant",
      text: "clean successor reply",
      turnId: "restart-store-next",
      route: {
        route: "claude-opus",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-opus-4-1",
        sessionId: "clean-sdk-session",
        spawnSignature: SIGNED_OPUS_ASSEMBLY,
      },
    }], { nowIso: "2026-08-16T10:03:59.000Z" });
    await threads.setThreadSession(threadId, "clean-sdk-session");
    expect(await threads.settleThreadInput(threadId, "restart-store-next", "settled", {
      nowIso: "2026-08-16T10:04:00.000Z",
    })).toMatchObject({
      inputId: "restart-store-next",
      startedAt: "2026-08-16T10:03:00.000Z",
      settledAt: "2026-08-16T10:04:00.000Z",
    });
    const cleanGeneration = await threads.getThread(threadId);
    expect(agentSdkNewGenerationFromThread(cleanGeneration)).toBe(false);
    expect(agentSdkResumeFromThread(cleanGeneration)).toMatchObject({
      sessionId: "clean-sdk-session",
    });
    expect(await threads.deleteThread(threadId)).toBe(true);
  });

  it("exact-recovers old ownership, retries in-process, and never replays an uncertain input", async () => {
    const knownThread = "restart-server-known";
    const retryThread = "restart-server-retry";
    const startingThread = "restart-server-starting";
    await threads.ensureThread({ id: knownThread });
    await threads.admitThreadInput(knownThread, {
      message: "known active must not replay",
      clientRequestId: "known-active-client",
    }, { inputId: "known-active-input" });
    await threads.admitThreadInput(knownThread, {
      message: "known queued successor",
      clientRequestId: "known-next-client",
    }, { inputId: "known-next-input" });
    await threads.claimNextThreadInput(knownThread);
    await threads.bindThreadInputGeneration(knownThread, "known-active-input", "known-old-generation");

    await threads.ensureThread({ id: retryThread });
    await threads.admitThreadInput(retryThread, {
      message: "retry active must not replay",
      clientRequestId: "retry-active-client",
    }, { inputId: "retry-active-input" });
    await threads.admitThreadInput(retryThread, {
      message: "retry queued successor",
      clientRequestId: "retry-next-client",
    }, { inputId: "retry-next-input" });
    await threads.claimNextThreadInput(retryThread);

    await threads.ensureThread({ id: startingThread });
    await threads.admitThreadInput(startingThread, {
      message: "pre-open active must not replay",
      clientRequestId: "starting-active-client",
    }, { inputId: "starting-active-input" });
    await threads.admitThreadInput(startingThread, {
      message: "starting queued successor",
      clientRequestId: "starting-next-client",
    }, { inputId: "starting-next-input" });
    await threads.claimNextThreadInput(startingThread);

    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}`;
    const first = await startServer({
      port: 0,
      host: "127.0.0.1",
      gatewayUrl,
      restartRecoveryAttempts: 6,
      restartRecoveryDelayMs: 20,
    });
    webServers.push(first.server);
    if (!first.server.listening) await new Promise<void>((resolve) => first.server.once("listening", resolve));
    const firstPort = (first.server.address() as any).port;
    expect((await fetch(`http://127.0.0.1:${firstPort}/health`)).status).toBe(200);

    await waitFor(() => gatewayTurns.length, (count) => count === 2, "in-process successor dispatches");
    expect(gatewayRecoveries.filter((body) => body.inputId === "known-active-input")).toEqual([
      { threadId: knownThread, inputId: "known-active-input" },
      { threadId: knownThread, inputId: "known-active-input" },
    ]);
    expect(gatewayRecoveries.filter((body) => body.inputId === "retry-active-input")).toEqual([
      { threadId: retryThread, inputId: "retry-active-input" },
    ]);
    expect(gatewayInterrupts).toEqual([]);
    const knownTurn = gatewayTurns.find((turn) => turn.body.inputId === "known-next-input");
    const retryTurn = gatewayTurns.find((turn) => turn.body.inputId === "retry-next-input");
    expect(knownTurn?.body.message).toBe("known queued successor");
    expect(retryTurn?.body.message).toBe("retry queued successor");
    expect(gatewayTurns.map((turn) => turn.body.message)).not.toContain("known active must not replay");
    expect(gatewayTurns.map((turn) => turn.body.message)).not.toContain("retry active must not replay");
    expect(gatewayTurns.map((turn) => turn.body.message)).not.toContain("pre-open active must not replay");
    expect(gatewayTurns.map((turn) => turn.body.message)).not.toContain("starting queued successor");
    expect(gatewayTurns.every((turn) => turn.body.agentSdkNewGeneration === true)).toBe(true);
    expect(gatewayTurns.every((turn) => turn.body.agentSdkResume === undefined)).toBe(true);
    expect(startingGenerationLookups.filter((body) => body.inputId === "retry-active-input")).toHaveLength(4);

    const parked = await threads.getThread(startingThread);
    expect(parked.pendingInputs).toMatchObject([{ inputId: "starting-next-input", state: "queued" }]);
    expect(parked.inputRecoveryBlocks).toMatchObject([{
      inputId: "starting-active-input",
      interruptedState: "starting",
    }]);
    expect(await threads.claimNextThreadInput(startingThread)).toBeNull();
    await waitFor(
      () => startingGenerationLookups.filter((body) => body.inputId === "starting-active-input").length,
      (count) => count === 6,
      "bounded unavailable starting-input reconciliation",
    );
    const parkedTranscript = await fetch(
      `http://127.0.0.1:${firstPort}/api/session-stream?thread=${startingThread}`,
    );
    const parkedTranscriptBody = await parkedTranscript.text();
    expect(parkedTranscriptBody).toContain('"live":false');
    expect(parkedTranscriptBody).toContain('"type":"end"');

    // Startup recreated a live registry even for the visibly parked queued item;
    // it has no producer until exact ownership reconciliation succeeds.
    const parkedLiveController = new AbortController();
    const parkedLive = await fetch(
      `http://127.0.0.1:${firstPort}/api/threads/${startingThread}/inputs/starting-next-input/live`,
      { signal: parkedLiveController.signal },
    );
    expect(parkedLive.status).toBe(200);
    await parkedLive.body?.cancel();
    parkedLiveController.abort();

    knownTurn?.response.write(sse("done", { reply: "known successor completed" }));
    knownTurn?.response.end();
    retryTurn?.response.write(sse("done", { reply: "retry successor completed" }));
    retryTurn?.response.end();
    await Promise.all([
      waitFor(
        () => threads.getThread(knownThread),
        (thread: any) => thread?.pendingInputs?.length === 0,
        "known successor settlement",
      ),
      waitFor(
        () => threads.getThread(retryThread),
        (thread: any) => thread?.pendingInputs?.length === 0,
        "retry successor settlement",
      ),
    ]);
    await closeServer(first.server);

    const startingLookupsBeforeRestart = startingGenerationLookups.filter(
      (body) => body.inputId === "starting-active-input",
    ).length;
    startingLookupEnabled = true;
    const second = await startServer({
      port: 0,
      host: "127.0.0.1",
      gatewayUrl,
      restartRecoveryAttempts: 3,
      restartRecoveryDelayMs: 0,
    });
    webServers.push(second.server);
    if (!second.server.listening) await new Promise<void>((resolve) => second.server.once("listening", resolve));

    await waitFor(() => gatewayTurns.length, (count) => count === 3, "starting successor dispatch after exact clear");
    expect(startingGenerationLookups.filter(
      (body) => body.inputId === "starting-active-input",
    ).slice(startingLookupsBeforeRestart)).toEqual([
      { threadId: startingThread, inputId: "starting-active-input" },
      { threadId: startingThread, inputId: "starting-active-input" },
    ]);
    expect(gatewayRecoveries.at(-1)).toEqual({
      threadId: startingThread,
      inputId: "starting-active-input",
    });
    const startingTurn = gatewayTurns.find((turn) => turn.body.inputId === "starting-next-input");
    expect(startingTurn?.body.message).toBe("starting queued successor");
    startingTurn?.response.write(sse("done", { reply: "starting successor completed" }));
    startingTurn?.response.end();
    await waitFor(
      () => threads.getThread(startingThread),
      (thread: any) => thread?.pendingInputs?.length === 0,
      "starting successor settlement",
    );
    await closeServer(second.server);

    const third = await startServer({ port: 0, host: "127.0.0.1", gatewayUrl });
    webServers.push(third.server);
    if (!third.server.listening) await new Promise<void>((resolve) => third.server.once("listening", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gatewayTurns).toHaveLength(3);
    expect(gatewayTurns.map((turn) => turn.body.inputId).sort()).toEqual([
      "known-next-input",
      "retry-next-input",
      "starting-next-input",
    ]);
    expect(gatewayTurns.every((turn) => turn.body.agentSdkNewGeneration === true)).toBe(true);
    expect(gatewayTurns.every((turn) => turn.body.agentSdkResume === undefined)).toBe(true);

    for (const threadId of [knownThread, retryThread, startingThread]) {
      const stored = await threads.getThread(threadId);
      expect(stored.messages.filter((message: any) =>
        message.role === "assistant" &&
        message.agentSdkResumeBarrier === true &&
        message.text === "" &&
        message.route?.stoppedReason?.includes("not replayed")
      )).toHaveLength(1);
      expect(stored.inputRecoveryBlocks).toEqual([]);
    }
  });
});
