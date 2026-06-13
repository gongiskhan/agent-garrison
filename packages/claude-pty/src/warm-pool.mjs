import { randomUUID } from "node:crypto";
import { OperativePtySession } from "./session.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WarmPtySessionPool {
  constructor(opts = {}) {
    this.id = opts.id ?? "warm-pty-pool";
    this.size = Math.max(0, Number(opts.size ?? 0));
    this.maxTurns = Math.max(1, Number(opts.maxTurns ?? 50));
    this.idleTimeoutMs = Math.max(1000, Number(opts.idleTimeoutMs ?? 30 * 60 * 1000));
    this.spawnOpts = opts.spawnOpts ?? {};
    this.spawnFn = opts.spawnFn ?? OperativePtySession.spawn.bind(OperativePtySession);
    this.available = [];
    this.checkedOut = new Map();
    this.spawning = new Set();
    this.started = false;
    this.closed = false;
    this.sweepTimer = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    await Promise.all(Array.from({ length: this.size }, () => this.#spawnReplacement("start")));
    this.#ensureSweep();
  }

  async checkout() {
    if (this.closed) throw new Error(`WarmPtySessionPool ${this.id} is shut down`);
    if (!this.started) await this.start();
    let record = this.available.shift();
    if (!record) {
      record = await this.#spawnRecord("checkout-empty");
    }
    this.checkedOut.set(record.id, record);
    void this.#spawnReplacement("checkout-rotate");
    let released = false;
    return {
      id: record.id,
      session: record.session,
      release: (opts = {}) => {
        if (released) return;
        released = true;
        this.#release(record.id, opts);
      }
    };
  }

  status() {
    return {
      id: this.id,
      started: this.started,
      targetSize: this.size,
      available: this.available.length,
      checkedOut: this.checkedOut.size,
      spawning: this.spawning.size,
      sessions: [...this.available, ...this.checkedOut.values()].map((record) => ({
        id: record.id,
        state: this.checkedOut.has(record.id) ? "checked-out" : "available",
        turns: record.turns,
        spawnedAt: record.spawnedAt,
        lastUsedAt: record.lastUsedAt,
        claudeSessionId: safeSessionId(record.session),
        alive: isAlive(record.session)
      }))
    };
  }

  sweepIdle(now = Date.now()) {
    let disposed = 0;
    const keep = [];
    for (const record of this.available) {
      if (now - record.lastUsedAt >= this.idleTimeoutMs || !isAlive(record.session)) {
        dispose(record.session);
        disposed += 1;
      } else {
        keep.push(record);
      }
    }
    this.available = keep;
    while (this.available.length + this.spawning.size < this.size && !this.closed) {
      void this.#spawnReplacement("idle-replace");
    }
    return disposed;
  }

  shutdown() {
    this.closed = true;
    this.started = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const record of this.available) dispose(record.session);
    for (const record of this.checkedOut.values()) dispose(record.session);
    this.available = [];
    this.checkedOut.clear();
    this.spawning.clear();
  }

  #release(id, opts) {
    const record = this.checkedOut.get(id);
    if (!record) return;
    this.checkedOut.delete(id);
    record.turns += Number(opts.turns ?? 1);
    record.lastUsedAt = Date.now();
    if (
      opts.dispose === true ||
      record.turns >= this.maxTurns ||
      !isAlive(record.session) ||
      this.closed ||
      this.available.length >= this.size
    ) {
      dispose(record.session);
      return;
    }
    this.available.push(record);
  }

  async #spawnReplacement(reason) {
    if (this.closed) return null;
    if (this.available.length + this.spawning.size >= this.size) return null;
    const token = randomUUID();
    this.spawning.add(token);
    try {
      const record = await this.#spawnRecord(reason);
      if (this.closed || this.available.length >= this.size) {
        dispose(record.session);
        return null;
      }
      this.available.push(record);
      return record;
    } finally {
      this.spawning.delete(token);
    }
  }

  async #spawnRecord(reason) {
    const session = await this.spawnFn(this.spawnOpts);
    return {
      id: randomUUID(),
      session,
      reason,
      turns: 0,
      spawnedAt: new Date().toISOString(),
      lastUsedAt: Date.now()
    };
  }

  #ensureSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), Math.min(this.idleTimeoutMs, 60_000));
    this.sweepTimer.unref?.();
  }
}

export async function measureIdleCost({ spawnFn, spawnOpts = {}, holdMs = 60_000, rssFn = () => process.memoryUsage().rss } = {}) {
  const beforeRss = rssFn();
  const session = await (spawnFn ?? OperativePtySession.spawn.bind(OperativePtySession))(spawnOpts);
  const beforeStatus = statusTokens(session);
  await sleep(holdMs);
  const afterStatus = statusTokens(session);
  const afterRss = rssFn();
  dispose(session);
  return {
    tokens: Math.max(0, afterStatus - beforeStatus),
    rssMb: Math.round(((afterRss - beforeRss) / 1024 / 1024) * 10) / 10
  };
}

function statusTokens(session) {
  try {
    const status = session.status?.();
    return Number(status?.tokens ?? status?.tokenCount ?? 0) || 0;
  } catch {
    return 0;
  }
}

function safeSessionId(session) {
  try {
    return session.getClaudeSessionId?.() ?? null;
  } catch {
    return null;
  }
}

function isAlive(session) {
  try {
    return session?.isAlive?.() !== false && session?.isDisposed?.() !== true;
  } catch {
    return false;
  }
}

function dispose(session) {
  try {
    session?.dispose?.();
  } catch {
    // ignore
  }
}
