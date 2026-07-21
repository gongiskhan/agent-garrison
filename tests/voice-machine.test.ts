import { describe, it, expect } from "vitest";
import {
  initialCtx,
  voiceReduce,
  transcriptOf,
  isMeaningfulTranscript,
  type VoiceCtx,
  type VoiceEvent,
  type VoiceEffect
} from "../fittings/seed/web-channel-default/ui/voice-machine";

// S6b / #28 - unit tests for the pure conversation-mode voice state machine.
// The reducer is pure (ctx, event) -> (nextCtx, effects), so every gating
// behaviour (silence-sends, barge-in, re-arm, PTT) is testable in node with no
// mocking. Helper: drive a sequence of events from a starting ctx.

function drive(start: VoiceCtx, events: VoiceEvent[]): { ctx: VoiceCtx; effects: VoiceEffect[] } {
  let ctx = start;
  let effects: VoiceEffect[] = [];
  for (const ev of events) {
    const r = voiceReduce(ctx, ev);
    ctx = r.ctx;
    effects = r.effects;
  }
  return { ctx, effects };
}

const effectTypes = (effects: VoiceEffect[]) => effects.map((e) => e.type);

describe("transcript helpers", () => {
  it("joins finals + interim, trimming and dropping blanks", () => {
    const ctx = { ...initialCtx(), finals: ["hello ", ""], interim: " world " };
    expect(transcriptOf(ctx)).toBe("hello world");
  });

  it("isMeaningfulTranscript drops sub-word / punctuation-only noise", () => {
    expect(isMeaningfulTranscript("")).toBe(false);
    expect(isMeaningfulTranscript("  ")).toBe(false);
    expect(isMeaningfulTranscript(".")).toBe(false);
    expect(isMeaningfulTranscript("a")).toBe(false); // < 2 letters/digits
    expect(isMeaningfulTranscript("ok")).toBe(true);
    expect(isMeaningfulTranscript("hey gary")).toBe(true);
  });
});

describe("start / capture gating", () => {
  it("START_CONVERSATION from idle enters listening/conversation and opens capture", () => {
    const { ctx, effects } = voiceReduce(initialCtx(), { type: "START_CONVERSATION" });
    expect(ctx.state).toBe("listening");
    expect(ctx.mode).toBe("conversation");
    expect(effectTypes(effects)).toEqual(["open-capture"]);
  });

  it("START_CONVERSATION is ignored when not idle (no double-open)", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const { ctx, effects } = voiceReduce(listening, { type: "START_CONVERSATION" });
    expect(ctx).toBe(listening);
    expect(effects).toEqual([]);
  });

  it("START_PTT enters listening/ptt with pttHeld and opens capture", () => {
    const { ctx, effects } = voiceReduce(initialCtx(), { type: "START_PTT" });
    expect(ctx.state).toBe("listening");
    expect(ctx.mode).toBe("ptt");
    expect(ctx.pttHeld).toBe(true);
    expect(effectTypes(effects)).toEqual(["open-capture"]);
  });
});

describe("PTT release", () => {
  it("RELEASE_PTT sends a meaningful transcript, closes capture, returns to idle", () => {
    const held = voiceReduce(initialCtx(), { type: "START_PTT" }).ctx;
    const withText = voiceReduce(held, { type: "FINAL", text: "open the vault" }).ctx;
    const { ctx, effects } = voiceReduce(withText, { type: "RELEASE_PTT" });
    expect(ctx.state).toBe("idle");
    expect(ctx.lastSent).toBe("open the vault");
    expect(effectTypes(effects)).toEqual(["close-capture", "send"]);
    const send = effects.find((e) => e.type === "send");
    expect(send && send.type === "send" && send.text).toBe("open the vault");
  });

  it("RELEASE_PTT with no meaningful transcript closes capture but does NOT send", () => {
    const held = voiceReduce(initialCtx(), { type: "START_PTT" }).ctx;
    const { ctx, effects } = voiceReduce(held, { type: "RELEASE_PTT" });
    expect(ctx.state).toBe("idle");
    expect(effectTypes(effects)).toEqual(["close-capture"]);
  });

  it("RELEASE_PTT is ignored outside ptt mode", () => {
    const conv = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const { ctx, effects } = voiceReduce(conv, { type: "RELEASE_PTT" });
    expect(ctx).toBe(conv);
    expect(effects).toEqual([]);
  });
});

