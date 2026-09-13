// Notifications from the capture triage job to the Garrison phone.
import { emitSystemMessage, systemInputFromNotification } from "@garrison/messages/system";
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
    try {
      const message = await emitSystemMessage(systemInputFromNotification({
        title: params.title || "Garrison", text: renderTemplate(template, params), link: params.cardUrl,
        idempotencyKey: params.idempotencyKey, cardId: params.cardId,
        mirrorContext:{tag:template,priority:template==="wake_confirmation"?"interactive":"routine"},
      }, "capture"), { env: this.env, fetchImpl: this.fetchImpl });
      return [{ means: "messages", ok: true, queued: true, messageId: message.id }];
    } catch (error) {
      this.counters?.bump("companion_notify_failed");
      return [{ means: "messages", ok: false, error: error.message }];
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
