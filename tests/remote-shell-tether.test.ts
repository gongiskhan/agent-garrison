// The tether: the reverse+forward SSH tunnel that makes a machine behind a
// relay (csg) a full mesh node. Pinned here: the argv carries BOTH -R and -L
// legs with ExitOnForwardFailure, the tether is inert on every node except
// its declared owner, two consecutive misses (not one) retire and respawn
// the child, onUp fires exactly once per down->up transition (never on every
// healthy tick), and status() has the shape the /tether route serves.

import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-ignore - dependency-free fitting JavaScript
import { TetherManager, tetherArgv, tetherArmed } from "../fittings/seed/remote-shell-runtime/lib/tether.mjs";

// #markUp writes $GARRISON_HOME/remote-shell/tether.json - GARRISON_HOME must
// be sandboxed in every env fixture below, or a test run writes into this
// machine's REAL ~/.garrison.
const TEST_HOME = mkdtempSync(path.join(tmpdir(), "gar-tether-"));
afterEach(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const TRANSPORT = {
  name: "csg",
  ssh: { host: "127.0.0.1", port: 2222, user: "u", identity: null },
  tether: {
    owner: "dev-madrid",
    node: "csg",
    reverseForwards: [
      { name: "state", remotePort: 8460, localPort: 8460 },
      { name: "git", remotePort: 2200, localPort: 22 }
    ],
    forwards: [
      { name: "app", remotePort: 8777, localPort: 9777, publish: { servePort: 8977 } },
      { name: "shells", remotePort: 8098, localPort: 9098, publish: { servePort: 8998 } }
    ],
    onUp: "$HOME/.garrison/node-supervisor.sh ensure"
  }
} as any;

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Every -L localPort gets a real listener (answering or silent, per
 *  `answer`) - the same discipline tests/remote-shell-forwards.test.ts uses,
 *  since probeRoundTrip does a REAL round trip, not a bare connect. */
function fakeSshSpawn(opts: { answer: boolean } = { answer: true }) {
  return (_cmd: string, argv: string[]) => {
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.stderr = new EventEmitter();
    child.argv = argv;
    child.__servers = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-L") {
        const spec = argv[i + 1];
        const localPort = Number(spec.split(":")[1]);
        const srv = net.createServer((socket) => {
          if (opts.answer) socket.on("data", () => socket.write("HTTP/1.1 404 Not Found\r\n\r\n"));
        });
        servers.push(srv);
        child.__servers.push(srv);
        if (Number.isInteger(localPort)) srv.listen(localPort, "127.0.0.1");
      }
    }
    child.kill = (sig?: string) => {
      child.exitCode = sig === "SIGKILL" ? -9 : 0;
      for (const s of child.__servers) { try { s.close(); } catch {} }
      child.emit("close", child.exitCode);
    };
    return child;
  };
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function transportWithFreePorts(appPort: number, shellsPort: number) {
  return {
    ...TRANSPORT,
    tether: {
      ...TRANSPORT.tether,
      forwards: [
        { name: "app", remotePort: 8777, localPort: appPort, publish: { servePort: 8977 } },
        { name: "shells", remotePort: 8098, localPort: shellsPort, publish: { servePort: 8998 } }
      ]
    }
  };
}

describe("tetherArmed: inert everywhere except the declared owner", () => {
  it("armed only when GARRISON_NODE_NAME matches tether.owner", () => {
    expect(tetherArmed(TRANSPORT, { GARRISON_NODE_NAME: "dev-madrid" } as any)).toBe(true);
    expect(tetherArmed(TRANSPORT, { GARRISON_NODE_NAME: "csg" } as any)).toBe(false);
    expect(tetherArmed(TRANSPORT, { GARRISON_NODE_NAME: "" } as any)).toBe(false);
    expect(tetherArmed({ ...TRANSPORT, tether: undefined }, { GARRISON_NODE_NAME: "dev-madrid" } as any)).toBe(false);
  });
});

describe("tetherArgv: both legs, ExitOnForwardFailure", () => {
  it("carries -R for every reverseForward and -L for every forward, plus -N and ExitOnForwardFailure=yes", () => {
    const argv = tetherArgv(TRANSPORT);
    expect(argv).toContain("-N");
    expect(argv.join(" ")).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("127.0.0.1:8460:127.0.0.1:8460"); // -R state
    expect(argv).toContain("127.0.0.1:2200:127.0.0.1:22"); // -R git
    expect(argv).toContain("127.0.0.1:9777:127.0.0.1:8777"); // -L app
    expect(argv).toContain("127.0.0.1:9098:127.0.0.1:8098"); // -L shells
    const rIdx = argv.indexOf("-R");
    const lIdx = argv.indexOf("-L");
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(lIdx).toBeGreaterThanOrEqual(0);
  });
});

