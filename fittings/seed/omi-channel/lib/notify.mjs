// Outbound notification dispatcher (spec M3). House discipline (drill
// broadcastOutcome + kanban notify-origin): fire-and-forget callers, honest
// per-means receipts with an explicit `skipped` REASON instead of silent
// no-ops, plain text + one bare deep link, NO action buttons ("the detail
// lives behind the links, not in the notification").
//
// Primary means: Omi direct notification to the pinned uid (per-day cap from
// config; the OmiApi client retries 429/5xx internally). Degrade path (I9):
// the web-channel PWA thread - the repo's mobile-reachable surface - used
// whenever the Omi means is off, unconfigured, capped, or failing.

import path from "node:path";
import { readFileSync } from "node:fs";
import os from "node:os";
import { atomicWriteJSON, readJSON } from "./store.mjs";
import { toTailnetUrl } from "./tailnet-serve.mjs";

const OMI_THREAD_ID = "omi-reports";
const FITTING_STATUS_ID = "omi-channel";

// ---- templates: every notification renders to ONE plain-text message ----
export function renderTemplate(template, params = {}) {
  switch (template) {
    case "card_created": {
      const lines = [`New card from Omi: ${params.title ?? "(untitled)"}`];
      if (params.cardUrl) lines.push(`Card: ${params.cardUrl}`);
      return lines.join("\n");
    }
    case "wake_confirmation": {
      const lines = [params.text ?? "Done."];
      if (params.cardUrl) lines.push(`Card: ${params.cardUrl}`);
      return lines.join("\n");
    }
    case "tip":
      return `Tip: ${params.text ?? ""}`.trim();
    case "relay":
      // Pre-rendered text from another Garrison surface (e.g. kanban card
      // lifecycle events arriving on the thread-append contract).
      return String(params.text ?? "").trim();
    default:
      throw new Error(`unknown template: ${template}`);
  }
}

function statusFileUrl(fittingId, env = process.env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

// Deep links go to phones that are never on this box: pair the loopback board
// URL with its HTTPS tailnet mapping when one exists. Falling back to the
// loopback URL (rather than dropping the link) keeps local/dev flows usable.
export async function boardCardUrl(cardId, env = process.env) {
  const base = statusFileUrl("kanban-loop", env);
  if (!base || !cardId) return null;
  const local = `${base}/#/cards/${cardId}`;
  const tailnet = await toTailnetUrl(local).catch(() => null);
  return tailnet ?? local;
}

export class Notifier {
  constructor({ cfg, store, counters, omiApi, fetchImpl = fetch, env = process.env, log = console, now = () => new Date() }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.omiApi = omiApi;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.log = log;
    this.now = now;
  }

  // Deep link for a card, tailnet-paired (see boardCardUrl above).
  cardUrl(cardId) {
    return boardCardUrl(cardId, this.env);
  }

  ledgerFile() {
    return path.join(this.store.root, "notify-ledger.json");
  }

  sentToday() {
    const today = this.now().toISOString().slice(0, 10);
    return readJSON(this.ledgerFile(), {})[today] ?? 0;
  }

  bumpLedger() {
    const file = this.ledgerFile();
    const ledger = readJSON(file, {});
    const today = this.now().toISOString().slice(0, 10);
    ledger[today] = (ledger[today] ?? 0) + 1;
    atomicWriteJSON(file, ledger);
  }

  // -> receipts [{ means, ok, target? , skipped?, error? }]
  async send({ template, params = {}, suppressWebFallback = false }) {
    const message = renderTemplate(template, params);
    if (!message) return [{ means: "none", ok: false, skipped: "empty message" }];

    const receipts = [];
    // Both run: the push alerts, the chat copy is what the operator can actually
    // read after tapping it. Concurrent because the wearer waits on the push and
    // must not pay the chat call's latency for it.
    const [omi, chat] = await Promise.all([this.sendOmi(message), this.sendOmiChat(message)]);
    receipts.push(omi, chat);
    if (!omi.ok && !suppressWebFallback) {
      receipts.push(await this.sendWebChannelFallback(message));
    } else if (!omi.ok && suppressWebFallback) {
      receipts.push({ means: "web-channel", ok: false, skipped: "fallback suppressed by caller (Web delivery is independent)" });
    }
    const line = receipts
      .map((r) => `${r.means}:${r.ok ? "ok" : (r.skipped ?? r.error ?? "failed")}`)
      .join(", ");
    this.log.log(`[omi-channel] notify ${template} -> ${line}`);
    return receipts;
  }

  async sendOmi(message) {
    const means = "omi-push";
    if (!this.cfg.notifyEnabled) return { means, ok: false, skipped: "notify disabled" };
    if (!this.omiApi.configured()) return { means, ok: false, skipped: "OMI_APP_ID/OMI_APP_SECRET not sealed" };
    const uid = this.store.pinnedUid();
    if (!uid) return { means, ok: false, skipped: "no pinned uid yet" };
    if (this.sentToday() >= this.cfg.notifyMaxPerDay) {
      this.counters.bump("notify_capped");
      return { means, ok: false, skipped: `daily cap ${this.cfg.notifyMaxPerDay} reached` };
    }
    const result = await this.omiApi.sendNotification({ uid, message });
    if (result.ok) {
      this.bumpLedger();
      this.counters.bump("notifications_sent");
      return { means, ok: true, target: `omi uid ${uid.slice(0, 4)}...` };
    }
    this.counters.bump("notify_failed");
    return { means, ok: false, error: `${result.error}${result.attempts > 1 ? ` (after ${result.attempts} attempts)` : ""}` };
  }

  // The READABLE copy. The push is a truncated line whose tap target is the Omi
  // chat, so anything longer than that line used to be unreadable AND
  // unrecoverable - the chat it opened did not contain the message. This puts the
  // full text exactly where the tap lands.
  //
  // Runs ALONGSIDE the push, not instead of it and not as a fallback: the push is
  // the buzz, this is the content. Its failure never degrades the push, because a
  // delivered alert with no readable body is still better than neither.
  async sendOmiChat(message) {
    const means = "omi-chat";
    if (!this.cfg.notifyEnabled) return { means, ok: false, skipped: "notify disabled" };
    if (!this.cfg.chatDeliveryEnabled) return { means, ok: false, skipped: "chat delivery off" };
    // The relay subclass carries no API client at all, and a caller may construct
    // a Notifier without one. Crashing here would take out the push too, since
    // both means are awaited together.
    if (!this.omiApi) return { means, ok: false, skipped: "no Omi API client" };
    if (!this.omiApi.chatConfigured()) {
      return { means, ok: false, skipped: "OMI_APP_ID/OMI_IMPORT_API_KEY not sealed" };
    }
    const uid = this.store.pinnedUid();
    if (!uid) return { means, ok: false, skipped: "no pinned uid yet" };
    const result = await this.omiApi.sendChatMessage({ uid, message });
    if (result.ok) {
      this.counters.bump("chat_messages_sent");
      return { means, ok: true, target: `omi chat ${uid.slice(0, 4)}...` };
    }
    this.counters.bump(result.status === 429 ? "chat_messages_rate_limited" : "chat_messages_failed");
    return { means, ok: false, error: result.error };
  }

  // The degrade path: a message into the web-channel PWA thread (the
  // mobile-reachable surface). Same thread-append contract this fitting also
  // exposes for inbound system notifications.
  async sendWebChannelFallback(message) {
    const means = "web-channel";
    const base = statusFileUrl("web-channel-default", this.env);
    if (!base) return { means, ok: false, skipped: "web channel not running" };
    try {
      const ensured = await this.fetchImpl(`${base}/api/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: OMI_THREAD_ID, title: "Omi", source: "omi-channel" }),
        signal: AbortSignal.timeout(5000)
      });
      if (!ensured.ok) return { means, ok: false, error: `thread ensure HTTP ${ensured.status}` };
      const posted = await this.fetchImpl(`${base}/api/threads/${OMI_THREAD_ID}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "assistant", text: message }] }),
        signal: AbortSignal.timeout(5000)
      });
      if (!posted.ok) return { means, ok: false, error: `HTTP ${posted.status}` };
      this.counters.bump("notify_fallback_web");
      return { means, ok: true, target: `thread ${OMI_THREAD_ID}` };
    } catch (err) {
      return { means, ok: false, error: err?.message ?? String(err) };
    }
  }

  // Drain the tips queue written by triage (M2). Attempt-once per tip: the
  // send already carries the omi -> web-channel degrade path; a tip that
  // reaches neither is recorded and dropped (a stale tip is worse than none).
  async drainTips() {
    const dir = path.join(this.store.root, "tips-queue");
    const { readdirSync, rmSync, existsSync } = await import("node:fs");
    if (!existsSync(dir)) return [];
    const receiptsAll = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const file = path.join(dir, f);
      const tip = readJSON(file, null);
      if (!tip?.text) {
        rmSync(file, { force: true });
        continue;
      }
      const receipts = await this.send({ template: "tip", params: { text: tip.text } });
      receiptsAll.push({ tip: tip.id, receipts });
      atomicWriteJSON(path.join(this.store.root, "tips-sent", `${tip.id}.json`), {
        ...tip,
        deliveredAt: this.now().toISOString(),
        receipts
      });
      rmSync(file, { force: true });
    }
    return receiptsAll;
  }
}

