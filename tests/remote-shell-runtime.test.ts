// remote-shell runtime — transport config, hook-driven lifecycle, and (when
// this box can ssh to itself with the garrison key) a live attach loop.
//
// The live block is the committed form of the runtime's core promise: input
// lands in the remote tmux session, and the stop-hook event line — never
// terminal scraping — flips running → idle, settles the turn, and fires the
// notify fan-out. It gates on local sshd + the dedicated key and skips
// cleanly elsewhere.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { loadTransports, sshArgv } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore — pure .mjs
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "remote-shell-runtime");

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-test-"));
  for (const key of ["GARRISON_HOME", "GARRISON_REMOTESHELLRUNTIME_TRANSPORTS"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GARRISON_HOME = tmpHome;
  delete process.env.GARRISON_REMOTESHELLRUNTIME_TRANSPORTS;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("transports config", () => {
  it("merges env JSON over the side file and normalizes entries", async () => {
    mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
    writeFileSync(
      path.join(tmpHome, "remote-shell", "transports.json"),
      JSON.stringify({
        fileonly: { ssh: { host: "10.0.0.5", user: "u" } },
        both: { ssh: { host: "from-file" } }
      })
    );
    const env = {
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
        both: { ssh: { host: "from-env", port: 2222 }, tmuxSession: "weird name!", label: "Both" },
        csg: {
          ssh: { host: "127.0.0.1", port: 2222, user: "ggomes", identity: "~/.ssh/k" },
          via: { devtunnel: { tunnel: "azr-x", port: 2222 } },
          cwd: "~/dev/repo",
          agentCommand: "cursor-agent"
        }
      })
    } as unknown as NodeJS.ProcessEnv;
    const transports = await loadTransports(env);
    expect([...transports.keys()].sort()).toEqual(["both", "csg", "fileonly"]);
    expect(transports.get("both").ssh.host).toBe("from-env");
    // tmux session names must survive tmux's naming rules.
    expect(transports.get("both").tmuxSession).toBe("weird_name_");
    const csg = transports.get("csg");
    expect(csg.via.devtunnel.tunnel).toBe("azr-x");
    expect(csg.eventsFile).toBe("~/.garrison/events.jsonl");
    expect(csg.ssh.identity).toBe(path.join(os.homedir(), ".ssh", "k"));
  });

  it("drops entries without an ssh block and tolerates bad env JSON", async () => {
    const bad = { GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: "{not json" } as unknown as NodeJS.ProcessEnv;
    expect((await loadTransports(bad)).size).toBe(0);
    const noSsh = {
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({ x: { tmuxSession: "x" } })
    } as unknown as NodeJS.ProcessEnv;
    expect((await loadTransports(noSsh)).size).toBe(0);
  });

  it("builds ssh argv with identity, port, and optional pty", async () => {
    const env = {
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
        t: { ssh: { host: "h", port: 2200, user: "u", identity: "~/.ssh/k" } }
      })
    } as unknown as NodeJS.ProcessEnv;
    const t = (await loadTransports(env)).get("t");
    const plain = sshArgv(t);
    expect(plain).toContain("-p");
    expect(plain).toContain("2200");
    expect(plain).toContain("u@h");
    expect(plain).toContain("-i");
    expect(plain).not.toContain("-tt");
    expect(sshArgv(t, { pty: true })).toContain("-tt");
  });
});

describe("hook-driven lifecycle", () => {
  async function makeManager(notifications: unknown[]) {
    // Port 9 (discard) fails instantly — capturePane inside stop settlement
    // must degrade to an empty tail, not hang.
    const env = {
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
        fake: { ssh: { host: "127.0.0.1", port: 9, user: "nobody" }, tmuxSession: "fake" }
      })
    } as unknown as NodeJS.ProcessEnv;
    const transports = await loadTransports(env);
    const manager = new SessionManager({
      tunnels: { ensure: async () => ({ ok: true }) },
      transports,
      notify: async (p: unknown) => { notifications.push(p); }
    });
    // Seed a session record through the restore path (no ssh involved).
    mkdirSync(path.join(tmpHome, "remote-shell"), { recursive: true });
    writeFileSync(
      path.join(tmpHome, "remote-shell", "sessions.json"),
      JSON.stringify({
        sessions: [{
          id: "s1", transport: "fake", tmuxSession: "fake",
          label: "Fake", createdAt: new Date().toISOString(), state: "idle", lastEventAt: null
        }]
      })
    );
    expect(await manager.restore()).toBe(1);
    return manager;
  }

  it("agent-start flips running; agent-stop flips idle, settles the turn, notifies", async () => {
    const notifications: unknown[] = [];
    const manager = await makeManager(notifications);
    const session = manager.get("s1");

    manager.onEventLine(session, JSON.stringify({ ts: "2026-08-21T10:00:00Z", event: "agent-start" }));
    expect(session.state).toBe("running");

    // A tracked turn, wired directly (startTurn would need live ssh).
    const turn = {
      id: "t1", text: "do work", startedAt: new Date().toISOString(),
      endedAt: null, state: "running", waiters: []
    };
    session.turns.set(turn.id, turn);
    session.activeTurn = turn;

    const settled = manager.awaitTurn(session, "t1", 5000);
    manager.onEventLine(session, JSON.stringify({ ts: "2026-08-21T10:00:05Z", event: "agent-stop", session_id: "x" }));
    const done = await settled;
    expect(done.state).toBe("completed");
    expect(session.state).toBe("idle");
    expect(session.activeTurn).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.length).toBe(1);
    expect((notifications[0] as { text: string }).text).toContain("finished");
  });

  it("ignores malformed and unknown event lines", async () => {
    const notifications: unknown[] = [];
    const manager = await makeManager(notifications);
    const session = manager.get("s1");
    manager.onEventLine(session, "not json at all");
    manager.onEventLine(session, JSON.stringify({ event: 42 }));
    manager.onEventLine(session, JSON.stringify({ event: "unknown-kind" }));
    expect(session.state).toBe("idle");
    expect(notifications.length).toBe(0);
  });
});

