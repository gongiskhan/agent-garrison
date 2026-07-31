// src/lib/dev-root.ts is a port of the gateway's SAFE project resolver
// (fittings/seed/http-gateway/scripts/lib/project-source.mjs). Two copies of a
// security-relevant predicate is a drift hazard, so this test does not check
// the TypeScript one against a hand-written expectation - it runs BOTH over the
// same trees and asserts they answer identically. The repo already pins the
// instance launcher against its TS twin the same way
// (tests/instance-isolation.test.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectNames, resolveProjectName } from "@/lib/dev-root";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - untyped fitting-local module, imported here only to pin the two implementations together
import * as gateway from "../fittings/seed/http-gateway/scripts/lib/project-source.mjs";

let root: string;
let devRoot: string;

function makeRepo(name: string): string {
  const dir = path.join(devRoot, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gar-devroot-"));
  devRoot = path.join(root, "dev");
  fs.mkdirSync(devRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("dev-root resolver", () => {
  it("accepts a git repo directly under the dev root and returns its realpath", () => {
    const repo = makeRepo("garrison");
    expect(resolveProjectName("garrison", { devRoot })).toBe(fs.realpathSync(repo));
  });

  it("rejects a directory with no .git, and a name that does not exist", () => {
    fs.mkdirSync(path.join(devRoot, "notes"), { recursive: true });
    expect(resolveProjectName("notes", { devRoot })).toBeNull();
    expect(resolveProjectName("missing", { devRoot })).toBeNull();
  });

  it("rejects traversal, separators, absolute paths, dotfiles and blanks", () => {
    makeRepo("garrison");
    for (const hostile of [
      "../etc",
      "..",
      ".",
      "a/b",
      "a\\b",
      "/etc",
      ".git",
      ".hidden",
      "",
      "   "
    ]) {
      expect(resolveProjectName(hostile, { devRoot }), hostile).toBeNull();
    }
  });

  it("rejects a symlinked child that escapes the dev root", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.symlinkSync(outside, path.join(devRoot, "escape"));
    expect(resolveProjectName("escape", { devRoot })).toBeNull();
    expect(listProjectNames(devRoot)).not.toContain("escape");
  });

  it("lists exactly the names it would accept", () => {
    makeRepo("alpha");
    makeRepo("beta");
    fs.mkdirSync(path.join(devRoot, "not-a-repo"), { recursive: true });
    const names = listProjectNames(devRoot);
    expect(names).toEqual(["alpha", "beta"]);
    for (const name of names) {
      expect(resolveProjectName(name, { devRoot })).not.toBeNull();
    }
  });

  it("agrees with the gateway's resolver on every case, hostile ones included", () => {
    makeRepo("alpha");
    makeRepo("beta");
    fs.mkdirSync(path.join(devRoot, "plain-dir"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    fs.symlinkSync(outside, path.join(devRoot, "escape"));

    const labels = [
      "alpha",
      "beta",
      "plain-dir",
      "escape",
      "missing",
      "../outside",
      "..",
      ".",
      ".git",
      "a/b",
      "/etc",
      "",
      "  alpha  "
    ];
    for (const label of labels) {
      expect(
        resolveProjectName(label, { devRoot }),
        `resolveProjectName(${JSON.stringify(label)})`
      ).toBe(gateway.resolveProjectName(label, { devRoot }));
    }
    expect(listProjectNames(devRoot)).toEqual(gateway.listProjectNames(devRoot));
  });
});
