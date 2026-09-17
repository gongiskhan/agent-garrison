// Browsing the remote machine's project: path handling, shell quoting, and the
// source layer the file browser reads.
//
// The confinement that matters most runs on the REMOTE (a realpath check after
// symlink resolution, verified live against the CSG VM: `../../../etc/passwd`,
// `/etc/passwd` and `docker/../../.ssh` are all refused). What is pinned here is
// the layer in front of it - the string handling that decides what is even put on
// the wire, and the quoting that decides whether a filename can become a command.

import { describe, it, expect } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { shQuote, rootExpr, normalizeRel, MAX_READ_BYTES } from "../fittings/seed/remote-shell-runtime/lib/remote-files.mjs";

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

