// Echo guard — stops Garrison's own spoken acknowledgements from being ingested
// as if the operator had said them.
//
// The operator wears an always-on pendant. The moment a voice sink speaks
// "Created a task, follow up with the lawyer", that sentence is picked up by the
// pendant a second later, transcribed, and delivered to this fitting through the
// realtime webhook - where it is indistinguishable from speech. Two things then
// go wrong, and both are self-amplifying:
//
//   * conversation triage sees an actionable sentence and cards it, so an ack for
//     a card creates another card, which acks, which cards;
//   * if a slot ever carries the wake word, the capture window opens on Zeca's
//     own voice (ack.mjs rejects those at render time, but this is the second
//     line of defence and the two are independent on purpose).
//
// Matching cannot be exact. The sink speaks one sentence; Omi returns it as
// several fragments, with different punctuation, casing and accents, sometimes
// mis-split mid-word. So suppression is TOKEN CONTAINMENT against a short-lived
// window of what was just spoken, not equality on a hash - the hash that rides on
// the ack is for correlation in logs, not for this decision.
//
// Biased toward speaking-and-being-heard over silence: a missed suppression
// costs one junk card the operator can delete, while over-suppression silently
// eats the operator's real speech, which is unrecoverable and undebuggable. Hence
// the minimum token count and the high containment threshold.

const DEFAULT_TTL_MS = 30_000;
const MIN_TOKENS = 3; // "yes", "do it" must never be swallowed
const CONTAINMENT = 0.8;
// Short spoken CUES ("Sim?", "Ok.") are a different problem from acks, and the
// MIN_TOKENS floor above is precisely why: it exists so a real "yes" is never
// swallowed, so it can never suppress a one-word cue coming back through the
// pendant either. That matters because a wake cue is spoken while the capture
// window is OPEN - the echo lands in the command being assembled AND re-arms
// the silence timer, corrupting the command and adding seconds of latency.
//
// So this lane is deliberately much tighter than containment: the segment's
// ENTIRE token list must equal a registered cue, inside a window sized to the
// round trip. It cannot eat a sentence, because a sentence is never equal to
// "sim".
const SHORT_TTL_MS = 4_000;

export function normalizeTokens(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export class EchoGuard {
  constructor({ ttlMs = DEFAULT_TTL_MS, counters = null, now = () => Date.now(), log = console } = {}) {
    this.ttlMs = ttlMs;
    this.counters = counters;
    this.now = now;
    this.log = log;
    this.window = []; // [{ tokens:Set, at, text, echo }] - in memory only (I5)
    this.shortWindow = []; // [{ key, at, ttlMs }] - exact-match cue echoes
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    this.window = this.window.filter((e) => e.at >= cutoff);
    const at = this.now();
    this.shortWindow = this.shortWindow.filter((e) => at - e.at < e.ttlMs);
  }

  // Register a short utterance for EXACT-match suppression. Called before the
  // cue leaves for the phone, the same ordering discipline handleAck uses: the
  // window has to be open before the sound exists, or the echo beats it back.
  registerShort(text, { ttlMs = SHORT_TTL_MS } = {}) {
    const key = normalizeTokens(text).join(" ");
    if (!key) return false;
    this.prune();
    this.shortWindow.push({ key, at: this.now(), ttlMs });
    this.counters?.bump?.("echo_short_registered");
    return true;
  }

  // Called when a sink is about to speak (or has just spoken) an ack.
  register({ text, echo = null }) {
    const tokens = normalizeTokens(text);
    if (tokens.length === 0) return false;
    this.prune();
    this.window.push({ tokens: new Set(tokens), at: this.now(), text: String(text), echo });
    this.counters?.bump?.("echo_registered");
    return true;
  }

  // -> true when this transcript segment looks like our own voice coming back.
  shouldSuppress(segmentText) {
    this.prune();
    if (this.window.length === 0 && this.shortWindow.length === 0) return false;
    const tokens = normalizeTokens(segmentText);
    const exact = tokens.join(" ");
    if (exact && this.shortWindow.some((e) => e.key === exact)) {
      this.counters?.bump?.("realtime_echo_suppressed_short");
      return true;
    }
    // Too short to attribute safely. A fragment like "created" appears in the ack
    // AND in ordinary speech; suppressing it would eat real words.
    if (tokens.length < MIN_TOKENS) return false;
    for (const entry of this.window) {
      let hits = 0;
      for (const t of tokens) if (entry.tokens.has(t)) hits++;
      if (hits / tokens.length >= CONTAINMENT) {
        this.counters?.bump?.("realtime_echo_suppressed");
        return true;
      }
    }
    return false;
  }
}
