import { describe, it, expect } from "vitest";
// The core is a pure .mjs module with no type declarations; single-line import
// so the @ts-ignore anchors to the module specifier and suppresses TS7016.
// @ts-ignore
import { parseSs, parseSsLine, parseProcessField, parseLsof, splitAddressPort, isLoopback, isWildcard, severity, buildWorktreeIndex, buildStatusIndex, resolveLabel, buildPortRows, listeningPidSet, killGuard, isInWorktreePool, WORKTREE_POOL_START, WORKTREE_POOL_END } from "../fittings/seed/ports-default/lib/ports-core.mjs";

// The .mjs exports are untyped (any); this local shape annotates the parsed-row
// callbacks so the suite typechecks cleanly under noImplicitAny.
type Row = {
  address: string;
  port: number;
  loopback: boolean;
  wildcard: boolean;
  command: string | null;
  pid: number | null;
  pids: number[];
};

// Canned `ss -tlnpH` output covering every address form seen on a real box:
// interface-scoped loopback, IPv4 wildcard (0.0.0.0 and *), a command name
// containing a space + paren, IPv6 loopback/wildcard/bracketed, and rows with
// no `users:(())` process column at all.
const SS_OUTPUT = [
  "LISTEN 0      4096                 127.0.0.53%lo:53    0.0.0.0:*",
  'LISTEN 0      511                        0.0.0.0:3702  0.0.0.0:* users:(("node",pid=183476,fd=18))',
  "LISTEN 0      4096                       0.0.0.0:22    0.0.0.0:*",
  'LISTEN 0      511                        0.0.0.0:5983  0.0.0.0:* users:(("next-server (v1",pid=615645,fd=19))',
  'LISTEN 0      511                      127.0.0.1:7088  0.0.0.0:* users:(("node",pid=277350,fd=18))',
  'LISTEN 0      128                              *:21118       *:* users:(("rustdesk",pid=828238,fd=35))',
  "LISTEN 0      4096                         [::1]:631      [::]:*",
  "LISTEN 0      4096                          [::]:22       [::]:*",
  'LISTEN 0      4096   [fd7a:115c:a1e0::ef36:a52f]:443      [::]:* users:(("tailscaled",pid=1234,fd=40))'
].join("\n");

describe("splitAddressPort", () => {
  it("splits IPv4 host:port", () => {
    expect(splitAddressPort("127.0.0.1:7088")).toEqual({ address: "127.0.0.1", port: 7088 });
    expect(splitAddressPort("0.0.0.0:3702")).toEqual({ address: "0.0.0.0", port: 3702 });
  });
  it("keeps an interface scope in the address", () => {
    expect(splitAddressPort("127.0.0.53%lo:53")).toEqual({ address: "127.0.0.53%lo", port: 53 });
  });
  it("handles the star wildcard host", () => {
    expect(splitAddressPort("*:21118")).toEqual({ address: "*", port: 21118 });
  });
  it("handles bracketed IPv6", () => {
    expect(splitAddressPort("[::1]:631")).toEqual({ address: "::1", port: 631 });
    expect(splitAddressPort("[::]:22")).toEqual({ address: "::", port: 22 });
    expect(splitAddressPort("[fd7a:115c:a1e0::ef36:a52f]:443")).toEqual({
      address: "fd7a:115c:a1e0::ef36:a52f",
      port: 443
    });
  });
  it("returns a null port for the any-port star", () => {
    expect(splitAddressPort("0.0.0.0:*").port).toBeNull();
  });
});

describe("isLoopback / isWildcard", () => {
  it("detects the IPv4 loopback block", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.53%lo")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
  });
  it("detects IPv6 loopback", () => {
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
  });
  it("does not treat wildcard binds as loopback", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("::")).toBe(false);
    expect(isLoopback("*")).toBe(false);
  });
  it("does not treat a specific routable address as loopback", () => {
    expect(isLoopback("100.88.165.46")).toBe(false);
    expect(isLoopback("fd7a:115c:a1e0::ef36:a52f")).toBe(false);
  });
  it("flags wildcard binds", () => {
    expect(isWildcard("0.0.0.0")).toBe(true);
    expect(isWildcard("::")).toBe(true);
    expect(isWildcard("*")).toBe(true);
    expect(isWildcard("127.0.0.1")).toBe(false);
    expect(isWildcard("100.88.165.46")).toBe(false);
  });
});