describe("conversation: silence sends", () => {
  it("UTTERANCE_END with meaningful transcript moves listening -> sending and emits send", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const withInterim = voiceReduce(listening, { type: "INTERIM", text: "what is the weather" }).ctx;
    const { ctx, effects } = voiceReduce(withInterim, { type: "UTTERANCE_END" });
    expect(ctx.state).toBe("sending");
    expect(ctx.lastSent).toBe("what is the weather");
    // utterance buffer is cleared on send
    expect(ctx.interim).toBe("");
    expect(ctx.finals).toEqual([]);
    expect(effectTypes(effects)).toEqual(["send"]);
  });

  it("UTTERANCE_END prefers the event transcript when provided", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const { ctx, effects } = voiceReduce(listening, { type: "UTTERANCE_END", transcript: "explicit text" });
    expect(ctx.state).toBe("sending");
    const send = effects[0];
    expect(send.type === "send" && send.text).toBe("explicit text");
  });

  it("UTTERANCE_END with only noise drops it and keeps listening (no send)", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const noisy = voiceReduce(listening, { type: "INTERIM", text: "." }).ctx;
    const { ctx, effects } = voiceReduce(noisy, { type: "UTTERANCE_END" });
    expect(ctx.state).toBe("listening");
    expect(effects).toEqual([]);
  });

  it("UTTERANCE_END is a no-op in PTT mode", () => {
    const held = voiceReduce(initialCtx(), { type: "START_PTT" }).ctx;
    const { ctx, effects } = voiceReduce(held, { type: "UTTERANCE_END", transcript: "hi there" });
    expect(ctx.state).toBe("listening"); // unchanged; ptt sends on release only
    expect(effects).toEqual([]);
  });
});

describe("conversation: reply is read aloud, then re-arms", () => {
  it("REPLY_READY while sending -> speaking + start-tts, TTS_DONE re-arms to listening", () => {
    let ctx = drive(initialCtx(), [
      { type: "START_CONVERSATION" },
      { type: "INTERIM", text: "hello" },
      { type: "UTTERANCE_END" }
    ]).ctx;
    expect(ctx.state).toBe("sending");
    const replied = voiceReduce(ctx, { type: "REPLY_READY", text: "Hi, how can I help?" });
    expect(replied.ctx.state).toBe("speaking");
    expect(replied.ctx.ttsActive).toBe(true);
    expect(effectTypes(replied.effects)).toEqual(["start-tts"]);
    const done = voiceReduce(replied.ctx, { type: "TTS_DONE" });
    expect(done.ctx.state).toBe("listening"); // re-armed, capture never closed
    expect(done.ctx.ttsActive).toBe(false);
    expect(done.effects).toEqual([]);
  });

  it("REPLY_READY with empty text re-arms without speaking", () => {
    const sending = drive(initialCtx(), [
      { type: "START_CONVERSATION" },
      { type: "UTTERANCE_END", transcript: "hello there" }
    ]).ctx;
    const { ctx, effects } = voiceReduce(sending, { type: "REPLY_READY", text: "   " });
    expect(ctx.state).toBe("listening");
    expect(effects).toEqual([]);
  });

  it("REPLY_READY is ignored outside conversation/sending (never talks over the user)", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const { ctx, effects } = voiceReduce(listening, { type: "REPLY_READY", text: "unsolicited" });
    expect(ctx).toBe(listening);
    expect(effects).toEqual([]);
  });
});