// The scheduler-spawned triage process carries NO Omi secrets - baking them
// into the job command would print them in scheduler-jobs.json and every ps
// listing - so its Omi pushes ride through the server process, which holds
// them. Only the Omi means is relayed (POST /internal/omi-push on this
// fitting's own server); the web-channel degrade path stays local, so a tick
// that finds the server down still lands its message somewhere.
export class RelayNotifier extends Notifier {
  // The relay holds no credentials by design, so it cannot post to the chat
  // itself - and must not try. The server's /internal/omi-push sends BOTH the
  // push and the chat copy, so a relayed message still lands readable; this
  // receipt just says who did it.
  async sendOmiChat() {
    return { means: "omi-chat", ok: false, skipped: "sent by the server via /internal/omi-push" };
  }

  async sendOmi(message) {
    const means = "omi-push";
    // Deliberately does NOT check cfg.notifyEnabled. This runs in the scheduler's
    // triage process, whose env carries only the triage flags - the notify flag
    // was never projected there, so the local copy reads false no matter how the
    // composition is configured. Gating on it made every triage-created card
    // report "omi-push: notify disabled" and silently degrade to the web thread
    // nobody reads, which is the exact failure the relay exists to fix. The
    // SERVER holds the authoritative flag, the daily cap and the ledger, and its
    // receipt is what comes back below.
    const base = statusFileUrl(FITTING_STATUS_ID, this.env);
    if (!base) return { means, ok: false, skipped: "omi-channel server not running" };
    try {
      const res = await this.fetchImpl(`${base}/internal/omi-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(10_000)
      });
      const receipt = await res.json().catch(() => null);
      if (!res.ok || typeof receipt !== "object" || receipt === null) {
        return { means, ok: false, error: `relay HTTP ${res.status}` };
      }
      // The server's Notifier produced a full receipt (cap, ledger and
      // counters were applied THERE, against the live config).
      return receipt;
    } catch (err) {
      return { means, ok: false, error: `relay: ${err?.message ?? err}` };
    }
  }
}
