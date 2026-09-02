// Companion notifier — the APNs transport (M5). House discipline (omi
// notify.mjs): fire-and-forget callers, honest per-means receipts keyed by
// `means` with an explicit `skipped` REASON instead of silent no-ops, plain
// text + one bare deep link, NO action buttons. Log privacy (I5): receipts
// and logs carry outcomes and counts, never message content.
//
// Delivery chain: companion-push (APNs to every registered device, per-day
// cap, Retry-After-honouring backoff, dead-token pruning) degrading to the
// Conversations thread on the Garrison app when the push means is off,
// unconfigured, capped or persistently failing.

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

// Templates that answer something the user just DID (spoke a command, was
// asked a question). These draw on the interactive push budget — never
// starved by the operative's routine fan-out.
const INTERACTIVE_TEMPLATES = new Set(["wake_confirmation", "card_created", "ask"]);

// The /notify relay sink carries the same names as tags, so one rule serves
// both paths.
export function priorityForTag(tag) {
  return INTERACTIVE_TEMPLATES.has(tag) ? "interactive" : "routine";
}

// A process that never named a GARRISON_HOME must not inherit the real one
// (2026-08-18): this resolves the live fittings used as the push fallback.
function underTestRunner(env) {
  return Boolean(env.VITEST || env.VITEST_WORKER_ID) || env.NODE_ENV === "test";
}

function statusFileUrl(fittingId, env = process.env) {
  try {
    if (!env.GARRISON_HOME?.trim() && underTestRunner(env)) return null;
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

// The Conversations host. The Garrison app serves the thread engine at /api/*
// and the runner projects its loopback base as GARRISON_APP_URL; a node still
// running the legacy web-channel fitting publishes that host's base through
// its status file. Both hosts share one thread store, so exactly one is ever
// posted to - the app whenever it is named.
function conversationsBaseUrl(env = process.env) {
  const app = env.GARRISON_APP_URL?.trim().replace(/\/+$/, "");
  if (app) return app;
  return statusFileUrl("web-channel-default", env);
}

// The in-app route a notification opens (the Garrison iOS app reads `path`
// from the APNs payload and navigates its webview there). Accepts an explicit
// shell path, or derives one from a link that lives on this node's app origin
// (GARRISON_APP_URL); a link to anywhere else yields no path, so a foreign URL
// can never steer the app. Returns null for anything that is not a rooted,
// single-slash path.
export function appPathFor({ path, link }, env = process.env) {
  const rooted = (candidate) => {
    const value = String(candidate ?? "").trim();
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("://")) return null;
    return value.length > 2048 ? null : value;
  };
  const explicit = rooted(path);
  if (explicit) return explicit;
  if (!link) return null;
  const app = env.GARRISON_APP_URL?.trim().replace(/\/+$/, "");
  if (!app) return null;
  try {
    const target = new URL(link);
    const origin = new URL(app);
    if (target.origin !== origin.origin) return null;
    return rooted(`${target.pathname}${target.search}${target.hash}`);
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

  // Two push budgets (the 2026-08-15 "no feedback" incident): the operative's
  // routine ack fan-out burned the single daily cap by mid-afternoon, so the
  // pushes that answer the user's OWN spoken commands were all skipped.
  // "interactive" (wake confirmations, asks, card links from a wake) draws on
  // its own budget that routine traffic can never starve. A ledger day entry
  // is {routine, interactive}; plain numbers from the old format read as
  // routine counts.
  todayEntry(ledger) {
    const today = this.now().toISOString().slice(0, 10);
    const raw = ledger[today];
    if (typeof raw === "number") return { routine: raw, interactive: 0 };
    return { routine: raw?.routine ?? 0, interactive: raw?.interactive ?? 0 };
  }

  sentToday(priority = "routine") {
    return this.todayEntry(readJSON(this.ledgerFile(), {}))[priority] ?? 0;
  }

  capFor(priority) {
    return priority === "interactive"
      ? this.cfg.notifyInteractiveMaxPerDay
      : this.cfg.notifyMaxPerDay;
  }

  bumpLedger(priority = "routine") {
    const file = this.ledgerFile();
    const ledger = readJSON(file, {});
    const today = this.now().toISOString().slice(0, 10);
    const entry = this.todayEntry(ledger);
    entry[priority] = (entry[priority] ?? 0) + 1;
    ledger[today] = entry;
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
      path: appPathFor({ path: cleanParams.path, link: cleanParams.cardUrl }, this.env),
      tag: template,
      priority: INTERACTIVE_TEMPLATES.has(template) ? "interactive" : "routine"
    });
  }

  // The real chain: push, degrading to the Conversations thread. Receipts for
  // every means attempted, in delivery order.
  async deliver({ title, body, link, path = null, tag, priority = "routine" }) {
    const push = await this.sendPush({ title, body, link, path, tag, priority });
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

  async sendPush({ title, body, link, path = null, tag, priority = "routine" }) {
    const means = "companion-push";
    if (!this.cfg.notifyEnabled) return { means, ok: false, skipped: "notify disabled" };
    if (!this.apns.enabled()) return { means, ok: false, skipped: "APNS_TEAM_ID/APNS_KEY_ID/APNS_P8 not sealed" };
    const tokens = this.deviceTokens();
    if (tokens.length === 0) return { means, ok: false, skipped: "no registered devices" };
    if (this.sentToday(priority) >= this.capFor(priority)) {
      this.counters.bump("notify_capped");
      return { means, ok: false, skipped: `daily ${priority} cap ${this.capFor(priority)} reached` };
    }

    const data = { ...(link ? { link } : {}), ...(path ? { path } : {}), ...(tag ? { tag } : {}) };
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
        this.bumpLedger(priority);
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

  // The degrade path: a message into the Conversations thread on the app (the
  // mobile-reachable surface), same thread-append contract omi uses. The
  // /api/* paths are served by both hosts conversationsBaseUrl can name.
  async sendWebChannelFallback(message) {
    const means = "web-channel";
    const base = conversationsBaseUrl(this.env);
    if (!base) {
      return { means, ok: false, skipped: "no Conversations host: GARRISON_APP_URL unset and web channel fitting not running" };
    }
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
