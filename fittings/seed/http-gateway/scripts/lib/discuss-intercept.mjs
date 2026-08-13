// discuss-intercept.mjs - out-of-band Discuss interception at the gateway seam.
//
// A message that ANSWERS a pending AskUserQuestion (the discuss duty waiting on scope),
// or a short affirmative "go" on a card HELD in Discuss by an explicit gate, must be
// handled BEFORE the turn is enqueued - the same out-of-band position POST /chat/answer
// uses. If it ran INSIDE the serialized turn chain it would queue behind the blocked
// discuss turn (which is holding the chain on the picker), and by the time it ran the
// picker would be gone. So the gateway calls resolveDiscussInterception at the /chat +
// /chat/stream entry points before enqueueTurn.
//
// CHANNEL PARITY (2026-08-09, ORCHESTRATOR_COHERENCE.md §5.2). This used to begin
// `if (channel !== "web") return null`, and to look the card up at a hardcoded
// `web:<sessionId>`. So answering a question, or saying "go", worked on the web channel
// and NOWHERE ELSE - on Omi, voice or Slack the same sentence was just an ordinary turn,
// which is the single largest parity break the Phase 0 audit found. The predicate is now
// the channel-agnostic one it should always have been: "is there a live Discuss card for
// this origin?". Origin ids are already `<transport>:<address>` for every transport, so
// nothing needed inventing - the web assumption was the only thing in the way.
//
// Pure decision + injectable board lookup; the gateway wires the effects (drive the
// live picker via handleAnswer, or an engine-header Move discuss->plan).

// A SHORT affirmative that resumes an explicitly-gated held discuss card. Deliberately
// tight (exact-match, optional trailing period) so an ordinary sentence that merely
// contains "go" is never mistaken for a resume.
export const AFFIRMATIVE_GO = /^(?:go|proceed|yes,?\s*(?:go ahead|proceed)|ship it)\.?$/i;
export function isAffirmativeGo(text) {
  return AFFIRMATIVE_GO.test(String(text ?? "").trim());
}

// Pick the pending-question tool_use_id to answer for a thread's live discuss card.
// Prefer a question BOUND to this card (its entry was stamped with the cardId when the
// ask-watcher fired during the card's engine dispatch). Conservative fallback ONLY when
// binding is UNAVAILABLE: exactly one pending question globally AND it is UNBOUND
// (cardId null) - so a stale entry, or one bound to a DIFFERENT card, can never hijack
// this thread's reply.
export function pickPendingQuestion(pendingQuestions, cardId) {
  const entries = [...pendingQuestions.entries()];
  const bound = entries.find(([, e]) => e && e.cardId === cardId);
  if (bound) return bound[0];
  if (entries.length === 1 && entries[0][1]?.cardId == null) return entries[0][0];
  return null;
}

/** The origin id a channel's session maps to. `<transport>:<address>` is the
 *  convention every transport already uses (origins.mjs), so this is a formatter,
 *  not a policy - the point is that NO channel is special-cased. */
export function originIdFor(channel, sessionId) {
  const c = String(channel ?? "").trim().toLowerCase();
  const s = String(sessionId ?? "").trim();
  if (!c || !s) return null;
  // An id that already carries its transport is passed through, so a caller
  // holding a full origin id (the Omi wake bus builds `omi:wake:<id>`) is not
  // double-prefixed into `omi:omi:wake:<id>`.
  if (s.startsWith(`${c}:`)) return s;
  return `${c}:${s}`;
}

// Decide whether an inbound message is a discuss ANSWER, an explicit GO, an
// autonomy-hold GO, or none of them.
// resolveThreadCard(origin_id) -> { attach } | { continueFrom } | null (injectable).
// Returns { action: "answer", toolUseId, card } | { action: "go", card } |
// { action: "autonomy-go", card } | null. A null
// result (the common case) means "run the ordinary turn"; the board is only consulted
// when there is a pending question OR the message is a bare affirmative, so ordinary
// turns pay no extra round-trip. Never throws.
//
// Works for EVERY channel. Behaviour is identical across channels; only rendering
// differs, and rendering is the caller's business.
export async function resolveDiscussInterception({ text, channel, sessionId, pendingQuestions, resolveThreadCard }) {
  const originId = originIdFor(channel, sessionId);
  if (!originId) return null;
  const hasPending = !!(pendingQuestions && pendingQuestions.size > 0);
  const affirmative = isAffirmativeGo(text);
  if (!hasPending && !affirmative) return null; // ordinary turn - no board lookup
  let liveCard = null;
  try {
    const resolved = await resolveThreadCard(originId);
    liveCard = resolved?.attach ?? null;
  } catch {
    return null;
  }
  if (!liveCard) return null;
  // (0) AUTONOMY-HOLD resume (ORCHESTRATOR_COHERENCE.md §7.1). A card the router
  // parked below its lower threshold is waiting for exactly this word - and it is
  // NOT on the Discuss list. It sits in the board's capture list on whatever the
  // router proposed, so this branch is checked FIRST and is deliberately not
  // list-scoped, unlike the two below it. Same word, same out-of-band position,
  // same channel-agnostic lookup; only the effect the caller wires differs.
  if (affirmative && liveCard.autonomyHeld === true) {
    return { action: "autonomy-go", card: liveCard };
  }
  if (liveCard.list !== "discuss") return null;
  // (1) reply-as-answer: a pending question bound to (or unambiguous for) this card.
  if (hasPending) {
    const toolUseId = pickPendingQuestion(pendingQuestions, liveCard.id);
    if (toolUseId) return { action: "answer", toolUseId, card: liveCard };
  }
  // (2) explicit-go resume: the card is HELD on Discuss by an explicit gate (D9b).
  if (affirmative && liveCard.discussHeld === true) {
    return { action: "go", card: liveCard };
  }
  return null;
}