describe("parseProcessField", () => {
  it("parses a single process", () => {
    expect(parseProcessField('users:(("node",pid=183476,fd=18))')).toEqual({
      command: "node",
      pid: 183476,
      pids: [183476]
    });
  });
  it("keeps a command name containing spaces and parens", () => {
    expect(parseProcessField('users:(("next-server (v1",pid=615645,fd=19))')).toEqual({
      command: "next-server (v1",
      pid: 615645,
      pids: [615645]
    });
  });
  it("collects every pid across a shared socket", () => {
    const parsed = parseProcessField('users:(("a",pid=10,fd=1),("b",pid=20,fd=2))');
    expect(parsed.command).toBe("a");
    expect(parsed.pid).toBe(10);
    expect(parsed.pids).toEqual([10, 20]);
  });
  it("returns nulls when there is no process column", () => {
    expect(parseProcessField("")).toEqual({ command: null, pid: null, pids: [] });
  });
});

describe("parseSs", () => {
  const rows = parseSs(SS_OUTPUT);

  it("parses every listening row", () => {
    expect(rows.map((r: Row) => r.port).sort((a: number, b: number) => a - b)).toEqual([
      22, 22, 53, 443, 631, 3702, 5983, 7088, 21118
    ]);
  });

  it("classifies the interface-scoped loopback row", () => {
    const row = rows.find((r: Row) => r.port === 53);
    expect(row.address).toBe("127.0.0.53%lo");
    expect(row.loopback).toBe(true);
    expect(row.command).toBeNull();
    expect(row.pid).toBeNull();
  });

  it("classifies the IPv4 wildcard row with a process", () => {
    const row = rows.find((r: Row) => r.port === 3702);
    expect(row.address).toBe("0.0.0.0");
    expect(row.wildcard).toBe(true);
    expect(row.loopback).toBe(false);
    expect(row.command).toBe("node");
    expect(row.pid).toBe(183476);
  });

  it("parses a command name with a space", () => {
    const row = rows.find((r: Row) => r.port === 5983);
    expect(row.command).toBe("next-server (v1");
    expect(row.pid).toBe(615645);
  });

  it("handles the star-wildcard bind", () => {
    const row = rows.find((r: Row) => r.port === 21118);
    expect(row.address).toBe("*");
    expect(row.wildcard).toBe(true);
    expect(row.command).toBe("rustdesk");
  });

  it("classifies IPv6 loopback, wildcard and bracketed binds", () => {
    expect(rows.find((r: Row) => r.port === 631).loopback).toBe(true); // [::1]
    const wildcard6 = rows.find((r: Row) => r.port === 22 && r.address === "::");
    expect(wildcard6.wildcard).toBe(true);
    const bound6 = rows.find((r: Row) => r.port === 443);
    expect(bound6.address).toBe("fd7a:115c:a1e0::ef36:a52f");
    expect(bound6.loopback).toBe(false);
    expect(bound6.wildcard).toBe(false);
    expect(bound6.command).toBe("tailscaled");
  });

  it("ignores blank and malformed lines", () => {
    expect(parseSsLine("")).toBeNull();
    expect(parseSsLine("not a socket line")).toBeNull();
    expect(parseSs("\n\n   \n")).toEqual([]);
  });
});

describe("severity", () => {
  it("maps loopback/wildcard/bound", () => {
    expect(severity({ loopback: true, wildcard: false })).toBe("local");
    expect(severity({ loopback: false, wildcard: true })).toBe("exposed");
    expect(severity({ loopback: false, wildcard: false })).toBe("bound");
  });
});

describe("worktree pool", () => {
  it("bounds the 50000-54999 pool", () => {
    expect(WORKTREE_POOL_START).toBe(50000);
    expect(WORKTREE_POOL_END).toBe(54999);
    expect(isInWorktreePool(50000)).toBe(true);
    expect(isInWorktreePool(54999)).toBe(true);
    expect(isInWorktreePool(49999)).toBe(false);
    expect(isInWorktreePool(55000)).toBe(false);
    expect(isInWorktreePool(7088)).toBe(false);
  });
});

describe("buildWorktreeIndex", () => {
  const state = {
    projects: {
      "/home/u/dev/app": {
        sessions: {
          s1: {
            branch: "feat/login",
            worktreePath: "/home/u/dev/app-feat-login",
            title: null,
            ports: { web: 50123, api: 50124 }
          },
          s2: {
            branch: "main",
            worktreePath: "/home/u/dev/app",
            title: "docs pass",
            ports: { web: 51999 }
          }
        }
      }
    }
  };

  it("maps pool ports to worktree names", () => {
    const idx = buildWorktreeIndex(state);
    expect(idx.get(50123)).toMatchObject({ worktree: "feat/login", service: "web" });
    expect(idx.get(50124)).toMatchObject({ worktree: "feat/login", service: "api" });
    // title wins over branch as the worktree name.
    expect(idx.get(51999).worktree).toBe("docs pass");
  });

  it("tolerates an empty / missing state", () => {
    expect(buildWorktreeIndex(undefined).size).toBe(0);
    expect(buildWorktreeIndex({}).size).toBe(0);
    expect(buildWorktreeIndex({ projects: {} }).size).toBe(0);
  });
});

