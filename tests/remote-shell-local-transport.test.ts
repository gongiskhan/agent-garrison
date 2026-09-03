// The `local` transport: the same #exec/attach/events-tail seams every ssh
// transport rides, running on THIS machine's own dedicated tmux socket
// instead of dialing out. Two layers pinned here:
//
//   1. localExec's prelude routes every `tmux ...` invocation in a command
//      string onto the fitting's own socket/config, without touching the
//      command strings themselves (proven against a fake tmux binary that
//      just echoes its argv).
//   2. A real SessionManager.start("local", ...) creates a REAL tmux session
//      on that dedicated socket - proof the whole plumbing (attach spec,
//      window-size/mouse setup, events file) works end to end, not just that
//      the command strings look right.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { loadTransports, localTransport, localExec, attachSpawnSpec, eventsTailSpec } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";
// @ts-ignore — pure .mjs
import { SessionManager } from "../fittings/seed/remote-shell-runtime/lib/sessions.mjs";

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-local-"));
  priorHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmpHome;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const hasTmux = spawnSync("tmux", ["-V"], { timeout: 3000 }).status === 0;

describe("loadTransports - local synthesis", () => {
  it("adds a local transport by default when tmux is on PATH", async () => {
    const transports = await loadTransports({ GARRISON_HOME: tmpHome } as unknown as NodeJS.ProcessEnv);
    expect(transports.has("local")).toBe(hasTmux);
    if (hasTmux) {
      const t = transports.get("local");
      expect(t.kind).toBe("local");
      expect(t.local.socket).toBe(path.join(tmpHome, "tmux", "shells.sock"));
    }
  });

  it("omits the local transport when explicitly disabled", async () => {
    const transports = await loadTransports({
      GARRISON_HOME: tmpHome,
      GARRISON_REMOTESHELLRUNTIME_LOCAL_SHELLS: "false"
    } as unknown as NodeJS.ProcessEnv);
    expect(transports.has("local")).toBe(false);
  });

  it("never synthesizes over an explicitly configured transport named local", async () => {
    const transports = await loadTransports({
      GARRISON_HOME: tmpHome,
      GARRISON_REMOTESHELLRUNTIME_TRANSPORTS: JSON.stringify({
        local: { ssh: { host: "10.0.0.9", user: "u" } }
      })
    } as unknown as NodeJS.ProcessEnv);
    expect(transports.get("local").kind).toBe("ssh");
  });

  it("injected tmuxAvailable() gates synthesis independently of the real machine", async () => {
    const transports = await loadTransports(
      { GARRISON_HOME: tmpHome } as unknown as NodeJS.ProcessEnv,
      { tmuxAvailable: () => false }
    );
    expect(transports.has("local")).toBe(false);
  });
});

describe.skipIf(!hasTmux)("localExec - the tmux() prelude", () => {
  let binDir: string;
  let priorPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(os.tmpdir(), "rsh-fakebin-"));
    const fakeTmux = path.join(binDir, "tmux");
    // Echoes its argv one-per-line and the ambient TMUX var, so the test can
    // assert both the prelude's injected flags and the sanitized env.
    writeFileSync(fakeTmux, "#!/bin/sh\nfor a in \"$@\"; do echo \"ARG:$a\"; done\necho \"TMUX:${TMUX:-unset}\"\n");
    chmodSync(fakeTmux, 0o755);
    priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterEach(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("routes tmux onto the transport's own socket/config and strips TMUX from the env", async () => {
    const t = localTransport({ GARRISON_HOME: tmpHome } as unknown as NodeJS.ProcessEnv);
    const r = await localExec(t, "tmux -V", { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toEqual(["ARG:-S", `ARG:${t.local.socket}`, "ARG:-f", `ARG:${t.local.conf}`, "ARG:-V", "TMUX:unset"]);
  });
});

describe.skipIf(!hasTmux)("SessionManager.start(\"local\", ...) - real tmux", () => {
  const tmuxName = `rshlocaltest_${process.pid}`;
  let session: { transport: { local: { socket: string; conf: string } } } | null = null;

  afterEach(() => {
    if (session) {
      spawnSync("tmux", ["-S", session.transport.local.socket, "-f", session.transport.local.conf, "kill-session", "-t", tmuxName], { timeout: 5000 });
    }
    session = null;
  });

  it("creates a real session on the dedicated socket with mouse on and window-size manual", async () => {
    const cwd = tmpHome;
    const manager = new SessionManager({
      tunnels: { ensure: async () => ({ ok: true }) },
      transports: await loadTransports({ GARRISON_HOME: tmpHome } as unknown as NodeJS.ProcessEnv),
      notify: async () => {}
    });
    const s = await manager.start("local", { tmuxSession: tmuxName, cwd, allocate: false, runtime: "shell" });
    session = s;
    expect(s.transport.kind).toBe("local");
    expect(s.runtime).toBe("shell");

    const { socket, conf } = s.transport.local;
    const hasSession = spawnSync("tmux", ["-S", socket, "-f", conf, "has-session", "-t", tmuxName], { timeout: 5000 });
    expect(hasSession.status).toBe(0);

    const mouse = spawnSync("tmux", ["-S", socket, "-f", conf, "show-options", "-t", tmuxName, "mouse"], { encoding: "utf8", timeout: 5000 });
    expect(mouse.stdout.trim()).toBe("mouse on");

    const size = spawnSync("tmux", ["-S", socket, "-f", conf, "show-options", "-g", "-t", tmuxName, "window-size"], { encoding: "utf8", timeout: 5000 });
    expect(size.stdout.trim()).toBe("window-size manual");
  });

  it("attachSpawnSpec/eventsTailSpec target the same socket and a real events file", async () => {
    const t = localTransport({ GARRISON_HOME: tmpHome } as unknown as NodeJS.ProcessEnv);
    const attach = attachSpawnSpec(t, tmuxName);
    expect(attach.file).toBe("tmux");
    expect(attach.argv).toEqual(["-S", t.local.socket, "-f", t.local.conf, "attach-session", "-t", tmuxName]);

    const tail = eventsTailSpec(t);
    expect(tail.file).toBe("tail");
    expect(tail.argv[0]).toBe("-n");
    expect(tail.argv[2]).toBe("-F");
    // eventsTailSpec ensures the file exists (mkdir + touch) before returning.
    const listed = spawnSync("test", ["-f", tail.argv[3]]);
    expect(listed.status).toBe(0);
  });
});
