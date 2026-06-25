import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The override store reads GARRISON_HOME at call time (via garrisonDir()), so we
// point it at a tmpdir per test. Imported normally — the env is set before each
// call resolves the path.
import { readPromotedOverrides, writePromotedSetup } from "@/lib/promoted-overrides";

const roots: string[] = [];
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.GARRISON_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-overrides-"));
  roots.push(root);
  process.env.GARRISON_HOME = root;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  while (roots.length) {
    const r = roots.pop();
    if (r) await fs.rm(r, { recursive: true, force: true });
  }
});

describe("promoted setup override store", () => {
  it("round-trips an override", async () => {
    await writePromotedSetup("playwright-cli", [{ command: "npm i -g playwright", idempotent: true }]);
    const all = await readPromotedOverrides();
    expect(all["playwright-cli"]).toEqual([{ command: "npm i -g playwright", idempotent: true }]);
  });

  it("stores an explicit empty array (clear), NOT a deleted key — so it does not fall back to baseline", async () => {
    await writePromotedSetup("playwright-cli", [{ command: "x", idempotent: true }]);
    await writePromotedSetup("playwright-cli", []);
    const all = await readPromotedOverrides();
    // The key is present with an explicit empty array.
    expect(Object.prototype.hasOwnProperty.call(all, "playwright-cli")).toBe(true);
    expect(all["playwright-cli"]).toEqual([]);
  });

  it("serializes concurrent writes to different ids without losing keys (no lost-update race)", async () => {
    await Promise.all([
      writePromotedSetup("a", [{ command: "echo a", idempotent: true }]),
      writePromotedSetup("b", [{ command: "echo b", idempotent: true }]),
      writePromotedSetup("c", [{ command: "echo c", idempotent: true }])
    ]);
    const all = await readPromotedOverrides();
    expect(Object.keys(all).sort()).toEqual(["a", "b", "c"]);
    expect(all.a[0].command).toBe("echo a");
    expect(all.b[0].command).toBe("echo b");
    expect(all.c[0].command).toBe("echo c");
  });
});
