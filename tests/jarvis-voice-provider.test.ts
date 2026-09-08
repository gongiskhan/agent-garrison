import { describe, expect, it } from "vitest";
import { normalizeVoiceInfo, splitSpeechText } from "../fittings/seed/jarvis-os/ui/voice-provider";

describe("Jarvis selected voice contract", () => {
  it("uses capture REST without inventing wake or streaming support", () => {
    const info = normalizeVoiceInfo({ available: true, fittingId: "capture-service", stt: true, tts: true, maxTextChars: 600 });
    expect(info).toMatchObject({ stt: true, tts: true, ttsFormat: "mp3", maxTextChars: 600, wakeEvents: false, stream: false });
  });
  it("honors the optional local provider's advertised capabilities", () => {
    expect(normalizeVoiceInfo({ available: true, stt: true, tts: true, ttsFormat: "wav", maxTextChars: 900, wakeEvents: true, stream: false })).toMatchObject({ ttsFormat: "wav", maxTextChars: 900, wakeEvents: true, stream: false });
  });
  it("does not use stale capabilities from an unavailable provider", () => {
    expect(normalizeVoiceInfo({ available: false, stt: true, tts: true, wakeEvents: true, stream: true })).toMatchObject({ stt: false, tts: false, wakeEvents: false, stream: false });
  });
  it.each([null, {}, { available: true }, { available: true, maxTextChars: -1 }, { available: true, maxTextChars: "900" }])("handles incomplete capabilities conservatively: %j", value => {
    expect(normalizeVoiceInfo(value)).toMatchObject({ stt: false, tts: false, maxTextChars: 600, ttsFormat: "mp3" });
  });
  it.each([600, 900])("preserves a complete long reply within a %i character provider limit", limit => {
    const text = "Esta resposta inclui várias frases e todos os seus detalhes. ".repeat(90);
    const chunks = splitSpeechText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= limit)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
  it("handles a long unbroken Unicode word without cutting surrogate pairs", () => {
    const text = "x" + "😀".repeat(750);
    const chunks = splitSpeechText(text, 600);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });
  it("keeps a short response intact and has no empty trailing chunks", () => {
    expect(splitSpeechText("Hello.", 600)).toEqual(["Hello."]);
    expect(splitSpeechText("", 600)).toEqual([]);
    expect(splitSpeechText("x".repeat(1200), 600)).toEqual(["x".repeat(600), "x".repeat(600)]);
  });
});
