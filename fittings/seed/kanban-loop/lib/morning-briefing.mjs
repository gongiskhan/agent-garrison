// Scheduled Morning briefing identity + multi-channel delivery.
//
// The occurrence owns its delivery receipts. Web is always an independent,
// stable thread; Omi is asked for direct delivery with its Web fallback
// suppressed so one failed wearable push cannot duplicate the Web message.
// Slack and Email are additive fan-out: each degrades honestly (channel not
// running / not configured / connector not connected) rather than failing the
// occurrence, and each carries forward the availability notes of every
// channel that ran before it so a reader on the LAST channel still learns
// what else did not land.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadAllCards, updateCardCAS } from "./board.mjs";

export const MORNING_BRIEF_SYSTEM_KEY = "morning-briefing-v2";
export const MORNING_BRIEF_WEB_THREAD = "morning-briefing";
export const MORNING_BRIEF_SLACK_THREAD = "morning-briefing";

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

// Slack has no thread-create endpoint (see slack-channel/lib/outbound.js): an
// id that is not a real Slack conversation id falls back to the fitting's
// configured notify_channel, or reports honestly that none is configured. So,
// unlike Web/Omi, there is no ensureThread call here.
async function deliverSlack(base, text, fetchImpl, idempotencyKey) {
  if (!base) return { status: "degraded", detail: "Slack channel is not running.", threadId: MORNING_BRIEF_SLACK_THREAD };
  try {
    const response = await fetchImpl(`${base}/api/threads/${MORNING_BRIEF_SLACK_THREAD}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text }], idempotencyKey }),
      signal: AbortSignal.timeout(12_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const reason = payload?.error ?? `Slack relay HTTP ${response.status}.`;
      return { status: "degraded", detail: String(reason).slice(0, 300), threadId: MORNING_BRIEF_SLACK_THREAD };
    }
    if (payload?.deduplicated) return { status: "delivered", detail: "Slack already had this message.", threadId: MORNING_BRIEF_SLACK_THREAD };
    return { status: "delivered", detail: "Slack channel notified.", threadId: MORNING_BRIEF_SLACK_THREAD };
  } catch (error) {
    return { status: "degraded", detail: String(error?.message ?? error).slice(0, 300), threadId: MORNING_BRIEF_SLACK_THREAD };
  }
}

// Email rides the same capability-contract shape the Automations engine uses
// to call a connector (fittings/seed/capture-service/lib/connector-call.mjs is
// the sibling of this): resolve a fresh OAuth token from the shell's
// internal-token-gated auth-env route, then spawn the google connector's own
// CLI so no Google API surface is duplicated here. Absent config or an
// unconnected Google account both degrade — gmail.send is documented as
// ask-first/irreversible, so this channel only ever fires once an operator has
// both connected Google AND set a recipient.
function connectorScriptPath(connectorId, env) {
  const dir = env.GARRISON_COMPOSITION_DIR?.trim();
  if (!dir) return null;
  return path.join(dir, "apm_modules", "_local", connectorId, "scripts", "connector.mjs");
}

function readInternalToken(env) {
  try {
    const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    return readFileSync(path.join(home, "internal-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function connectorAuthEnv(connectorId, env, fetchImpl) {
  const base = (env.GARRISON_BASE_URL?.trim() || env.GARRISON_APP_URL?.trim() || "").replace(/\/+$/, "");
  const token = readInternalToken(env);
  if (!base || !token) return null;
  try {
    const response = await fetchImpl(`${base}/api/connectors/${encodeURIComponent(connectorId)}/auth-env`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-internal": token },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data?.env && typeof data.env === "object" ? data.env : null;
  } catch {
    return null;
  }
}

function runGmailSend(script, authEnv, args, env, spawnImpl, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("node", [script, "call", "gmail.send", JSON.stringify(args)], {
      env: { ...env, ...authEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error("gmail.send timed out; delivery could not be confirmed"));
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const collect = (chunk, stderr) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 64 * 1024) {
        finish(new Error("gmail.send exceeded its output limit; delivery could not be confirmed"));
        child.kill("SIGKILL");
        return;
      }
      if (stderr) err += chunk;
      else out += chunk;
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`gmail.send exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(out);
        if (parsed?.ok !== true || typeof parsed.result?.id !== "string" || !parsed.result.id.trim()) {
          finish(new Error(parsed?.ok === false
            ? String(parsed.error ?? "gmail.send refused")
            : "gmail.send returned no confirmed message identifier"));
        } else finish(null, { messageId: parsed.result.id });
      } catch {
        finish(new Error("gmail.send returned unparseable output"));
      }
    });
  });
}

