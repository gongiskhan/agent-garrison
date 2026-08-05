import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

// @ts-ignore — source-only fitting module.
import {
  clearLiveSessionPointer,
  liveSessionPointerFile,
  readLiveSessionPointer,
  writeLiveSessionPointer
} from "../fittings/seed/kanban-loop/lib/live-session.mjs";
// @ts-ignore — source-only fitting module.
import { parseTranscriptLines, relatedTaskEvents } from "../fittings/seed/kanban-loop/lib/session-transcript.mjs";
// @ts-ignore — source-only fitting module.
import { createCard, loadCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — source-only fitting module.
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "kanban-live-session-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("card-local live journal pointer", () => {
  it("is visible only to the matching running generation and cleanup cannot hit its successor", async () => {
    const root = tempRoot();
    const first = { id: "01KZ9GRDM6MW6Y76K93WXCJGYR", status: "running", runSeq: 7 };
    const second = { ...first, runSeq: 8 };

    await writeLiveSessionPointer(root, first, {
      sessionId: "runtime-session-7",
      transcriptPath: "/runtime/journals/runtime-session-7.jsonl"
    }, "2026-08-05T18:00:00.000Z");
    await writeLiveSessionPointer(root, second, { sessionId: "runtime-session-8" });

    expect(await readLiveSessionPointer(root, first)).toMatchObject({ runSeq: 7, sessionId: "runtime-session-7" });
    expect(await readLiveSessionPointer(root, second)).toMatchObject({ runSeq: 8, sessionId: "runtime-session-8" });
    expect(await readLiveSessionPointer(root, { ...first, status: "ok" })).toBeNull();

    await clearLiveSessionPointer(root, first.id, first.runSeq);
    expect(await readLiveSessionPointer(root, first)).toBeNull();
    expect(await readLiveSessionPointer(root, second)).toMatchObject({ sessionId: "runtime-session-8" });
  });

  it("rejects malformed or path-steering identities", async () => {
    const root = tempRoot();
    const card = { id: "../escape", status: "running", runSeq: 1 };
    expect(liveSessionPointerFile(root, card.id, card.runSeq)).toBeNull();
    expect(await writeLiveSessionPointer(root, { ...card, id: "safe-card" }, { sessionId: "../../secret" })).toBeNull();

    const valid = { id: "safe-card", status: "running", runSeq: 2 };
    await writeLiveSessionPointer(root, valid, { sessionId: "safe-session" });
    const file = liveSessionPointerFile(root, valid.id, valid.runSeq)!;
    writeFileSync(file, JSON.stringify({
      cardId: valid.id,
      runSeq: valid.runSeq,
      sessionId: "safe-session",
      transcriptPath: "../../outside"
    }));
    expect(readFileSync(file, "utf8")).toContain("outside");
    expect(await readLiveSessionPointer(root, valid)).toBeNull();
  });
});

describe("Kanban transcript adapter matches the shared SessionStream journal model", () => {
  it("normalizes live command progress and safe related-task snapshots", () => {
    const toolUseId = "toolu_agent_1";
    const lines = [
      JSON.stringify({
        type: "assistant", uuid: "assistant-1", timestamp: "2026-08-05T18:00:00.000Z",
        message: { content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "Inspect stream", subagent_type: "Explore" } }] }
      }),
      JSON.stringify({
        type: "progress", uuid: "progress-1", timestamp: "2026-08-05T18:00:01.000Z",
        parentToolUseID: toolUseId,
        data: { type: "agent_progress", agentId: "agent_internal_1", message: "Reading journal" }
      }),
      JSON.stringify({
        type: "progress", uuid: "bash-1", timestamp: "2026-08-05T18:00:02.000Z",
        parentToolUseID: "toolu_bash_1",
        data: { type: "bash_progress", fullOutput: "tests running", elapsedTimeSeconds: 2 }
      })
    ];

    expect(parseTranscriptLines(lines).events).toContainEqual(expect.objectContaining({
      id: "bash-1",
      blocks: [expect.objectContaining({ type: "tool_progress", text: "tests running", elapsedMs: 2000 })]
    }));
    const related = relatedTaskEvents(lines, { streamUrlFor: () => "/cards/card/session-stream?live=1&task=task-toolu_agent_1" });
    expect(related).toEqual([expect.objectContaining({
      id: "related:task-toolu_agent_1",
      blocks: [expect.objectContaining({
        type: "related_task",
        taskId: "task-toolu_agent_1",
        name: "Inspect stream",
        status: "running",
        streamUrl: expect.stringContaining("task-toolu_agent_1")
      })]
    })]);
    expect(JSON.stringify(related)).not.toContain("agent_internal_1");
  });
});

describe("card session-stream route", () => {
  it("serves the current generation's sidecar as the shared SessionStream SSE contract", async () => {
    const root = tempRoot();
    const card = await createCard(root, { title: "Live route", list: "plan", project: "garrison" });
    const acquired = await saveCardCAS(root, { ...card, status: "running", runSeq: 1 }, card.rev);
    expect(acquired.ok).toBe(true);

    const transcriptPath = path.join(root, "runtime", "route-session.jsonl");
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: "user",
        uuid: "user-route-1",
        timestamp: "2026-08-05T18:00:00.000Z",
        message: { content: [{ type: "text", text: "Show the live work" }] }
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-route-1",
        timestamp: "2026-08-05T18:00:01.000Z",
        message: { content: [{ type: "text", text: "The journal is visible" }] }
      })
    ].join("\n") + "\n");
    await writeLiveSessionPointer(root, acquired.card, {
      sessionId: "route-session",
      transcriptPath
    });

    const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cards/${card.id}/session-stream?live=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");

      // End the generation after the handler has loaded the sidecar; its next
      // bounded poll observes the status change and closes the stream.
      const running = await loadCard(root, card.id);
      const settled = await saveCardCAS(root, { ...running, status: "ok" }, running.rev);
      expect(settled.ok).toBe(true);
      const text = await response.text();
      const frames = text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice("data: ".length)));
      expect(frames[0]).toMatchObject({ type: "init", available: true, live: true });
      expect(JSON.stringify(frames[0].events)).toContain("The journal is visible");
      expect(frames.at(-1)).toEqual({ type: "end" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
