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

  it("readJsonlFrom does not leak a file descriptor when the read throws (F4)", async () => {
    const { readJsonlFrom } = await import(PKG);
    // openSync(dir) succeeds on Linux but readSync(dir-fd) throws EISDIR — the
    // exact "throws AFTER openSync" path. Without the finally the fd leaked on
    // every call, and the 400ms watcher hammers this. Assert the open-fd count is
    // stable across many calls (a leak would grow it ~1:1).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpty-fdleak-"));
    const countFds = () => {
      try {
        return fs.readdirSync("/proc/self/fd").length;
      } catch {
        return -1; // non-Linux — skip the numeric assertion below
      }
    };
    // The call must be safe (returns empty, never throws) regardless of platform.
    expect(readJsonlFrom(dir, 0)).toEqual({ events: [], newOffset: 0 });
    const before = countFds();
    for (let i = 0; i < 200; i++) readJsonlFrom(dir, 0);
    const after = countFds();
    if (before !== -1 && after !== -1) {
      // Generous slack for unrelated fd churn; a leak would be ~+200.
      expect(after).toBeLessThanOrEqual(before + 15);
    }
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

  // Extended thinking (@high effort) prints "Thought for Ns" BETWEEN the user echo
  // and the reply. It ends in "for Ns", colliding with the SPINNER_DONE stop — which
  // made extractReply return empty for every thinking turn (the real Discuss bug).
  const THINKING_SCREEN = [
    "❯ Think hard about why the sky is blue, then answer in one sentence.",
    "  Thought for 2s",
    "⏺ Sunlight scatters off air molecules via Rayleigh scattering,",
    "  which favors short wavelengths.",
    "  So the sky looks blue.",
    "✻ Sautéed for 13s",
    "────────────────────────────────────────────────────────────────────",
    "❯ ",
    "  default | main | 18% | Sonnet 4.6@high | 14 files",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ];

  it("extractReply returns the reply on an @high thinking turn (skips the 'Thought for Ns' summary)", async () => {
    const { extractReply } = await import(PKG);
    const reply = extractReply(fakeHandle(THINKING_SCREEN), "Think hard about why the sky is blue, then answer in one sentence.");
    expect(reply).toContain("Rayleigh scattering");
    expect(reply).toContain("So the sky looks blue.");
    expect(reply).not.toBe("");
    expect(reply).not.toContain("Thought for");
    expect(reply).not.toContain("Sautéed");
  });

  // EXPANDED thinking: the TUI prints the thinking body under a "⎿" tree marker
  // (between the summary and the reply). This is the real Discuss bug — the thinking
  // text leaked into and smushed against the scraped reply ("…concise brief.Brief
  // written to…"). extractReply must skip the "Thinking…" summary AND the ⎿ block.
  const EXPANDED_THINKING_SCREEN = [
    "❯ 1. sounds better 2. all three 3 ignore 4. use ekoa-deploy",
    "✻ Thinking…",
    "⎿  The user answered my clarifying questions tersely. Now I need to write the brief.",
    "   Let me write a concise brief.",
    "⏺ Brief written to briefs/01KW-on-the-ekoa-website.md. Ready for build.",
    "✻ Baked for 6s",
    "────────────────────────────────────────────────────────────────────",
    "❯ ",
    "  ekoa | 4% | Haiku 4.5",
  ];

  it("extractReply skips an EXPANDED thinking block (⎿ …) and returns only the reply", async () => {
    const { extractReply } = await import(PKG);
    const reply = extractReply(fakeHandle(EXPANDED_THINKING_SCREEN), "1. sounds better 2. all three 3 ignore 4. use ekoa-deploy");
    expect(reply).toBe("Brief written to briefs/01KW-on-the-ekoa-website.md. Ready for build.");
    expect(reply).not.toContain("The user answered");
    expect(reply).not.toContain("Let me write a concise brief");
    expect(reply).not.toContain("Thinking");
  });

  it("isWorking matches the real high-effort spinner regardless of glyph (✽ / ✢) via the ellipsis", async () => {
    const { isWorking } = await import(PKG);
    expect(isWorking(fakeHandle(["✽ Infusing… (2s · thinking with high effort)", "❯ "]))).toBe(true);
    expect(isWorking(fakeHandle(["✢ Infusing… (3s · ↓ 121 tokens · thinking with high effort)", "❯ "]))).toBe(true);
    // The "Thought for Ns" summary and the done line are NOT working.
    expect(isWorking(fakeHandle(THINKING_SCREEN))).toBe(false);
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

  it("isWorking covers the extended-thinking spinner (no 'esc to interrupt') and excludes the done line", async () => {
    const { isWorking, isBusy } = await import(PKG);
    // Normal generation: the interrupt hint is present.
    const generating = ["⏺ ...", "✻ Cooking… (esc to interrupt · 4s)", "❯ "];
    expect(isWorking(fakeHandle(generating))).toBe(true);
    // Extended thinking: a spinner glyph + live progress counter, but NO interrupt
    // hint — isBusy misses it, isWorking must catch it (this is the empty-reply bug).
    const thinking = ["✻ Thinking… (12s · ↑ 2.1k tokens)", "❯ "];
    expect(isBusy(fakeHandle(thinking))).toBe(false);
    expect(isWorking(fakeHandle(thinking))).toBe(true);
    // A completed turn (assistant block + "Baked for 3s" done line, idle prompt) is
    // NOT working — otherwise a finished turn would never settle.
    expect(isWorking(fakeHandle(SCREEN))).toBe(false);
    // Reply prose that merely contains a parenthetical must not read as working.
    const prose = ["⏺ It finished in (3s) total.", "✻ Baked for 3s", "❯ "];
    expect(isWorking(fakeHandle(prose))).toBe(false);
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

describe("claude-pty: warm pool", () => {
  it("spawns a warm pool and checkout rotates a replacement", async () => {
    const { WarmPtySessionPool } = await import(PKG);
    let spawned = 0;
    const sessions: any[] = [];
    const spawnFn = async () => {
      spawned += 1;
      const session = {
        id: `s${spawned}`,
        disposed: false,
        lastActivityAt: Date.now(),
        isDisposed() { return this.disposed; },
        isAlive() { return !this.disposed; },
        dispose() { this.disposed = true; },
        getClaudeSessionId() { return this.id; },
        status() { return { tokens: 0 }; }
      };
      sessions.push(session);
      return session;
    };
    const pool = new WarmPtySessionPool({ size: 2, spawnFn, idleTimeoutMs: 60_000 });
    await pool.start();
    expect(pool.status().available).toBe(2);
    const a = await pool.checkout();
    const b = await pool.checkout();
    expect(a.session.getClaudeSessionId()).not.toBe(b.session.getClaudeSessionId());
    expect(spawned).toBeGreaterThanOrEqual(3);
    a.release();
    b.release();
    expect(pool.status().available).toBeLessThanOrEqual(2);
    pool.shutdown();
    expect(sessions.some((s) => s.disposed)).toBe(true);
  });
});

describe("claude-pty: liveness after child exit", () => {
  function fakePtyImpl() {
    const dataHandlers: Array<(d: string) => void> = [];
    const exitHandlers: Array<(ev: { exitCode: number }) => void> = [];
    const pty = {
      pid: 4242,
      onData(h: (d: string) => void) { dataHandlers.push(h); return { dispose() {} }; },
      onExit(h: (ev: { exitCode: number }) => void) { exitHandlers.push(h); return { dispose() {} }; },
      write(_d: string) {},
      resize(_c: number, _r: number) {},
      kill() {},
      emitData(d: string) { for (const h of dataHandlers.slice()) h(d); },
      emitExit(code: number) { for (const h of exitHandlers.slice()) h({ exitCode: code }); },
    };
    return { impl: () => pty, pty };
  }

  it("spawnClaudePty handle reports dead after the child exits", async () => {
    const { spawnClaudePty } = await import(PKG);
    const { impl, pty } = fakePtyImpl();
    const handle = spawnClaudePty("claude", [], { spawnImpl: impl, cwd: os.tmpdir() });
    expect(handle.isAlive()).toBe(true);
    pty.emitExit(0);
    expect(handle.isAlive()).toBe(false);
    expect(handle.exitCode()).toBe(0);
  });

  it("waitForSessionReady rejects with StartupExitError when the child dies during startup", async () => {
    const { spawnClaudePty, waitForSessionReady, StartupExitError } = await import(PKG);
    const { impl, pty } = fakePtyImpl();
    const handle = spawnClaudePty("claude", [], { spawnImpl: impl, cwd: os.tmpdir() });
    pty.emitData("No conversation found with session ID: dead-beef\r\n");
    const ready = waitForSessionReady(handle, {
      projectDir: os.tmpdir(),
      knownFiles: new Set<string>(),
      timeoutMs: 5000,
      pollMs: 20,
    });
    setTimeout(() => pty.emitExit(0), 30);
    await expect(ready).rejects.toBeInstanceOf(StartupExitError);
    await expect(ready).rejects.toThrow(/no conversation found/i);
  });

  it("runTurn fails fast on a dead handle instead of retrying for 30s", async () => {
    const { OperativePtySession } = await import(PKG);
    const deadHandle = {
      isAlive: () => false,
      exitCode: () => 0,
      async sendInput(_t: string) {},
      writeRaw(_b: string) {},
    };
    const session = new OperativePtySession({
      handle: deadHandle,
      compositionDir: os.tmpdir(),
      claudeSessionId: "x",
    });
    const started = Date.now();
    await expect(session.runTurn({ message: "hello" })).rejects.toThrow(/claude process exited/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("claude-pty: queued-message detection", () => {
  it("hasQueuedMessages detects the TUI's queued hint", async () => {
    const { hasQueuedMessages } = await import(PKG);
    expect(hasQueuedMessages(fakeHandle(["❯ Press up to edit queued messages"]))).toBe(true);
    expect(hasQueuedMessages(fakeHandle(["2 queued messages"]))).toBe(true);
    expect(hasQueuedMessages(fakeHandle(["❯ ", "  default | main | 8%"]))).toBe(false);
  });
});
