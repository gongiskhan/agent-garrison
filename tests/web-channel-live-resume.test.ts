// Web Channel live-turn continuity.
//
// Drives the real web-channel server against a controllable fake gateway. The
// gateway pauses mid-turn so the assertions observe the state a user gets after
// navigating away and back: the ask is already on disk, route/session metadata is
// already usable, and /live replays then follows the exact ordered SSE frames.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-live-resume-"));
process.env.GARRISON_HOME = TMP_HOME;

// These modules freeze GARRISON_HOME at import time.
// @ts-ignore - plain ESM .mjs server
const server: any = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
const { startServer } = server;
// @ts-ignore - plain ESM .mjs store
const threads = await import("../fittings/seed/web-channel-default/scripts/threads.mjs");
// @ts-ignore - plain ESM .mjs parser
const transcript = await import("../fittings/seed/web-channel-default/lib/session-transcript.mjs");

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

let gateway: http.Server;
let webServer: http.Server;
let gatewayTurn: http.ServerResponse | null = null;
let webPort = 0;

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  gateway = http.createServer((req, res) => {
    if (req.url === "/chat/stream" && req.method === "POST") {
      // Drain the request so the socket remains in an ordinary keep-alive state.
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      gatewayTurn = res;
      res.write(sse("open", { generationId: "generation-live", ts: Date.now() }));
      // Agent SDK-style route metadata plus PTY-style replacement chunks prove the
      // continuity layer is runtime-neutral while preserving producer semantics.
      res.write(sse("route", {
        runtime: "agent-sdk",
        route: "agentsdk-primary",
        session_id: "agent-session-live",
        pending: true,
        turnSeq: 41,
      }));
      res.write(sse("chunk", { text: "draft " }));
      res.write(sse("chunk", { text: "clean", replace: true }));
      res.write(sse("activity", { kind: "thinking", text: "checking the repository" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));

  const started = await startServer({
    port: 0,
    host: "127.0.0.1",
    gatewayUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
  });
  webServer = started.server;
  if (!webServer.listening) await new Promise<void>((resolve) => webServer.once("listening", resolve));
  webPort = (webServer.address() as any).port;
});

afterAll(async () => {
  try { gatewayTurn?.end(); } catch {}
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const api = (pathname: string) => `http://127.0.0.1:${webPort}${pathname}`;

function parseFrames(raw: string) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (event === "message" && data.length === 0) return null;
      let payload: any = {};
      try { payload = JSON.parse(data.join("\n")); } catch {}
      return { event, payload };
    })
    .filter(Boolean) as { event: string; payload: any }[];
}

describe("web-channel live turn replay/resume", () => {
  it("persists the ask, stores route session metadata, replays/follows, and ends after done", async () => {
    const id = "chat-live-resume";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source: "chat" }),
    });

    // Keep this request alive while a second client reconnects to /live.
    const originalTurn = fetch(api("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: "Please continue after I navigate away", thread: id, turnSeq: 41 }),
    }).then(async (response) => ({ status: response.status, text: await response.text() }));

    await waitFor(async () => (gatewayTurn ? gatewayTurn : null), "fake gateway turn");
    const midTurn: any = await waitFor(async () => {
      const thread: any = await threads.getThread(id);
      return thread?.messages?.length === 1 && thread.claudeSessionId === "agent-session-live" ? thread : null;
    }, "user persistence and route session metadata");
    expect(midTurn.messages).toEqual([
      expect.objectContaining({ role: "user", text: "Please continue after I navigate away" }),
    ]);

    const running: any = await (await fetch(api(`/api/threads/${id}`))).json();
    expect(running.thread.runningSince).toEqual(expect.any(String));

    // Subscription is established before the producer continues, making the
    // boundary between replayed and followed frames observable.
    const live = await fetch(api(`/api/threads/${id}/live`), {
      headers: { accept: "text/event-stream" },
    });
    expect(live.status).toBe(200);
    const liveBody = live.text();

    gatewayTurn!.write(sse("tool", { name: "Read", id: "toolu_live" }));
    gatewayTurn!.write(sse("chunk", { text: " answer" }));
    gatewayTurn!.write(sse("done", {
      reply: "clean answer",
      runtime: "agent-sdk",
      session_id: "agent-session-live",
      turnSeq: 41,
    }));
    gatewayTurn!.end();
    gatewayTurn = null;

    const [liveRaw, original] = await Promise.all([liveBody, originalTurn]);
    expect(original.status).toBe(200);
    expect(original.text).toContain("event: done");

    const frames = parseFrames(liveRaw);
    expect(frames.map((frame) => frame.event)).toEqual([
      "input",
      "input",
      "input",
      "open",
      "route",
      "chunk",
      "chunk",
      "activity",
      "tool",
      "chunk",
      "done",
      "input",
    ]);
    const chunkFrames = frames.filter((frame) => frame.event === "chunk");
    const chunks = chunkFrames.map((frame) => ({
      text: frame.payload.text,
      ...(frame.payload.replace ? { replace: true } : {}),
    }));
    expect(chunks).toEqual([
      { text: "draft " },
      { text: "clean", replace: true },
      { text: " answer" },
    ]);
    expect(chunkFrames.every((frame) => frame.payload.generationId === "generation-live")).toBe(true);
    expect(new Set(chunkFrames.map((frame) => frame.payload.inputId)).size).toBe(1);

    const settled: any = await waitFor(async () => {
      const thread: any = await threads.getThread(id);
      return thread?.messages?.length === 2 ? thread : null;
    }, "settled assistant persistence");
    expect(settled.messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
    expect(settled.messages[1]).toMatchObject({
      text: "clean answer",
      route: { runtime: "agent-sdk", sessionId: "agent-session-live" },
    });

    const idle: any = await (await fetch(api(`/api/threads/${id}`))).json();
    expect(idle.thread.runningSince).toBeNull();
    expect((await fetch(api(`/api/threads/${id}/live`))).status).toBe(404);
  });
});