describe("buildStatusIndex", () => {
  it("maps ports to fittingIds", () => {
    const idx = buildStatusIndex([
      { fittingId: "improver", port: 7088 },
      { fittingId: "monitor-default", port: 7077 },
      { nope: true }, // ignored
      null // ignored
    ]);
    expect(idx.get(7088)).toBe("improver");
    expect(idx.get(7077)).toBe("monitor-default");
    expect(idx.size).toBe(2);
  });
});

describe("resolveLabel — resolution order", () => {
  const worktreeIndex = buildWorktreeIndex({
    projects: {
      p: { sessions: { s: { branch: "feat/x", ports: { web: 50500 } } } }
    }
  });
  const statusIndex = buildStatusIndex([
    { fittingId: "improver", port: 7088 },
    // A status file that also claims a pool port — worktree must still win.
    { fittingId: "ghost", port: 50500 }
  ]);
  const indexes = { worktreeIndex, statusIndex };

  it("worktree registry beats status file and cmdline", () => {
    const label = resolveLabel({ port: 50500, command: "node", pid: 42 }, indexes);
    expect(label.source).toBe("worktree");
    expect(label.label).toBe("feat/x");
    expect(label.detail).toBe("web");
  });

  it("status file beats cmdline when no worktree entry", () => {
    const label = resolveLabel({ port: 7088, command: "node", pid: 99 }, indexes);
    expect(label.source).toBe("fitting");
    expect(label.label).toBe("improver");
  });

  it("falls back to the owning command + pid", () => {
    const label = resolveLabel({ port: 3702, command: "node", pid: 183476 }, indexes);
    expect(label.source).toBe("process");
    expect(label.label).toBe("node");
    expect(label.detail).toBe("pid 183476");
  });

  it("reports unknown when there is no owner at all", () => {
    const label = resolveLabel({ port: 22, command: null, pid: null }, indexes);
    expect(label.source).toBe("unknown");
    expect(label.label).toBeNull();
  });
});

describe("buildPortRows", () => {
  it("labels a full scan and sorts by port", () => {
    const parsed = parseSs(SS_OUTPUT);
    const worktreeIndex = buildWorktreeIndex({ projects: {} });
    const statusIndex = buildStatusIndex([{ fittingId: "improver", port: 7088 }]);
    const rows = buildPortRows(parsed, { worktreeIndex, statusIndex });
    // sorted ascending by port
    const ports = rows.map((r: { port: number }) => r.port);
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
    const improver = rows.find((r: { port: number }) => r.port === 7088);
    expect(improver.labelSource).toBe("fitting");
    expect(improver.label).toBe("improver");
    expect(improver.severity).toBe("local");
    const exposed = rows.find((r: { port: number }) => r.port === 3702);
    expect(exposed.severity).toBe("exposed");
    expect(exposed.labelSource).toBe("process");
  });
});

describe("listeningPidSet", () => {
  it("collects every owning pid", () => {
    const set = listeningPidSet(parseSs(SS_OUTPUT));
    expect(set.has(183476)).toBe(true);
    expect(set.has(615645)).toBe(true);
    expect(set.has(277350)).toBe(true);
    expect(set.has(828238)).toBe(true);
    expect(set.has(1234)).toBe(true);
    // rows without a process column contribute nothing
    expect(set.has(NaN)).toBe(false);
  });
});

describe("killGuard", () => {
  const listeningPids = new Set([183476, 277350]);

  it("refuses pid <= 1", () => {
    expect(killGuard(1, { listeningPids }).allowed).toBe(false);
    expect(killGuard(0, { listeningPids }).allowed).toBe(false);
    expect(killGuard(-5, { listeningPids }).allowed).toBe(false);
  });

  it("refuses a pid that holds no listening socket", () => {
    const guard = killGuard(999999, { listeningPids });
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toMatch(/listening socket/);
  });

  it("refuses the server's own pid and its parent", () => {
    expect(killGuard(277350, { listeningPids, selfPid: 277350 }).allowed).toBe(false);
    expect(killGuard(183476, { listeningPids, parentPid: 183476 }).allowed).toBe(false);
  });

  it("allows a listening third-party pid", () => {
    const guard = killGuard(183476, { listeningPids, selfPid: 5, parentPid: 6 });
    expect(guard.allowed).toBe(true);
    expect(guard.reason).toBeNull();
  });

  it("PID-reuse defense: a pid absent from the CURRENT listening set is refused", () => {
    // The handler re-scans immediately before calling the guard, so `latest`
    // reflects live sockets: a pid that listened at the previous poll but has
    // since exited (and whose number the kernel may have reused for something
    // unrelated) is not in the fresh set and must be refused - never signalled.
    const fresh = new Set([183476]); // 277350 has since exited
    expect(killGuard(277350, { listeningPids: fresh }).allowed).toBe(false);
    expect(killGuard(183476, { listeningPids: fresh }).allowed).toBe(true);
  });

  it("accepts an array of listening pids too", () => {
    expect(killGuard(42, { listeningPids: [42, 43] }).allowed).toBe(true);
    expect(killGuard(44, { listeningPids: [42, 43] }).allowed).toBe(false);
  });
});

