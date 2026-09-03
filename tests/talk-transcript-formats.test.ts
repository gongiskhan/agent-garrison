// Cursor/Codex/Gemini transcript parsers - each must produce the same
// {events, title} shape session-transcript.mjs's parseTranscriptLines does.
// The codex fixture lines are copied verbatim from a REAL rollout file on
// this machine (2026-09-03) so the parser is checked against the actual
// on-disk shape, not a guess.

import { describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { parseByFormat, parseCodexRolloutLines, parseCursorTranscriptLines, parseGeminiChatLines } from "../packages/talk/src/transcript-formats.mjs";

describe("parseCursorTranscriptLines", () => {
  it("parses user/assistant Anthropic-shaped blocks", () => {
    const lines = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "fix the header" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }] } })
    ];
    const { events } = parseCursorTranscriptLines(lines);
    expect(events).toHaveLength(2);
    expect(events[0].role).toBe("user");
    expect(events[0].blocks[0]).toEqual({ type: "text", text: "fix the header" });
    expect(events[1].blocks[0]).toEqual({ type: "text", text: "Done." });
    expect(events[1].blocks[1].type).toBe("tool_use");
  });

  it("skips lines with no parseable content", () => {
    const { events } = parseCursorTranscriptLines(["not json", JSON.stringify({ role: "system" })]);
    expect(events).toHaveLength(0);
  });
});

describe("parseCodexRolloutLines (real rollout shapes)", () => {
  const userMsg = { timestamp: "2026-08-05T18:57:56.957Z", type: "response_item", payload: { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "please fix the tooling gap" }] } };
  const devMsg = { timestamp: "2026-08-05T18:57:57.000Z", type: "response_item", payload: { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "<app-context>...</app-context>" }] } };
  const assistantMsg = { timestamp: "2026-08-05T18:57:57.009Z", type: "response_item", payload: { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "Shipped in commit 2d84d315." }] } };
  const reasoning = { timestamp: "2026-08-05T18:58:05.373Z", type: "response_item", payload: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking about the fix" }] } };
  const emptyReasoning = { timestamp: "2026-08-05T18:58:05.400Z", type: "response_item", payload: { type: "reasoning", id: "rs_2", summary: [] } };
  const customToolCall = { timestamp: "2026-08-05T18:58:07.922Z", type: "response_item", payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_1", name: "exec", input: "const r = await tools.exec_command({cmd:\"git diff\"});" } };
  const customToolOutput = { timestamp: "2026-08-05T18:58:08.110Z", type: "response_item", payload: { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1", output: [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "diff --git a/x b/x\n" }] } };
  const functionCall = { timestamp: "2026-08-05T18:59:19.218Z", type: "response_item", payload: { type: "function_call", id: "fc_1", name: "wait", arguments: "{\"cell_id\":\"8\"}", call_id: "call_2" } };
  const functionCallOutput = { timestamp: "2026-08-05T18:59:30.221Z", type: "response_item", payload: { type: "function_call_output", id: "fco_1", call_id: "call_2", output: "Script running with cell ID 8\n" } };
  const sessionMeta = { timestamp: "2026-08-05T18:57:56.792Z", type: "session_meta", payload: { session_id: "x", id: "y" } };

  it("keeps user/assistant messages, drops developer scaffolding", () => {
    const { events } = parseCodexRolloutLines([userMsg, devMsg, assistantMsg].map((r) => JSON.stringify(r)));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: "user", blocks: [{ type: "text", text: "please fix the tooling gap" }] });
    expect(events[1]).toMatchObject({ role: "assistant", blocks: [{ type: "text", text: "Shipped in commit 2d84d315." }] });
  });

  it("ignores non-response_item records (session_meta, turn_context, event_msg)", () => {
    const { events } = parseCodexRolloutLines([sessionMeta].map((r) => JSON.stringify(r)));
    expect(events).toHaveLength(0);
  });

  it("reasoning: text summary becomes a thinking block, empty summary produces nothing", () => {
    const { events: withText } = parseCodexRolloutLines([JSON.stringify(reasoning)]);
    expect(withText).toEqual([{ id: "codex:0", role: "assistant", ts: expect.any(Number), blocks: [{ type: "thinking", text: "thinking about the fix" }] }]);
    const { events: empty } = parseCodexRolloutLines([JSON.stringify(emptyReasoning)]);
    expect(empty).toHaveLength(0);
  });

  it("custom_tool_call/_output: input is already a string, output is an array of text parts joined", () => {
    const { events } = parseCodexRolloutLines([customToolCall, customToolOutput].map((r) => JSON.stringify(r)));
    expect(events[0].blocks[0]).toMatchObject({ type: "tool_use", toolUseId: "call_1", name: "exec" });
    expect(events[0].blocks[0].input).toContain("git diff");
    expect(events[1].blocks[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1", isError: false });
    expect(events[1].blocks[0].text).toBe("Script completed\n\ndiff --git a/x b/x\n");
    expect(events[1].toolResultsOnly).toBe(true);
  });

  it("function_call/_output: arguments/output are plain strings, used as-is", () => {
    const { events } = parseCodexRolloutLines([functionCall, functionCallOutput].map((r) => JSON.stringify(r)));
    expect(events[0].blocks[0]).toMatchObject({ type: "tool_use", toolUseId: "call_2", name: "wait", input: '{"cell_id":"8"}' });
    expect(events[1].blocks[0]).toMatchObject({ type: "tool_result", toolUseId: "call_2", text: "Script running with cell ID 8\n" });
  });

  it("a torn final line does not throw", () => {
    expect(() => parseCodexRolloutLines([JSON.stringify(userMsg), "{not json"])).not.toThrow();
  });
});

describe("parseGeminiChatLines", () => {
  it("takes the LAST $set.messages patch (latest-wins replace semantics)", () => {
    const lines = [
      JSON.stringify({ sessionId: "s1", projectHash: "h", startTime: "2026-09-01T00:00:00Z", lastUpdated: "2026-09-01T00:05:00Z", kind: "chat" }),
      JSON.stringify({ $set: { messages: [{ id: 1, type: "user", content: [{ text: "help me debug" }] }] } }),
      JSON.stringify({ $set: { messages: [
        { id: 1, type: "user", content: [{ text: "help me debug" }] },
        { id: 2, type: "gemini", content: [{ text: "sure, what error do you see" }] }
      ] } })
    ];
    const { events } = parseGeminiChatLines(lines);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: "user", blocks: [{ type: "text", text: "help me debug" }] });
    expect(events[1]).toMatchObject({ role: "assistant", blocks: [{ type: "text", text: "sure, what error do you see" }] });
  });

  it("no $set patch at all returns an empty transcript, not an error", () => {
    expect(parseGeminiChatLines(["not json", JSON.stringify({ sessionId: "s1" })])).toEqual({ events: [], title: null });
  });
});

describe("parseByFormat", () => {
  it("dispatches on format and defaults to empty for an unknown one", () => {
    expect(parseByFormat("cursor-agent-jsonl", [JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hi" }] } })]).events).toHaveLength(1);
    expect(parseByFormat("unknown-format", ["x"])).toEqual({ events: [], title: null });
  });
});
