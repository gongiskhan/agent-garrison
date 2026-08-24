// Browsing the remote machine's project: path handling, shell quoting, and the
// source layer the file browser reads.
//
// The confinement that matters most runs on the REMOTE (a realpath check after
// symlink resolution, verified live against the CSG VM: `../../../etc/passwd`,
// `/etc/passwd` and `docker/../../.ssh` are all refused). What is pinned here is
// the layer in front of it - the string handling that decides what is even put on
// the wire, and the quoting that decides whether a filename can become a command.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect, beforeEach } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { shQuote, rootExpr, normalizeRel, MAX_READ_BYTES } from "../fittings/seed/remote-shell-runtime/lib/remote-files.mjs";
// @ts-ignore
import { parseSourceId, listSources, resetSourceCache } from "../fittings/seed/file-browser/scripts/sources.mjs";

describe("shell quoting", () => {
  it("survives the characters a filename can legally contain", () => {
    // A name is attacker-adjacent input: it comes off someone else's disk.
    expect(shQuote("simple")).toBe("'simple'");
    expect(shQuote("with space")).toBe("'with space'");
    // POSIX close-reopen: end the quote, emit an escaped quote, start a new one.
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
    expect(shQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shQuote("`id`")).toBe("'`id`'");
  });
});

describe("remote root expression", () => {
  it("lets the REMOTE expand ~, because only it knows its own HOME", () => {
    // Expanding locally would build a path for the wrong machine's user.
    expect(rootExpr({ cwd: "~/dev/proj" })).toBe(`"$HOME"/'dev/proj'`);
    expect(rootExpr({ cwd: "/srv/app" })).toBe("'/srv/app'");
    expect(rootExpr({})).toBe("'~'");
  });
});

describe("relative path handling", () => {
  it("accepts ordinary paths and normalises the noise", () => {
    expect(normalizeRel("src/index.ts")).toBe("src/index.ts");
    expect(normalizeRel("./src/")).toBe("src");
    expect(normalizeRel("a//b")).toBe("a/b");
    expect(normalizeRel("")).toBe("");
    expect(normalizeRel(".")).toBe("");
    expect(normalizeRel(undefined)).toBe("");
  });

  it("refuses anything that leaves the project, and says which rule it broke", () => {
    expect(() => normalizeRel("/etc/passwd")).toThrow(/must be relative/);
    expect(() => normalizeRel("../secrets")).toThrow(/escapes/);
    expect(() => normalizeRel("a/../../b")).toThrow(/escapes/);
    expect(() => normalizeRel("..")).toThrow(/escapes/);
  });

  it("keeps a path that merely CONTAINS .. inside the tree", () => {
    // "a/../b" resolves to "b", which is still inside - refusing it would be
    // superstition rather than confinement.
    expect(normalizeRel("a/../b")).toBe("b");
    expect(normalizeRel("docs/..rc")).toBe("docs/..rc");
  });

  it("bounds a single read so one file cannot exhaust the channel", () => {
    expect(MAX_READ_BYTES).toBeGreaterThan(0);
    expect(MAX_READ_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("file-browser sources", () => {
  // GARRISON_HOME pinning, the same discipline the rest of the suite uses. The
  // source list now enumerates dev-root projects, so an unpinned env would read
  // whatever repositories happen to sit in the developer's ~/dev and the
  // assertions below would be about this machine rather than about the code.
  let home: string;
  let emptyDevRoot: string;
  let env: Record<string, string>;

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), "garrison-src-home-"));
    emptyDevRoot = mkdtempSync(path.join(tmpdir(), "garrison-src-devroot-"));
    writeFileSync(path.join(home, "dev-root"), emptyDevRoot);
    env = { GARRISON_HOME: home };
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyDevRoot, { recursive: true, force: true });
  });

  beforeEach(() => resetSourceCache());

  it("splits a source id into local, project and remote", () => {
    expect(parseSourceId("local")).toEqual({ kind: "local" });
    expect(parseSourceId(undefined)).toEqual({ kind: "local" });
    expect(parseSourceId("remote:csg")).toEqual({ kind: "remote", transport: "csg" });
    expect(parseSourceId("project:garrison")).toEqual({ kind: "project", project: "garrison" });
    expect(parseSourceId("nonsense")).toEqual({ kind: "unknown", raw: "nonsense" });
  });

  it("always offers the local source, even with no shell to ask", async () => {
    const sources = await listSources(env, "/root/files");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: "local", writable: true, root: "/root/files" });
  });

  it("adds one read-only source per transport, discovered not guessed", async () => {
    // The peer's port belongs to the composition and shifts per instance, so the
    // address is asked for. A literal here would talk to another instance's machine.
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith("/api/fittings/views")) {
        return new Response(JSON.stringify({ views: [{ fittingId: "remote-shell-runtime", url: "http://127.0.0.1:9999" }] }));
      }
      return new Response(JSON.stringify({ transports: [{ name: "csg", label: "CSG work", cwd: "~/dev/proj" }] }));
    }) as typeof fetch;
    try {
      const sources = await listSources({ ...env, GARRISON_BASE_URL: "http://127.0.0.1:8777" }, "/root/files");
      expect(sources.map((s: any) => s.id)).toEqual(["local", "remote:csg"]);
      expect(sources[1]).toMatchObject({ kind: "remote", transport: "csg", root: "~/dev/proj", writable: false });
      expect(seen[0]).toContain("/api/fittings/views");
      expect(seen[1]).toBe("http://127.0.0.1:9999/transports");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("degrades to local-only when the shell is unreachable, rather than failing to load", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as typeof fetch;
    try {
      const sources = await listSources({ ...env, GARRISON_BASE_URL: "http://127.0.0.1:8777" }, "/root/files");
      expect(sources.map((s: any) => s.id)).toEqual(["local"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never marks a remote source writable", async () => {
    // An agent is running in that tree; editing under it would race with work you
    // cannot see, and there is no merge story.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/api/fittings/views")
        ? new Response(JSON.stringify({ views: [{ fittingId: "remote-shell-runtime", url: "http://x" }] }))
        : new Response(JSON.stringify({ transports: [{ name: "a" }, { name: "b" }] }))) as typeof fetch;
    try {
      const sources = await listSources({ ...env, GARRISON_BASE_URL: "http://s" }, "/r");
      for (const s of sources.filter((x: any) => x.kind === "remote")) expect(s.writable).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
