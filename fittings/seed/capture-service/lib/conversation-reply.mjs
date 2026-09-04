// The reply to a spoken conversation turn (D56). A wake hit on a broadcast
// becomes a user message in the conversation (digest.mjs postConversationTurn);
// the operative answers there, in a stretch loop the phone never sees while its
// owner is in another app. This module waits for that answer in the ledger so
// the wake bus can push it to the phone, exactly as the old companion pushed
// and spoke the answer to a spoken command.
//
// The ledger (packages/claude-pty conversation-store) is read through the same
// Conversations host the turn was posted to, `GET {base}/api/conversation/:id/
// log?fromIndex=`, from the index the conversation had BEFORE the turn was
// posted. The answer is the last assistant text of the first stretch that ends
// with a user-facing duty (`discuss` by default: the loop's triage and test
// stretches talk to the loop, not to the person). When the loop stops without
// one - a triage that answered directly - the last stretch to end is the reply,
// once nothing has started for `idleGraceMs`.

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 3_000;
const DEFAULT_IDLE_GRACE_MS = 20_000;
// The duties whose stretch END is an answer TO THE PERSON. `dialogue` is the
// spoken conversation's own duty (D62) and comes first; `discuss` is the
// written back-and-forth; `responder` answers a person on a settled work
// conversation. Every other duty talks to the loop, not to the wearer - and
// when none of these matches, the idle fallback speaks whatever ended last,
// which is how a `test` stretch's "Nothing left to do here" was read aloud.
export const DEFAULT_REPLY_DUTIES = ["dialogue", "discuss", "responder"];
// APNs caps the whole payload at 4 KB; a phone shows the first few lines.
export const REPLY_TEXT_CAP = 700;

// The routing trailer every stretch appends ("[route: ...]", "[orchestrator-
// active]") is bookkeeping, not an answer: drop bracket-only lines. Code fences
// are unreadable on a lock screen and unspeakable; keep their content out too.
export function cleanReplyText(raw, cap = REPLY_TEXT_CAP) {
  let text = String(raw ?? "").replace(/\r/g, "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line));
  let out = lines.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length > cap) out = `${out.slice(0, cap - 3).trimEnd()}...`;
  return out;
}

function assistantText(payload) {
  if (!payload || payload.role !== "assistant" || !Array.isArray(payload.blocks)) return "";
  return payload.blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Fold one page of ledger events into the tracker. Pure: returns the reply
// when one is decided, null otherwise. `isFresh(stretchId)` lets two watchers
// on the same conversation (two wake hits before the first answer landed) not
// announce the same stretch twice: a stretch the bus already pushed is skipped
// and the watcher keeps waiting for the next one. Exported for the unit test.
export function foldReplyEvents(state, events, { duties = DEFAULT_REPLY_DUTIES, now = Date.now(), isFresh = () => true } = {}) {
  for (const ev of events) {
    const kind = ev?.kind;
    const payload = ev?.payload ?? {};
    if (kind === "stretch-started") {
      state.running = payload.stretchId ?? "?";
      state.texts.set(state.running, "");
      state.lastEnded = null;
    } else if (kind === "session-event") {
      const text = assistantText(payload);
      if (text && state.running) state.texts.set(state.running, text);
    } else if (kind === "stretch-ended") {
      const id = payload.stretchId ?? state.running;
      const text = cleanReplyText(state.texts.get(id) ?? "");
      state.running = null;
      // Only skip a stretch another watcher has ALREADY announced; a stretch
      // that merely becomes `lastEnded` here is not spoken yet, and burning it
      // in this branch is what made the idle fallback speak the stretch after
      // the one it meant (D62).
      if (!isFresh(id)) continue;
      const duty = typeof payload.duty === "string" ? payload.duty : null;
      if (duty && duties.includes(duty) && text) return { text, duty, stretchId: id };
      state.lastEnded = { text, duty, stretchId: id, at: now };
    }
  }
  return null;
}

export async function awaitConversationReply({
  base,
  conversationId,
  fromIndex = 0,
  fetchImpl = fetch,
  duties = DEFAULT_REPLY_DUTIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  idleGraceMs = DEFAULT_IDLE_GRACE_MS,
  isFresh = () => true,
  // Called once, synchronously, when this watcher is about to announce a
  // stretch: true = it is mine to speak, false = another watcher already took
  // it and I stop. Defaults to "always mine" for the single-watcher callers.
  claim = () => true,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  if (!base || !conversationId) return null;
  const state = { running: null, texts: new Map(), lastEnded: null };
  let cursor = Math.max(0, Number(fromIndex) || 0);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let page = null;
    try {
      const res = await fetchImpl(
        `${base}/api/conversation/${encodeURIComponent(conversationId)}/log?fromIndex=${cursor}&limit=500`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) page = await res.json().catch(() => null);
    } catch {
      page = null;
    }
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length) {
      cursor = typeof page.nextIndex === "number" ? page.nextIndex : cursor + events.length;
      const reply = foldReplyEvents(state, events, { duties, now: now(), isFresh });
      // The claim is SYNCHRONOUS and happens at the return point, not during the
      // fold: several watchers poll the same conversation (one per spoken turn),
      // and a check-then-act across their awaits let all of them announce the
      // same stretch - the user heard one answer three times (D62). A watcher
      // that loses the claim gives up rather than polling on, or it would speak
      // the NEXT unrelated stretch minutes later.
      if (reply) return claim(reply.stretchId) ? { ...reply, timedOut: false } : null;
    }
    const idle = state.lastEnded && !state.running && now() - state.lastEnded.at >= idleGraceMs;
    if (idle) {
      const { text, duty, stretchId } = state.lastEnded;
      if (!text) return null;
      return claim(stretchId) ? { text, duty, stretchId, timedOut: false } : null;
    }
    await sleep(pollMs);
  }
  return null;
}
