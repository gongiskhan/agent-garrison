// Standby wake/stop phrase logic for the voice HUD — extracted from main.tsx so
// it can be unit-tested (a bad match strands the session asleep or awake). PT+EN.

// A whole short utterance that drops the session into standby ("hey jarvis" wakes
// it again).
export const STOP_RE =
  /^\s*(ok\s+)?(jarvis[,.!?\s]+)?(desliga(-te)?|para de ouvir|podes? parar( de ouvir)?|fica em standby|vai dormir|adeus|até (já|logo)|stop listening|go to sleep|stand ?by)\s*[,.!?]*\s*(jarvis)?\s*[.!?]*\s*$/i;

// Wake phrase for the browser-side standby: only an utterance addressing Jarvis
// wakes the session. Whisper mangles "hey/jarvis" in PT sometimes, so common
// mis-hearings are included. Whatever follows becomes the first turn.
export const WAKE_RE =
  /^\W{0,3}(hey|ei|ok|olá|ola|oi|alô|alo)?[\s,]*(jarvis|jervis|djarvis|járvis)\b[\s,.!?…:;-]*/i;

export function isStopPhrase(transcript: string): boolean {
  return STOP_RE.test((transcript || "").trim());
}

// At least 2 letter/number chars — enough to be a real query, not a stray blip.
function meaningful(s: string): boolean {
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2;
}

export type WakeResult =
  | { kind: "ignore" }              // not addressed to Jarvis — drop, stay dormant
  | { kind: "stay-dormant" }        // "jarvis, para de ouvir" while already dormant
  | { kind: "wake"; query: string };// woke; query is "" for a bare "hey jarvis"

// Decide what a transcript heard WHILE IN STANDBY means.
export function classifyStandbyUtterance(transcript: string): WakeResult {
  const t = (transcript || "").trim();
  const m = t.match(WAKE_RE);
  if (!m) return { kind: "ignore" };
  const remainder = t.slice(m[0].length).trim();
  if (remainder && STOP_RE.test(remainder)) return { kind: "stay-dormant" };
  return { kind: "wake", query: meaningful(remainder) ? remainder : "" };
}
