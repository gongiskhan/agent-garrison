import path from "node:path";
import { describe, expect, it } from "vitest";

const PTYS = path.resolve(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "ptys.mjs");
const countAppends = (cmd: string) => (cmd.match(/--append-system-prompt-file/g) || []).length;

describe("claudeCommand — orchestrated launch (s3b)", () => {
  it("bare session is unchanged: browser-pane only, no --model (back-compat)", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({});
    expect(cmd).toContain("browser-pane.md");
    expect(cmd).not.toContain("--model");
    expect(countAppends(cmd)).toBe(1);
  });

  it("orchestrated: prepends the mode prompt, keeps browser-pane last, adds --model", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({
      appendPromptFiles: ["/home/u/.garrison/dev-env-souls/joe.md"],
      model: "opus"
    });
    expect(cmd).toContain("--model opus");
    expect(cmd).toContain("joe.md");
    expect(cmd).toContain("browser-pane.md");
    expect(countAppends(cmd)).toBe(2);
    // mode identity leads, browser-pane guidance last
    expect(cmd.indexOf("joe.md")).toBeLessThan(cmd.indexOf("browser-pane.md"));
  });

  it("rejects an unsafe model string (no --model injected)", async () => {
    const { claudeCommand } = await import(PTYS);
    expect(claudeCommand({ model: "opus; rm -rf /" })).not.toContain("--model");
    expect(claudeCommand({ model: "sonnet" })).toContain("--model sonnet");
  });

  it("rejects a model starting with '-' (CLI option-injection guard) but allows real ids", async () => {
    const { claudeCommand } = await import(PTYS);
    expect(claudeCommand({ model: "-dangerously-skip" })).not.toContain("--model");
    expect(claudeCommand({ model: "claude-opus-4-8" })).toContain("--model claude-opus-4-8");
  });

  it("orchestrated + resumeId: --resume + mode prompt + --model together", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({
      resumeId: "abc12345-def0-1234-5678-90abcdef0000",
      appendPromptFiles: ["/x/joe.md"],
      model: "sonnet"
    });
    expect(cmd).toContain("--resume abc12345-def0-1234-5678-90abcdef0000");
    expect(cmd).toContain("--model sonnet");
    expect(cmd).toContain("joe.md");
    expect(countAppends(cmd)).toBe(2);
  });

  it("shell-quotes prompt paths so $()/backticks can't inject (defense-in-depth)", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({ appendPromptFiles: ["/x/$(touch pwned).md"] });
    expect(cmd).toContain("'/x/$(touch pwned).md'"); // single-quoted → inert
    expect(cmd).not.toContain('"/x/$(touch pwned).md"');
  });

  it("ignores non-string entries in appendPromptFiles", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({ appendPromptFiles: [null, "", "/x/james.md", 42] as unknown as string[] });
    expect(cmd).toContain("james.md");
    expect(countAppends(cmd)).toBe(2); // james + browser-pane
  });
});