describe("TetherManager.ensure: brings the tether up on evidence from both legs", () => {
  it("reports up when every -L leg round-trips and the reverse exec succeeds", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any });
    const result = await mgr.ensure(transport);
    expect(result.ok).toBe(true);
    expect(mgr.status("csg").state).toBe("up");
    expect(exec).toHaveBeenCalledWith(transport, expect.stringContaining("curl -sf --max-time 5 http://127.0.0.1:8460/v1/health"), expect.anything());
  });

  it("refuses to ensure on a node that is not the tether's owner", async () => {
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn(), exec: vi.fn(), env: { GARRISON_NODE_NAME: "csg", GARRISON_HOME: TEST_HOME } as any });
    const result = await mgr.ensure(TRANSPORT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not armed/);
  });

  it("reports suspect (not up) when a -L leg is a wedged (accept-but-silent) channel", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: false }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any });
    const result = await mgr.ensure(transport);
    expect(result.ok).toBe(false);
    expect(mgr.status("csg").state).not.toBe("up");
  });

  it("reports unhealthy when the reverse (state) leg's remote curl fails, even if forwards are fine", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 7, stdout: "", stderr: "connection refused" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any });
    const result = await mgr.ensure(transport);
    expect(result.ok).toBe(false);
    expect(mgr.status("csg").legs?.reverse?.ok).toBe(false);
  });
});

describe("TetherManager.tick: two misses (not one) before retiring", () => {
  it("stays 'suspect' on the first miss, only retires+respawns on the second", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    let answering = true;
    const spawnFn = (cmd: string, argv: string[]) => fakeSshSpawn({ get answer() { return answering; } } as any)(cmd, argv);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn, exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });
    await mgr.ensure(transport);
    expect(mgr.status("csg").state).toBe("up");

    // Break the forward legs (close the listeners the fake spawned) and tick once.
    const child = (mgr as any).entries.get("csg").child;
    for (const s of child.__servers) s.close();
    answering = false;

    await mgr.tick(transport);
    expect(mgr.status("csg").state).toBe("suspect");
    expect(mgr.status("csg").misses).toBe(1);
    // still the SAME child - not retired yet
    expect((mgr as any).entries.get("csg").child).toBe(child);

    await mgr.tick(transport);
    // second miss retires the old child and starts a new one
    expect((mgr as any).entries.get("csg").child).not.toBe(child);
  });

  // Ratchet, found live on dev-madrid (2026-09-03): `ssh` exits almost
  // immediately on ECONNREFUSED (a genuinely unreachable target), unlike a
  // wedged-but-live forward. The original tick() only re-probed a LIVE
  // child's health and silently did nothing once the child's process table
  // entry was gone - a dead-on-arrival ssh was never retried again, ever.
  it("retries a child that already died on its own between ticks (e.g. ECONNREFUSED) - not stuck forever", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    let spawnCount = 0;
    const diesImmediately = (_cmd: string, _argv: string[]) => {
      spawnCount += 1;
      const child: any = new EventEmitter();
      child.exitCode = 255; // ssh's own exit code on a refused connection
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    };
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: diesImmediately, exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });

    const first = await mgr.ensure(transport);
    expect(first.ok).toBe(false); // the probe never had a live child's forwards to check
    expect(spawnCount).toBe(1);

    await mgr.tick(transport);
    // tick() must notice the child is already dead and spawn a replacement -
    // not silently do nothing forever.
    expect(spawnCount).toBe(2);
    expect(mgr.status("csg").misses).toBeGreaterThan(0);

    await mgr.tick(transport);
    expect(spawnCount).toBe(3);
  });

  it("tick() is a no-op on a node that is not the owner", async () => {
    const exec = vi.fn();
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn(), exec, env: { GARRISON_NODE_NAME: "csg", GARRISON_HOME: TEST_HOME } as any });
    await mgr.tick(TRANSPORT);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("TetherManager onUp: fires once per down->up transition", () => {
  it("runs onUp and onRecovered on the FIRST up, not on subsequent healthy ticks", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });
    const recovered = vi.fn();
    mgr.onRecovered = recovered;

    await mgr.ensure(transport);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(transport, expect.stringContaining("node-supervisor.sh ensure"), expect.anything());

    const onUpCallsBefore = exec.mock.calls.filter((c) => String(c[1]).includes("node-supervisor.sh")).length;
    await mgr.tick(transport); // still healthy - must NOT re-fire onUp
    const onUpCallsAfter = exec.mock.calls.filter((c) => String(c[1]).includes("node-supervisor.sh")).length;
    expect(onUpCallsAfter).toBe(onUpCallsBefore);
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});

describe("status(): the shape /tether serves", () => {
  it("reports down/{since:null,...} for a transport never ensured", () => {
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn(), exec: vi.fn(), env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any });
    expect(mgr.status("csg")).toEqual({ state: "down", since: null, lastOkAt: null, misses: 0, legs: null, lastError: null });
  });

  it("carries state/since/lastOkAt/misses/legs/lastError once ensured", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });
    await mgr.ensure(transport);
    const s = mgr.status("csg");
    expect(s.state).toBe("up");
    expect(typeof s.since).toBe("string");
    expect(typeof s.lastOkAt).toBe("string");
    expect(s.misses).toBe(0);
    expect(s.legs?.forwards).toHaveLength(2);
  });
});

