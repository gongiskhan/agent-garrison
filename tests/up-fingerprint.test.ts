// The up() fast-path change detector: stable on no-change, sensitive to
// manifest, overlay, and fitting-source changes.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compositionFingerprint, readLastUp, writeLastUp } from "../src/lib/up-fingerprint";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "upfp-"));
  mkdirSync(path.join(tmp, "comp"), { recursive: true });
  mkdirSync(path.join(tmp, "fittings", "seed", "thing"), { recursive: true });
  writeFileSync(path.join(tmp, "fittings", "seed", "thing", "server.mjs"), "code");
  writeFileSync(
    path.join(tmp, "comp", "apm.yml"),
    "name: c\ndependencies:\n  apm:\n    - path: ../fittings/seed/thing\n"
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("compositionFingerprint", () => {
  it("is stable across calls when nothing changed", async () => {
    const a = await compositionFingerprint(path.join(tmp, "comp"));
    const b = await compositionFingerprint(path.join(tmp, "comp"));
    expect(a).toBe(b);
  });
  it("changes when the manifest changes", async () => {
    const a = await compositionFingerprint(path.join(tmp, "comp"));
    writeFileSync(path.join(tmp, "comp", "apm.yml"), "name: c2\ndependencies:\n  apm:\n    - path: ../fittings/seed/thing\n");
    expect(await compositionFingerprint(path.join(tmp, "comp"))).not.toBe(a);
  });
  it("changes when a fitting source file changes", async () => {
    const a = await compositionFingerprint(path.join(tmp, "comp"));
    const f = path.join(tmp, "fittings", "seed", "thing", "server.mjs");
    writeFileSync(f, "code changed");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(await compositionFingerprint(path.join(tmp, "comp"))).not.toBe(a);
  });
  it("last-up record round-trips", async () => {
    const dir = path.join(tmp, "comp");
    expect(await readLastUp(dir)).toBeNull();
    await writeLastUp(dir, { fingerprint: "abc", at: "now", ok: true, verifyResults: [] });
    expect((await readLastUp(dir))?.fingerprint).toBe("abc");
  });
});