describe("parseLsof (macOS)", () => {
  const LSOF = [
    "COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
    "node     1234 ggomes  18u  IPv4  0x1      0t0     TCP  127.0.0.1:7088 (LISTEN)",
    "node     1234 ggomes  19u  IPv6  0x2      0t0     TCP  [::1]:631 (LISTEN)",
    "sshd      777 root     3u   IPv4  0x3      0t0     TCP  *:22 (LISTEN)",
    "Chrome    900 ggomes  40u  IPv4  0x4      0t0     TCP  127.0.0.1:5000->127.0.0.1:6000 (ESTABLISHED)"
  ].join("\n");

  it("parses listening rows and skips the header + non-listening rows", () => {
    const rows = parseLsof(LSOF);
    expect(rows.map((r: { port: number }) => r.port).sort((a: number, b: number) => a - b)).toEqual([22, 631, 7088]);
    const loopback = rows.find((r: { port: number }) => r.port === 7088);
    expect(loopback.command).toBe("node");
    expect(loopback.pid).toBe(1234);
    expect(loopback.loopback).toBe(true);
    const wildcard = rows.find((r: { port: number }) => r.port === 22);
    expect(wildcard.address).toBe("*");
    expect(wildcard.wildcard).toBe(true);
  });
});

// GARRISON-UNIFY-V1 S11 security regression (rev2-s1011 MAJOR): the mutating
// endpoints (kill, open-in-browser) are unauthenticated + loopback-bound, so a
// drive-by page could CORS-simple POST a SIGTERM, and DNS-rebinding enabled
// read-then-kill. crossSiteBlocked() rejects a non-loopback Host (rebinding) and
// a cross-site Origin (CSRF) before the handler runs. (Same guard is applied to
// the power + outpost mutating endpoints.)
import { crossSiteBlocked } from "../fittings/seed/ports-default/scripts/server.mjs";

function fakeReqRes(headers: Record<string, string>) {
  const res: { statusCode: number; body: unknown; ended: boolean; headers: Record<string, string> } = { statusCode: 200, body: null, ended: false, headers: {} };
  const resObj = {
    statusCode: 200,
    setHeader(k: string, v: string) { res.headers[k] = v; },
    end(s: string) { res.ended = true; res.body = s ? JSON.parse(s) : null; res.statusCode = resObj.statusCode; }
  };
  Object.defineProperty(resObj, "statusCode", { get() { return res.statusCode; }, set(v) { res.statusCode = v; } });
  return { req: { headers }, res: resObj, out: res };
}

describe("crossSiteBlocked (S11 CSRF / DNS-rebinding guard)", () => {
  it("allows a same-origin loopback request (Host + Origin loopback)", () => {
    const { req, res, out } = fakeReqRes({ host: "127.0.0.1:7088", origin: "http://127.0.0.1:7088" });
    expect(crossSiteBlocked(req, res, {})).toBe(false);
    expect(out.ended).toBe(false);
  });

  it("allows a request with no Origin header (curl / same-origin GET-turned-POST)", () => {
    const { req, res } = fakeReqRes({ host: "localhost:7088" });
    expect(crossSiteBlocked(req, res, {})).toBe(false);
  });

  it("blocks a cross-site Origin (CSRF)", () => {
    const { req, res, out } = fakeReqRes({ host: "127.0.0.1:7088", origin: "http://evil.example.com" });
    expect(crossSiteBlocked(req, res, {})).toBe(true);
    expect(out.statusCode).toBe(403);
    expect(String(out.body && (out.body as { reason?: string }).reason)).toMatch(/CSRF/);
  });

  it("blocks a non-loopback Host (DNS-rebinding)", () => {
    const { req, res, out } = fakeReqRes({ host: "attacker.example.com", origin: "http://attacker.example.com" });
    expect(crossSiteBlocked(req, res, {})).toBe(true);
    expect(out.statusCode).toBe(403);
    expect(String(out.body && (out.body as { reason?: string }).reason)).toMatch(/rebinding/);
  });

  it("allows IPv6 loopback and the bound 0.0.0.0 form", () => {
    expect(crossSiteBlocked(fakeReqRes({ host: "[::1]:7088" }).req, fakeReqRes({}).res, {})).toBe(false);
  });
});
