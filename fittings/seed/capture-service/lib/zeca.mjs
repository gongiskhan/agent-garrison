// Where a spoken "Zeca" lands (D60): the standing Zeca conversation the talk
// engine owns. The wake bus needs the id synchronously at the wake hit (it
// binds the conversation the moment the name is heard), so this keeps a cached
// copy: fetched at boot, refreshed on a timer, and re-asked on demand when a
// hit arrives before the first answer. The talk engine creates the
// conversation on the first ask and rotates it nightly; both show up here on
// the next refresh, and a rotation in between only means one turn lands in
// the conversation that was current when the name was said - which is where
// the person was looking anyway.
//
// Unreachable talk engine: id() is null and the wake bus keeps its per-session
// conversation (the REC button's) or falls back to the classifier lane, so the
// voice layer degrades to what it did before D60 instead of dropping turns.

import { conversationsBaseUrl } from "./notify.mjs";

export const ZECA_REFRESH_MS = 60_000;

export class ZecaConversation {
  constructor({ env = process.env, fetchImpl = fetch, refreshMs = ZECA_REFRESH_MS, counters = null, log = console, now = () => Date.now() } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.refreshMs = refreshMs;
    this.counters = counters;
    this.log = log;
    this.now = now;
    this.current = null;
    this.fetchedAt = 0;
    this.inFlight = null;
    this.timer = null;
    this.lastError = null;
  }

  base() {
    return conversationsBaseUrl(this.env);
  }

  // The cached id, or null when the talk engine has not answered yet. A miss
  // kicks a refresh so the next hit finds it.
  id() {
    if (!this.current) void this.refresh();
    return this.current;
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    const base = this.base();
    if (!base) {
      this.lastError = "no Conversations host: GARRISON_APP_URL unset";
      return null;
    }
    this.inFlight = (async () => {
      try {
        const res = await this.fetchImpl(`${base}/api/zeca`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const id = typeof body?.conversationId === "string" && body.conversationId ? body.conversationId : null;
        if (!id) throw new Error("no conversationId in the answer");
        if (id !== this.current) {
          this.log.log(`[capture-service] zeca conversation is ${id}${this.current ? ` (was ${this.current})` : ""}`);
          this.counters?.bump("zeca_conversation_changed");
        }
        this.current = id;
        this.fetchedAt = this.now();
        this.lastError = null;
        return id;
      } catch (err) {
        this.lastError = err?.message ?? String(err);
        this.counters?.bump("zeca_conversation_fetch_failed");
        return this.current;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  start() {
    void this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health() {
    return { conversationId: this.current, fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null, error: this.lastError };
  }
}
