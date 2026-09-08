import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilityKinds } from "@/lib/types";
import { PROFILE_PORT_OFFSET } from "@/lib/instance-profile";
// @ts-ignore
import { servePort } from "../fittings/seed/preflight/lib/preflight-core.mjs";
// @ts-ignore
import { readCapabilityKinds } from "../fittings/seed/preflight/lib/collect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Preflight is a plain .mjs fitting that must run on a cold machine, so it
// cannot import these .ts sources. It reads what it can as text and copies the
// rest. Copies drift, and a doctor whose whole value is being RIGHT about these
// invariants must not be the last to know -- so the copies are pinned here.
describe("preflight agrees with the sources it audits", () => {
  it("reads the same capability vocabulary the app defines", () => {
    const parsed = readCapabilityKinds(ROOT) as Set<string>;
    expect(parsed).toBeInstanceOf(Set);
    expect([...parsed].sort()).toEqual([...capabilityKinds].sort());
  });

  it("derives serve ports with the formula both publishers commit to", () => {
    for (const rel of ["src/lib/tailnet-publish.ts", "scripts/tailnet-serve-views.mjs"]) {
      expect(read(rel)).toContain("8400 + (localPort % 1000)");
    }
    expect(servePort(8098)).toBe(8498);
    expect(servePort(7098)).toBe(8498);
  });

  // The publishers bump past these; preflight must know the same set, or it
  // reports a reserved landing as fine.
  it("reserves every serve port the publishers refuse", () => {
    const core = read("fittings/seed/preflight/lib/preflight-core.mjs");
    const reserved = core.match(/RESERVED_SERVE = new Set\(\[([^\]]*)\]\)/);
    expect(reserved).not.toBeNull();
    const got = new Set(reserved![1].split(",").map((s) => Number(s.trim())));
    for (const port of [443, 8443, 8444, 8445]) expect(got.has(port)).toBe(true);
  });

  it("uses the app's own profile offsets", () => {
    expect(PROFILE_PORT_OFFSET).toEqual({ node: 0, dev: 10000, codex: 20000 });
    expect(read("fittings/seed/preflight/lib/collect.mjs")).toContain("PROFILE_PORT_OFFSET");
  });
});
