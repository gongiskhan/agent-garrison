// Diagnosing a dev tunnel that is not carrying traffic.
//
// The failure this pins is a diagnosis failure, not a transport one. `devtunnel
// connect` against a tunnel nobody hosts does not error - it waits, silently,
// forever - so the old code could only time out and offer a hedge ("the remote
// host is not running, OR you are not logged in here"). Live, that hedge sent a
// debugging session to re-login on BOTH machines when neither was the problem.
// The service already knows the answer; these tests pin that we ask it, and
// that the sentence we print names the machine the reader has to go fix.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
// @ts-ignore - dependency-free fitting JavaScript
import { describeTunnel, explainTunnel, TunnelManager } from "../fittings/seed/remote-shell-runtime/lib/transports.mjs";

const DT = { tunnel: "peaceful-ocean-zcx3mqx.eun1", port: 2222 };

/** A stand-in CLI: `show` answers with `out`, anything else stays alive. */
function fakeCli(out: string, code = 0, seen: string[][] = []) {
  return (_bin: string, argv: string[]) => {
    seen.push(argv);
    const child: any = new EventEmitter();
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.exitCode = 0; child.emit("close", 0); };
    if (argv[0] === "show") {
      setTimeout(() => {
        child.stdout.emit("data", Buffer.from(out));
        child.emit("close", code);
      }, 0);
    }
    // `connect` deliberately never settles - that is the real CLI's behaviour
    // and the reason a timeout cannot diagnose anything.
    return child;
  };
}

const HOSTED_NONE = JSON.stringify({ tunnel: { tunnelId: DT.tunnel, hostConnections: 0, ports: [{ portNumber: 2222 }] } });

