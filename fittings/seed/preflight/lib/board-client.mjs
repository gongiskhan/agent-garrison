// The findings->card door. Trimmed from fittings/seed/email-channel's copy,
// which is itself the omi-channel precedent: discovery reads the board's status
// file ~/.garrison/ui-fittings/kanban-loop.json at CALL time and uses its `url`
// — never a hardcoded port. Board down = null base = nothing is filed.
//
// Preflight is the first fitting to file cards from its OWN findings, so two
// rules are load-bearing: the dedupe probe THROWS rather than reading a
// transient failure as "no card exists" (which would file a duplicate on every
// report), and cards go to `backlog`, the only active manual list the board
// accepts direct creation into (kanban-loop/scripts/server.mjs:1904-1908).

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

  // A failed probe THROWS: treating a transient query failure as absence would
  // file a duplicate card every time the report runs.
  async findByOriginId(originId) {
    const base = this.base();
    if (!base) throw new Error("the Kanban board is not running, so nothing was filed");
    const res = await this.fetchImpl(`${base}/cards?origin_id=${encodeURIComponent(originId)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`card dedupe probe failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const cards = Array.isArray(data) ? data : (data.cards ?? []);
    return Array.isArray(cards) ? cards : [];
  }

  async createCard(payload) {
    const base = this.base();
    if (!base) throw new Error("the Kanban board is not running, so nothing was filed");
    const res = await this.fetchImpl(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`card create failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return data.card ?? data;
  }
}
