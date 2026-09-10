// Notifications from the capture triage job to the Garrison phone.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, atomicWriteJSON } from "./store.mjs";
import { toTailnetUrl } from "./tailnet-serve.mjs";

export function renderTemplate(template, params = {}) {
  switch (template) {
    case "card_created": {
      const lines = [`New card from capture: ${params.title ?? "(untitled)"}`];
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

// Same guard as kanban-loop's fan-out discovery (2026-08-18): a process that
// never named a GARRISON_HOME must not inherit the real one and reach a LIVE
// fitting through it. The relay notifiers below POST to capture-service
// /notify (an APNs push to the phone), so a test that
// forgot to isolate its home would buzz the user for real. Naming a home
// explicitly still exercises this path honestly.
export function underTestRunner(env) {
  return Boolean(env.VITEST || env.VITEST_WORKER_ID) || env.NODE_ENV === "test";
}

export function statusFileUrl(fittingId, env = process.env) {
  try {
    if (!env.GARRISON_HOME?.trim() && underTestRunner(env)) return null;
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

export async function boardCardUrl(cardId, env = process.env) {
  const base = statusFileUrl("kanban-loop", env);
  if (!base || !cardId) return null;
  const local = `${base}/#/cards/${cardId}`;
  const tailnet = await toTailnetUrl(local).catch(() => null);
  return tailnet ?? null;
}
export class CompanionRelayNotifier {
  constructor({ store = null, counters = null, env = process.env, fetchImpl = fetch } = {}) {
    this.store = store;
    this.now = () => new Date();
    this.counters = counters;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  cardUrl(cardId) {
    return boardCardUrl(cardId, this.env);
  }

  async send({ template, params = {} }) {
    const means = "companion-push";
    const title = params.title ?? "";
    const text = renderTemplate(template, params);
    const base = statusFileUrl("capture-service", this.env);
    if (!base) {
      this.counters?.bump("companion_notify_skipped_down");
      return [{ means, ok: false, skipped: "capture-service not running" }];
    }
    try {
      const res = await this.fetchImpl(`${base}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, text, link: params.cardUrl ?? null, tag: template }),
        signal: AbortSignal.timeout(8_000)
      });
      if (res.status === 404) {
        this.counters?.bump("companion_notify_skipped_no_sink");
        return [{ means, ok: false, skipped: "capture-service /notify not implemented" }];
      }
      const receipt = await res.json().catch(() => null);
      if (!res.ok || typeof receipt !== "object" || receipt === null) {
        this.counters?.bump("companion_notify_failed");
        return [{ means, ok: false, error: `relay HTTP ${res.status}` }];
      }
      return Array.isArray(receipt) ? receipt : [receipt];
    } catch (err) {
      this.counters?.bump("companion_notify_failed");
      return [{ means, ok: false, error: `relay: ${err?.message ?? err}` }];
    }
  }
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
