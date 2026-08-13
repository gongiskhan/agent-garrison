// Kanban board client - the channel->card door (invariant I4: tasks have ONE
// home, the Kanban Loop; Garrison never writes tasks back into Omi).
//
// Discovery follows the URL-link contract: read the board's status file
// ~/.garrison/ui-fittings/kanban-loop.json at CALL time and use its `url` -
// never a hardcoded port. Board down = null base = the caller queues and
// retries next tick; it never hard-blocks and never guesses a port.

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
  async findByOriginId(originId) {
    const base = this.base();
    if (!base) return [];
    const res = await this.fetchImpl(`${base}/cards?origin_id=${encodeURIComponent(originId)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const cards = Array.isArray(data) ? data : (data.cards ?? []);
    return Array.isArray(cards) ? cards : [];
  }

  // Creates the card in backlog (a manual list - never auto-dispatched); human
  // promotion decides what runs. `project` must be a known LABEL or null -
  // never a fabricated path.
  async createCard(payload) {
    const base = this.base();
    if (!base) throw new Error("board unavailable");
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

  // Revise a card the wake bus already created. Two routes on purpose: while the
  // card is still sitting on a manual list it can be edited outright, but once
  // the engine owns it (D16) the board rejects edits with 403 - and steering is
  // the correct semantic there anyway ("I've changed my mind, here's more").
  // Returns how it landed so the caller can say so out loud.
  async reviseCard(cardId, { title = null, description = null, note = null }) {
    const base = this.base();
    if (!base || !cardId) return { ok: false, mode: "unavailable" };
    const patch = {};
    if (title) patch.title = title;
    if (description) patch.description = description;
    if (Object.keys(patch).length > 0) {
      const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) return { ok: true, mode: "patched" };
      // 403 = engine-owned; anything else is a real failure worth reporting.
      if (res.status !== 403) return { ok: false, mode: `http-${res.status}` };
    }
    const text = note || description || title;
    if (!text) return { ok: false, mode: "nothing-to-say" };
    const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000)
    });
    return res.ok ? { ok: true, mode: "steered" } : { ok: false, mode: `steer-http-${res.status}` };
  }

  // Resolve a spoken/short reference to a card. The board owns the matching
  // (full ULID, ULID suffix of >= 3 chars, or a title fragment); this client
  // only maps the three documented outcomes: 200 one card, 404 none, 409
  // several candidates. Ambiguity is surfaced to the caller, never guessed at.
  async resolveCard(ref) {
    const base = this.base();
    if (!base) return { status: 0, error: "board unavailable" };
    const res = await this.fetchImpl(`${base}/cards/resolve?ref=${encodeURIComponent(ref)}`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 200) return { status: 200, card: data?.card ?? data ?? null };
    if (res.status === 409) {
      return {
        status: 409,
        error: data?.error ?? "ambiguous reference",
        candidates: Array.isArray(data?.candidates) ? data.candidates : []
      };
    }
    return { status: res.status, error: data?.error ?? `HTTP ${res.status}` };
  }

  // Start (or advance) a card - the spoken "run card <REF>".
  async startCard(cardId) {
    const base = this.base();
    if (!base || !cardId) throw new Error("board unavailable");
    const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`card start failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return data?.card ?? data ?? null;
  }

  // Push a card's due time out - the spoken "snooze card <REF> ...". Exactly
  // one of minutes/until is expected by the caller; the optional action rides
  // along untouched.
  async snoozeCard(cardId, { minutes = null, until = null, action = null } = {}) {
    const base = this.base();
    if (!base || !cardId) throw new Error("board unavailable");
    const body = {};
    if (minutes != null) body.minutes = minutes;
    if (until != null) body.until = until;
    if (action != null) body.action = action;
    const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}/snooze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`card snooze failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return data?.card ?? data ?? null;
  }

  // Deep link for a card, tailnet-paired by the caller (lib/notify.mjs
  // boardCardUrl does the rehost); this raw form is loopback.
  async cardUrl(cardId) {
    const base = this.base();
    return base && cardId ? `${base}/#/cards/${cardId}` : null;
  }

  // Flat card summaries ({cards:[...]}; lastReply is NOT in the projection -
  // fetch the detail per card when the outcome text is needed).
  async listCards() {
    const base = this.base();
    if (!base) return [];
    try {
      const res = await this.fetchImpl(`${base}/cards`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data?.cards) ? data.cards : [];
    } catch {
      return [];
    }
  }

  async getCard(cardId) {
    const base = this.base();
    if (!base || !cardId) return null;
    try {
      const res = await this.fetchImpl(`${base}/cards/${encodeURIComponent(cardId)}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return data?.card ?? data ?? null;
    } catch {
      return null;
    }
  }

  // Candidate project labels for the triage prompt. Defensive about shape;
  // failure = empty list (triage then leaves project null and the board's own
  // visible project inference runs).
  async listProjects() {
    const base = this.base();
    if (!base) return [];
    try {
      const res = await this.fetchImpl(`${base}/projects`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data) ? data : (data.projects ?? []);
      return list
        .map((p) => (typeof p === "string" ? p : (p?.name ?? p?.id ?? p?.label ?? null)))
        .filter((p) => typeof p === "string" && p.length > 0);
    } catch {
      return [];
    }
  }
}
