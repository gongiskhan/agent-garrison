import { describe, expect, it } from "vitest";
import {
  collectRelatedTasks,
  groupSessionTurns,
  latestBlocksByToolUse,
  mergeSessionEvents,
  presentSessionTurn,
  sessionActivityBeats,
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

  it("groups interim assistant envelopes into one growing visual turn", () => {
    const events: SessionEvent[] = [
      { id: "user-1", role: "user", ts: null, blocks: [{ type: "text", text: "check both" }] },
      event("intro", [{ type: "text", text: "I'll inspect the files." }]),
      event("read", [{ type: "tool_use", name: "Read", toolUseId: "read-1", input: "{}" }]),
      // Tool results are user-shaped in Claude JSONL but must not split the turn.
      { id: "read-result", role: "user", ts: null, toolResultsOnly: true, blocks: [{ type: "tool_result", toolUseId: "read-1", text: "ok" }] },
      event("next", [{ type: "text", text: "Now I'll check the web." }]),
      event("final", [{ type: "text", text: "Done — both worked." }]),
    ];

    const turns = groupSessionTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantEvents.map((entry) => entry.id)).toEqual(["intro", "read", "next", "final"]);
    expect(presentSessionTurn(turns[0], true)).toEqual({
      primaryText: "I'll inspect the files.\n\nNow I'll check the web.\n\nDone — both worked.",
      interimText: [],
      finalTextEventIndex: null,
    });
  });

  it("keeps only the final response primary after settle and retains interim text", () => {
    const turns = groupSessionTurns([
      { id: "user-1", role: "user", ts: null, blocks: [{ type: "text", text: "check both" }] },
      event("intro", [{ type: "text", text: "I'll inspect the files." }]),
      event("thinking", [{ type: "thinking", text: "Choosing what to inspect" }]),
      event("next", [{ type: "text", text: "Now I'll check the web." }]),
      event("final", [{ type: "text", text: "Done — both worked." }]),
    ]);

    expect(presentSessionTurn(turns[0], false)).toEqual({
      primaryText: "Done — both worked.",
      interimText: ["I'll inspect the files.", "Now I'll check the web."],
      finalTextEventIndex: 3,
    });
  });

  it("keeps historical turns settled while only the last conversational turn grows live", () => {
    const turns = groupSessionTurns([
      { id: "user-1", role: "user", ts: null, blocks: [{ type: "text", text: "first" }] },
      event("first-interim", [{ type: "text", text: "Working on the first." }]),
      event("first-final", [{ type: "text", text: "First complete." }]),
      { id: "user-2", role: "user", ts: null, blocks: [{ type: "text", text: "second" }] },
      event("second-interim", [{ type: "text", text: "Working on the second." }]),
      event("second-tool", [{ type: "tool_use", name: "Read", toolUseId: "read-2" }]),
      event("second-latest", [{ type: "text", text: "Still checking." }]),
    ]);

    expect(turns).toHaveLength(2);
    expect(presentSessionTurn(turns[0], false)).toMatchObject({
      primaryText: "First complete.",
      interimText: ["Working on the first."],
    });
    expect(presentSessionTurn(turns[1], true)).toMatchObject({
      primaryText: "Working on the second.\n\nStill checking.",
      interimText: [],
    });
  });

  it("splits an assistant-only recovered chain on exact A/A then B/B turn coordinates", () => {
    const recovered = (id: string, turnId: string, text: string): SessionEvent => ({
      ...event(id, [{ type: "text", text }]),
      turnId,
    });
    const turns = groupSessionTurns([
      recovered("a-interim", "input-a", "Working on A."),
      recovered("a-final", "input-a", "A complete."),
      recovered("b-interim", "input-b", "Working on B."),
      recovered("b-latest", "input-b", "Still checking B."),
    ]);

    expect(turns.map((turn) => turn.assistantEvents.map((entry) => entry.id))).toEqual([
      ["a-interim", "a-final"],
      ["b-interim", "b-latest"],
    ]);
    expect(presentSessionTurn(turns[0], false)).toMatchObject({
      primaryText: "A complete.",
      interimText: ["Working on A."],
    });
    expect(presentSessionTurn(turns[1], true)).toMatchObject({
      primaryText: "Working on B.\n\nStill checking B.",
      interimText: [],
    });
  });

  it("keeps null-coordinate beats with their surrounding synthetic turn", () => {
    const recovered = (id: string, turnId?: string): SessionEvent => ({
      ...event(id, [{ type: "thinking", text: id }]),
      ...(turnId ? { turnId } : {}),
    });
    const turns = groupSessionTurns([
      recovered("a-one", "input-a"),
      recovered("a-null"),
      recovered("a-two", "input-a"),
      recovered("b-one", "input-b"),
      recovered("b-null"),
      recovered("b-two", "input-b"),
    ]);

    expect(turns.map((turn) => turn.assistantEvents.map((entry) => entry.id))).toEqual([
      ["a-one", "a-null", "a-two"],
      ["b-one", "b-null", "b-two"],
    ]);
  });

  it("does not split a real user-bounded turn when runtime coordinates roll", () => {
    const turns = groupSessionTurns([
      { id: "user", role: "user", ts: null, blocks: [{ type: "text", text: "Run it" }] },
      { ...event("session-a", [{ type: "text", text: "Starting." }]), turnId: "runtime-a" },
      { ...event("session-b", [{ type: "text", text: "Finished." }]), turnId: "runtime-b" },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].assistantEvents.map((entry) => entry.id)).toEqual(["session-a", "session-b"]);
  });

  it("keeps live prose, tool calls, and later prose in journal order", () => {
    const beats = sessionActivityBeats([
      event("live", [
        { type: "text", text: "I'll read" },
        { type: "text", text: " the file." },
        { type: "tool_use", name: "Read", toolUseId: "read-1" },
      ]),
      event("after-tool", [{ type: "text", text: "Now I'll inspect the result." }]),
    ]);

    expect(beats.map((beat) => beat.type)).toEqual(["text", "tool_use", "text"]);
    expect(beats[0]).toMatchObject({ type: "text", text: "I'll read the file." });
    expect(beats[2]).toMatchObject({ type: "text", text: "Now I'll inspect the result." });
  });

  it("uses a terminal result as settled primary text and retains typed errors as beats", () => {
    const turns = groupSessionTurns([
      event("tool", [{ type: "tool_use", name: "Bash", toolUseId: "bash-1" }]),
      event("terminal", [
        { type: "error", kind: "runtime_error", text: "subprocess failed" },
        { type: "turn_end", status: "error", result: "Please retry the operation." },
      ]),
    ]);

    expect(presentSessionTurn(turns[0], false)).toMatchObject({
      primaryText: "Please retry the operation.",
      finalTextEventIndex: 1,
    });
    expect(sessionActivityBeats(turns[0].assistantEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", text: "subprocess failed" }),
    ]));
  });
});
