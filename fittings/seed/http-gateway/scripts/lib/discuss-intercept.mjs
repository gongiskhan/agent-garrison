// discuss-intercept.mjs - S3d review R1/R3: out-of-band Discuss interception for the
// gateway HTTP seam.
//
// A web thread message that ANSWERS a pending AskUserQuestion (the discuss duty waiting
// on scope), or a short affirmative "go" on a card HELD in Discuss by an explicit gate,
// must be handled BEFORE the turn is enqueued - the same out-of-band position POST
// /chat/answer uses. If it ran INSIDE the serialized turn chain it would queue behind
// the blocked discuss turn (which is holding the chain on the picker), and by the time
// it ran the picker would be gone. So the gateway calls resolveDiscussInterception at
// the /chat + /chat/stream entry points before enqueueTurn.
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

// Decide whether a web thread message is a discuss ANSWER, an explicit GO, or neither.
// resolveThreadCard(origin_id) -> { attach } | { continueFrom } | null (injectable).
// Returns { action: "answer", toolUseId, card } | { action: "go", card } | null. A null
// result (the common case) means "run the ordinary turn"; the board is only consulted
// when there is a pending question OR the message is a bare affirmative, so ordinary
// turns pay no extra round-trip. Never throws.
export async function resolveDiscussInterception({ text, channel, sessionId, pendingQuestions, resolveThreadCard }) {
  if (String(channel ?? "").toLowerCase() !== "web" || !sessionId) return null;
  const hasPending = !!(pendingQuestions && pendingQuestions.size > 0);
  const affirmative = isAffirmativeGo(text);
  if (!hasPending && !affirmative) return null; // ordinary turn - no board lookup
  let liveCard = null;
  try {
    const resolved = await resolveThreadCard(`web:${sessionId}`);
    liveCard = resolved?.attach ?? null;
  } catch {
    return null;
  }
  if (!liveCard || liveCard.list !== "discuss") return null;
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
