// Regression guard (added after kanban-loop V1b shipped an own-port board with no
// scripts/start.mjs → the runner's startOwnPortFitting errors "no start script" and
// the board never boots). The runner (src/lib/own-port-lifecycle.ts) starts an
// operative-bound own-port Fitting by spawning `<fittingDir>/scripts/start.mjs`. So
// EVERY seed Fitting that declares x-garrison.own_port: true and is operative-bound
// (lifecycle !== "detached") MUST ship scripts/start.mjs, or it silently fails to
// start under Garrison even though `node scripts/server.mjs` works standalone.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

const SEED_DIR = join(__dirname, "..", "fittings", "seed");

function ownPortOperativeBoundFittings(): { id: string; dir: string }[] {
  const out: { id: string; dir: string }[] = [];
  for (const id of readdirSync(SEED_DIR)) {
    const dir = join(SEED_DIR, id);
    const apm = join(dir, "apm.yml");
    if (!existsSync(apm)) continue;
    let meta: any;
    try { meta = (parseYaml(readFileSync(apm, "utf8")) as any)?.["x-garrison"]; } catch { continue; }
    if (!meta || meta.own_port !== true) continue;
    if (meta.lifecycle === "detached") continue; // detached fittings aren't runner-started
    out.push({ id, dir });
  }
  return out;
}

describe("own-port fittings — runner start contract", () => {
  const fittings = ownPortOperativeBoundFittings();

  it("there is at least one own-port operative-bound seed fitting to check", () => {
    expect(fittings.length).toBeGreaterThan(0);
  });

  for (const { id, dir } of fittings) {
    it(`${id} ships scripts/start.mjs (the runner's startOwnPortFitting entrypoint)`, () => {
      const startScript = join(dir, "scripts", "start.mjs");
      expect(existsSync(startScript), `${id} declares own_port:true but has no scripts/start.mjs — the runner cannot boot it`).toBe(true);
      // Must be a real entrypoint, not an empty stub.
      const src = readFileSync(startScript, "utf8").trim();
      expect(src.length, `${id}/scripts/start.mjs is empty`).toBeGreaterThan(20);
    });
  }
});
