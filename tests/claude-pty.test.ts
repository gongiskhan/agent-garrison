import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// The claude-pty package is plain ESM .mjs; import via the workspace package
// name (resolves to packages/claude-pty through the root node_modules link).
const PKG = "@garrison/claude-pty";

// A fake xterm-like handle backed by an array of screen lines, enough to drive
// the screen.mjs pure functions (extractReply, parseStatus, isBusy, etc.).
function fakeHandle(lines: string[]) {
  const rows = lines.slice();
  return {
    term: {
      buffer: {
        active: {
          length: rows.length,
          cursorY: rows.length - 1,
          cursorX: 0,
          getLine(i: number) {
            const text = rows[i] ?? "";
            return { translateToString: () => text };
          },
        },
      },
    },
  };
}

describe("claude-pty: jsonl", () => {
  it("parseTurn extracts assistant text, thinking, tool use/result, duration, model", async () => {
    const { parseTurn } = await import(PKG);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-jsonl-"));
    const f = path.join(dir, "s.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Hello!" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }] },
      }),
      JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 4200 }),
    ];
    fs.writeFileSync(f, lines.join("\n") + "\n");
    const turn = parseTurn(f, 0);
    expect(turn.assistantTexts).toEqual(["Hello!"]);
    expect(turn.thinkingTexts).toEqual(["hmm"]);
    expect(turn.toolUses[0]).toMatchObject({ name: "Bash", tool_use_id: "t1" });
    expect(turn.toolResults[0]).toMatchObject({ tool_use_id: "t1", content: "a\nb", is_error: false });
    expect(turn.turnDurationMs).toBe(4200);
    expect(turn.model).toBe("claude-sonnet");
  });

  it("readJsonlFrom does not consume a partial trailing line", async () => {
    const { readJsonlFrom } = await import(PKG);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-partial-"));
    const f = path.join(dir, "s.jsonl");
    const full = [JSON.stringify({ type: "user", message: { content: "a" } })].join("\n") + "\n";
    fs.writeFileSync(f, full + '{"type":"assi'); // partial trailing line
    const r = readJsonlFrom(f, 0);
    expect(r.events).toHaveLength(1);
    // Offset advances only past the last complete newline, so the partial line
    // is re-read on the next poll once it completes.
    expect(r.newOffset).toBe(Buffer.byteLength(full, "utf8"));
  });

  it("extractLocalCommandOutput pulls slash-command stdout", async () => {
    const { extractLocalCommandOutput } = await import(PKG);
    const events = [
      { type: "user", message: { role: "user", content: "<local-command-stdout>context: 42% left</local-command-stdout>" } },
    ];
    expect(extractLocalCommandOutput(events)).toBe("context: 42% left");
  });
});

describe("claude-pty: detection helpers", () => {
  it("isCommandMessage recognises single-line slash commands only", async () => {
    const { isCommandMessage } = await import(PKG);
    expect(isCommandMessage("/context")).toBe(true);
    expect(isCommandMessage("  /help  ")).toBe(true);
    expect(isCommandMessage("hello")).toBe(false);
    expect(isCommandMessage("/a\nb")).toBe(false);
  });

  it("stripAnsi removes escape sequences", async () => {
    const { stripAnsi } = await import(PKG);
    expect(stripAnsi("\x1b[2mhi\x1b[0m")).toBe("hi");
  });
});

