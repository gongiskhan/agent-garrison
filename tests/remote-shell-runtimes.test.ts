// The runtime catalog: RUNTIMES argv builders, and SessionManager.start()
// wiring them into the same "type into a bare-shell pane" path agentCommand
// has always used - proven against a fake #exec that records every command
// string rather than a real remote.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { loadTransports } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore — pure .mjs
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";
// @ts-ignore — pure .mjs
import { RUNTIMES, commandLine, buildRuntimeProbeScript, parseRuntimeProbe } from "../fittings/seed/remote-shell-runtime/lib/runtimes.mjs";

describe("RUNTIMES argv builders", () => {
  // commandLine shell-quotes EVERY token, the binary included - the same
  // convention #remoteCommand already used, since the whole string is later
  // typed literally into a shell prompt via tmux send-keys.
  it("claude: new / resume / attach", () => {
    expect(commandLine(RUNTIMES.claude.newArgv())).toBe("'claude'");
    expect(commandLine(RUNTIMES.claude.resumeArgv("abc-123"))).toBe("'claude' '--resume' 'abc-123'");
    expect(commandLine(RUNTIMES.claude.attachArgv("bg-1"))).toBe("'claude' 'attach' 'bg-1'");
  });

  it("codex has no attach", () => {
    expect(RUNTIMES.codex.attachArgv).toBeNull();
    expect(commandLine(RUNTIMES.codex.resumeArgv("019f-uuid"))).toBe("'codex' 'resume' '019f-uuid'");
  });

  it("cursor resume", () => {
    expect(commandLine(RUNTIMES.cursor.resumeArgv("chat_abc123"))).toBe("'cursor-agent' '--resume' 'chat_abc123'");
  });

  it("gemini accepts latest or an integer index", () => {
    expect(commandLine(RUNTIMES.gemini.resumeArgv("latest"))).toBe("'gemini' '--resume' 'latest'");
    expect(commandLine(RUNTIMES.gemini.resumeArgv("3"))).toBe("'gemini' '--resume' '3'");
    expect(RUNTIMES.gemini.refPattern.test("latest")).toBe(true);
    expect(RUNTIMES.gemini.refPattern.test("3")).toBe(true);
    expect(RUNTIMES.gemini.refPattern.test("abc")).toBe(false);
  });

  it("shell has no argv at all", () => {
    expect(RUNTIMES.shell.newArgv()).toEqual([]);
    expect(RUNTIMES.shell.bin).toBeNull();
  });
});

describe("runtime probe script", () => {
  it("round-trips through parseRuntimeProbe", () => {
    // The script's first column is the runtime ID ("cursor"), not its bin
    // ("cursor-agent") - see buildRuntimeProbeScript.
    const stdout = "claude\t/home/u/.local/bin/claude\ncodex\t\ncursor\t/usr/bin/cursor-agent\ngemini\t\n";
    const rows = parseRuntimeProbe(stdout);
    const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.claude.available).toBe(true);
    expect(byId.claude.path).toBe("/home/u/.local/bin/claude");
    expect(byId.codex.available).toBe(false);
    expect(byId.codex.path).toBeNull();
    expect(byId.cursor.available).toBe(true);
  });

  it("the script itself only names the four binned runtimes, quoted", () => {
    const script = buildRuntimeProbeScript();
    expect(script).toContain("'claude'");
    expect(script).toContain("'cursor-agent'");
    expect(script).not.toContain("shell");
  });
});

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-rt-"));
  priorHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmpHome;
  mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** A manager whose remote is a script, exactly like the multisession harness:
 *  `tmux has-session` always reports a bare pane, and every other command is
 *  recorded verbatim so the test can assert on the exact typed command. */
