// Keeping the remote able to host its own tunnel, from here.
//
// The failure being designed out is self-sealing: the remote's devtunnel login
// lasts under a day, `devtunnel host` cannot run without one, and the machine is
// reachable ONLY through the tunnel that host provides. So when the credential
// lapses the tunnel drops, and renewing it requires standing at the machine that
// just became unreachable. Garrison holds the account, so Garrison mints a 24h
// host token and pushes it over the channel while it is still up.
//
// What is pinned here is the handling a secret deserves - never in argv, never
// truncated, never half-written - plus the one failure that must not be reported
// generically, because it is the single point of failure the whole design leaves.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
// @ts-ignore - dependency-free fitting JavaScript
import { mintHostToken, pushHostToken, refreshHostTokens, REMOTE_TOKEN_PATH } from "../fittings/seed/remote-shell-runtime/lib/host-credential.mjs";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.body.sig";

function fakeCli(out: string, code = 0, seen: string[][] = []) {
  return (_bin: string, argv: string[]) => {
    seen.push(argv);
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit("data", Buffer.from(out));
      child.emit("close", code);
    }, 0);
    return child;
  };
}

const MINTED = JSON.stringify({ scope: "host", lifeTime: "1.00:00:00", expiration: "2026-08-25 07:55:30 UTC", token: TOKEN });

describe("minting", () => {
  it("asks for host scope only - it covers hosting AND the health read", async () => {
    // One credential rather than a pair with separate lifetimes to keep alive.
    const seen: string[][] = [];
    const mint = await mintHostToken("t1", { spawnFn: fakeCli(MINTED, 0, seen) });
    expect(mint).toMatchObject({ ok: true, token: TOKEN, expiration: "2026-08-25 07:55:30 UTC" });
    expect(seen[0]).toEqual(["token", "t1", "--scopes", "host", "--json"]);
  });

  it("names Garrison's OWN lapsed login rather than reporting a generic failure", async () => {
    // This is the single point of failure the design leaves: if this side cannot
    // mint for a full day, the remote lapses too. A generic "mint failed" would
    // send the reader to the remote, which is exactly the wrong machine.
    const mint = await mintHostToken("t1", { spawnFn: fakeCli("Login token expired.\n", 0) });
    expect(mint).toMatchObject({ ok: false, reason: "login" });
    expect(mint.error).toContain("HERE");
    expect(mint.error).toContain("devtunnel user login");
  });

  it("reports anything else as a mint failure with the CLI's own words", async () => {
    const mint = await mintHostToken("t1", { spawnFn: fakeCli("tunnel not found\n", 1) });
    expect(mint).toMatchObject({ ok: false, reason: "mint" });
    expect(mint.error).toContain("not found");
  });
});

describe("delivery", () => {
  const transport = { name: "csg", ssh: { host: "h", port: 22, user: "u", identity: null } } as any;

  it("puts the token on stdin, never in the command", async () => {
    // argv is world-readable in `ps` on both machines.
    let seenCmd = "";
    let seenInput: string | null = null;
    const exec = async (_t: any, cmd: string, opts: any) => {
      seenCmd = cmd;
      seenInput = opts.input;
      return { code: 0, stdout: `GARRISON_TOKEN_BYTES ${Buffer.byteLength(TOKEN)}\n`, stderr: "" };
    };
    const res = await pushHostToken(transport, TOKEN, { exec });
    expect(res.ok).toBe(true);
    expect(seenInput).toBe(TOKEN);
    expect(seenCmd).not.toContain(TOKEN);
  });

  it("stages and renames, under a private umask", async () => {
    // A supervisor may read this file at any moment; it must see the old token or
    // the new one, never a half-written file - and never a world-readable one.
    let seenCmd = "";
    const exec = async (_t: any, cmd: string) => {
      seenCmd = cmd;
      return { code: 0, stdout: `GARRISON_TOKEN_BYTES ${Buffer.byteLength(TOKEN)}\n`, stderr: "" };
    };
    await pushHostToken(transport, TOKEN, { exec });
    expect(seenCmd).toContain("umask 077");
    expect(seenCmd).toContain(`${REMOTE_TOKEN_PATH}.tmp`);
    expect(seenCmd).toMatch(new RegExp(`mv .*\\.tmp ${REMOTE_TOKEN_PATH.replace("$", "\\$")}`));
  });

  it("treats a short write as a failure, not a success", async () => {
    // A truncated token is worse than none: the supervisor would take it for a
    // credential and fail to authenticate with no idea why.
    const exec = async () => ({ code: 0, stdout: "GARRISON_TOKEN_BYTES 5\n", stderr: "" });
    const res = await pushHostToken(transport, TOKEN, { exec });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("truncated");
  });

  it("reports an ssh failure with the remote's own stderr", async () => {
    const exec = async () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey).\n" });
    const res = await pushHostToken(transport, TOKEN, { exec });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("publickey");
  });
});

