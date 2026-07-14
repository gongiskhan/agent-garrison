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

import { existsSync, readFileSync } from "node:fs";
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
// (POST /api/threads/:id/messages). The web channel is the only wired consumer
// today; adding a channel means adding its fitting id here (or a channel
// fitting exposing the same route).
const CHANNEL_FITTINGS = { web: "web-channel-default" };

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

export const ORIGIN_EVENT_KINDS = ["created", "needs-input", "blocked", "failed", "finished", "duty-summary"];

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

// Fire-and-forget POST of an assistant message to the web channel thread. Extracted
// so every transport-web delivery uses one path.
function deliverWebMessage(threadId, text) {
  const fittingId = CHANNEL_FITTINGS.web;
  if (!fittingId || !threadId || !text) return;
  const base = statusFileUrl(fittingId);
  if (!base) return;
  void fetch(`${base}/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "assistant", text }] })
  })
    .then((res) => {
      if (!res.ok) console.error(`[kanban] origin event → HTTP ${res.status} (thread ${threadId})`);
    })
    .catch((err) => {
      console.error(`[kanban] origin event delivery failed: ${err?.message || err}`);
    });
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
    if (transport === "web" && !card.quick && event.message && card.originChannel?.threadId) {
      deliverWebMessage(card.originChannel.threadId, event.message);
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