describe("reading the tunnel service's answer", () => {
  it("parses the count and ports out of --json", async () => {
    const info = await describeTunnel(DT.tunnel, { spawnFn: fakeCli(HOSTED_NONE) });
    expect(info).toEqual({ ok: true, hostConnections: 0, ports: [2222] });
  });

  it("parses past the first-run banner the CLI prints before the JSON", async () => {
    // A fresh XDG data home (every Garrison instance redirects one) makes the
    // CLI greet you before it answers. Parsing from byte zero would throw here.
    const banner = "Welcome to dev tunnels!\nCLI version: 1.0.2030\n\n";
    const info = await describeTunnel(DT.tunnel, {
      spawnFn: fakeCli(banner + JSON.stringify({ tunnel: { hostConnections: 2, ports: [{ portNumber: 2222 }] } }))
    });
    expect(info).toMatchObject({ ok: true, hostConnections: 2 });
  });

  it("separates 'not logged in here' from every other failure", async () => {
    const login = await describeTunnel(DT.tunnel, { spawnFn: fakeCli("Welcome!\n\nGitHub login required.\n", 3) });
    expect(login).toMatchObject({ ok: false, reason: "login", expired: false });
    const gone = await describeTunnel(DT.tunnel, { spawnFn: fakeCli("Tunnel not found\n", 1) });
    expect(gone).toEqual({ ok: false, reason: "missing" });
    const other = await describeTunnel(DT.tunnel, { spawnFn: fakeCli("connection reset by peer\n", 1) });
    expect(other).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("reads an EXPIRED login as a login problem, not as an unknown one", async () => {
    // The CLI words this differently per subcommand - `list` says "Login
    // required.", `show` says "Login token expired." - and a GitHub login here
    // lasts under a day, so expired is the common case. Matching only "required"
    // dropped it into the unknown branch, whose message sends the reader off to
    // debug a client that was never the problem.
    const info = await describeTunnel(DT.tunnel, { spawnFn: fakeCli("Login token expired.\n", 0) });
    expect(info).toMatchObject({ ok: false, reason: "login", expired: true });
  });
});

describe("the sentence the user actually reads", () => {
  it("sends them to the REMOTE when nobody is hosting, and rules out re-logging in", async () => {
    const msg = explainTunnel({ ok: true, hostConnections: 0, ports: [2222] }, DT);
    expect(msg).toContain("nothing is hosting");
    expect(msg).toContain(`devtunnel host ${DT.tunnel}`);
    expect(msg).toContain("ON THE REMOTE");
    // The dead end that cost a live session: it must say so outright.
    expect(msg).toContain("Logging in again here changes nothing");
  });

  it("names the missing port when the tunnel is hosted but does not carry it", () => {
    const msg = explainTunnel({ ok: true, hostConnections: 1, ports: [3006] }, DT)!;
    expect(msg).toContain("forwards no port 2222");
    expect(msg).toContain("devtunnel port create");
  });

  it("sends them HERE when this box is the one not logged in", () => {
    const msg = explainTunnel({ ok: false, reason: "login", expired: false }, DT)!;
    expect(msg).toContain("devtunnel user login");
    expect(msg).toContain("HERE, not on the remote");
    // The XDG redirect is why a logged-in box can still read as logged out.
    expect(msg).toContain("XDG_DATA_HOME");
  });

  it("says EXPIRED when that is what happened, so it does not read as never-logged-in", () => {
    // "You are not logged in" to someone who logged in yesterday reads as a bug
    // in the tool rather than as a credential that lapsed.
    const msg = explainTunnel({ ok: false, reason: "login", expired: true }, DT)!;
    expect(msg).toContain("EXPIRED");
    expect(msg).toContain("devtunnel user login");
  });

  it("stays silent when the description gives no reason not to try", () => {
    expect(explainTunnel({ ok: true, hostConnections: 1, ports: [2222] }, DT)).toBeNull();
    expect(explainTunnel({ ok: false, reason: "unknown" }, DT)).toBeNull();
  });
});

describe("ensure() acts on the answer", () => {
  it("fails fast instead of waiting on a client that can never connect", async () => {
    const seen: string[][] = [];
    const mgr = new TunnelManager({ spawnFn: fakeCli(HOSTED_NONE, 0, seen) });
    const closed = await freePort();
    const started = Date.now();
    const result = await mgr.ensure({
      name: "csg",
      ssh: { host: "127.0.0.1", port: closed, user: "u", identity: null },
      via: { devtunnel: DT }
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nothing is hosting");
    // No `connect` child: spawning one would have cost the caller ten seconds
    // of waiting for an answer we already had.
    expect(seen.map((argv) => argv[0])).toEqual(["show"]);
    expect(Date.now() - started).toBeLessThan(5000);
    mgr.shutdown();
  }, 15000);

  it("retires a client that stayed alive without ever carrying the forward", async () => {
    // Third instance of liveness-is-not-health in this fitting, now on the client
    // side: `devtunnel connect` does not exit when the credential under it
    // lapses, and #startClient skips a live child - so one was found ten hours
    // old, holding nothing, with every retry inheriting it.
    const hosted = JSON.stringify({ tunnel: { hostConnections: 1, ports: [{ portNumber: 2222 }] } });
    // A tunnel id nothing REAL can hold: the cross-profile lock lives in the
    // shared tmpdir keyed by tunnel id, so using the production id here makes
    // the test lose the claim to the live fitting on the same box - correctly.
    const TEST_DT = { tunnel: `test-retire-${process.pid}`, port: DT.port };
    const kids: any[] = [];
    const cli = fakeCli(hosted);
    const mgr = new TunnelManager({
      spawnFn: (bin: string, argv: string[]) => {
        const child = cli(bin, argv);
        if (argv[0] === "connect") kids.push(child);
        return child;
      }
    });
    const result = await mgr.ensure({
      name: "csg",
      ssh: { host: "127.0.0.1", port: await freePort(), user: "u", identity: null },
      via: { devtunnel: TEST_DT }
    } as any);
    expect(result.ok).toBe(false);
    // It got as far as spawning a client - the service gave no reason not to.
    expect(kids).toHaveLength(1);
    expect(kids[0].exitCode).not.toBeNull();
    expect(result.error).toContain("retired");
    mgr.shutdown();
  }, 30000);
});

/** A loopback port nothing holds, so the probe refuses immediately. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
