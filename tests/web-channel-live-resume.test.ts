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
const { startServer } = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
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
      "route",
      "chunk",
      "chunk",
      "activity",
      "tool",
      "chunk",
      "done",
    ]);
    const chunks = frames.filter((frame) => frame.event === "chunk").map((frame) => frame.payload);
    expect(chunks).toEqual([
      { text: "draft " },
      { text: "clean", replace: true },
      { text: " answer" },
    ]);

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
});
