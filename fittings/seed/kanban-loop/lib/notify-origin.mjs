// Close the loop to the originating channel (GARRISON feedback slice).
//
// A card created from a channel conversation carries originChannel
// ({channel, threadId} — stamped by the gateway's carding, D19). When the card
// reaches a TERMINAL outcome — it lands on `done`, or parks in
// `needs-attention` — the thread that asked for the work hears the outcome,
// instead of going silent forever after "Registered as a run".
//
// Design constraints:
//   - Fire-and-forget, never throws, never awaited on the save path: feedback
//     is best-effort; a channel being down must never fail a card write.
//   - Channel discovery follows the URL-link contract (the fitting's status
//     file under ~/.garrison/ui-fittings/), never a hardcoded port.
//   - Transition-edge triggered: fires only when the LIST CHANGES into a
//     terminal state (done / needs-attention), so repeated saves on a parked
//     card do not spam the thread.
//   - Quick cards are excluded: their outcome was the inline channel reply.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveOriginId, parseOriginId, ensureOriginRecord, appendOriginEvent } from "./origins.mjs";

const DONE_LIST = "done";
const ATTENTION_LIST = "needs-attention";

function statusFileUrl(fittingId) {
  try {
    const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const file = path.join(home, "ui-fittings", `${fittingId}.json`);
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc.url === "string" && doc.url.length ? doc.url : null;
  } catch {
    return null;
  }
}

// Channel id -> the fitting whose server accepts the thread-append route
// (POST /api/threads/:id/messages). Adding a channel means adding its fitting
// id here (the fitting must expose the same route). omi relays the message to
// the wearer as an Omi direct notification (falling back to the web-channel
// thread); a card only carries the omi transport when the omi-channel fitting
// created it, so with that fitting absent or off this entry is inert.
const CHANNEL_FITTINGS = { web: "web-channel-default", omi: "omi-channel" };


// ---- multi-channel fan-out -------------------------------------------------
// The chain above delivers a reminder to exactly ONE place (origin thread, else
// omi, else the board notice). That is right for a conversational reply, but
// wrong for a reminder: the user wants it on every surface they might be
// looking at, so they can decide which one works and ignore the rest.
//
// Discovery is deliberately NOT a hardcoded transport map. Such a map is why
// slack-channel - which has existed and can post - was invisible to
// notifications: nobody remembered to add it. Instead we ask every RUNNING
// own-port fitting whether it accepts the channel notify contract; the ones
// that do not simply 404 and are skipped. A new channel Fitting is reachable
// the moment it implements POST /notify, with no change here.
//
// Cost: a handful of 404s per reminder against non-channel fittings. That is
// cheaper than the failure mode it replaces (a channel silently never used).
function runningFittingBases() {
  try {
    const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const dir = path.join(home, "ui-fittings");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = f.replace(/\.json$/, "");
        return { id, base: statusFileUrl(id) };
      })
      .filter((e) => Boolean(e.base));
  } catch {
    return [];
  }
}

/**
 * POST the channel notify contract to every running fitting that accepts it.
 * `skipFittingIds` avoids double-delivering to a channel the caller already
 * reached through the origin chain.
 */