async function deliverEmail(card, text, { env, fetchImpl, spawnImpl, beforeSend }) {
  const to = env.GARRISON_KANBANLOOP_MORNING_BRIEF_EMAIL?.trim();
  if (!to) return { status: "degraded", detail: "No morning_brief_email configured; email skipped." };
  const script = connectorScriptPath("google", env);
  if (!script) return { status: "degraded", detail: "No composition directory resolved; cannot reach the google connector." };
  const authEnv = await connectorAuthEnv("google", env, fetchImpl);
  if (!authEnv) return { status: "degraded", detail: "Google is not connected; email skipped." };
  try {
    const subject = `Morning briefing — ${String(card?.occurrenceAt ?? card?.updated ?? "today").slice(0, 10)}`;
    if (!await beforeSend()) return { status: "degraded", detail: "Delivery claim was replaced; email not sent." };
    const receipt = await runGmailSend(script, authEnv, { to, subject, body: text }, env, spawnImpl);
    return { status: "delivered", detail: `Email sent to ${to}.`, messageId: receipt.messageId };
  } catch (error) {
    return { status: "degraded", detail: String(error?.message ?? error).slice(0, 300) };
  }
}

// Every channel after the first carries forward availability notes for every
// PRIOR channel that degraded, so a reader arriving on the last surviving
// channel still learns what else did not land — same wording deliverWeb has
// always used for Omi ("Availability — <Label>: degraded. <detail>").
function withPriorAvailability(text, priors) {
  const notes = priors
    .filter(({ receipt }) => receipt?.status === "degraded")
    .map(({ label, receipt }) => `Availability — ${label}: degraded. ${receipt.detail}`);
  return notes.length ? [text, ...notes].join("\n\n") : text;
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
  afterChannelDelivered = null,
  spawnImpl = spawn
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

  const briefingText = baseMessage(claimed, summary, calendar);
  const webText = briefingText;
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
    if (!persisted) return { skipped: "delivery claim was replaced", card: null, calendar, web };
    delivery = persisted.morningBriefDelivery;
  }
  const slackText = withPriorAvailability(briefingText, [
    { label: "Web", receipt: web }
  ]);
  const slackKey = stableDeliveryKey(claimed, "slack");
  let slack = delivery.slack;
  if (!terminalReceipt(slack)) {
    slack = {
      ...await deliverSlack(fittingUrlFn("slack-channel"), slackText, fetchImpl, slackKey),
      idempotencyKey: slackKey
    };
    if (typeof afterChannelDelivered === "function") {
      await afterChannelDelivered({ channel: "slack", idempotencyKey: slackKey, receipt: slack });
    }
    const persisted = await persistDeliveryPatch(root, id, claimId, { slack });
    if (!persisted) return { skipped: "delivery claim was replaced", card: null, calendar, web, slack };
    delivery = persisted.morningBriefDelivery;
  }
  const emailText = withPriorAvailability(briefingText, [
    { label: "Web", receipt: web },
    { label: "Slack", receipt: slack }
  ]);
  const emailKey = stableDeliveryKey(claimed, "email");
  let email = delivery.email;
  if (!terminalReceipt(email)) {
    // Gmail has no idempotent send contract. A durable attempt fence must
    // precede the side effect: after a crash, do not silently send it again.
    // A missing result is honest uncertainty, never a delivery success.
    if (email?.status === "sending") {
      email = {
        ...email, status: "degraded", outcome: "unknown",
        detail: "A previous email attempt was interrupted; delivery is unknown and was not retried. Check Sent mail before sending again."
      };
    } else {
      email = {
        ...await deliverEmail(claimed, emailText, {
          env, fetchImpl, spawnImpl,
          beforeSend: async () => {
            const persisted = await persistDeliveryPatch(root, id, claimId, {
              email: { status: "sending", attemptedAt: now(), idempotencyKey: emailKey }
            });
            if (!persisted) return false;
            delivery = persisted.morningBriefDelivery;
            return true;
          }
        }),
        idempotencyKey: emailKey,
        ...(delivery.email?.attemptedAt ? { attemptedAt: delivery.email.attemptedAt } : {})
      };
    }
    if (typeof afterChannelDelivered === "function") {
      await afterChannelDelivered({ channel: "email", idempotencyKey: emailKey, receipt: email });
    }
    const persisted = await persistDeliveryPatch(root, id, claimId, { email });
    if (!persisted) return { skipped: "delivery claim was replaced", card: null, calendar, web, slack, email };
    delivery = persisted.morningBriefDelivery;
  }
  const completedAt = now();
  const updated = await updateCardCAS(root, id, (card) => {
    if (card.morningBriefDelivery?.claimId !== claimId) return null;
    const event = {
      at: completedAt,
      kind: "morning-brief-delivery",
      message: `Morning briefing delivery — Web ${web.status}; Slack ${slack.status}; Email ${email.status}; Calendar ${calendar.status}`
    };
    return {
      ...card,
      morningBriefDelivery: {
        ...card.morningBriefDelivery,
        completedAt,
        calendar,
        web,
        slack,
        email,
        claimId: null,
        claimedAt: null
      },
      events: [...(Array.isArray(card.events) ? card.events : []), event].slice(-200)
    };
  });
  if (!updated?.morningBriefDelivery?.completedAt) {
    return { skipped: "delivery claim was replaced", card: updated ?? null, calendar, web, slack, email };
  }
  return { card: updated, calendar, web, slack, email };
}

// Startup and every kanban tick recover incomplete deliveries. Web/Slack
// accept stable append keys; Gmail's durable attempt fence instead prevents
// repeating an unconfirmed send and records its uncertainty for review.
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
