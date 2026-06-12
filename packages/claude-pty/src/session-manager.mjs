// PtySessionManager — process-wide registry of live OperativePtySessions.
// Ported (lightened) from ekoa-core/src/backends/claude-code-pty/
// session-manager.ts. Phase 1 ships it for completeness; the gateway's single
// operative doesn't need it, but Phase 2 (souls path) keys multiple concurrent
// sessions through here.

import { randomUUID } from "node:crypto";
import { OperativePtySession } from "./session.mjs";

export class PtySessionManager {
  constructor(opts = {}) {
    this.sessions = new Map();
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60 * 60 * 1000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60 * 1000;
    this.spawnFn = opts.spawnFn ?? OperativePtySession.spawn.bind(OperativePtySession);
    this.sweepTimer = null;
    this.processHooksInstalled = false;
    this.installedHandlers = [];
  }

  get(id) {
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    if (s.isDisposed()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  size() {
    return this.sessions.size;
  }

  ids() {
    return Array.from(this.sessions.keys());
  }

  /** Spawn + register under a new id (or a provided one). */
  async create(spawnOpts, id = randomUUID()) {
    this.#ensureSweep();
    const session = await this.spawnFn(spawnOpts);
    this.sessions.set(id, session);
    return { id, session };
  }

  /** Register an already-spawned session. */
  register(session, id = randomUUID()) {
    this.#ensureSweep();
    this.sessions.set(id, session);
    return id;
  }

  dispose(id) {
    const s = this.sessions.get(id);
    if (s === undefined) return;
    this.sessions.delete(id);
    s.dispose();
  }

  disposeAll() {
    let n = 0;
    for (const [id, session] of this.sessions) {
      this.sessions.delete(id);
      session.dispose();
      n++;
    }
    return n;
  }

  shutdown() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const { sig, handler } of this.installedHandlers) {
      process.removeListener(sig, handler);
    }
    this.installedHandlers = [];
    this.processHooksInstalled = false;
    this.disposeAll();
  }

  sweepIdle(now = Date.now()) {
    let n = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt >= this.idleTimeoutMs) {
        this.sessions.delete(id);
        session.dispose();
        n++;
      }
    }
    return n;
  }

  #ensureSweep() {
    if (this.sweepTimer === null && this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
    if (!this.processHooksInstalled) {
      this.processHooksInstalled = true;
      const handler = () => this.disposeAll();
      process.on("exit", handler);
      process.on("SIGTERM", handler);
      process.on("SIGINT", handler);
      this.installedHandlers.push(
        { sig: "exit", handler },
        { sig: "SIGTERM", handler },
        { sig: "SIGINT", handler },
      );
    }
  }
}
