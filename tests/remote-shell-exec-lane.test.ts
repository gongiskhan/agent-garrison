// The exec lane: a headless agent turn on a remote machine, over the tunnel the
// fitting already owns.
//
// Why it exists at all: the tmux lane drives an interactive TUI, which has no
// turn boundaries, no chat id and no token counts - everything above it has to
// infer. `cursor-agent -p --output-format stream-json` hands over all three, so
// the far machine can be an ordinary Garrison runtime target instead of a screen
// we scrape. The failures worth pinning are the quiet ones:
//
//   - the CLI prints its refusals (untrusted workspace, unknown model) as human
//     prose and EXITS 0, so "no result object" must fail the turn rather than
//     return an empty success;
//   - a non-interactive ssh command gets none of the user's profile, so without
//     a login shell the agent binary is simply not on PATH;
//   - the prompt must never reach argv (it is arbitrary user text on a machine
//     running an agent with --force).

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { loadTransports } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore - dependency-free fitting JavaScript
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";
// @ts-ignore - dependency-free fitting JavaScript
import { parseRemoteTarget } from "../fittings/seed/remote-shell-runtime/lib/remote-shell-adapter.mjs";

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-exec-"));
  priorHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmpHome;
  mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

type Call = { command: string; input: string | null };

async function harness(reply: (call: Call) => { code: number; stdout: string; stderr: string }) {
  const calls: Call[] = [];
  const env = {
    GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
      box: {
        ssh: { host: "127.0.0.1", port: 9, user: "nobody" },
        tmuxSession: "box",
        cwd: "~/dev/standing",
        agentCommand: "cursor-agent"
      },
      claudebox: {
        ssh: { host: "127.0.0.1", port: 9, user: "nobody" },
        tmuxSession: "cb",
        cwd: "~/dev/x",
        agentCommand: "claude"
      }
    })
  } as unknown as NodeJS.ProcessEnv;

  const manager = new SessionManager({
    tunnels: { ensure: async () => ({ ok: true }), noteTraffic() {}, markSuspect() {} },
    transports: await loadTransports(env),
    notify: async () => {},
    exec: async (_t: unknown, command: string, opts: any = {}) => {
      const call = { command, input: opts.input ?? null };
      calls.push(call);
      const out = reply(call);
      // Deliver stdout the way ssh does when the caller is streaming.
      if (opts.onStdout && out.stdout) opts.onStdout(out.stdout);
      return out;
    },
    ptySpawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} })
  });
  return { manager, calls };
}

const RESULT = (text: string, id = "chat-1") =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 42, result: text, session_id: id, usage: { inputTokens: 10, outputTokens: 3 } });

