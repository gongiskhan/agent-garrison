import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs package
import { MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";

// Stub adapters (no live runtime) — each tracks how many sessions it spawned.
function stubAdapter(id: string) {
  return {
    id,
    spawned: 0,
    async spawn() {
      this.spawned++;
      return { id: `${id}-${this.spawned}`, alive: true, isAlive: () => true, dispose() {} };
    }
  };
}

describe("MultiRuntimePool (MRr-pool-multi — multi-runtime-pool-ok)", () => {
  it("at start, warms a pool for the primary AND every active secondary", async () => {
    const claude = stubAdapter("claude-code");
    const codex = stubAdapter("codex");
    const gemini = stubAdapter("gemini");
    const pool = new MultiRuntimePool({
      runtimes: [
        { id: "claude-code", adapter: claude, role: "primary", size: 2 },
        { id: "codex", adapter: codex, role: "secondary", size: 1 },
        { id: "gemini", adapter: gemini, role: "secondary", size: 1 }
      ]
    });
    await pool.start();

    // every runtime got a warm pool
    expect(pool.warmedRuntimes().sort()).toEqual(["claude-code", "codex", "gemini"]);
    const status = pool.status();
    expect(status["claude-code"].role).toBe("primary");
    expect(status["codex"].role).toBe("secondary");
    // primary warmed 2, secondaries warmed 1 each
    expect(claude.spawned).toBe(2);
    expect(codex.spawned).toBe(1);
    expect(gemini.spawned).toBe(1);

    pool.shutdown();
  });

  it("checkout draws from the named runtime's pool + drives its adapter", async () => {
    const codex = stubAdapter("codex");
    const pool = new MultiRuntimePool({ runtimes: [{ id: "codex", adapter: codex, role: "secondary", size: 1 }] });
    await pool.start();
    const co = await pool.checkout("codex");
    expect(co.session.alive).toBe(true);
    co.release?.();
    expect(() => pool.checkout("nope")).toThrowError(/no pool for runtime/);
    pool.shutdown();
  });

  it("respects the global max-total session cap across runtimes", async () => {
    const a = stubAdapter("a");
    const b = stubAdapter("b");
    const pool = new MultiRuntimePool({
      maxTotal: 3,
      runtimes: [
        { id: "a", adapter: a, role: "primary", size: 2 },
        { id: "b", adapter: b, role: "secondary", size: 2 } // wants 2, but only 1 left in the budget
      ]
    });
    await pool.start();
    expect(a.spawned + b.spawned).toBeLessThanOrEqual(3);
    expect(a.spawned).toBe(2);
    expect(b.spawned).toBe(1); // capped by the remaining budget
    pool.shutdown();
  });
});