async function harness() {
  const commands: string[] = [];
  const env = {
    GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS: "false",
    GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
      box: {
        ssh: { host: "127.0.0.1", port: 9, user: "nobody" },
        tmuxSession: "box",
        cwd: "~/dev/standing",
        agentCommand: "cursor-agent"
      }
    })
  } as unknown as NodeJS.ProcessEnv;
  const exec = (_t: unknown, cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("tmux display-message") && cmd.includes("pane_current_command")) {
      return { code: 0, stdout: "zsh\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new SessionManager({
    tunnels: { ensure: async () => ({ ok: true }) },
    transports: await loadTransports(env),
    notify: async () => {},
    exec
  });
  return { manager, commands };
}

describe("SessionManager.start() with a named runtime", () => {
  it("types a resume command and records it on the session", async () => {
    const { manager, commands } = await harness();
    const session = await manager.start("box", { runtime: "codex", resume: "019fc7c2-5638-7143-a8cb-ec6be630ad13" });
    expect(session.runtime).toBe("codex");
    expect(session.runtimeBin).toBe("codex");
    expect(session.resumeRef).toBe("019fc7c2-5638-7143-a8cb-ec6be630ad13");
    expect(session.resumeCommand).toBe("'codex' 'resume' '019fc7c2-5638-7143-a8cb-ec6be630ad13'");
    const typed = commands.find((c) => c.includes("send-keys") && c.includes("-l"));
    expect(typed).toContain("codex");
    expect(typed).toContain("resume");
    expect(typed).toContain("019fc7c2-5638-7143-a8cb-ec6be630ad13");
  });

  it("attach only works for claude", async () => {
    const { manager } = await harness();
    await expect(manager.start("box", { runtime: "codex", attach: true, resume: "019fc7c2-5638-7143-a8cb-ec6be630ad13" }))
      .rejects.toThrow(/does not support attach/);
  });

  it("types the attach command for a claude background session", async () => {
    const { manager, commands } = await harness();
    const session = await manager.start("box", { runtime: "claude", attach: true, resume: "9e5f1a2b-0000-4000-8000-000000000000" });
    expect(session.runtime).toBe("claude");
    // The typed command carries TWO escaping layers (the ssh/local-shell
    // command string, then the literal keystrokes typed into the pane's own
    // shell) - assert content, not the fully doubled-escaped literal.
    const typed = commands.find((c) => c.includes("send-keys") && c.includes("-l"));
    expect(typed).toContain("claude");
    expect(typed).toContain("attach");
    expect(typed).toContain("9e5f1a2b-0000-4000-8000-000000000000");
  });

  it("rejects a resume ref that fails the runtime's own pattern", async () => {
    const { manager } = await harness();
    await expect(manager.start("box", { runtime: "cursor", resume: "x" }))
      .rejects.toThrow(/bad resume reference/);
  });

  it("rejects an unknown runtime id", async () => {
    const { manager } = await harness();
    await expect(manager.start("box", { runtime: "chatgpt" })).rejects.toThrow(/unknown runtime/);
  });

  it("no runtime named: falls back to the transport's own agentCommand, reported under its basename", async () => {
    const { manager, commands } = await harness();
    const session = await manager.start("box", {});
    expect(session.runtime).toBe("cursor-agent");
    const typed = commands.find((c) => c.includes("send-keys") && c.includes("-l"));
    expect(typed).toContain("'cursor-agent'");
  });

  it("explicit runtime: shell types nothing into a bare pane", async () => {
    const { manager, commands } = await harness();
    const session = await manager.start("box", { runtime: "shell" });
    expect(session.runtime).toBe("shell");
    const typed = commands.find((c) => c.includes("send-keys") && c.includes("-l"));
    expect(typed).toBeUndefined();
  });

  it("a plain reattach (no runtime) never erases a previously recorded resumeCommand", async () => {
    const { manager } = await harness();
    const first = await manager.start("box", { runtime: "codex", resume: "019fc7c2-5638-7143-a8cb-ec6be630ad13" });
    expect(first.resumeCommand).toContain("'codex'");
    expect(first.resumeCommand).toContain("'resume'");
    const again = await manager.start("box", {});
    expect(again.id).toBe(first.id);
    expect(again.resumeCommand).toContain("'codex'");
    expect(again.resumeCommand).toContain("'resume'");
  });
});
