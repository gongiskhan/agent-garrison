// Scheduled Morning briefing identity + explicit dual-channel delivery.
//
// The occurrence owns its delivery receipts. Web is always an independent,
// stable thread; Omi is asked for direct delivery with its Web fallback
// suppressed so one failed wearable push cannot duplicate the Web message.

import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAllCards, updateCardCAS } from "./board.mjs";

export const MORNING_BRIEF_SYSTEM_KEY = "morning-briefing-v2";
export const MORNING_BRIEF_WEB_THREAD = "morning-briefing";
export const MORNING_BRIEF_OMI_THREAD = "morning-briefing";

function fittingUrl(fittingId, env = process.env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const doc = JSON.parse(readFileSync(path.join(home, "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url.trim() ? doc.url.trim().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

// The Web thread's base. Conversations lives in the Garrison shell, whose
// loopback base the runner projects into every fitting as GARRISON_APP_URL; its
// HTTP API is the /api/* form deliverWeb already posts. The legacy own-port
// web-channel fitting's status file (through the injected fittingUrlFn, so tests
// stay deterministic) is the fallback for a process the runner did not start.
function webChannelUrl(env, fittingUrlFn) {
  const app = env.GARRISON_APP_URL?.trim().replace(/\/+$/, "");
  return app || fittingUrlFn("web-channel-default");
}

export function isMorningBriefOccurrence(card) {
  return Boolean(card?.scheduleTemplateId && card?.scheduleSystemKey === MORNING_BRIEF_SYSTEM_KEY);
}

export function calendarResultFromSummary(_summary) {
  return {
    status: "degraded",
    detail: "Calendar prose is not connector evidence; no events were inferred or fabricated."
  };
}

export function calendarResultFromEvidence(raw) {
  const evidence = raw?.calendar && typeof raw.calendar === "object" ? raw.calendar : raw;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      status: "degraded",
      detail: "No structured Google Calendar connector evidence was produced; no events were inferred or fabricated."
    };
  }
  const connector = evidence.connector === "google";
  const action = evidence.action === "calendar.list_events";
  const checkedAt = typeof evidence.checkedAt === "string" && Number.isFinite(Date.parse(evidence.checkedAt))
    ? new Date(evidence.checkedAt).toISOString()
    : null;
  const eventCount = Number.isInteger(evidence.eventCount) && evidence.eventCount >= 0 ? evidence.eventCount : null;
  if (connector && action && evidence.ok === true && checkedAt && eventCount !== null) {
    return {
      status: "reported",
      detail: `Google Calendar connector returned ${eventCount} event${eventCount === 1 ? "" : "s"}.`,
      connector: "google",
      action: "calendar.list_events",
      checkedAt,
      eventCount
    };
  }
  const reason = typeof evidence.reason === "string" && evidence.reason.trim()
    ? evidence.reason.trim().replace(/\s+/g, " ").slice(0, 300)
    : "connector evidence was missing, invalid, or reported failure";
  return {
    status: "degraded",
    detail: `Google Calendar unavailable: ${reason}. No events were inferred or fabricated.`,
    ...(connector ? { connector: "google" } : {}),
    ...(action ? { action: "calendar.list_events" } : {}),
    ...(checkedAt ? { checkedAt } : {})
  };
}

function runsRoot(env = process.env) {
  return path.resolve(
    env.GARRISON_RUNS_DIR?.trim() ||
    path.join(env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison"), "runs")
  );
}

export function readMorningBriefConnectorEvidence(card, env = process.env) {
  if (typeof card?.runDir !== "string" || !card.runDir.trim()) return null;
  try {
    const root = runsRoot(env);
    const dir = path.resolve(card.runDir);
    if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) return null;
    const file = path.join(dir, "morning-briefing-evidence.json");
    if (statSync(file).size > 32 * 1024) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function baseMessage(card, summary, calendar) {
  const rawBody = String(summary ?? card?.lastReply ?? "").trim();
  // A degraded/missing connector receipt makes all prose Calendar claims
  // untrusted. Remove those lines rather than publishing a confident model
  // statement next to a warning that says it was never observed.
  const body = calendar.status === "reported"
    ? rawBody
    : rawBody.split(/\r?\n/).filter((line) => !/(?:calendar|calend[aá]rio)/i.test(line)).join("\n").trim();
  const lines = [`Morning briefing — ${String(card?.occurrenceAt ?? card?.updated ?? "today").slice(0, 10)}`];
  lines.push(body || "No briefing body was returned.");
  lines.push(`Availability — Calendar: ${calendar.status}. ${calendar.detail}`);
  return lines.join("\n\n").slice(0, 12_000);
}

async function ensureThread(base, { id, title, source }, fetchImpl) {
  const response = await fetchImpl(`${base}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, title, source }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`thread ensure HTTP ${response.status}`);
}

async function deliverOmi(base, text, fetchImpl, idempotencyKey) {
  if (!base) return { status: "degraded", detail: "Omi channel is not running.", threadId: MORNING_BRIEF_OMI_THREAD };
  try {
    await ensureThread(base, {
      id: MORNING_BRIEF_OMI_THREAD,
      title: "Morning briefing",
      source: "kanban-loop"
    }, fetchImpl);
    const response = await fetchImpl(`${base}/api/threads/${MORNING_BRIEF_OMI_THREAD}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "assistant", text }],
        suppressWebFallback: true,
        idempotencyKey
      }),
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) return { status: "degraded", detail: `Omi relay HTTP ${response.status}.`, threadId: MORNING_BRIEF_OMI_THREAD };
    const payload = await response.json().catch(() => ({}));
    const direct = Array.isArray(payload?.deliveryReceipts)
      ? payload.deliveryReceipts.find((receipt) => receipt?.means === "omi-push")
      : null;
    if (direct?.ok) return { status: "delivered", detail: direct.target ?? "Omi direct notification sent.", threadId: MORNING_BRIEF_OMI_THREAD };
    const reason = direct?.skipped ?? direct?.error ?? "Omi direct delivery returned no receipt.";
    return { status: "degraded", detail: String(reason).slice(0, 300), threadId: MORNING_BRIEF_OMI_THREAD };
  } catch (error) {
    return { status: "degraded", detail: String(error?.message ?? error).slice(0, 300), threadId: MORNING_BRIEF_OMI_THREAD };
  }
}

