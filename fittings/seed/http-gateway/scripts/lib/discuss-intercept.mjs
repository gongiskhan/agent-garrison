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
// autonomy-hold GO, an autonomy-hold CORRECTION, or none of them.
// resolveThreadCard(origin_id) -> { attach } | { continueFrom } | null (injectable).
// Returns { action: "answer", toolUseId, card } | { action: "go", card } |
// { action: "autonomy-go", card } | { action: "autonomy-correct", card, correction }
// | null. A null result (the common case) means "run the ordinary turn". Never throws.
//
// THE BOARD LOOKUP (2026-08-13). This used to return early - no lookup - unless
// there was a pending question or the message was a bare affirmative, so an
// ordinary turn paid no round-trip. That early return is what made the ask a
// dead end: the router held a card, asked "reply go to proceed, or correct me",
// and the correction that came back ("what?!? no! I was asking a question!") was
// not affirmative, so it fell through this function and was routed as a brand-new
// turn with no thread context at all. A held card BLOCKS the thread, so any reply
// on it is the answer to the question - which cannot be known without asking the
// board whether one is held. The lookup is one 3s-bounded localhost GET, out of
// band (before enqueueTurn), and the ordinary-turn DECISION is unchanged.
//
// Works for EVERY channel. Behaviour is identical across channels; only rendering
// differs, and rendering is the caller's business.
export async function resolveDiscussInterception({ text, channel, sessionId, pendingQuestions, resolveThreadCard }) {
  const originId = originIdFor(channel, sessionId);
  if (!originId) return null;
  const hasPending = !!(pendingQuestions && pendingQuestions.size > 0);
  const affirmative = isAffirmativeGo(text);
  const reply = String(text ?? "").trim();
  if (!hasPending && !affirmative && !reply) return null; // nothing to interpret
  let liveCard = null;
  try {
    const resolved = await resolveThreadCard(originId);
    liveCard = resolved?.attach ?? null;
  } catch {
    return null;
  }
  if (!liveCard) return null;
  // (0) AUTONOMY-HOLD (ORCHESTRATOR_COHERENCE.md §7.1). A card the router parked
  // below its lower threshold is waiting for an answer - and it is NOT on the
  // Discuss list. It sits in the board's capture list on whatever the router
  // proposed, so this branch is checked FIRST and is deliberately not list-scoped,
  // unlike the two below it. The ask offers two answers and both land here: the
  // word "go" releases it, and anything else IS the correction it invited. A held
  // card has never dispatched, so it can hold no live picker of its own - the
  // reply cannot belong to the answer branch below.
  if (liveCard.autonomyHeld === true) {
    if (affirmative) return { action: "autonomy-go", card: liveCard };
    if (reply) return { action: "autonomy-correct", card: liveCard, correction: reply };
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