describe("conversation: barge-in", () => {
  function toSpeaking(): VoiceCtx {
    return drive(initialCtx(), [
      { type: "START_CONVERSATION" },
      { type: "UTTERANCE_END", transcript: "first question" },
      { type: "REPLY_READY", text: "here is a long spoken answer" }
    ]).ctx;
  }

  it("SPEECH_STARTED while speaking stops TTS and returns to listening", () => {
    const speaking = toSpeaking();
    expect(speaking.state).toBe("speaking");
    const { ctx, effects } = voiceReduce(speaking, { type: "SPEECH_STARTED" });
    expect(ctx.state).toBe("listening");
    expect(ctx.ttsActive).toBe(false);
    expect(effectTypes(effects)).toEqual(["stop-tts"]);
  });

  it("meaningful INTERIM while speaking barges in (stop-tts, listen, seed interim)", () => {
    const { ctx, effects } = voiceReduce(toSpeaking(), { type: "INTERIM", text: "actually wait" });
    expect(ctx.state).toBe("listening");
    expect(ctx.interim).toBe("actually wait");
    expect(ctx.ttsActive).toBe(false);
    expect(effectTypes(effects)).toEqual(["stop-tts"]);
  });

  it("meaningful FINAL while speaking barges in and seeds the new utterance", () => {
    const { ctx, effects } = voiceReduce(toSpeaking(), { type: "FINAL", text: "stop please" });
    expect(ctx.state).toBe("listening");
    expect(ctx.finals).toEqual(["stop please"]);
    expect(effectTypes(effects)).toEqual(["stop-tts"]);
  });

  it("sub-meaningful INTERIM while speaking does NOT barge in (TTS bleed guard)", () => {
    const speaking = toSpeaking();
    const { ctx, effects } = voiceReduce(speaking, { type: "INTERIM", text: "a" });
    expect(ctx.state).toBe("speaking");
    expect(effects).toEqual([]);
  });
});

describe("stop / error teardown", () => {
  it("STOP from a live state closes capture and returns to idle", () => {
    const listening = voiceReduce(initialCtx(), { type: "START_CONVERSATION" }).ctx;
    const { ctx, effects } = voiceReduce(listening, { type: "STOP" });
    expect(ctx.state).toBe("idle");
    expect(effectTypes(effects)).toEqual(["close-capture"]);
  });

  it("ERROR while TTS is active also stops TTS before closing", () => {
    const speaking = drive(initialCtx(), [
      { type: "START_CONVERSATION" },
      { type: "UTTERANCE_END", transcript: "a question" },
      { type: "REPLY_READY", text: "an answer" }
    ]).ctx;
    const { ctx, effects } = voiceReduce(speaking, { type: "ERROR", error: "socket" });
    expect(ctx.state).toBe("idle");
    expect(effectTypes(effects)).toEqual(["stop-tts", "close-capture"]);
  });

  it("STOP while already idle is a no-op", () => {
    const { ctx, effects } = voiceReduce(initialCtx(), { type: "STOP" });
    expect(ctx.state).toBe("idle");
    expect(effects).toEqual([]);
  });
});

describe("full conversation turn", () => {
  it("drives idle -> listening -> sending -> speaking -> listening across one turn", () => {
    const seq: Array<{ ev: VoiceEvent; state: VoiceCtx["state"] }> = [
      { ev: { type: "START_CONVERSATION" }, state: "listening" },
      { ev: { type: "INTERIM", text: "tell me a joke" }, state: "listening" },
      { ev: { type: "UTTERANCE_END" }, state: "sending" },
      { ev: { type: "REPLY_READY", text: "Why did the chicken..." }, state: "speaking" },
      { ev: { type: "TTS_DONE" }, state: "listening" }
    ];
    let ctx = initialCtx();
    for (const step of seq) {
      ctx = voiceReduce(ctx, step.ev).ctx;
      expect(ctx.state).toBe(step.state);
    }
    // Capture was opened once and never closed across the turn (re-armed).
    expect(ctx.mode).toBe("conversation");
  });
});
