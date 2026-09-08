import { describe, expect, it } from "vitest";
import { nativeTerminalEventText } from "../packages/talk/ui/native-terminal-text";

describe("native shell observer", () => {
  it("labels tool results as output even when the runtime wraps them in a user message", () => {
    const result = nativeTerminalEventText({ role: "user", blocks: [{ type: "tool_result", text: "at 14:49: 15 prompts" }] });
    expect(result).toContain("TOOL OUTPUT");
    expect(result).not.toContain("USER");
    const mixed = nativeTerminalEventText({ role: "user", blocks: [{ type: "text", text: "Please continue" }, { type: "tool_result", text: "Process finished" }] });
    expect(mixed).toMatch(/USER[\s\S]*Please continue[\s\S]*TOOL OUTPUT[\s\S]*Process finished/);
  });
  it("renders tool commands and results as terminal output without interpreting untrusted escape sequences", () => {
    const text = nativeTerminalEventText({ role: "assistant", blocks: [
      { type: "tool_use", name: "Shell", input: "pwd" },
      { type: "tool_result", text: "\x1b[2J/tmp/project\x1b]52;c;clipboard\x07", isError: false }
    ] });
    expect(text).toContain("$ Shell\npwd");
    expect(text).toContain("/tmp/project");
    expect(text).not.toContain("\x1b[2J");
    expect(text).not.toContain("clipboard");
  });
});