// ── Live local-ssh attach loop ──────────────────────────────────────────────
// Real ssh (to this box), real tmux, real events file — the CSG shape with
// localhost as the "remote". Requires sshd + the dedicated key; skips cleanly
// when absent.

const KEY = path.join(os.homedir(), ".ssh", "garrison-remote-shell");
const sshSelfOk = (() => {
  const r = spawnSync("ssh", [
    "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=accept-new",
    `${os.userInfo().username}@127.0.0.1`, "true"
  ], { timeout: 8000 });
  if (r.status !== 0) return false;
  return spawnSync("tmux", ["-V"], { timeout: 3000 }).status === 0;
})();

describe.skipIf(!sshSelfOk)("live local-ssh attach", () => {
  const tmuxName = `rshtest_${process.pid}`;

  afterEach(() => {
    spawnSync("tmux", ["kill-session", "-t", tmuxName], { timeout: 5000 });
  });

  it("attaches, injects input, and settles a turn from the events file", async () => {
    const eventsFile = path.join(tmpHome, "events.jsonl");
    writeFileSync(eventsFile, "");
    const env = {
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
        localtest: {
          ssh: { host: "127.0.0.1", port: 22, user: os.userInfo().username, identity: KEY },
          tmuxSession: tmuxName,
          cwd: tmpHome,
          eventsFile,
          label: "Live test"
        }
      })
    } as unknown as NodeJS.ProcessEnv;
    const notifications: unknown[] = [];
    const manager = new SessionManager({
      tunnels: { ensure: async () => ({ ok: true }) },
      transports: await loadTransports(env),
      notify: async (p: unknown) => { notifications.push(p); }
    });
    try {
      const session = await manager.start("localtest", {});
      expect(session.state).toBe("idle");

      const turn = await manager.startTurn(session, "echo live-turn-marker");
      expect(session.state).toBe("running");

      // The remote agent's stop hook, simulated: append to the events file the
      // watcher is tailing over ssh.
      await new Promise((r) => setTimeout(r, 700));
      writeFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), event: "agent-stop" }) + "\n", { flag: "a" });

      const done = await manager.awaitTurn(session, turn.id, 15_000);
      expect(done.state).toBe("completed");
      expect(session.state).toBe("idle");
      expect(done.tail).toContain("live-turn-marker");
      expect(notifications.length).toBe(1);
    } finally {
      manager.shutdownAll();
    }
  }, 40_000);
});

// ── Adapter contract against a live server ──────────────────────────────────
// Boots the real own-port server on a scratch port and drives a full delegated
// turn through RemoteShellAdapter: spawn (model slot names the transport) →
// sendTurn → stop-hook event → awaitResponse settles with the pane tail.

describe.skipIf(!sshSelfOk)("RemoteShellAdapter against a live server", () => {
  const tmuxName = `rshadp_${process.pid}`;

  afterEach(() => {
    spawnSync("tmux", ["kill-session", "-t", tmuxName], { timeout: 5000 });
  });

  it("delegates a turn end to end", async () => {
    const eventsFile = path.join(tmpHome, "adapter-events.jsonl");
    writeFileSync(eventsFile, "");
    const port = 19000 + (process.pid % 1000);
    process.env.GARRISON_REMOTESHELLRUNTIME_PORT = String(port);
    process.env.GARRISON_REMOTESHELLRUNTIME_TRANSPORTS = JSON.stringify({
      adp: {
        ssh: { host: "127.0.0.1", port: 22, user: os.userInfo().username, identity: KEY },
        tmuxSession: tmuxName,
        cwd: tmpHome,
        eventsFile,
        label: "Adapter test"
      }
    });
    // @ts-ignore — pure .mjs
    const { startServer } = await import("../fittings/seed/remote-shell-runtime/scripts/server.mjs");
    // @ts-ignore — pure .mjs
    const { RemoteShellAdapter } = await import("../fittings/seed/remote-shell-runtime/lib/remote-shell-adapter.mjs");
    const server = await startServer();
    try {
      const adapter = new RemoteShellAdapter({ baseUrl: `http://127.0.0.1:${port}` });
      const session = await adapter.spawn({ model: "adp" });
      await adapter.awaitReady(session);
      await adapter.sendTurn(session, "echo adapter-turn-marker");
      // Late enough that a progress tick lands first: the delegate lane must
      // show the remote's output WHILE it works, not only once it stops.
      setTimeout(() => {
        writeFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), event: "agent-stop" }) + "\n", { flag: "a" });
      }, 5000);
      const chunks: Array<{ text: string; replace: boolean }> = [];
      const resp = await adapter.awaitResponse(session, {
        onChunk: (text: string, replace: boolean) => { chunks.push({ text, replace }); }
      });
      expect(resp.text).toContain("adapter-turn-marker");
      expect(resp.text).toContain("finished");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.text.includes("adapter-turn-marker"))).toBe(true);
      // A TUI rewrites its last lines in place, so every chunk is a REPLACE of
      // the whole text; appending them would duplicate the transcript.
      expect(chunks.every((c) => c.replace === true)).toBe(true);
      await adapter.teardown(session);
    } finally {
      server.close();
    }
  }, 40_000);
});