describe("the exec lane runs a real turn on the far machine", () => {
  it("returns the text, the chat id and the usage from the result object", async () => {
    const h = await harness(() => ({ code: 0, stdout: `${RESULT("PROBE-OK", "chat-9")}\n`, stderr: "" }));
    const turn = await h.manager.agentTurn("box", { prompt: "say it", model: "gpt-5.3-codex-low" });
    expect(turn.text).toBe("PROBE-OK");
    expect(turn.sessionId).toBe("chat-9");
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(turn.cwd).toBe("~/dev/standing");
  });

  it("runs under a LOGIN shell, in the project folder, with the prompt on stdin", async () => {
    const h = await harness(() => ({ code: 0, stdout: `${RESULT("ok")}\n`, stderr: "" }));
    await h.manager.agentTurn("box", { prompt: "a prompt; rm -rf /", cwd: "~/dev/thing", model: "auto" });
    const [call] = h.calls;
    // Without `bash -lc` the agent binary is not on PATH at all: a
    // non-interactive ssh command reads no profile.
    expect(call.command.startsWith("bash -lc ")).toBe(true);
    expect(call.command).toContain('cd "$HOME"');
    expect(call.command).toContain("cursor-agent");
    expect(call.command).toContain("--output-format");
    expect(call.command).toContain("stream-json");
    // The prompt is arbitrary text on a machine running an agent with --force.
    expect(call.input).toBe("a prompt; rm -rf /");
    expect(call.command).not.toContain("rm -rf");
  });

  it("passes --resume so a second turn continues the same chat", async () => {
    const h = await harness(() => ({ code: 0, stdout: `${RESULT("ok", "chat-7")}\n`, stderr: "" }));
    await h.manager.agentTurn("box", { prompt: "hi", resumeId: "chat-7" });
    expect(h.calls[0].command).toContain("--resume");
    expect(h.calls[0].command).toContain("chat-7");
  });

  it("streams deltas as they land, then settles on the result", async () => {
    const deltas: string[] = [];
    const h = await harness(() => ({
      code: 0,
      stdout:
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ text: "Hel" }] } }) + "\n" +
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ text: "lo" }] } }) + "\n" +
        RESULT("Hello") + "\n",
      stderr: ""
    }));
    const turn = await h.manager.agentTurn("box", { prompt: "hi", onDelta: (d: string) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(turn.text).toBe("Hello");
  });

  it("does not emit the closing RECAP frame as another delta", async () => {
    // The live shape: partials "RAW","-","OK" and then ONE frame carrying the
    // whole "RAW-OK" again. Streamed straight through, the channel showed the
    // answer twice until the result settled it.
    const deltas: string[] = [];
    const frame = (text: string, stamped = true) =>
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        session_id: "chat-1",
        ...(stamped ? { timestamp_ms: 1 } : {})
      });
    const h = await harness(() => ({
      code: 0,
      stdout: [frame("RAW"), frame("-"), frame("OK"), frame("RAW-OK", false), RESULT("RAW-OK")].join("\n") + "\n",
      stderr: ""
    }));
    const turn = await h.manager.agentTurn("box", { prompt: "hi", onDelta: (d: string) => deltas.push(d) });
    expect(deltas.join("")).toBe("RAW-OK");
    expect(turn.text).toBe("RAW-OK");
  });

  it("FAILS a turn that produced no result object, however it exited", async () => {
    // The live shape: an untrusted workspace prints prose and exits 0. Reporting
    // that as an empty reply is the one failure the caller cannot see.
    const h = await harness(() => ({ code: 0, stdout: "Workspace Trust Required\nDo you trust…\n", stderr: "" }));
    await expect(h.manager.agentTurn("box", { prompt: "hi" })).rejects.toThrow(/no result/i);
  });

  it("surfaces an error result rather than returning its text as an answer", async () => {
    const h = await harness(() => ({
      code: 0,
      stdout: JSON.stringify({ type: "result", is_error: true, result: "model not found" }) + "\n",
      stderr: ""
    }));
    await expect(h.manager.agentTurn("box", { prompt: "hi" })).rejects.toThrow(/model not found/);
  });

  it("reports a missing folder as such", async () => {
    const h = await harness(() => ({ code: 9, stdout: "", stderr: "" }));
    await expect(h.manager.agentTurn("box", { prompt: "hi", cwd: "~/dev/nope" })).rejects.toThrow(/no such folder/i);
  });

  it("refuses a transport whose agent it cannot speak", async () => {
    // Better a loud refusal than cursor flags handed to another CLI.
    const h = await harness(() => ({ code: 0, stdout: "", stderr: "" }));
    await expect(h.manager.agentTurn("claudebox", { prompt: "hi" })).rejects.toThrow(/cursor-agent/);
    expect(h.calls).toHaveLength(0);
  });

  it("quotes every argv element, so a model id cannot become syntax", async () => {
    const h = await harness(() => ({ code: 0, stdout: `${RESULT("ok")}\n`, stderr: "" }));
    await h.manager.execArgv("box", { argv: ["echo", "a b", "; touch /tmp/pwned"] });
    expect(h.calls[0].command).toContain("'; touch /tmp/pwned'");
  });

  it("rejects an empty or malformed argv", async () => {
    const h = await harness(() => ({ code: 0, stdout: "", stderr: "" }));
    await expect(h.manager.execArgv("box", { argv: [] })).rejects.toThrow(/argv/);
    await expect(h.manager.execArgv("box", { argv: ["ok", 42 as unknown as string] })).rejects.toThrow(/argv/);
  });
});

describe("the target's model slot picks the lane", () => {
  it("a bare transport stays on the interactive TUI lane", () => {
    expect(parseRemoteTarget("csg")).toEqual({ transport: "csg", model: null, lane: "tui" });
  });

  it("transport:model selects the headless exec lane", () => {
    expect(parseRemoteTarget("csg:gpt-5.3-codex-low")).toEqual({
      transport: "csg",
      model: "gpt-5.3-codex-low",
      lane: "exec"
    });
  });

  it("keeps a bracketed cursor model intact", () => {
    // Cursor encodes effort in the id; splitting on the FIRST colon only is what
    // keeps `claude-opus-4-8[context=1m]` reaching the CLI unmangled.
    expect(parseRemoteTarget("csg:claude-opus-4-8[context=1m,effort=high]").model).toBe(
      "claude-opus-4-8[context=1m,effort=high]"
    );
  });

  it("treats a trailing colon as no model, not an empty one", () => {
    expect(parseRemoteTarget("csg:")).toEqual({ transport: "csg", model: null, lane: "exec" });
  });
});

describe("the exec lane is not browser-reachable", () => {
  it("keeps /exec and /agent-turns out of the web channel's relay", async () => {
    // The browser can reach the fitting only through the web channel's explicit
    // allow-list. /exec runs a command on the remote machine and /agent-turns
    // spends the account's tokens: neither belongs on a surface a page can call.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../packages/talk/src/router.mjs", import.meta.url),
        "utf8"
      )
    );
    const line = /const REMOTE_SHELL_PROXY_RE =\s*\n?\s*(\/\^.*\$\/);/.exec(src);
    expect(line, "the relay allow-list moved").toBeTruthy();
    // eslint-disable-next-line no-eval
    const re = eval(line![1]) as RegExp;
    expect(re.test("/exec")).toBe(false);
    expect(re.test("/agent-turns")).toBe(false);
    // …while the surfaces the UI genuinely uses still pass.
    expect(re.test("/sessions")).toBe(true);
    expect(re.test("/projects")).toBe(true);
  });
});
