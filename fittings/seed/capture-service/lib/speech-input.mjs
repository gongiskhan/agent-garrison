// Speech evidence for interruption and the brief reply window. Recognition
// confidence is not speaker identity; no voiceprint is enrolled here.
export const REPLY_FEEDBACK_WINDOW_MS = 15_000;
export const FEEDBACK_SETTLE_MS = 900;
export const FEEDBACK_MAX_UTTERANCE_MS = 30_000;

export function confidentSpeech(segment, { interim = false } = {}) {
  if (!segment || segment.is_user === false) return false;
  const text = String(segment.text ?? "").trim();
  if (!text || /^[\[(*].*[\])*]$/.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length || words.every(word => /^(?:h+m*|u+h+|u+m+|ah|eh|noise|music|silence)$/i.test(word))) return false;
  const confidence = segment.confidence;
  const duration = segment.speech_duration ?? (segment.end - segment.start);
  if (!Number.isFinite(confidence) || !Number.isFinite(duration)) return false;
  if (interim) return words.length >= 2 && confidence >= 0.9 && duration >= 0.45;
  return segment.final === true && confidence >= (words.length === 1 ? 0.92 : 0.85) && duration >= (words.length === 1 ? 0.18 : 0.35);
}