describe("claude-pty: screen parsing", () => {
  // A realistic post-turn TUI snapshot captured from claude 2.1.175.
  const SCREEN = [
    "╭─── Claude Code v2.1.175 ───────────────────────────────────────╮",
    "│                Welcome back Goncalo!                            │",
    "╰────────────────────────────────────────────────────────────────╯",
    " ⚠ 3 setup issues: MCP · /doctor",
    "❯ Write a haiku about garrisons. Then write DONE-MARKER-42.",
    "⏺ Walls hold the night watch,",
    "  Stone sentinels guard the gates,",
    "  Silence keeps the peace.",
    "  DONE-MARKER-42",
    "✻ Baked for 3s",
    "────────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────────",
    "  myproj | 14% | Sonnet 4.6@high          You've used 93% of your weekly limit",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    "",
    "",
  ];

  it("extractReply returns the assistant block, excluding chrome and spinner", async () => {
    const { extractReply } = await import(PKG);
    const reply = extractReply(fakeHandle(SCREEN), "Write a haiku about garrisons. Then write DONE-MARKER-42.");
    expect(reply).toContain("Walls hold the night watch,");
    expect(reply).toContain("DONE-MARKER-42");
    expect(reply).not.toContain("Baked for");
    expect(reply).not.toContain("bypass permissions");
    expect(reply).not.toContain("14%");
  });

  it("parseStatus extracts mode, context %, model and raw rows", async () => {
    const { parseStatus } = await import(PKG);
    const s = parseStatus(fakeHandle(SCREEN));
    expect(s.mode).toBe("bypassPermissions");
    expect(s.contextPct).toBe(14);
    expect(s.model).toBe("Sonnet 4.6@high");
    expect(s.statusRow).toContain("Sonnet 4.6@high");
    expect(s.rows.length).toBeGreaterThan(0);
  });

  it("parsePermissionMode maps mode rows", async () => {
    const { parsePermissionMode } = await import(PKG);
    expect(parsePermissionMode("⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe("bypassPermissions");
    expect(parsePermissionMode("⏸ plan mode on")).toBe("plan");
    expect(parsePermissionMode("⏵ accept edits on")).toBe("acceptEdits");
    expect(parsePermissionMode("garbage")).toBe("unknown");
  });

  it("isBusy true while a turn is processing, false when done", async () => {
    const { isBusy } = await import(PKG);
    const busyScreen = ["⏺ working...", "✻ Cooking… (esc to interrupt)", "❯ "];
    expect(isBusy(fakeHandle(busyScreen))).toBe(true);
    expect(isBusy(fakeHandle(SCREEN))).toBe(false);
  });

  it("turnStarted true when an assistant marker / spinner / done indicator is present", async () => {
    const { turnStarted } = await import(PKG);
    expect(turnStarted(fakeHandle(SCREEN))).toBe(true);
    const fresh = ["╭─ Claude Code ─╮", "❯ Try \"how do I...\"", "  myproj | 5% | Sonnet"];
    expect(turnStarted(fakeHandle(fresh))).toBe(false);
  });

  // dev-env runs claude inside a shell PTY, so the mirror screen carries the
  // shell command echo + banner above the reply. extractLatestAssistant must
  // return only the assistant prose, with no progress/spinner lines leaking.
  const DEVENV_SCREEN = [
    "ggomes@host devproj % claude --dangerously-skip-permissions --append-system-prompt-file x.md",
    "╭─── Claude Code v2.1.175 ───╮",
    "│  Welcome back Goncalo!     │",
    "╰────────────────────────────╯",
    "❯ Reply with exactly: devenv-rich-ok",
    "⏺ devenv-rich-ok",
    "✻ Mulling (running stop hooks 3/4 · 2s · 10 tokens)",
    "  garrison-devproj | 2% | Opus 4.8 (1M context)@xhigh    /rc active",
    "   bypass permissions on (shift+tab to cycle)",
  ];

  it("extractLatestAssistant returns only the reply from a shell-echo screen", async () => {
    const { extractLatestAssistant } = await import(PKG);
    const reply = extractLatestAssistant(fakeHandle(DEVENV_SCREEN));
    expect(reply).toBe("devenv-rich-ok");
  });

  it("parseStatus parses the dev-env status row (multi-space split, parenthesised model)", async () => {
    const { parseStatus } = await import(PKG);
    const s = parseStatus(fakeHandle(DEVENV_SCREEN));
    expect(s.mode).toBe("bypassPermissions");
    expect(s.contextPct).toBe(2);
    expect(s.model).toBe("Opus 4.8 (1M context)@xhigh");
  });

  it("a progress line never leaks into extractReply", async () => {
    const { extractReply } = await import(PKG);
    const screen = [
      "❯ say hi",
      "⏺ Hello there",
      "  more text",
      "✻ Embellishing (running stop hooks 3/4 · 2s · 8 tokens)",
      "  myproj | 0% | Sonnet",
    ];
    const reply = extractReply(fakeHandle(screen), "say hi");
    expect(reply).toBe("Hello there\nmore text");
  });
});

describe("claude-pty: trust", () => {
  let tmpCfg: string;
  let prev: string | undefined;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-trust-"));
    tmpCfg = path.join(dir, ".claude.json");
    prev = process.env.GARRISON_CLAUDE_CONFIG_PATH;
    process.env.GARRISON_CLAUDE_CONFIG_PATH = tmpCfg;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GARRISON_CLAUDE_CONFIG_PATH;
    else process.env.GARRISON_CLAUDE_CONFIG_PATH = prev;
  });

  it("preTrustCwd sets hasTrustDialogAccepted atomically", async () => {
    const { preTrustCwd } = await import(PKG);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-cwd-"));
    await preTrustCwd(cwd);
    const cfg = JSON.parse(fs.readFileSync(tmpCfg, "utf8"));
    // The cwd is canonicalised; check at least one entry is trusted.
    const trusted = Object.values(cfg.projects ?? {}).some((p: any) => p?.hasTrustDialogAccepted === true);
    expect(trusted).toBe(true);
  });

  it("preTrustCwd refuses to clobber corrupt JSON", async () => {
    const { preTrustCwd } = await import(PKG);
    fs.writeFileSync(tmpCfg, "{not json");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-cwd2-"));
    await preTrustCwd(cwd);
    // File is left as-is (still corrupt), not overwritten.
    expect(fs.readFileSync(tmpCfg, "utf8")).toBe("{not json");
  });
});