describe("tether.json: what scripts/tailnet-serve-tether.mjs reads", () => {
  it("writes {transport, node, forwards:[{name,localPort,servePort}]} once the tether is up", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });
    await mgr.ensure(transport);
    const written = JSON.parse(readFileSync(path.join(TEST_HOME, "remote-shell", "tether.json"), "utf8"));
    expect(written).toEqual({
      transport: "csg",
      node: "csg",
      forwards: [
        { name: "app", localPort: appPort, servePort: 8977 },
        { name: "shells", localPort: shellsPort, servePort: 8998 }
      ]
    });
  });

  it("skips a forward with no publish.servePort declared", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = {
      ...TRANSPORT,
      tether: {
        ...TRANSPORT.tether,
        forwards: [
          { name: "app", remotePort: 8777, localPort: appPort, publish: { servePort: 8977 } },
          { name: "unpublished", remotePort: 8098, localPort: shellsPort } // no publish block
        ]
      }
    };
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const mgr = new TetherManager({ spawnFn: fakeSshSpawn({ answer: true }), exec, env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any, log: { warn: () => {} } });
    await mgr.ensure(transport);
    const written = JSON.parse(readFileSync(path.join(TEST_HOME, "remote-shell", "tether.json"), "utf8"));
    expect(written.forwards).toEqual([{ name: "app", localPort: appPort, servePort: 8977 }]);
  });
});

// The deadlock this suite did not catch, found the day WSL died under csg.
//
// `onUp` is the RECOVERY command - on csg, `node-supervisor.sh ensure`, which
// starts the node process whose ports the -L forwards carry. Firing it only on
// the down->up transition made it unreachable exactly when it was needed: the
// forwards cannot carry until the node runs, and the node did not run until the
// forwards carried. The tether sat in `suspect` with a perfectly healthy reverse
// leg (ssh worked by hand) until a human ran the hook's own command.
//
// The reverse leg carrying IS "we can run commands over there", which is the
// only precondition the hook has. That is what gates it now.
describe("the recovery hook fires on REACHABLE, not only on fully-up", () => {
  it("runs onUp while the -L forwards carry nothing, because the reverse leg proves we can reach the far side", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const calls: string[] = [];
    const exec = vi.fn(async (_t: unknown, cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" }; // the reverse-leg curl succeeds
    });
    const mgr = new TetherManager({
      spawnFn: fakeSshSpawn({ answer: false }), // listeners accept, never answer
      exec,
      env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any,
      log: { warn: () => {} }
    });

    const res = await mgr.ensure(transport);
    expect(res.state).toBe("suspect"); // the forwards genuinely are not carrying
    expect(
      calls.some((c) => c.includes("node-supervisor.sh ensure")),
      "the recovery hook must run while the far side is reachable but its forwards are dead - that is the whole point of it"
    ).toBe(true);
  });

  it("does NOT run onUp when the reverse leg is down - there is nothing to run it through", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const calls: string[] = [];
    const exec = vi.fn(async (_t: unknown, cmd: string) => {
      calls.push(cmd);
      return { code: 1, stdout: "", stderr: "no route" }; // reverse leg dead
    });
    const mgr = new TetherManager({
      spawnFn: fakeSshSpawn({ answer: false }),
      exec,
      env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any,
      log: { warn: () => {} }
    });

    await mgr.ensure(transport);
    expect(calls.some((c) => c.includes("node-supervisor.sh ensure"))).toBe(false);
  });

  it("does not re-run the hook on every tick while it is still working", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    const calls: string[] = [];
    const exec = vi.fn(async (_t: unknown, cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const mgr = new TetherManager({
      spawnFn: fakeSshSpawn({ answer: false }),
      exec,
      env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any,
      log: { warn: () => {} }
    });

    await mgr.ensure(transport);
    await mgr.tick(transport);
    const hookRuns = calls.filter((c) => c.includes("node-supervisor.sh ensure"));
    expect(hookRuns).toHaveLength(1);
  });
});

describe("#start refuses to run a second ssh over a live one", () => {
  it("ensure() twice spawns exactly one child (the tether had no live-child guard; a raced tick could orphan a working ssh)", async () => {
    const [appPort, shellsPort] = [await freeLocalPort(), await freeLocalPort()];
    const transport = transportWithFreePorts(appPort, shellsPort);
    let spawns = 0;
    const inner = fakeSshSpawn({ answer: true });
    const spawnFn = (cmd: string, argv: string[]) => { spawns += 1; return inner(cmd, argv); };
    const mgr = new TetherManager({
      spawnFn,
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
      env: { GARRISON_NODE_NAME: "dev-madrid", GARRISON_HOME: TEST_HOME } as any,
      log: { warn: () => {} }
    });

    await mgr.ensure(transport);
    await mgr.ensure(transport);
    expect(spawns).toBe(1);
  });
});
