// multi-runtime-pool.mjs — the generic multi-runtime warm pool (BRIEF v4 §2
// "The pool manager is generic (built on the RuntimeAdapter): at operative start
// it warms pools for the primary AND every active secondary runtime").
//
// Built ONCE on top of the RuntimeAdapter contract + WarmPtySessionPool: given a
// set of runtimes (each an adapter + warm size + spawn config), it warms one pool
// per runtime so neither the primary's major sessions nor a secondary's
// delegations pay the cold-boot latency. Runtime-agnostic — adding a runtime =
// passing its adapter, no pool code change.
import { WarmPtySessionPool } from "./warm-pool.mjs";

export class MultiRuntimePool {
  // runtimes: [{ id, adapter, size?, spawnConfig?, role? ('primary'|'secondary') }]
  constructor(opts = {}) {
    this.runtimes = opts.runtimes ?? [];
    this.maxTotal = opts.maxTotal ?? 8; // global cap (matches the router-view default)
    this.pools = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    // Respect the global max-total cap across all runtimes' warm sessions.
    let budget = this.maxTotal;
    for (const rt of this.runtimes) {
      const want = Math.max(0, rt.size ?? (rt.role === "primary" ? 2 : 1));
      const size = Math.min(want, budget);
      budget -= size;
      const pool = new WarmPtySessionPool({
        id: `pool:${rt.id}`,
        size,
        // Drive the runtime's own adapter.spawn — the pool stays runtime-agnostic.
        spawnFn: () => rt.adapter.spawn(rt.spawnConfig ?? {})
      });
      await pool.start();
      this.pools.set(rt.id, { pool, role: rt.role ?? "secondary", adapter: rt.adapter });
    }
  }

  checkout(runtimeId) {
    const entry = this.pools.get(runtimeId);
    if (!entry) throw new Error(`MultiRuntimePool: no pool for runtime "${runtimeId}"`);
    return entry.pool.checkout();
  }

  status() {
    const out = {};
    for (const [id, { pool, role }] of this.pools) {
      out[id] = { role, ...pool.status() };
    }
    return out;
  }

  // The set of runtimes a pool was warmed for (primary + active secondaries).
  warmedRuntimes() {
    return [...this.pools.keys()];
  }

  // The RuntimeAdapter that backs a warmed runtime id (primary vs classifier vs a
  // secondary). Lets a caller that holds only a checkout record reach the adapter
  // driving that session — e.g. the gateway routing Stage-B moves / resume through
  // the operative's own adapter instead of assuming a Claude PTY. Null when the
  // runtime was never warmed.
  adapterFor(runtimeId) {
    return this.pools.get(runtimeId)?.adapter ?? null;
  }

  shutdown() {
    for (const { pool } of this.pools.values()) {
      try {
        pool.shutdown();
      } catch {
        /* ignore */
      }
    }
    this.pools.clear();
    this.started = false;
  }
}
