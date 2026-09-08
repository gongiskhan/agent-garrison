import { describe, expect, it } from "vitest";
import { nativeTerminalEventText } from "../packages/talk/ui/native-terminal-text";

describe("native shell observer", () => {
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