export async function fanOutNotification(
  { title, text, actions = [], link = null, tag = null },
  { skipFittingIds = [], fetchImpl = fetch } = {}
) {
  const skip = new Set(skipFittingIds.filter(Boolean));
  const results = [];
  await Promise.all(
    runningFittingBases()
      .filter((e) => !skip.has(e.id))
      .map(async ({ id, base }) => {
        try {
          const res = await fetchImpl(`${base}/notify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, text, actions, link, tag }),
            signal: AbortSignal.timeout(8000)
          });
          // 404 = not a notify-capable channel. Anything else is a real outcome.
          if (res.status !== 404) results.push({ id, status: res.status, ok: res.ok });
        } catch {
          // A fitting that is starting or wedged must never block a reminder
          // reaching the other channels.
        }
      })
  );
  return results;
}

function boardCardUrl(cardId) {
  const base = statusFileUrl("kanban-loop");
  return base ? `${base}/#/cards/${cardId}` : null;
}

// The outcome message the thread receives. Plain text + the card link — the
// channel renders links; content stays snippet-sized (the card holds the rest).
export function outcomeMessage(card) {
  const title = (card.title || "(untitled)").trim();
  const url = boardCardUrl(card.id);
  if (card.list === DONE_LIST) {
    const lines = [`Run complete — ${title}.`];
    const snippet = typeof card.lastReply === "string" && card.lastReply.trim() ? card.lastReply.trim() : null;
    if (snippet) lines.push(snippet.length > 400 ? `${snippet.slice(0, 400)}…` : snippet);
    if (card.videoUrl) lines.push(`Evidence video: ${card.videoUrl}`);
    if (url) lines.push(`Card: ${url}`);
    return lines.join("\n\n");
  }
  const reason = typeof card.attentionReason === "string" && card.attentionReason.trim() ? card.attentionReason.trim() : "the run engine parked it";
  const lines = [`Run needs attention — ${title}.`, reason.length > 400 ? `${reason.slice(0, 400)}…` : reason];
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

// Should a prev->next card write notify? Pure, so the edge logic is testable:
// an originChannel-carrying, non-quick card whose list CHANGED into a terminal
// state. `prev` may be null (first write — never a terminal transition worth
// announcing unless it lands terminal outright, which real flows never do).
export function terminalTransition(prev, next) {
  if (!next || typeof next !== "object") return false;
  if (next.quick === true) return false;
  const oc = next.originChannel;
  if (!oc || typeof oc !== "object" || !oc.channel || !oc.threadId) return false;
  const landed = next.list === DONE_LIST || next.list === ATTENTION_LIST;
  if (!landed) return false;
  return (prev?.list ?? null) !== next.list;
}

// Fire-and-forget: resolve the channel fitting, POST the outcome to its thread
// notify endpoint. Every failure path is swallowed (logged to stderr once) —
// the card write must never depend on a channel being up.
export function notifyOriginTransition(prev, next) {
  try {
    if (!terminalTransition(prev, next)) return;
    const fittingId = CHANNEL_FITTINGS[String(next.originChannel.channel).toLowerCase()];
    if (!fittingId) return;
    const base = statusFileUrl(fittingId);
    if (!base) return;
    const text = outcomeMessage(next);
    void fetch(`${base}/api/threads/${encodeURIComponent(next.originChannel.threadId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text }] })
    })
      .then((res) => {
        if (!res.ok) console.error(`[kanban] origin notify → HTTP ${res.status} (${fittingId}, thread ${next.originChannel.threadId})`);
      })
      .catch((err) => {
        console.error(`[kanban] origin notify failed: ${err?.message || err}`);
      });
  } catch {
    /* never let feedback break a card write */
  }
}

// ─────────────────────────── S3a: per-transport lifecycle event router (D8)
//
// Five lifecycle events (created | needs-input | blocked | failed | finished) plus
// the WS2 duty-summary event flow through routeOriginEvent: it ALWAYS appends to the
// origin's durable event log (all transports — the record S3e's pull delivery reads),
// then delivers per transport (web = thread message; board/skill/terminal = event log
// only for now). Failure isolation identical to notifyOriginTransition: fire-and-
// forget, never throws, never blocks a save.

export const ORIGIN_EVENT_KINDS = ["created", "needs-input", "blocked", "failed", "finished", "duty-summary", "steering", "schedule-due"];

function titleCaseWord(s) {
  const w = String(s || "").trim();
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

// Short human texts (web delivery). finished/blocked/failed reuse the legacy
// outcomeMessage so the web wording stays stable; created/duty-summary/needs-input
// get their own concise texts.
export function createdMessage(card) {
  const url = boardCardUrl(card.id);
  const lines = [`Registered as a run — ${(card.title || "(untitled)").trim()}.`];
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

export function dutySummaryMessage(card, { phase, summary } = {}) {
  const url = boardCardUrl(card.id);
  const duty = titleCaseWord(phase || "Duty");
  const one = typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 200) : "";
  const head = one ? `${duty} complete — ${one}` : `${duty} complete.`;
  const lines = [head];
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

export function needsInputMessage(card, { questions } = {}) {
  const url = boardCardUrl(card.id);
  const lines = [`Needs input — ${(card.title || "(untitled)").trim()}.`];
  const qs = Array.isArray(questions) ? questions : [];
  qs.forEach((q, i) => {
    const text = typeof q === "string" ? q : q?.question || q?.text || "";
    if (text) lines.push(`${i + 1}. ${text}`);
  });
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

// S3d (D9b): the DISCUSS brief message - the settled scope delivered to the origin
// when the discuss duty finishes. Pass-through proceeds to plan ("reply to adjust");
// the explicit gate holds for a go. Brief content capped so the thread stays readable.
export function briefMessage(card, { brief, gate } = {}) {
  const url = boardCardUrl(card.id);
  const head =
    gate === "explicit"
      ? "Brief ready - holding in Discuss for your go. Reply 'go' or Move the card to proceed to plan; reply to adjust the scope."
      : "Brief ready - proceeding to plan. Reply to adjust the scope.";
  const lines = [head];
  const body = typeof brief === "string" && brief.trim() ? brief.trim() : "";
  if (body) lines.push(body.length > 2000 ? `${body.slice(0, 2000)}…` : body);
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

/**
 * Route the DISCUSS brief to a card's origin (S3d). Rides the duty-summary kind so
 * web delivery + origin-log append work unchanged; the message carries the brief +
 * the proceed/hold notice. Fire-and-forget, never throws.
 */
export function routeBrief(root, card, { brief, gate } = {}) {
  routeOriginEvent(root, null, card, {
    kind: "duty-summary",
    message: briefMessage(card, { brief, gate }),
    detail: { phase: "discuss", gate: gate ?? "pass-through", brief: typeof brief === "string" ? brief.slice(0, 2000) : null }
  });
}

// Fire-and-forget POST of an assistant message to a channel fitting's thread
// (the shared thread-append contract). Extracted so every channel-transport
// delivery uses one path; the channel id picks the fitting via CHANNEL_FITTINGS.
function deliverChannelMessage(channel, threadId, text) {
  const fittingId = CHANNEL_FITTINGS[channel];
  if (!fittingId || !threadId || !text) return;
  const base = statusFileUrl(fittingId);
  if (!base) return;
  void fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "assistant", text }] })
  })
    .then((res) => {
      if (!res.ok) console.error(`[kanban] origin event → HTTP ${res.status} (${channel} thread ${threadId})`);
    })
    .catch((err) => {
      console.error(`[kanban] origin event delivery failed: ${err?.message || err}`);
    });
}

// Board-level notice (the weekly review) — not tied to any card or origin, so it
// cannot ride routeOriginEvent. Reuses the same transport: resolve the web channel
// via its status file, ensure a fixed well-known thread, post the text there.
// Awaitable so a CLI caller can finish delivery before exiting, but never throws;
// resolves false when the channel is down (the report file + stdout still land).
const BOARD_NOTICE_THREAD = "kanban-board-review";

export async function deliverBoardNotice(title, text) {
  try {
    if (!text) return false;
    const base = statusFileUrl(CHANNEL_FITTINGS.web);
    if (!base) return false;
    const ensured = await fetch(`${base}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: BOARD_NOTICE_THREAD, title: title || "Board review", source: "kanban-loop" })
    });
    if (!ensured.ok) {
      console.error(`[kanban] board notice → thread ensure HTTP ${ensured.status}`);
      return false;
    }
    const posted = await fetch(`${base}/api/threads/${BOARD_NOTICE_THREAD}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text }] })
    });
    if (!posted.ok) {
      console.error(`[kanban] board notice → HTTP ${posted.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[kanban] board notice failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Route one lifecycle event to a card's origin. Appends to the durable event log for
 * EVERY transport, then delivers per transport (web only for now). `event` is
 * { kind, message?, detail?, at? }. Never throws.
 */
export function routeOriginEvent(root, disk, card, event) {
  try {
    if (!card || typeof card !== "object" || !event || !event.kind) return;
    const origin_id = deriveOriginId(card);
    const { transport, address } = parseOriginId(origin_id);
    ensureOriginRecord(root, { origin_id, transport, address, thread: card.originChannel?.threadId ?? null });
    appendOriginEvent(root, origin_id, {
      at: event.at || new Date().toISOString(),
      kind: event.kind,
      cardId: card.id,
      title: card.title ?? null,
      message: event.message ?? null,
      ...(event.detail !== undefined && event.detail !== null ? { detail: event.detail } : {})
    });
    // Transport delivery. Web posts the message into the originating thread (quick
    // cards excluded — their outcome was the inline channel reply). board/skill/
    // terminal are event-log-only for now (skill/terminal pull delivery lands in S3e).
    // S3c: a steering event whose confirmation was ALREADY delivered by the gateway
    // turn's own SSE reply (detail.viaTurn) records the event but does NOT re-post to
    // the thread (no double confirmation).
    //
    // `created` is the same story: the gateway's inline turn reply ("Registered as a
    // run …") already confirms a freshly-carded run in the originating web thread, so
    // pushing the board's `created` event there too shows the same card twice. Record
    // the event (appended above, and other transports still read it) but suppress its
    // web delivery. Web delivery only ever fires for a gateway-carded thread card, and
    // that path ALWAYS sends the inline reply, so this is never the sole notification.
    const skipWeb =
      (event.kind === "steering" && event.detail?.viaTurn === true) ||
      event.kind === "created";
    if (CHANNEL_FITTINGS[transport] && !card.quick && event.message && card.originChannel?.threadId && !skipWeb) {
      deliverChannelMessage(transport, card.originChannel.threadId, event.message);
    }
  } catch {
    /* never let event routing break a card write */
  }
}

// The terminal edge (list CHANGED into done | needs-attention). Unlike the legacy
// terminalTransition this does NOT pre-exclude quick / no-originChannel cards — the
// event log records every terminal outcome; routeOriginEvent gates web delivery.
function terminalEdge(prev, next) {
  if (!next || typeof next !== "object") return false;
  const landed = next.list === DONE_LIST || next.list === ATTENTION_LIST;
  if (!landed) return false;
  return (prev?.list ?? null) !== next.list;
}

/**
 * The saveCardCAS terminal-edge entry point: route finished (into done) or
 * blocked|failed (into needs-attention, split by card.attentionKind) with the legacy
 * web text. Fire-and-forget, never throws.
 */
export function routeTerminalTransition(root, prev, next) {
  try {
    if (!terminalEdge(prev, next)) return;
    let kind;
    if (next.list === DONE_LIST) kind = "finished";
    else kind = next.attentionKind === "failed" ? "failed" : "blocked";
    routeOriginEvent(root, prev, next, { kind, message: outcomeMessage(next) });
  } catch {
    /* never let the router break a save */
  }
}

// ─────────────────────────── Card scheduling reminders
//
// Omi notifications are PLAIN TEXT (two query params, no buttons - verified
// against the integration OpenAPI). So the "snooze / run" actions are a text
// protocol: the reminder carries the exact phrases the wearer can say aloud
// (wake word) or type to the ask_gary chat, plus the card deep link. The
// operative holds the matching tools (run_card / schedule_card), so the
// phrases are executable, not aspirational.

// A speakable handle for a card: the last 4 chars of its ULID. Resolved back
// by the board's /cards/resolve endpoint (unique-suffix match, fail-ambiguous).
export function cardShortRef(cardId) {
  return String(cardId || "").slice(-4).toUpperCase();
}

export function scheduleReminderMessage(card, { started = false } = {}) {
  const title = (card.title || "(untitled)").trim();
  const ref = cardShortRef(card.id);
  const url = boardCardUrl(card.id);
  const lines = [];
  if (started) {
    lines.push(`Scheduled card started - "${title}" (card ${ref}).`);
  } else {
    lines.push(`Scheduled: "${title}" is due (card ${ref}).`);
    if (card.project) lines.push(`Project: ${card.project}`);
    lines.push(`Tell Gary: "run card ${ref}" to start it, or "snooze card ${ref} for 2 hours" - say it aloud (wake word) or type it in this chat.`);
  }
  if (url) lines.push(`Card: ${url}`);
  return lines.join("\n\n");
}

// The board-created-card fallback thread on the omi channel: schedule
// reminders for cards with NO originating thread still reach the wearer via
// the omi fitting's relay (which pushes an Omi notification and degrades to
// the web channel by itself). With the omi fitting absent, fall back to the
// web board-notice thread so the reminder is never silently dropped.
const OMI_REMINDER_THREAD = "omi-reports";

export function deliverScheduleReminder(root, card, { started = false } = {}) {
  try {
    const text = scheduleReminderMessage(card, { started });
    // Fan out to every notify-capable channel IN ADDITION to the origin chain
    // below. A reminder is not a reply: the user asked for it on every surface
    // so they can find out which one actually works for them. Deep link and a
    // Start button ride along; transports that cannot render buttons append the
    // link as text instead.
    const ref = cardShortRef(card.id);
    // The chain below already reaches ONE channel: the origin thread's fitting
    // when the card has one, else the omi relay thread. Skip that fitting in
    // the fan-out or the user gets the same reminder twice on that surface.
    const chainFittingId = card.originChannel?.channel
      ? CHANNEL_FITTINGS[String(card.originChannel.channel).toLowerCase()]
      : statusFileUrl(CHANNEL_FITTINGS.omi)
        ? CHANNEL_FITTINGS.omi
        : null;
    void fanOutNotification(
      {
        title: started ? "Scheduled card started" : "Card due",
        text,
        link: boardCardUrl(card.id),
        tag: `card-${card.id}`,
        actions: started ? [] : [{ label: "Open card", url: boardCardUrl(card.id) }]
      },
      { skipFittingIds: [chainFittingId] }
    );
    if (card.originChannel?.channel && card.originChannel?.threadId) {
      routeOriginEvent(root, null, card, {
        kind: "schedule-due",
        message: text,
        detail: { scheduledFor: card.scheduledFor ?? null, started }
      });
      return;
    }
    // No originating thread (board-created card): record the event, then push
    // through omi when its fitting is up, else the web board-notice thread.
    routeOriginEvent(root, null, card, {
      kind: "schedule-due",
      message: null,
      detail: { scheduledFor: card.scheduledFor ?? null, started }
    });
    if (statusFileUrl(CHANNEL_FITTINGS.omi)) {
      deliverChannelMessage("omi", OMI_REMINDER_THREAD, text);
    } else {
      void deliverBoardNotice("Scheduled cards", text);
    }
  } catch {
    /* reminders are best-effort - never break the tick */
  }
}

/**
 * needs-input router (S3d wires the emission; defined + unit-tested here). Renders
 * the questions as a numbered thread message for web; event-log only otherwise.
 */
export function routeNeedsInput(root, disk, card, { questions } = {}) {
  const qs = (Array.isArray(questions) ? questions : []).map((q) =>
    typeof q === "string" ? q : q?.question || q?.text || ""
  );
  routeOriginEvent(root, disk, card, {
    kind: "needs-input",
    message: needsInputMessage(card, { questions: qs }),
    detail: { questions: qs }
  });
}
