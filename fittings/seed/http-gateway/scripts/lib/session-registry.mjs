// In-memory sessions registry. Each entry tracks one claude subprocess
// (orchestrator or soul). Persistence is intentional v1 — orchestrator session
// id is the only thing persisted (to a sidecar file), so on http-gateway restart
// the orchestrator resumes by id; souls are ephemeral.

export class SessionRegistry {
  constructor() {
    /** @type {Map<string, SessionState>} */
    this.sessions = new Map();
    /** @type {Map<string, string>} */ // soul name -> active sessionId
    this.activeBySoul = new Map();
  }

  /**
   * Register a new session state. status defaults to "spawning". Returns the
   * stored object so callers can mutate fields like `child` later.
   */
  register(initial) {
    const session = {
      mode: "headless",
      status: "spawning",
      waiters: [],
      pendingSummaries: [],
      ...initial
    };
    this.sessions.set(session.sessionId, session);
    if (session.soul) {
      this.activeBySoul.set(session.soul, session.sessionId);
    }
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  bySoul(soul) {
    const id = this.activeBySoul.get(soul);
    return id ? this.sessions.get(id) ?? null : null;
  }

  list(filter = {}) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (filter.parent && s.parentSessionId !== filter.parent) continue;
      if (filter.worktreeId && s.worktreeId !== filter.worktreeId) continue;
      if (filter.mode && s.mode !== filter.mode) continue;
      if (filter.soul && s.soul !== filter.soul) continue;
      out.push(serialize(s));
    }
    return out;
  }

  setStatus(sessionId, status) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.status = status;
    return true;
  }

  setSummary(sessionId, summary) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.lastSummary = summary;
    s.lastResultAt = new Date().toISOString();
    s.pendingSummaries.push({ summary, at: s.lastResultAt, acknowledged: false });
    return true;
  }

  drainPendingSummaries() {
    const out = [];
    for (const s of this.sessions.values()) {
      for (const p of s.pendingSummaries) {
        if (!p.acknowledged) {
          out.push({ sessionId: s.sessionId, soul: s.soul, summary: p.summary, at: p.at });
          p.acknowledged = true;
        }
      }
    }
    return out;
  }

  /**
   * Add a waiter resolved on the next `result` event.
   */
  addWaiter(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return new Promise((resolve) => {
      s.waiters.push(resolve);
    });
  }

  resolveWaiters(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const w of s.waiters) {
      try { w({ status: s.status, summary: s.lastSummary ?? "" }); } catch { /* ignore */ }
    }
    s.waiters = [];
  }

  remove(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.soul && this.activeBySoul.get(s.soul) === sessionId) {
      this.activeBySoul.delete(s.soul);
    }
    this.sessions.delete(sessionId);
    return true;
  }
}

function serialize(s) {
  return {
    session_id: s.sessionId,
    soul: s.soul,
    status: s.status,
    mode: s.mode,
    cwd: s.cwd,
    channel: s.channel,
    parent_session_id: s.parentSessionId,
    worktree_id: s.worktreeId,
    tier: s.tier,
    tier_flags: s.tierFlags,
    terminal_tab_id: s.terminalTabId,
    last_summary_at: s.lastResultAt
  };
}
