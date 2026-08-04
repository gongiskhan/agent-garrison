import { describe, expect, it } from "vitest";
import {
  collectRelatedTasks,
  latestBlocksByToolUse,
  mergeSessionEvents,
  sessionThinkingSummary,
  sessionToolSummary,
  type SessionEvent,
} from "../packages/claude-chat/src/journal";

const event = (id: string, blocks: SessionEvent["blocks"]): SessionEvent => ({
  id,
  role: "assistant",
  ts: null,
  blocks,
});

describe("claude-chat activity journal", () => {
  it("summarises common tool inputs into one presentable line", () => {
    expect(sessionToolSummary({ type: "tool_use", name: "Bash", input: JSON.stringify({ command: "npm test -- tests/unit.test.ts" }) }))
      .toBe("npm test -- tests/unit.test.ts");
    expect(sessionToolSummary({ type: "tool_use", name: "Read", input: JSON.stringify({ file_path: "/tmp/report.md" }) }))
      .toBe("/tmp/report.md");
    expect(sessionToolSummary({ type: "tool_use", name: "Agent", input: JSON.stringify({ description: "Audit the auth flow", subagent_type: "Explore" }) }))
      .toBe("Audit the auth flow");
  });

  it("pairs live progress and a later result with the originating tool", () => {
    const events = [
      event("use", [{ type: "tool_use", name: "Bash", toolUseId: "tool-1", input: "{}" }]),
      event("beat-1", [{ type: "tool_progress", toolUseId: "tool-1", text: "building 2/4", elapsedMs: 1200 }]),
      event("result", [{ type: "tool_result", toolUseId: "tool-1", text: "done" }]),
    ];
    expect(latestBlocksByToolUse(events, "tool_progress").get("tool-1")).toMatchObject({ text: "building 2/4", elapsedMs: 1200 });
    expect(latestBlocksByToolUse(events, "tool_result").get("tool-1")).toMatchObject({ text: "done" });
  });

  it("upserts stable snapshot events without moving the journal timeline", () => {
    const initial = [
      event("tool", [{ type: "tool_use", name: "Agent", toolUseId: "agent-tool" }]),
      event("related:task-agent-tool", [{
        type: "related_task",
        toolUseId: "agent-tool",
        taskId: "task-agent-tool",
        status: "running",
      }]),
    ];
    const merged = mergeSessionEvents(initial, [event("related:task-agent-tool", [{
      type: "related_task",
      toolUseId: "agent-tool",
      taskId: "task-agent-tool",
      status: "completed",
      streamUrl: "/api/session-stream?session=parent&task=task-agent-tool",
    }])]);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("tool");
    expect(merged[1].blocks[0]).toMatchObject({
      status: "completed",
      streamUrl: "/api/session-stream?session=parent&task=task-agent-tool",
    });
  });

  it("shows fan-out only when an actual Agent-style tool call grounds it", () => {
    const noFanout = [event("read", [{ type: "tool_use", name: "Read", toolUseId: "read-1", input: "{}" }])];
    expect(collectRelatedTasks(noFanout, true)).toEqual([]);

    const fanout = [
      event("agent", [{
        type: "tool_use",
        name: "Agent",
        toolUseId: "agent-tool",
        input: JSON.stringify({ description: "Inspect session recovery", subagent_type: "Explore" }),
      }]),
      event("progress", [{
        type: "tool_progress",
        toolUseId: "agent-tool",
        taskId: "task-agent-tool",
        text: "Tracing the resume path",
        status: "running",
      }]),
    ];
    expect(collectRelatedTasks(fanout, true)).toEqual([
      expect.objectContaining({
        toolUseId: "agent-tool",
        taskId: "task-agent-tool",
        label: "Inspect session recovery",
        detail: "Explore",
        status: "running",
        text: "Tracing the resume path",
      }),
    ]);
  });

  it("upgrades a grounded Agent call with an opaque related-task stream URL", () => {
    const events = [
      event("agent", [{
        type: "tool_use",
        name: "Agent",
        toolUseId: "agent-tool",
        input: JSON.stringify({ description: "Check the UI" }),
      }]),
      event("related", [{
        type: "related_task",
        toolUseId: "agent-tool",
        taskId: "agent-public-id",
        name: "Check the UI",
        detail: "Explore",
        status: "running",
        streamUrl: "/api/session-stream?session=opaque&task=agent-public-id",
      }]),
    ];
    const tasks = collectRelatedTasks(events, true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "agent-public-id",
      streamUrl: "/api/session-stream?session=opaque&task=agent-public-id",
      status: "running",
    });
    expect(tasks[0].streamUrl).not.toContain("/home/");
  });

  it("rejects external related-task stream URLs from journal content", () => {
    const tasks = collectRelatedTasks([
      event("related", [{
        type: "related_task",
        taskId: "agent-public-id",
        name: "Unsafe link",
        status: "running",
        streamUrl: "https://example.invalid/transcript",
      }]),
    ], true);
    expect(tasks[0].streamUrl).toBeNull();
  });

  it("turns a long thinking block into a compact completed summary", () => {
    expect(sessionThinkingSummary("I should trace the persistence boundary before changing the renderer. More follows."))
      .toBe("I should trace the persistence boundary before changing the renderer");
  });
});
