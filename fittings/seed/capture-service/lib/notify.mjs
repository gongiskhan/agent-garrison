// Companion notifier — the APNs transport (M5). House discipline (omi
// notify.mjs): fire-and-forget callers, honest per-means receipts keyed by
// `means` with an explicit `skipped` REASON instead of silent no-ops, plain
// text + one bare deep link, NO action buttons. Log privacy (I5): receipts
// and logs carry outcomes and counts, never message content.
//
// Delivery chain: companion-push (APNs to every registered device, per-day
// cap, Retry-After-honouring backoff, dead-token pruning) degrading to the
// web-channel PWA thread when the push means is off, unconfigured, capped or
// persistently failing.

import path from "node:path";
import { readFileSync } from "node:fs";
import os from "node:os";
import { atomicWriteJSON, readJSON } from "./store.mjs";
import { toTailnetUrl } from "./tailnet-serve.mjs";
import { ApnsSender } from "./apns.mjs";

export const COMPANION_THREAD_ID = "companion-reports";

// Retries must be WIDER than the limit they back off from (spec §11 failure
// 7): honour Retry-After when APNs sends one (capped), else these floors.
const RETRY_DELAYS_MS = [5_000, 25_000];
const RETRY_AFTER_CAP_MS = 300_000;
const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;

// ---- templates: every notification renders to ONE plain-text message ----
export function renderTemplate(template, params = {}) {
  switch (template) {
    case "card_created": {
      const lines = [`New card from the companion: ${params.title ?? "(untitled)"}`];
      if (params.cardUrl) lines.push(`Card: ${params.cardUrl}`);
      return lines.join("\n");
    }
    case "wake_confirmation": {
      const lines = [params.text ?? "Done."];
      if (params.cardUrl) lines.push(`Card: ${params.cardUrl}`);
      return lines.join("\n");
    }
    case "ask":
      return String(params.text ?? "").trim();
    case "tip":
      return `Tip: ${params.text ?? ""}`.trim();
    case "relay":
      // Pre-rendered text from another Garrison surface (e.g. kanban card
      // lifecycle events arriving on the /notify fan-out contract).
      return String(params.text ?? "").trim();
    default:
      throw new Error(`unknown template: ${template}`);
  }
}

const TEMPLATE_TITLES = {
  card_created: "New card",
  wake_confirmation: "Zeca",
  ask: "Zeca asks",
  tip: "Tip",
  relay: "Garrison"
};