describe("refreshing every transport", () => {
  const dtTransport = (name: string, tunnel: string) =>
    ({ name, ssh: { host: "h", port: 22, user: "u", identity: null }, via: { devtunnel: { tunnel, port: 2222 } } } as any);

  it("skips direct-ssh transports, which have no tunnel credential to keep", async () => {
    const seen: string[][] = [];
    const out = await refreshHostTokens(
      [{ name: "mac", ssh: {}, via: null } as any],
      { spawnFn: fakeCli(MINTED, 0, seen), exec: async () => ({ code: 0, stdout: "", stderr: "" }) }
    );
    expect(out).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("mints once per tunnel even when transports share it", async () => {
    const seen: string[][] = [];
    const out = await refreshHostTokens(
      [dtTransport("a", "t1"), dtTransport("b", "t1")],
      {
        spawnFn: fakeCli(MINTED, 0, seen),
        exec: async () => ({ code: 0, stdout: `GARRISON_TOKEN_BYTES ${Buffer.byteLength(TOKEN)}\n`, stderr: "" })
      }
    );
    expect(out.map((r: any) => r.ok)).toEqual([true, true]);
    expect(seen.filter((argv) => argv[0] === "token")).toHaveLength(1);
  });

  it("brings the tunnel up before pushing, because nothing else has at boot", async () => {
    // The push is plain ssh through the devtunnel forward. At startup that
    // forward does not exist yet, so a refresher that assumed it fails on every
    // boot - silently, while the remote's token ages out. Caught live.
    const order: string[] = [];
    const out = await refreshHostTokens([dtTransport("csg", "t1")], {
      ensure: async () => { order.push("ensure"); return { ok: true }; },
      spawnFn: (bin: string, argv: string[]) => { order.push(argv[0]); return fakeCli(MINTED)(bin, argv); },
      exec: async () => {
        order.push("push");
        return { code: 0, stdout: `GARRISON_TOKEN_BYTES ${Buffer.byteLength(TOKEN)}\n`, stderr: "" };
      }
    });
    expect(out[0]).toMatchObject({ ok: true, stage: "delivered" });
    expect(order).toEqual(["ensure", "token", "push"]);
  });

  it("does not waste a mint on a remote it cannot reach", async () => {
    const seen: string[][] = [];
    const out = await refreshHostTokens([dtTransport("csg", "t1")], {
      ensure: async () => ({ ok: false, error: "nothing is hosting the tunnel" }),
      spawnFn: fakeCli(MINTED, 0, seen),
      exec: async () => { throw new Error("must not push"); }
    });
    expect(out[0]).toMatchObject({ ok: false, stage: "tunnel" });
    expect(out[0].error).toContain("nothing is hosting");
    expect(seen).toEqual([]);
  });

  it("keeps going when one remote is unreachable", async () => {
    // It runs on a timer beside a live server; one dead remote must not stop the
    // others being refreshed.
    let call = 0;
    const out = await refreshHostTokens([dtTransport("a", "t1"), dtTransport("b", "t2")], {
      spawnFn: fakeCli(MINTED),
      exec: async () =>
        ++call === 1
          ? { code: 255, stdout: "", stderr: "timed out" }
          : { code: 0, stdout: `GARRISON_TOKEN_BYTES ${Buffer.byteLength(TOKEN)}\n`, stderr: "" }
    });
    expect(out.map((r: any) => [r.transport, r.ok])).toEqual([["a", false], ["b", true]]);
  });

  it("skips a transport whose devtunnel opts out (pushHostToken: false) - a VS Code Remote Tunnel manages its own auth", async () => {
    const seen: string[][] = [];
    const t = { name: "csg", ssh: { host: "h", port: 22, user: "u", identity: null }, via: { devtunnel: { tunnel: "swift-book", port: 2222, pushHostToken: false } } } as any;
    const out = await refreshHostTokens([t], { spawnFn: fakeCli(MINTED, 0, seen), exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(out).toEqual([]);
    expect(seen).toEqual([]);
  });
});
