export type VoiceInfo = {
  available: boolean;
  fittingId?: string;
  stt: boolean;
  tts: boolean;
  maxTextChars: number;
  ttsFormat: "mp3" | "wav";
  wakeEvents: boolean;
  stream: boolean;
  reason?: string;
};

export function normalizeVoiceInfo(value: unknown): VoiceInfo {
  const info = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const available = info.available === true;
  return {
    available,
    ...(typeof info.fittingId === "string" ? { fittingId: info.fittingId } : {}),
    stt: available && info.stt === true,
    tts: available && info.tts === true,
    maxTextChars: Number.isInteger(info.maxTextChars) && Number(info.maxTextChars) >= 8 && Number(info.maxTextChars) <= 20_000 ? Number(info.maxTextChars) : 600,
    ttsFormat: info.ttsFormat === "wav" ? "wav" : "mp3",
    wakeEvents: available && info.wakeEvents === true,
    stream: available && info.stream === true,
    ...(typeof info.reason === "string" ? { reason: info.reason } : {})
  };
}

// Preserve every accepted character, preferring word boundaries. The limit is
// measured in UTF-16 units (also safe for a provider counting Unicode points).
// Never split a surrogate pair when a single word exceeds the provider limit.
export function splitSpeechText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 8) throw new Error("Invalid voice text limit");
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let end = maxChars;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    const prefix = rest.slice(0, end);
    const whitespace = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"), prefix.lastIndexOf("\t"));
    if (whitespace >= maxChars / 2) end = whitespace + 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