function statusFileUrl(fittingId, env = process.env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

// The phone is never on this box: a loopback URL in a notification is both
// unreachable and mixed content (spec §11 failure 8's cousin — it already
// shipped once). Links are tailnet-paired upstream; anything still loopback
// by send time is stripped rather than delivered broken.
export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

// Deep links go to phones that are never on this box: pair the loopback board
// URL with its HTTPS tailnet mapping when one exists.
export async function boardCardUrl(cardId, env = process.env) {
  const base = statusFileUrl("kanban-loop", env);
  if (!base || !cardId) return null;
  const local = `${base}/#/cards/${cardId}`;
  const tailnet = await toTailnetUrl(local).catch(() => null);
  return tailnet ?? local;
}

export class CompanionNotifier {
  constructor({
    cfg,
    store,
    counters,
    env = process.env,
    log = console,
    now = () => new Date(),
    apns = null,
    fetchImpl = fetch,
    sleepFn = (ms) => new Promise((r) => setTimeout(r, ms))
  }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.env = env;
    this.log = log;
    this.now = now;
    this.apns = apns ?? new ApnsSender({ cfg, counters, log });
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
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

  deviceTokens() {
    return (readJSON(this.store.devicesFile, { tokens: [] }).tokens ?? []).map((t) => t.token);
  }

  pruneTokens(deadTokens) {
    if (deadTokens.length === 0) return;
    const registry = readJSON(this.store.devicesFile, { tokens: [] });
    registry.tokens = (registry.tokens ?? []).filter((t) => !deadTokens.includes(t.token));
    atomicWriteJSON(this.store.devicesFile, registry);
    this.counters.bump("apns_tokens_pruned", deadTokens.length);
  }

  // Idempotency ledger for the /notify sink — a redelivered fan-out must not
  // buzz the phone twice. Pruned by TTL so it cannot grow unbounded.
  seenFile() {
    return path.join(this.store.root, "notify-seen.json");
  }

  alreadyDelivered(idempotencyKey) {
    if (!idempotencyKey) return false;
    const seen = readJSON(this.seenFile(), {});
    return Boolean(seen[idempotencyKey]);
  }

  markDelivered(idempotencyKey) {
    if (!idempotencyKey) return;
    const seen = readJSON(this.seenFile(), {});
    const cutoff = this.now().getTime() - IDEMPOTENCY_TTL_MS;
    for (const [key, at] of Object.entries(seen)) {
      if (Date.parse(at) < cutoff) delete seen[key];
    }
    seen[idempotencyKey] = this.now().toISOString();
    atomicWriteJSON(this.seenFile(), seen);
  }

  // -> [{means, ok, target?, skipped?, error?}], receipts keyed by MEANS,
  // never by list position (spec §3 [R2]).
  async send({ template, params = {} }) {
    let cleanParams = params;
    if (params.cardUrl && isLoopbackUrl(params.cardUrl)) {
      this.counters.bump("notify_loopback_link_stripped");
      cleanParams = { ...params, cardUrl: null };
    }
    let message;
    try {
      message = renderTemplate(template, cleanParams);
    } catch (err) {
      return [{ means: "none", ok: false, skipped: `render failed: ${err?.message ?? err}` }];
    }
    if (!message || message.trim().length === 0) {
      return [{ means: "none", ok: false, skipped: "empty message" }];
    }
    return this.deliver({
      title: TEMPLATE_TITLES[template] ?? "Garrison",
      body: message,
      link: cleanParams.cardUrl ?? null,
      tag: template
    });
  }

  // The real chain: push, degrading to the web-channel thread. Receipts for
  // every means attempted, in delivery order.
  async deliver({ title, body, link, tag }) {
    const push = await this.sendPush({ title, body, link, tag });
    const receipts = [push];
    if (!push.ok) {
      receipts.push(await this.sendWebChannelFallback(body));
    }
    this.log.log(
      `[capture-service] notify ${tag ?? "message"} -> ${receipts
        .map((r) => `${r.means}:${r.ok ? "ok" : (r.skipped ? "skipped" : "failed")}`)
        .join(", ")}`
    );
    return receipts;
  }

  async sendPush({ title, body, link, tag }) {
    const means = "companion-push";
    if (!this.cfg.notifyEnabled) return { means, ok: false, skipped: "notify disabled" };
    if (!this.apns.enabled()) return { means, ok: false, skipped: "APNS_TEAM_ID/APNS_KEY_ID/APNS_P8 not sealed" };
    const tokens = this.deviceTokens();
    if (tokens.length === 0) return { means, ok: false, skipped: "no registered devices" };
    if (this.sentToday() >= this.cfg.notifyMaxPerDay) {
      this.counters.bump("notify_capped");
      return { means, ok: false, skipped: `daily cap ${this.cfg.notifyMaxPerDay} reached` };
    }

    const data = { ...(link ? { link } : {}), ...(tag ? { tag } : {}) };
    let lastOutcome = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const outcome = await this.apns.notify(tokens, { title, body, data });
      lastOutcome = outcome;
      if (outcome.skipped) return { means, ok: false, skipped: outcome.skipped };
      if (outcome.error) return { means, ok: false, error: outcome.error };

      const dead = outcome.results.filter((r) => r.dead).map((r) => r.token);
      this.pruneTokens(dead);
      const delivered = outcome.results.filter((r) => r.ok);
      if (delivered.length > 0) {
        this.bumpLedger();
        this.counters.bump("notifications_sent");
        return { means, ok: true, target: `${delivered.length}/${tokens.length} devices` };
      }
      // Every remaining token failed. Retry only when something is worth
      // retrying (429/5xx/transport); a sea of dead tokens is not.
      const retriable = outcome.results.some((r) => !r.dead && (r.status === 429 || r.status >= 500 || r.status === 0));
      if (!retriable || attempt === RETRY_DELAYS_MS.length) break;
      const retryAfterSec = Math.max(0, ...outcome.results.map((r) => r.retryAfter ?? 0));
      const delay = retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, RETRY_AFTER_CAP_MS) : RETRY_DELAYS_MS[attempt];
      await this.sleepFn(delay);
    }
    this.counters.bump("notify_failed");
    const reasons = [...new Set((lastOutcome?.results ?? []).map((r) => r.reason || `HTTP ${r.status}`))];
    return { means, ok: false, error: `push failed (${reasons.join(", ") || "no outcome"})` };
  }

  // The degrade path: a message into the web-channel PWA thread (the
  // mobile-reachable surface), same thread-append contract omi uses.
  async sendWebChannelFallback(message) {
    const means = "web-channel";
    const base = statusFileUrl("web-channel-default", this.env);
    if (!base) return { means, ok: false, skipped: "web channel not running" };
    try {
      const ensured = await this.fetchImpl(`${base}/api/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: COMPANION_THREAD_ID, title: "Companion", source: "capture-service" }),
        signal: AbortSignal.timeout(5000)
      });
      if (!ensured.ok) return { means, ok: false, error: `thread ensure HTTP ${ensured.status}` };
      const posted = await this.fetchImpl(`${base}/api/threads/${COMPANION_THREAD_ID}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "assistant", text: message }] }),
        signal: AbortSignal.timeout(5000)
      });
      if (!posted.ok) return { means, ok: false, error: `HTTP ${posted.status}` };
      this.counters.bump("notify_fallback_web");
      return { means, ok: true, target: `thread ${COMPANION_THREAD_ID}` };
    } catch (err) {
      return { means, ok: false, error: err?.message ?? String(err) };
    }
  }
}
