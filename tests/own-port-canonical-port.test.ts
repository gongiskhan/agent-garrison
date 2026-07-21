// Regression guard for the two bugs that let the Ports/Power/Outpost views sit
// broken and unnoticed:
//
//  1. TWO seeds claimed the same canonical port. automations and power-default
//     both declared 7090; improver and ports-default both declared 7088. Nothing
//     caught it, because the colliding fittings were never stationed at the same
//     time — power-default and ports-default were not in any composition, so the
//     collision could not fire. The moment they were stationed, one server lost
//     the race and the other was pushed off its port.
//
//  2. Three own-port servers still carried findFreePort. 07ba683 removed the
//     auto-shift so a server binds its configured port or exits 1 — but it fixed
//     only the NINE servers that were then stationed. ports-default, power-default
//     and outpost-tailscale-host kept shifting, which is exactly what hid bug (1):
//     ports-default silently walked 7088 → 7092 instead of refusing, so the
//     collision surfaced as a mystery ("the view is on the wrong port") rather
//     than as a loud failure.
//
// Together these two invariants make the failure impossible to reintroduce: ports
// are unique at the source, and a collision is loud rather than silently shifted.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

const SEED_DIR = join(__dirname, "..", "fittings", "seed");

interface OwnPortSeed {
  id: string;
  dir: string;
  port: number | null;
}

// The canonical port a seed claims: x-garrison.default_port, else the
// config_schema `port` key's default (improver declares only the latter).
function canonicalPort(meta: any): number | null {
  if (typeof meta?.default_port === "number") return meta.default_port;
  const schema = meta?.config_schema;
  if (Array.isArray(schema)) {
    const portKey = schema.find((entry: any) => entry?.key === "port");
    if (typeof portKey?.default === "number") return portKey.default;
  }
  return null;
}

// Match CODE SHAPES, not bare words. Two traps, both hit while writing this test:
//   - Several servers legitimately mention findFreePort in a comment explaining why
//     it is gone ("no findFreePort auto-shift"). A bare substring match fails the
//     very files that are correct — so require a CALL: `findFreePort(`.
//   - Stripping comments first is not an option: a regex-based comment stripper runs
//     away across JS regex literals containing `/*` (it ate 9k chars of the
//     orchestrator, including its real guard). Hence: no stripping, precise patterns.
const FIND_FREE_PORT_CALL = /\bfindFreePort\s*\(/; // a call or a declaration, never prose
const EADDRINUSE_GUARD = /["']EADDRINUSE["']/; // the string literal in `err.code === "EADDRINUSE"`

function ownPortSeeds(): OwnPortSeed[] {
  const out: OwnPortSeed[] = [];
  for (const id of readdirSync(SEED_DIR)) {
    const dir = join(SEED_DIR, id);
    const apm = join(dir, "apm.yml");
    if (!existsSync(apm)) continue;
    let meta: any;
    try {
      meta = (parseYaml(readFileSync(apm, "utf8")) as any)?.["x-garrison"];
    } catch {
      continue;
    }
    if (!meta || meta.own_port !== true) continue;
    out.push({ id, dir, port: canonicalPort(meta) });
  }
  return out;
}

describe("own-port fittings — canonical port contract", () => {
  const seeds = ownPortSeeds();

  it("there are own-port seeds to check", () => {
    expect(seeds.length).toBeGreaterThan(0);
  });

  // Bug (1). Detached vs operative-bound is irrelevant: any two own-port servers
  // can be up at once, so a shared canonical port is always a latent collision.
  it("no two own-port seeds claim the same canonical port", () => {
    const byPort = new Map<number, string[]>();
    for (const { id, port } of seeds) {
      if (port === null) continue;
      byPort.set(port, [...(byPort.get(port) ?? []), id]);
    }
    const collisions = [...byPort.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([port, ids]) => `port ${port} claimed by ${ids.join(" + ")}`);
    expect(
      collisions,
      `own-port seeds must claim distinct canonical ports; whichever server loses the race is pushed off its port:\n  ${collisions.join("\n  ")}`
    ).toEqual([]);
  });

  it("every own-port seed declares a canonical port at all", () => {
    const missing = seeds.filter((s) => s.port === null).map((s) => s.id);
    expect(missing, `own_port:true with no default_port and no config_schema port default: ${missing.join(", ")}`).toEqual([]);
  });

  // Bug (2). The contract from 07ba683, enforced for EVERY own-port server rather
  // than the subset that happened to be stationed the day it was written.
  for (const { id, dir } of seeds) {
    it(`${id} binds its configured port or exits — no findFreePort shift`, () => {
      const server = join(dir, "scripts", "server.mjs");
      if (!existsSync(server)) return; // start.mjs-only fittings are covered elsewhere
      const src = readFileSync(server, "utf8");

      expect(
        FIND_FREE_PORT_CALL.test(src),
        `${id}/scripts/server.mjs still calls findFreePort — a port collision silently shifts the server to a different port instead of failing, which orphans its status-file slot and hides the collision`
      ).toBe(false);

      expect(
        EADDRINUSE_GUARD.test(src),
        `${id}/scripts/server.mjs has no EADDRINUSE guard — it must refuse to start on a shifted port (the configured port is canonical)`
      ).toBe(true);
    });
  }
});