describe("web-channel Agent SDK journal normalization", () => {
  it("rebuilds stable per-turn canonical events from a durable session transcript", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "journal-user-1",
        timestamp: "2026-08-04T08:00:00.000Z",
        message: { content: "first prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-draft",
        timestamp: "2026-08-04T08:00:01.000Z",
        message: { id: "provider-message-1", content: [{ type: "text", text: "partial" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-settled",
        timestamp: "2026-08-04T08:00:02.000Z",
        message: { id: "provider-message-1", content: [{ type: "text", text: "partial answer" }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "wrapper-result",
        timestamp: "2026-08-04T08:00:03.000Z",
        message: {
          id: "provider-result-1",
          content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "done" }],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "journal-user-2",
        timestamp: "2026-08-04T08:01:00.000Z",
        message: { content: [{ type: "text", text: "second prompt" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-second",
        timestamp: "2026-08-04T08:01:01.000Z",
        message: { id: "provider-message-2", content: [{ type: "text", text: "second answer" }] },
      }),
    ];

    const recovered: any[] = transcript.recoverTranscriptSessionEvents(lines, { sessionId: "session-a" });
    expect(recovered.map((event) => event.id)).toEqual([
      "provider-message-1",
      "provider-result-1",
      "provider-message-2",
    ]);
    expect(recovered[0]).toMatchObject({
      role: "assistant",
      sessionId: "session-a",
      revision: 2,
      blocks: [{ type: "text", text: "partial answer" }],
    });
    expect(recovered[1]).toMatchObject({ role: "user", toolResultsOnly: true });
    expect(recovered[0].turnId).toBe(recovered[1].turnId);
    expect(recovered[2].turnId).not.toBe(recovered[0].turnId);
    expect(JSON.stringify(recovered)).not.toContain("first prompt");
    expect(JSON.stringify(recovered)).not.toContain("second prompt");
  });

  it("uses the user wrapper identity when a provider boundary id is blank", () => {
    const lines = [
      JSON.stringify({ type: "user", uuid: "user-one", timestamp: "2026-08-04T08:00:00.000Z", message: { id: "", content: "one" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-one", timestamp: "2026-08-04T08:00:01.000Z", message: { id: "answer-one", content: [{ type: "text", text: "one" }] } }),
      JSON.stringify({ type: "user", uuid: "user-two", timestamp: "2026-08-04T08:01:00.000Z", message: { id: "", content: "two" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-two", timestamp: "2026-08-04T08:01:01.000Z", message: { id: "answer-two", content: [{ type: "text", text: "two" }] } }),
    ];
    const recovered = transcript.recoverTranscriptSessionEvents(lines, { sessionId: "blank-boundaries" });
    expect(recovered).toHaveLength(2);
    expect(recovered[0].turnId).not.toBe(recovered[1].turnId);
  });

  it("fills missing activity and strict partial snapshots without erasing typed durable state", () => {
    const durable: any[] = [
      {
        id: "provider-message-1",
        role: "assistant",
        ts: Date.parse("2026-08-04T08:00:01.000Z"),
        turnId: "input-1",
        sessionId: "session-a",
        generationId: "generation-a",
        order: 7,
        revision: 8,
        blocks: [{ type: "text", text: "partial" }],
      },
      {
        id: "typed-terminal",
        role: "assistant",
        ts: Date.parse("2026-08-04T08:02:00.000Z"),
        turnId: "input-1",
        order: 8,
        revision: 2,
        blocks: [{ type: "error", kind: "runtime", text: "durable failure" }],
      },
    ];
    const recovered: any[] = [
      {
        id: "provider-message-1",
        role: "assistant",
        ts: Date.parse("2026-08-04T08:00:02.000Z"),
        turnId: "transcript-turn-a",
        sessionId: "session-a",
        order: 1,
        revision: 1,
        blocks: [
          { type: "text", text: "partial answer" },
          { type: "tool_use", toolUseId: "toolu-added", name: "Read", input: "{}" },
        ],
      },
      {
        id: "typed-terminal",
        role: "assistant",
        ts: Date.parse("2026-08-04T08:02:00.000Z"),
        turnId: "transcript-turn-a",
        sessionId: "session-a",
        order: 2,
        revision: 1,
        blocks: [{ type: "text", text: "not authoritative" }],
      },
      {
        id: "missing-tool",
        role: "assistant",
        ts: Date.parse("2026-08-04T08:00:03.000Z"),
        turnId: "transcript-turn-a",
        sessionId: "session-a",
        order: 3,
        revision: 1,
        blocks: [{ type: "tool_use", toolUseId: "toolu-1", name: "Read", input: "{}" }],
      },
    ];

    const merged: any[] = transcript.reconcileTranscriptSessionEvents(durable, recovered);
    expect(merged.map((event) => event.id)).toEqual([
      "provider-message-1",
      "missing-tool",
      "typed-terminal",
    ]);
    expect(merged[0]).toMatchObject({
      turnId: "input-1",
      generationId: "generation-a",
      order: 7,
      revision: 9,
      blocks: [
        { type: "text", text: "partial answer" },
        { type: "tool_use", toolUseId: "toolu-added", name: "Read", input: "{}" },
      ],
    });
    expect(merged[2].blocks).toEqual([{ type: "error", kind: "runtime", text: "durable failure" }]);
  });

  it("never promotes a colliding provider id across sessions or a different tool input", () => {
    const base = {
      id: "provider-collision",
      role: "assistant",
      ts: 1,
      turnId: "input-1",
      sessionId: "session-a",
      order: 1,
      revision: 3,
      blocks: [{ type: "tool_use", toolUseId: "tool-1", name: "Write", input: '{"safe":true}' }],
    };
    const crossSession = transcript.reconcileTranscriptSessionEvents([base], [{
      ...base,
      sessionId: "session-b",
      turnId: "transcript-b",
      revision: 1,
      blocks: [{ type: "tool_use", toolUseId: "tool-1", name: "Write", input: '{"different_and_longer":true}' }],
    }]);
    expect(crossSession).toHaveLength(2);
    expect(crossSession.find((entry: any) => entry.id === "provider-collision")).toEqual(base);
    expect(crossSession.find((entry: any) => entry.sessionId === "session-b")?.id).toMatch(/^recovered:/);

    const sameSessionDifferent = transcript.reconcileTranscriptSessionEvents([base], [{
      ...base,
      revision: 1,
      blocks: [{ type: "tool_use", toolUseId: "tool-1", name: "Write", input: '{"different_and_longer":true}' }],
    }]);
    expect(sameSessionDifferent).toEqual([base]);

    for (const input of ['{"safe":true,"evil":true}', '{"added":true}']) {
      const current = input.includes("safe") ? base : {
        ...base,
        blocks: [{ type: "tool_use", toolUseId: "tool-1", name: "Write", input: "{}" }],
      };
      expect(transcript.reconcileTranscriptSessionEvents([current], [{
        ...current,
        revision: 1,
        blocks: [{ type: "tool_use", toolUseId: "tool-1", name: "Write", input }],
      }])).toEqual([current]);
    }
  });

  it("keeps a promoted stable event in its durable chronological slot", () => {
    const durable = [
      {
        id: "partial-first",
        role: "assistant",
        ts: 10,
        turnId: "input-order",
        sessionId: "session-order",
        order: 1,
        revision: 2,
        blocks: [{ type: "text", text: "par" }],
      },
      {
        id: "control-second",
        role: "assistant",
        ts: 20,
        turnId: "input-order",
        sessionId: "session-order",
        order: 2,
        revision: 1,
        blocks: [{ type: "permission_request", status: "cancelled" }],
      },
    ];
    const merged = transcript.reconcileTranscriptSessionEvents(durable, [{
      ...durable[0],
      ts: 30,
      revision: 1,
      blocks: [{ type: "text", text: "partial complete" }],
    }]);
    expect(merged.map((entry: any) => entry.id)).toEqual(["partial-first", "control-second"]);
    expect(merged[0]).toMatchObject({ ts: 10, order: 1, revision: 3 });
  });

  it("promotes capped text snapshots without treating the truncation marker as content", () => {
    const prefix = "x".repeat(20_000);
    const durable = [{
      id: "capped-message",
      role: "assistant",
      ts: 1,
      turnId: "input-capped",
      sessionId: "session-capped",
      order: 1,
      revision: 2,
      blocks: [{ type: "text", text: `${prefix}\n… [truncated 1 chars]` }],
    }];
    const recovered = [{
      ...durable[0],
      revision: 1,
      blocks: [
        { type: "text", text: `${prefix}\n… [truncated 10000 chars]` },
        { type: "tool_use", toolUseId: "tool-after-cap", name: "Read", input: "{}" },
      ],
    }];
    expect(transcript.reconcileTranscriptSessionEvents(durable, recovered)[0]).toMatchObject({
      revision: 3,
      blocks: recovered[0].blocks,
    });

    const literal = [{
      ...durable[0],
      id: "literal-marker",
      blocks: [{ type: "text", text: "literal marker\n… [truncated 1 chars]" }],
    }];
    expect(transcript.reconcileTranscriptSessionEvents(literal, [{
      ...literal[0],
      revision: 1,
      blocks: [{ type: "text", text: "literal marker\n… [truncated 999 chars]" }],
    }])).toEqual(literal);
  });

  it("binds recovered turn groups to claimed intervals rather than queued admission time", () => {
    const thread = {
      messages: [
        { role: "user", turnId: "input-a", ts: "2026-08-04T08:00:00.000Z" },
        { role: "assistant", turnId: "input-a", ts: "2026-08-04T08:00:03.000Z" },
        // Legacy M4 rows used acceptedAt here even though B was claimed later.
        { role: "user", turnId: "input-b", ts: "2026-08-04T08:00:01.000Z" },
        { role: "assistant", turnId: "input-b", ts: "2026-08-04T08:00:06.000Z" },
      ],
      inputReceipts: [
        { inputId: "input-a", startedAt: "2026-08-04T08:00:00.000Z", settledAt: "2026-08-04T08:00:03.000Z" },
        { inputId: "input-b", startedAt: "2026-08-04T08:00:04.000Z", settledAt: "2026-08-04T08:00:06.000Z" },
      ],
    };
    const recovered = [
      { id: "a-tool", turnId: "journal-a", ts: Date.parse("2026-08-04T08:00:02.000Z") },
      { id: "a-result-late", turnId: "journal-a", ts: Date.parse("2026-08-04T08:00:04.500Z") },
      { id: "b-text", turnId: "journal-b", ts: Date.parse("2026-08-04T08:00:05.000Z") },
    ];
    expect(server.bindRecoveredEventsToThread(thread, recovered).map((entry: any) => entry.turnId)).toEqual([
      "input-a",
      "input-a",
      "input-b",
    ]);
  });

  it("assigns a singleton shared-boundary event to the later turn", () => {
    const thread = {
      messages: [
        { role: "user", turnId: "input-a", ts: "2026-08-04T08:00:00.000Z" },
        { role: "assistant", turnId: "input-a", ts: "2026-08-04T08:00:00.100Z" },
        { role: "user", turnId: "input-b", ts: "2026-08-04T08:00:00.100Z" },
        { role: "assistant", turnId: "input-b", ts: "2026-08-04T08:00:00.200Z" },
      ],
    };
    const bound = server.bindRecoveredEventsToThread(thread, [
      { id: "a", turnId: "journal-a", ts: Date.parse("2026-08-04T08:00:00.099Z") },
      { id: "b", turnId: "journal-b", ts: Date.parse("2026-08-04T08:00:00.100Z") },
    ]);
    expect(bound.map((entry: any) => entry.turnId)).toEqual(["input-a", "input-b"]);
  });

  it("does not bind legacy recovered history to a future generated input", () => {
    const thread = {
      messages: [
        { role: "user", text: "legacy ask", ts: "2026-08-01T08:00:00.000Z" },
        { role: "assistant", text: "legacy answer", ts: "2026-08-01T08:00:01.000Z" },
        { role: "user", text: "new ask", turnId: "input-new", ts: "2026-08-16T08:00:00.000Z" },
        { role: "assistant", text: "new answer", turnId: "input-new", ts: "2026-08-16T08:00:01.000Z" },
      ],
    };
    const bound = server.bindRecoveredEventsToThread(thread, [
      { id: "old-answer", turnId: "journal-old", ts: Date.parse("2026-08-01T08:00:01.000Z") },
      { id: "new-answer", turnId: "journal-new", ts: Date.parse("2026-08-16T08:00:00.500Z") },
    ]);
    expect(bound.map((entry: any) => entry.turnId)).toEqual(["journal-old", "input-new"]);
  });

  it("keeps a schedulable queued handoff live but ends a restart-parked queue", () => {
    const queued = [{ inputId: "input-b", state: "queued" }];
    expect(server.threadSessionJournalIsLive({ inputRecoveryBlocks: [] }, queued)).toBe(true);
    expect(server.threadSessionJournalIsLive({
      inputRecoveryBlocks: [{ inputId: "orphan-a", interruptedState: "starting" }],
    }, queued)).toBe(false);
    expect(server.threadSessionJournalIsLive({ inputRecoveryBlocks: [] }, [])).toBe(false);
  });

  it("hydrates and streams one reconciled journal across every recorded SDK session", async () => {
    const projects = path.join(TMP_HOME, "multi-session-projects");
    const project = path.join(projects, "project-a");
    fs.mkdirSync(project, { recursive: true });
    const priorRoot = process.env.GARRISON_CLAUDE_PROJECTS_DIR;
    process.env.GARRISON_CLAUDE_PROJECTS_DIR = projects;
    const sessionOne = "recovery-session-one";
    const sessionTwo = "recovery-session-two";
    fs.writeFileSync(path.join(project, `${sessionOne}.jsonl`), [
      JSON.stringify({
        type: "user",
        uuid: "user-a",
        timestamp: "2026-08-04T08:00:00.000Z",
        message: { content: "private prompt a" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-a",
        timestamp: "2026-08-04T08:00:01.000Z",
        message: { id: "message-a-tool", content: [{ type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "/tmp/a" } }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "user-b",
        timestamp: "2026-08-04T08:01:00.000Z",
        message: { content: "private prompt b" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-b",
        timestamp: "2026-08-04T08:01:01.000Z",
        message: { id: "message-b-text", content: [{ type: "text", text: "answer b" }] },
      }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(project, `${sessionTwo}.jsonl`), [
      JSON.stringify({
        type: "assistant",
        uuid: "wrapper-a-final",
        timestamp: "2026-08-04T08:00:02.000Z",
        message: { id: "message-a-final", content: [{ type: "text", text: "answer a" }] },
      }),
    ].join("\n") + "\n");

    const threadId = "chat-multi-session-recovery";
    await threads.ensureThread({ id: threadId, nowIso: "2026-08-04T08:00:00.000Z" });
    await threads.appendMessages(threadId, [
      { role: "user", text: "ask a", turnId: "input-a", ts: "2026-08-04T08:00:00.000Z" },
      { role: "assistant", text: "answer a", turnId: "input-a", ts: "2026-08-04T08:00:03.000Z" },
      { role: "user", text: "ask b", turnId: "input-b", ts: "2026-08-04T08:01:00.000Z" },
      { role: "assistant", text: "answer b", turnId: "input-b", ts: "2026-08-04T08:01:03.000Z" },
    ] as any[]);
    await threads.setThreadSession(threadId, sessionOne);
    await threads.setThreadSession(threadId, sessionTwo);

    try {
      const hydrated: any = await (await fetch(api(`/api/threads/${threadId}`))).json();
      expect(hydrated.thread.sessionEvents.map((entry: any) => entry.id)).toEqual([
        "message-a-tool",
        "message-a-final",
        "message-b-text",
      ]);
      expect(hydrated.thread.sessionEvents.map((entry: any) => entry.turnId)).toEqual([
        "input-a",
        "input-a",
        "input-b",
      ]);
      expect(JSON.stringify(hydrated.thread.sessionEvents)).not.toContain("private prompt");

      const raw = await (await fetch(api(`/api/session-stream?thread=${threadId}`))).text();
      const frames = parseFrames(raw);
      expect(frames[0]).toMatchObject({
        payload: {
          type: "init",
          live: false,
          events: hydrated.thread.sessionEvents,
        },
      });
      expect(frames.at(-1)?.payload).toEqual({ type: "end" });
    } finally {
      if (priorRoot === undefined) delete process.env.GARRISON_CLAUDE_PROJECTS_DIR;
      else process.env.GARRISON_CLAUDE_PROJECTS_DIR = priorRoot;
    }
  });

  it("keeps equal-timestamp session-chain order stable beyond the recovery cache cap", async () => {
    const projects = path.join(TMP_HOME, "cache-order-projects");
    const project = path.join(projects, "project-a");
    fs.mkdirSync(project, { recursive: true });
    const priorRoot = process.env.GARRISON_CLAUDE_PROJECTS_DIR;
    process.env.GARRISON_CLAUDE_PROJECTS_DIR = projects;
    const sessionIds = Array.from({ length: 65 }, (_, index) => `cache-session-${index + 1}`);
    sessionIds.forEach((sessionId, index) => {
      fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), `${JSON.stringify({
        type: "assistant",
        uuid: `wrapper-${index + 1}`,
        timestamp: "2026-08-04T09:00:00.000Z",
        message: { id: `cache-message-${index + 1}`, content: [{ type: "text", text: `answer ${index + 1}` }] },
      })}\n`);
    });
    try {
      const thread = { sessionIds, sessionEvents: [], messages: [] };
      const expected = sessionIds.map((_, index) => `cache-message-${index + 1}`);
      const first = await server.recoverThreadSessionJournal(thread);
      const second = await server.recoverThreadSessionJournal(thread);
      expect(first.map((entry: any) => entry.id)).toEqual(expected);
      expect(second.map((entry: any) => entry.id)).toEqual(expected);
    } finally {
      if (priorRoot === undefined) delete process.env.GARRISON_CLAUDE_PROJECTS_DIR;
      else process.env.GARRISON_CLAUDE_PROJECTS_DIR = priorRoot;
    }
  });

  it("refuses an ambiguous copied session journal", async () => {
    const projects = path.join(TMP_HOME, "ambiguous-projects");
    process.env.GARRISON_CLAUDE_PROJECTS_DIR = projects;
    for (const dir of ["project-a", "project-b"]) {
      fs.mkdirSync(path.join(projects, dir), { recursive: true });
      fs.writeFileSync(path.join(projects, dir, "duplicated-session.jsonl"), "{}\n");
    }
    await expect(server.findTranscriptBySession("duplicated-session")).resolves.toBeNull();
    delete process.env.GARRISON_CLAUDE_PROJECTS_DIR;
  });

  it("maps bash_progress to a runtime-neutral tool_progress block", () => {
    const line = JSON.stringify({
      type: "progress",
      uuid: "progress-1",
      timestamp: "2026-08-04T08:00:00.000Z",
      parentToolUseID: "toolu_bash",
      data: {
        type: "bash_progress",
        output: "older output",
        fullOutput: "line one\nline two",
        elapsedTimeSeconds: 2.75,
        taskId: "bash-task",
        timeoutMs: 120_000,
        totalBytes: 17,
        totalLines: 2,
      },
    });
    const parsed: any = transcript.parseTranscriptLines([line]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].blocks[0]).toEqual({
      type: "tool_progress",
      toolUseId: "toolu_bash",
      text: "line one\nline two",
      elapsedMs: 2750,
      status: "running",
      taskId: "bash-task",
      timeoutMs: 120_000,
      totalBytes: 17,
      totalLines: 2,
    });
  });

  it("grounds a related task from live agent_progress without exposing its internal agent id", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-04T08:01:00.000Z",
        message: { content: [{
          type: "tool_use",
          id: "toolu_agent",
          name: "Agent",
          input: { description: "Inspect the live stream", subagent_type: "claude" },
        }] },
      }),
      JSON.stringify({
        type: "progress",
        timestamp: "2026-08-04T08:01:01.000Z",
        parentToolUseID: "toolu_agent",
        data: { type: "agent_progress", agentId: "internal-agent-42", message: "Reading the transport" },
      }),
    ];
    const events: any[] = transcript.relatedTaskEvents(lines, {
      streamUrlFor: (task: any) => task.agentId ? `/api/session-stream?session=parent&task=${task.taskId}` : null,
    });
    expect(events).toHaveLength(1);
    expect(events[0].blocks[0]).toEqual({
      type: "related_task",
      toolUseId: "toolu_agent",
      taskId: "task-toolu_agent",
      name: "Inspect the live stream",
      detail: "claude",
      status: "running",
      text: "Reading the transport",
      streamUrl: "/api/session-stream?session=parent&task=task-toolu_agent",
    });
    expect(JSON.stringify(events)).not.toContain("internal-agent-42");
  });

  it("keeps task-completion metadata out of user turns while retaining related-task status", () => {
    const notification = [
      "<task-notification>",
      "<tool-use-id>toolu_agent_done</tool-use-id>",
      "<status>completed</status>",
      "<summary>Inspection finished</summary>",
      "</task-notification>",
    ].join("\n");
    const lines = [
      JSON.stringify({
        type: "assistant",
        uuid: "agent-launch",
        timestamp: "2026-08-04T08:02:00.000Z",
        message: { content: [{
          type: "tool_use",
          id: "toolu_agent_done",
          name: "Agent",
          input: { description: "Inspect fan-out" },
        }] },
      }),
      JSON.stringify({
        type: "user",
        uuid: "internal-completion",
        timestamp: "2026-08-04T08:02:01.000Z",
        message: { content: [{ type: "text", text: notification }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "final-answer",
        timestamp: "2026-08-04T08:02:02.000Z",
        message: { content: [{ type: "text", text: "Final answer" }] },
      }),
    ];

    const parsed: any = transcript.parseTranscriptLines(lines);
    expect(parsed.events.map((event: any) => event.id)).toEqual(["agent-launch", "final-answer"]);
    expect(JSON.stringify(parsed.events)).not.toContain("task-notification");

    const related: any[] = transcript.relatedTaskEvents(lines);
    expect(related).toHaveLength(1);
    expect(related[0].blocks[0]).toMatchObject({
      toolUseId: "toolu_agent_done",
      status: "completed",
      text: "Inspection finished",
    });
  });
});
