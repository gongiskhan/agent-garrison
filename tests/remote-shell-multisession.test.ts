// Several agents on one machine, and one folder able to hold more than one.
//
// Two things break silently if this is wrong, and both are pinned here:
//
//   1. Instance allocation. The name is chosen by the FITTING because only it
//      can see its own sessions AND the tmux sessions already on the remote
//      (which outlive a fitting restart). A client that guessed the number
//      would attach a "new" shell to somebody else's running agent - the same
//      class of mistake as starting an agent in the wrong cwd, and just as
//      invisible until it edits the wrong tree.
//   2. Matching a thread to ITS session. With one session per machine the web
//      channel could key live state by transport; with many, that map hands
//      every shell on the box whichever session happened to be last, so a row
//      reads "Working" because a different project's agent is busy.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { loadTransports } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore - dependency-free fitting JavaScript
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";
// @ts-ignore - dependency-free fitting JavaScript
import { matchRemoteShellSession } from "../packages/talk/src/server.mjs";

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-multi-"));
  priorHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmpHome;
  mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

type Exec = (cmd: string) => { code: number; stdout: string; stderr: string };

/** A manager whose remote is a script: `remoteSessions` is what tmux reports,
 *  and every session it creates lands there, exactly as the real one would. */
async function harness(remoteSessions: string[] = []) {
  const commands: string[] = [];
  const live = new Set(remoteSessions);
  const env = {
    GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
      box: {
        ssh: { host: "127.0.0.1", port: 9, user: "nobody" },
        tmuxSession: "box",
        cwd: "~/dev/standing",
        agentCommand: "cursor-agent"
      }
    })
  } as unknown as NodeJS.ProcessEnv;

  const exec: Exec = (cmd) => {
    if (cmd.includes("tmux list-sessions")) {
      return { code: 0, stdout: [...live].join("\n") + (live.size ? "\n" : ""), stderr: "" };
    }
    if (cmd.includes("tmux has-session")) {
      // The bring-up command creates the session when it is missing, then
      // reports what the pane is running.
      const m = /tmux has-session -t '([^']+)'/.exec(cmd);
      if (m) live.add(m[1]);
      return { code: 0, stdout: "zsh\n", stderr: "" };
    }
    if (cmd.includes("for d in")) {
      return { code: 0, stdout: "/home/u/dev/alpha/\n/home/u/dev/beta/\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const manager = new SessionManager({
    tunnels: { ensure: async () => ({ ok: true }), noteTraffic() {}, markSuspect() {} },
    transports: await loadTransports(env),
    notify: async () => {},
    exec: async (_t: unknown, cmd: string) => { commands.push(cmd); return exec(cmd); },
    ptySpawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} })
  });
  return { manager, commands, live };
}

describe("one folder, several agents", () => {
  it("allocates the next free instance instead of joining the running one", async () => {
    const h = await harness();
    const first = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });
    const second = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });
    const third = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });

    expect([first.tmuxSession, second.tmuxSession, third.tmuxSession]).toEqual(["alpha", "alpha-2", "alpha-3"]);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    // Named, not numbered-and-nameless: the rail shows these side by side.
    expect([first.label, second.label, third.label]).toEqual(["alpha", "alpha #2", "alpha #3"]);
    // Every one of them is in the same tree.
    expect([first.cwd, second.cwd, third.cwd]).toEqual(["~/dev/alpha", "~/dev/alpha", "~/dev/alpha"]);
  });

  it("skips a name that exists only on the REMOTE, which is what a restart leaves", async () => {
    // The fitting restarted and knows nothing; tmux on the box still holds the
    // agent. Reusing `alpha` here would silently adopt that running session as
    // a brand new shell.
    const h = await harness(["alpha", "alpha-2"]);
    const s = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });
    expect(s.tmuxSession).toBe("alpha-3");
  });

  it("gives two simultaneous starts two different sessions", async () => {
    // Both allocations read the same free name before either registers; the
    // in-flight reservation is the only thing that separates them.
    const h = await harness();
    const [a, b] = await Promise.all([
      h.manager.start("box", { tmuxSession: "beta", cwd: "~/dev/beta", label: "beta", allocate: true }),
      h.manager.start("box", { tmuxSession: "beta", cwd: "~/dev/beta", label: "beta", allocate: true })
    ]);
    expect(a.tmuxSession).not.toBe(b.tmuxSession);
    expect([a.tmuxSession, b.tmuxSession].sort()).toEqual(["beta", "beta-2"]);
  });

  it("without allocate, a named session is still idempotent", async () => {
    // Opening an existing shell must ATTACH, never spawn a sibling - this is
    // the path every thread takes when it is opened.
    const h = await harness();
    const a = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha" });
    const b = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha" });
    expect(b.id).toBe(a.id);
    expect(h.manager.list()).toHaveLength(1);
  });

  it("lists every session in a folder, not the first one", async () => {
    const h = await harness();
    await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });
    await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", label: "alpha", allocate: true });
    const projects = await h.manager.listProjects("box");
    const alpha = projects.find((p: any) => p.name === "alpha");
    expect(alpha.sessions.map((s: any) => s.tmuxSession)).toEqual(["alpha", "alpha-2"]);
    expect(projects.find((p: any) => p.name === "beta").sessions).toEqual([]);
  });

  it("marks the transport's standing session, so a thread that names none can find it", async () => {
    const h = await harness();
    const standing = await h.manager.start("box", {});
    const project = await h.manager.start("box", { tmuxSession: "alpha", cwd: "~/dev/alpha", allocate: true });
    const summaries = h.manager.list();
    expect(summaries.find((s: any) => s.id === standing.id).standing).toBe(true);
    expect(summaries.find((s: any) => s.id === project.id).standing).toBe(false);
  });
});

describe("a thread finds ITS session", () => {
  const sessions = [
    { id: "std", transport: "box", tmuxSession: "box", standing: true, state: "idle" },
    { id: "a1", transport: "box", tmuxSession: "alpha", standing: false, state: "running" },
    { id: "a2", transport: "box", tmuxSession: "alpha-2", standing: false, state: "idle" },
    { id: "other", transport: "elsewhere", tmuxSession: "alpha", standing: false, state: "running" }
  ];

  it("matches by tmux session name", () => {
    expect(matchRemoteShellSession({ transport: "box", tmuxSession: "alpha-2" }, sessions).id).toBe("a2");
  });

  it("never lets a busy sibling mark a quiet shell as working", () => {
    // The bug the per-transport map produced: alpha is running, so alpha-2's
    // row claimed its agent was working too.
    expect(matchRemoteShellSession({ transport: "box", tmuxSession: "alpha-2" }, sessions).state).toBe("idle");
  });

  it("falls back to the standing session for a binding written before multi-session", () => {
    expect(matchRemoteShellSession({ transport: "box" }, sessions).id).toBe("std");
  });

  it("stays on its own machine", () => {
    expect(matchRemoteShellSession({ transport: "elsewhere", tmuxSession: "alpha" }, sessions).id).toBe("other");
    expect(matchRemoteShellSession({ transport: "nowhere", tmuxSession: "alpha" }, sessions)).toBeNull();
  });

  it("is null for a thread with no binding at all", () => {
    expect(matchRemoteShellSession(null, sessions)).toBeNull();
  });
});
