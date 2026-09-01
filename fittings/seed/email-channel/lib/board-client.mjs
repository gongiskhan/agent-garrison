// Kanban board client - the channel->card door. Trimmed from the omi-channel
// precedent: discovery reads the board's status file
// ~/.garrison/ui-fittings/kanban-loop.json at CALL time and uses its `url` -
// never a hardcoded port. Board down = null base = the caller leaves the
// message unseen and retries next tick; it never guesses a port.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function boardBase(env = process.env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", "kanban-loop.json"), "utf8"));
    const url = typeof doc?.url === "string" ? doc.url.trim().replace(/\/$/, "") : "";
    return url || null;
  } catch {
    return null;
  }
}

export class BoardClient {
  constructor({ baseUrl = null, fetchImpl = fetch, env = process.env } = {}) {
    this.explicitBase = baseUrl;
    this.fetchImpl = fetchImpl;
    this.env = env;
  }

  base() {
    return this.explicitBase ?? boardBase(this.env);
  }

  async reachable() {
    const base = this.base();
    if (!base) return false;
    try {
      const res = await this.fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  // origin_id is the natural dedupe key (the board itself has NO dedupe).
  // A failed probe THROWS rather than reading as "no card exists" - treating
  // a transient query failure as absence would file a duplicate card.
  async findByOriginId(originId) {
    const base = this.base();
    if (!base) throw new Error("board unavailable");
    const res = await this.fetchImpl(`${base}/cards?origin_id=${encodeURIComponent(originId)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const err = new Error(`card dedupe probe failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    const cards = Array.isArray(data) ? data : (data.cards ?? []);
    return Array.isArray(cards) ? cards : [];
  }

  // Full card envelope; `attachments` rides beside `card` in the response.
  async getCard(cardId) {
    const base = this.base();
    if (!base) throw new Error("board unavailable");
    const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const err = new Error(`card fetch failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json().catch(() => ({}));
  }

  async createCard(payload) {
    const base = this.base();
    if (!base) throw new Error("board unavailable");
    const res = await this.fetchImpl(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = new Error(`card create failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    return data.card ?? data;
  }

  // Card-owned upload; the board caps a file at 10 MB decoded and suffixes
  // colliding names - trust the returned name, not the sent one.
  async uploadAttachment(cardId, filename, buffer) {
    const base = this.base();
    if (!base) throw new Error("board unavailable");
    const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, content_base64: buffer.toString("base64") }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      const err = new Error(`attachment upload failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json().catch(() => ({}));
  }
}
