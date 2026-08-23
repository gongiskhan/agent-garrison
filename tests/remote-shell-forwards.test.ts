// Port forwards for the remote-shell runtime: reaching a service that runs ON the
// remote machine, so remote work can be REVIEWED and not merely reported.
//
// The two properties pinned here are the ones live use proved matter, in the order
// they bit:
//   1. health must be a real round trip - `ssh -L` accepts on the local port
//      whether or not the far end is reachable, so a TCP connect reports "up" for
//      a forward that hangs on every request;
//   2. the local port must mirror the remote one where it can, and must SAY SO
//      when it cannot - the remote page keeps resolving absolute
//      localhost:<remote> URLs, which then hit this machine's own copy of the
//      same service and produce a silent hybrid of two machines.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
// @ts-ignore - dependency-free fitting JavaScript
import { ForwardManager, normalizeForwards, normalizeForward } from "../fittings/seed/remote-shell-runtime/lib/forwards.mjs";

const TRANSPORT = {
  name: "csg",
  ssh: { host: "127.0.0.1", port: 2222, user: "u", identity: null },
  forwards: []
} as any;

/**
 * A stand-in for `ssh -N -L`: it does what ssh does, which is open a LISTENER on
 * the local side of the forward. `answer` decides whether that listener replies -
 * the difference between a working channel and a wedged one, and the whole point
 * of the health check under test. A fake that only pretended to be a live process
 * would make every case read as "down" and prove nothing.
 */
function fakeSsh(opts: { answer: boolean }) {
  return (_cmd: string, argv: string[]) => {
    const spec = argv[argv.indexOf("-L") + 1] ?? "";
    const localPort = Number(spec.split(":")[1]);
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.stderr = new EventEmitter();
    child.forwardedTo = spec;
    const srv = net.createServer((socket) => {
      if (opts.answer) socket.on("data", () => socket.write("HTTP/1.1 404 Not Found\r\n\r\n"));
    });
    servers.push(srv);
    if (Number.isInteger(localPort)) srv.listen(localPort, "127.0.0.1");
    child.kill = () => {
      child.exitCode = 0;
      try { srv.close(); } catch { /* already closed */ }
      child.emit("close", 0);
    };
    return child;
  };
}

/** A port nothing is holding, so the mirrored path is the one exercised. */
function freeLocalPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A listener that accepts and, optionally, answers - the difference that matters. */
function listener(opts: { answer: boolean }): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      if (opts.answer) socket.on("data", () => socket.write("HTTP/1.1 404 Not Found\r\n\r\n"));
      // else: accept and stay silent, exactly like a wedged ssh -L channel
    });
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
  });
}

describe("forward config", () => {
  it("keeps only entries that name a real port, and defaults the rest", () => {
    const out = normalizeForwards([
      { name: "web", remotePort: 3006, label: "Web" },
      { port: 8080 },
      { name: "bad", remotePort: 0 },
      { name: "nope" },
      "garbage"
    ]);
    expect(out.map((f: any) => f.name)).toEqual(["web", "port-8080"]);
    expect(out[0]).toMatchObject({ remotePort: 3006, label: "Web", path: "/" });
    expect(out[1].label).toBe("port-8080");
  });

  it("only accepts an absolute path, so a link can be built by concatenation", () => {
    expect(normalizeForward({ remotePort: 1, path: "/admin" }, 0)!.path).toBe("/admin");
    expect(normalizeForward({ remotePort: 1, path: "admin" }, 0)!.path).toBe("/");
  });

  it("ignores a non-array forwards block instead of throwing at load", () => {
    expect(normalizeForwards(undefined)).toEqual([]);
    expect(normalizeForwards("3006" as any)).toEqual([]);
  });
});

describe("forward health is a round trip, not a TCP accept", () => {
  it("reports down for a channel that accepts and then answers nothing", async () => {
    // The exact live failure: ssh -L bound to a replaced tunnel accepted instantly
    // and hung forever, while the status said "up".
    const port = await freeLocalPort();
    const mgr = new ForwardManager({ spawnFn: fakeSsh({ answer: false }) });
    const result = await mgr.ensure(TRANSPORT, { name: "web", remotePort: port, label: "Web", path: "/" });
    expect(result.status).toBe("down");
    mgr.stopAll();
  }, 20000);

  it("reports up when the channel actually answers - any status counts", async () => {
    // A 404 still proves the channel carries traffic; the question is reachability,
    // not whether the remote likes the path.
    const port = await freeLocalPort();
    const mgr = new ForwardManager({ spawnFn: fakeSsh({ answer: true }) });
    const result = await mgr.ensure(TRANSPORT, { name: "web", remotePort: port, label: "Web", path: "/" });
    expect(result.status).toBe("up");
    mgr.stopAll();
  }, 20000);
});

describe("mirroring, and admitting when it failed", () => {
  it("falls off the mirrored port when this machine already owns it, and says what that costs", async () => {
    // Occupying the port stands in for the real case: a local copy of the same
    // service already listening on it.
    const taken = await listener({ answer: true });
    let forwardedTo: string | null = null;
    const spawnFn = fakeSsh({ answer: true });
    const mgr = new ForwardManager({
      spawnFn: (cmd: string, argv: string[]) => {
        forwardedTo = argv[argv.indexOf("-L") + 1];
        return spawnFn(cmd, argv);
      }
    });
    const result = await mgr.ensure(TRANSPORT, { name: "web", remotePort: taken, label: "Web", path: "/" });
    expect(result.mirrored).toBe(false);
    expect(result.localPort).not.toBe(taken);
    expect(result.conflict).toContain(`localhost:${taken}`);
    expect(result.conflict).toContain("not the remote's");
    // The far side of the tunnel is still the REMOTE port, whatever the local one is.
    expect(forwardedTo).toContain(`:127.0.0.1:${taken}`);
    mgr.stopAll();
  }, 20000);

  it("carries no conflict note when the port mirrored cleanly", async () => {
    const free = await freeLocalPort();
    const mgr = new ForwardManager({ spawnFn: fakeSsh({ answer: true }) });
    const result = await mgr.ensure(TRANSPORT, { name: "x", remotePort: free, label: "X", path: "/" });
    expect(result.status).toBe("up");
    expect(result.mirrored).toBe(true);
    expect(result.localPort).toBe(free);
    expect(result.conflict ?? null).toBeNull();
    mgr.stopAll();
  }, 20000);
});

describe("snapshot does not overclaim", () => {
  it("says open, not up, for a live child it has not round-tripped", async () => {
    const port = await freeLocalPort();
    const mgr = new ForwardManager({ spawnFn: fakeSsh({ answer: true }) });
    const forward = { name: "web", remotePort: port, label: "Web", path: "/" };
    await mgr.ensure(TRANSPORT, forward);
    const [snap] = mgr.snapshot({ ...TRANSPORT, forwards: [forward] });
    // "up" is reserved for the path that actually proved it.
    expect(snap.status).toBe("open");
    mgr.stopAll();
  }, 20000);

  it("says down once the child is gone", async () => {
    const port = await freeLocalPort();
    const mgr = new ForwardManager({ spawnFn: fakeSsh({ answer: true }) });
    const forward = { name: "web", remotePort: port, label: "Web", path: "/" };
    await mgr.ensure(TRANSPORT, forward);
    mgr.stopAll();
    const [snap] = mgr.snapshot({ ...TRANSPORT, forwards: [forward] });
    expect(snap.status).toBe("down");
  }, 20000);
});
