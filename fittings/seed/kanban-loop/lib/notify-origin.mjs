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
