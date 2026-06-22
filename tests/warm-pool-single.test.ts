import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs package
import { MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";

function stub(id: string) {
  return {
    id,
    spawned: 0,
    async spawn() {
      this.spawned++;
      return { id: `${id}-${this.spawned}`, alive: true, isAlive: () => true, dispose() {} };
    }
  };
}

// s2 / pool-collapse FINDING 7: there is ONE generic warm operative pool — model
// and effort are applied at checkout via slash-inject (/model, /effort), NOT by
// partitioning the pool per (model × effort × task-type). Mode/soul identity is a
// separate soul session (a BOOT dimension), never a pool key.
describe("single generic warm pool (s2 / pool-collapse FINDING 7)", () => {
  it("the operative pool is keyed by RUNTIME, not by (model×effort×type)", async () => {
    const op = stub("operative");
    const cls = stub("classifier");
    const pool = new MultiRuntimePool({
      runtimes: [
        { id: "operative", adapter: op, role: "primary", size: 1 },
        { id: "classifier", adapter: cls, role: "secondary", size: 1 }
      ]
    });
    await pool.start();
    // exactly two warm pools (one generic operative + the classifier) — never one per model/effort
    expect(pool.warmedRuntimes().sort()).toEqual(["classifier", "operative"]);
    // repeated operative checkouts draw from the SAME generic pool
    const a = await pool.checkout("operative");
    a.release?.();
    const b = await pool.checkout("operative");
    b.release?.();
    expect(op.spawned).toBeGreaterThanOrEqual(1);
    pool.shutdown();
  });

  it("the gateway wires exactly one primary 'operative' runtime (no per-model partitioning)", () => {
    const src = readFileSync(
      join(__dirname, "..", "fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs"),
      "utf8"
    );
    const primaries = (src.match(/role:\s*"primary"/g) || []).length;
    expect(primaries).toBe(1); // one generic operative pool
    expect(src).toContain('id: "operative"');
    // no per-(model/effort/type) pool keying anywhere
    expect(src).not.toMatch(/poolKey|byModel|perModel|partitionBy/);
  });
});
