// The serve-port formula (8400 + localPort % 1000) deliberately ignores
// profile offsets. On the mesh that is an INVARIANT: every node runs the
// committed map at offset 0, so the same fitting gets the same serve port on
// every machine — which is what makes a peer's view URL computable as
// https://<peer-host>:<servePort> without asking the peer. This test pins the
// formula and the property that gave it teeth.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function servePort(localPort: number): number {
  let p = 8400 + (localPort % 1000);
  while (p === 8443 || p === 8444 || p === 8445 || p === 443) p += 1;
  return p;
}

describe("mesh serve ports", () => {
  it("the committed script uses exactly this formula", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "tailnet-serve-views.mjs"), "utf8");
    expect(src).toContain("8400 + (localPort % 1000)");
  });

  it("every committed own-port default lands on a distinct serve port", () => {
    const ports: number[] = [];
    for (const dir of readdirSync(path.join(ROOT, "fittings", "seed"))) {
      const manifest = path.join(ROOT, "fittings", "seed", dir, "apm.yml");
      try {
        const m = readFileSync(manifest, "utf8").match(/default_port: (\d+)/);
        if (m) ports.push(Number(m[1]));
      } catch {
        /* no manifest */
      }
    }
    expect(ports.length).toBeGreaterThan(10);
    const served = ports.map(servePort);
    expect(new Set(served).size).toBe(served.length);
  });

  it("the node profile is offset 0 — committed ports ARE the served ports", async () => {
    const { PROFILE_PORT_OFFSET } = await import("../src/lib/instance-profile");
    expect(PROFILE_PORT_OFFSET.node).toBe(0);
  });
});