async function deliverWeb(base, text, fetchImpl, idempotencyKey) {
  if (!base) return { status: "degraded", detail: "No web channel base: GARRISON_APP_URL is unset and web-channel-default is not running.", threadId: MORNING_BRIEF_WEB_THREAD };
  try {
    await ensureThread(base, {
      id: MORNING_BRIEF_WEB_THREAD,
      title: "Morning briefing",
      source: "kanban-loop"
    }, fetchImpl);
    const response = await fetchImpl(`${base}/api/threads/${MORNING_BRIEF_WEB_THREAD}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text }], idempotencyKey }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return { status: "degraded", detail: `Web delivery HTTP ${response.status}.`, threadId: MORNING_BRIEF_WEB_THREAD };
    return { status: "delivered", detail: "Stable Web thread updated.", threadId: MORNING_BRIEF_WEB_THREAD };
  } catch (error) {
    return { status: "degraded", detail: String(error?.message ?? error).slice(0, 300), threadId: MORNING_BRIEF_WEB_THREAD };
  }
}

function terminalReceipt(receipt) {
  return receipt?.status === "delivered" || receipt?.status === "degraded";
}

function stableDeliveryKey(card, channel) {
  const identity = String(card?.occurrenceKey ?? card?.id ?? "unknown").slice(0, 150);
  return `morning:${identity}:${channel}`;
}

async function persistDeliveryPatch(root, id, claimId, patch) {
  const updated = await updateCardCAS(root, id, (card) => {
    if (card.morningBriefDelivery?.claimId !== claimId) return null;
    return {
      ...card,
      morningBriefDelivery: { ...card.morningBriefDelivery, ...patch }
    };
  });
  return updated?.morningBriefDelivery?.claimId === claimId ? updated : null;
}

// Awaitable for tests and recovery. The terminal edge schedules it without
// awaiting; a durable claim prevents two edge/reconciliation callers from
// delivering the same occurrence concurrently.
export async function deliverMorningBriefCompletion(root, cardOrId, {
  summary = null,
  connectorEvidence = undefined,
  fetchImpl = fetch,
  env = process.env,
  now = () => new Date().toISOString(),
  at = () => Date.now(),
  claimStaleMs = 120_000,
  fittingUrlFn = (id) => fittingUrl(id, env),
  afterChannelDelivered = null
} = {}) {
  const id = typeof cardOrId === "string" ? cardOrId : cardOrId?.id;
  if (!id) return { skipped: "missing card id" };
  const claimId = crypto.randomUUID();
  const claimed = await updateCardCAS(root, id, (card) => {
    if (!isMorningBriefOccurrence(card)) return null;
    const delivery = card.morningBriefDelivery ?? {};
    if (delivery.completedAt) return null;
    const claimAt = Date.parse(delivery.claimedAt ?? "");
    if (delivery.claimId && Number.isFinite(claimAt) && at() - claimAt < claimStaleMs) return null;
    return {
      ...card,
      morningBriefDelivery: { ...delivery, claimId, claimedAt: now() }
    };
  });
  if (!claimed || claimed.morningBriefDelivery?.claimId !== claimId) {
    return { skipped: "already delivered or claimed", card: claimed ?? null };
  }

  let delivery = claimed.morningBriefDelivery ?? {};
  // Persist the evidence verdict before either external side effect. A retry
  // must compose the same message even if the run directory is subsequently
  // cleaned up or edited.
  const calendar = delivery.calendar?.status
    ? delivery.calendar
    : calendarResultFromEvidence(
      connectorEvidence === undefined
        ? readMorningBriefConnectorEvidence(claimed, env)
        : connectorEvidence
    );
  if (!delivery.calendar?.status) {
    const persisted = await persistDeliveryPatch(root, id, claimId, { calendar });
    if (!persisted) return { skipped: "delivery claim was replaced", card: null };
    delivery = persisted.morningBriefDelivery;
  }

  const omiText = baseMessage(claimed, summary, calendar);
  const omiKey = stableDeliveryKey(claimed, "omi");
  let omi = delivery.omi;
  if (!terminalReceipt(omi)) {
    omi = {
      ...await deliverOmi(fittingUrlFn("omi-channel"), omiText, fetchImpl, omiKey),
      idempotencyKey: omiKey
    };
    if (typeof afterChannelDelivered === "function") {
      await afterChannelDelivered({ channel: "omi", idempotencyKey: omiKey, receipt: omi });
    }
    const persisted = await persistDeliveryPatch(root, id, claimId, { omi });
    if (!persisted) return { skipped: "delivery claim was replaced", card: null, calendar, omi };
    delivery = persisted.morningBriefDelivery;
  }
  const webText = omi.status === "degraded"
    ? `${omiText}\n\nAvailability — Omi: degraded. ${omi.detail}`
    : omiText;
  const webKey = stableDeliveryKey(claimed, "web");
  let web = delivery.web;
  if (!terminalReceipt(web)) {
    web = {
      ...await deliverWeb(webChannelUrl(env, fittingUrlFn), webText, fetchImpl, webKey),
      idempotencyKey: webKey
    };
    if (typeof afterChannelDelivered === "function") {
      await afterChannelDelivered({ channel: "web", idempotencyKey: webKey, receipt: web });
    }
    const persisted = await persistDeliveryPatch(root, id, claimId, { web });
    if (!persisted) return { skipped: "delivery claim was replaced", card: null, calendar, web, omi };
    delivery = persisted.morningBriefDelivery;
  }
  const completedAt = now();
  const updated = await updateCardCAS(root, id, (card) => {
    if (card.morningBriefDelivery?.claimId !== claimId) return null;
    const event = {
      at: completedAt,
      kind: "morning-brief-delivery",
      message: `Morning briefing delivery — Web ${web.status}; Omi ${omi.status}; Calendar ${calendar.status}`
    };
    return {
      ...card,
      morningBriefDelivery: {
        ...card.morningBriefDelivery,
        completedAt,
        calendar,
        web,
        omi,
        claimId: null,
        claimedAt: null
      },
      events: [...(Array.isArray(card.events) ? card.events : []), event].slice(-200)
    };
  });
  if (!updated?.morningBriefDelivery?.completedAt) {
    return { skipped: "delivery claim was replaced", card: updated ?? null, calendar, web, omi };
  }
  return { card: updated, calendar, web, omi };
}

// Startup and every kanban tick call this recovery pass. It repairs all three
// process-death windows: after a terminal edge but before the first send, after
// one channel receipt, and after both receipts but before finalisation. Stable
// append keys at the Web/Omi boundaries make replay after an unreceipted HTTP
// response safe as well.
export async function reconcileMorningBriefDeliveries(root, options = {}) {
  const cards = await loadAllCards(root);
  const pending = cards.filter((card) =>
    card?.list === "done" &&
    isMorningBriefOccurrence(card) &&
    !card.morningBriefDelivery?.completedAt
  );
  const result = { checked: pending.length, completed: 0, skipped: 0, errors: [] };
  for (const card of pending) {
    try {
      const delivery = await deliverMorningBriefCompletion(root, card.id, options);
      if (delivery?.card?.morningBriefDelivery?.completedAt) result.completed += 1;
      else result.skipped += 1;
    } catch (error) {
      result.errors.push({ cardId: card.id, error: String(error?.message ?? error).slice(0, 500) });
    }
  }
  return result;
}

export function scheduleMorningBriefDelivery(root, card, options = {}) {
  if (!isMorningBriefOccurrence(card)) return false;
  setImmediate(() => {
    void deliverMorningBriefCompletion(root, card.id, options).catch((error) => {
      console.error(`[kanban] Morning briefing delivery failed for ${card.id}: ${error?.message ?? error}`);
    });
  });
  return true;
}
