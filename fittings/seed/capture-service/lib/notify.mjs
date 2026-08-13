// Companion notifier — M3 skeleton of the M5 APNs transport. House
// discipline (omi notify.mjs): fire-and-forget callers, honest per-means
// receipts keyed by `means` with an explicit `skipped` REASON instead of
// silent no-ops, plain text + one bare deep link, NO action buttons.
//
// Until M5 lands the APNs sender, send() renders the template (text is
// always generated on our side) and answers a skip receipt naming the
// missing transport — so the wake bus's confirmation path runs end to end
// without ever pretending a push happened (invariant I11: never optimistic).

import path from "node:path";
import { readFileSync } from "node:fs";
import os from "node:os";
import { toTailnetUrl } from "./tailnet-serve.mjs";

export const COMPANION_THREAD_ID = "companion-reports";

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
      // lifecycle events arriving on the ack/notify contracts).
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
// URL with its HTTPS tailnet mapping when one exists (the loopback fallback
// is only useful in sandboxed tests, and M5's acceptance asserts every URL
// in a rendered notification is non-loopback in real use).
export async function boardCardUrl(cardId, env = process.env) {
  const base = statusFileUrl("kanban-loop", env);
  if (!base || !cardId) return null;
  const local = `${base}/#/cards/${cardId}`;
  const tailnet = await toTailnetUrl(local).catch(() => null);
  return tailnet ?? local;
}

export class CompanionNotifier {
  constructor({ cfg, store, counters, env = process.env, log = console, now = () => new Date() }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.env = env;
    this.log = log;
    this.now = now;
  }

  // Deep link for a card, tailnet-paired (see boardCardUrl above).
  cardUrl(cardId) {
    return boardCardUrl(cardId, this.env);
  }

  // -> [{means, ok, target?, skipped?, error?}], receipts keyed by MEANS,
  // never by list position (spec §3 [R2]).
  async send({ template, params = {} }) {
    let message;
    try {
      message = renderTemplate(template, params);
    } catch (err) {
      return [{ means: "none", ok: false, skipped: `render failed: ${err?.message ?? err}` }];
    }
    if (!message || message.trim().length === 0) {
      return [{ means: "none", ok: false, skipped: "empty message" }];
    }
    if (!this.cfg.notifyEnabled) {
      this.counters.bump("notify_skipped_disabled");
      return [{ means: "companion-push", ok: false, skipped: "notify disabled" }];
    }
    // M5 replaces this with the real APNs sender + per-day cap + backoff.
    this.counters.bump("notify_skipped_unimplemented");
    this.log.log(`[capture-service] notify ${template} -> companion-push: skipped (APNs transport lands at M5)`);
    return [{ means: "companion-push", ok: false, skipped: "APNs transport not implemented until M5" }];
  }
}
