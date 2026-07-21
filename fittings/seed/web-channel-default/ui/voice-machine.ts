// Conversation-mode voice state machine (S6b, D20).
//
// A PURE reducer: no DOM, no timers, no browser APIs — every side effect the
// machine wants performed is returned as a declarative `VoiceEffect` for the host
// component (voice-conversation.tsx) to run. That split is what makes the gating
// behaviour (silence-sends, barge-in, re-arm) unit-testable in a Node vitest run
// with zero mocking (tests/voice-machine.test.ts).
//
// Two capture modes share one AudioWorklet capture path (voice-capture.ts):
//   • conversation — hands-free: press once → listen; SILENCE (Deepgram
//     utterance_end) SENDS the utterance; the reply is ALWAYS read aloud (streaming
//     TTS); speaking while the reply plays BARGES IN (stops TTS, re-listens); on
//     TTS end it re-arms. Capture stays open for the whole session so barge-in is
//     detectable.
//   • ptt — push-to-talk: hold to talk, release to send, then idle.
//
// State chart (conversation):
//   idle --START_CONVERSATION--> listening --UTTERANCE_END(meaningful)--> sending
//   sending --REPLY_READY(text)--> speaking --TTS_DONE--> listening   (re-arm)
//   speaking --SPEECH_STARTED/INTERIM(barge-in)--> listening          (stop TTS)
//   any --STOP/ERROR--> idle

export type VoiceState = "idle" | "listening" | "sending" | "speaking";
export type VoiceMode = "conversation" | "ptt";

export interface VoiceCtx {
  state: VoiceState;
  /** Active capture mode while not idle; null when idle. */
  mode: VoiceMode | null;
  /** Current interim (not-yet-final) transcript fragment. */
  interim: string;
  /** Finalized transcript segments accumulated for the current utterance. */
  finals: string[];
  /** True while streaming TTS playback is in progress. */
  ttsActive: boolean;
  /** True while the PTT button is physically held. */
  pttHeld: boolean;
  /** The last utterance text handed to the chat (debug/introspection). */
  lastSent: string | null;
}

export type VoiceEvent =
  | { type: "START_CONVERSATION" }
  | { type: "START_PTT" }
  | { type: "RELEASE_PTT" }
  | { type: "STREAM_READY" }
  | { type: "INTERIM"; text: string }
  | { type: "FINAL"; text: string }
  | { type: "UTTERANCE_END"; transcript?: string }
  | { type: "SPEECH_STARTED" }
  | { type: "REPLY_READY"; text: string }
  | { type: "TTS_FIRST_AUDIO" }
  | { type: "TTS_DONE" }
  | { type: "STOP" }
  | { type: "ERROR"; error?: string };

export type VoiceEffect =
  | { type: "open-capture" }
  | { type: "close-capture" }
  | { type: "send"; text: string }
  | { type: "start-tts"; text: string }
  | { type: "stop-tts" };

export interface Reduced {
  ctx: VoiceCtx;
  effects: VoiceEffect[];
}

export function initialCtx(): VoiceCtx {
  return { state: "idle", mode: null, interim: "", finals: [], ttsActive: false, pttHeld: false, lastSent: null };
}

/** The display transcript = finalized segments followed by the live interim. */
export function transcriptOf(ctx: VoiceCtx): string {
  return [...ctx.finals, ctx.interim]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/** Loop-safety gate: the mic opening into ambient noise / TTS bleed produces
 *  empty or sub-word transcripts. Anything with fewer than 2 letters/digits is
 *  dropped so it never auto-sends and starts a self-talk loop. */
export function isMeaningfulTranscript(text: string): boolean {
  const clean = (text || "").trim();
  return clean.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2;
}

function resetUtterance(ctx: VoiceCtx): Pick<VoiceCtx, "interim" | "finals"> {
  return { interim: "", finals: [] };
}

/** The whole machine. Pure: (ctx, event) → (nextCtx, effects). */
export function voiceReduce(ctx: VoiceCtx, ev: VoiceEvent): Reduced {
  switch (ev.type) {
    case "START_CONVERSATION": {
      if (ctx.state !== "idle") return { ctx, effects: [] };
      return {
        ctx: { ...initialCtx(), state: "listening", mode: "conversation" },
        effects: [{ type: "open-capture" }],
      };
    }

    case "START_PTT": {
      if (ctx.state !== "idle") return { ctx, effects: [] };
      return {
        ctx: { ...initialCtx(), state: "listening", mode: "ptt", pttHeld: true },
        effects: [{ type: "open-capture" }],
      };
    }

    case "RELEASE_PTT": {
      if (ctx.mode !== "ptt") return { ctx, effects: [] };
      const text = transcriptOf(ctx);
      const effects: VoiceEffect[] = [{ type: "close-capture" }];
      let lastSent = ctx.lastSent;
      if (isMeaningfulTranscript(text)) {
        effects.push({ type: "send", text });
        lastSent = text;
      }
      return { ctx: { ...initialCtx(), lastSent }, effects };
    }

    case "STREAM_READY":
      return { ctx, effects: [] };

    case "INTERIM": {
      if (ctx.state === "idle") return { ctx, effects: [] };
      // Barge-in: the user speaks while the reply is being read aloud → cut the
      // TTS and start a fresh utterance.
      if (ctx.state === "speaking" && isMeaningfulTranscript(ev.text)) {
        return {
          ctx: { ...ctx, state: "listening", ttsActive: false, ...resetUtterance(ctx), interim: ev.text },
          effects: [{ type: "stop-tts" }],
        };
      }
      return { ctx: { ...ctx, interim: ev.text }, effects: [] };
    }

    case "FINAL": {
      if (ctx.state === "idle") return { ctx, effects: [] };
      if (ctx.state === "speaking" && isMeaningfulTranscript(ev.text)) {
        return {
          ctx: { ...ctx, state: "listening", ttsActive: false, interim: "", finals: [ev.text] },
          effects: [{ type: "stop-tts" }],
        };
      }
      const finals = ev.text.trim() ? [...ctx.finals, ev.text] : ctx.finals;
      return { ctx: { ...ctx, finals, interim: "" }, effects: [] };
    }

    case "SPEECH_STARTED": {
      // Deepgram VAD onset. The barge-in trigger when a reply is playing.
      if (ctx.state === "speaking") {
        return {
          ctx: { ...ctx, state: "listening", ttsActive: false, ...resetUtterance(ctx) },
          effects: [{ type: "stop-tts" }],
        };
      }
      return { ctx, effects: [] };
    }

    case "UTTERANCE_END": {
      // Silence endpoint. In conversation mode this is the auto-send trigger.
      if (ctx.mode !== "conversation") return { ctx, effects: [] };
      if (ctx.state !== "listening") return { ctx, effects: [] };
      const text = (ev.transcript && ev.transcript.trim()) || transcriptOf(ctx);
      if (!isMeaningfulTranscript(text)) {
        // Nothing meaningful heard — drop it and keep listening (no send).
        return { ctx: { ...ctx, ...resetUtterance(ctx) }, effects: [] };
      }
      return {
        ctx: { ...ctx, state: "sending", ...resetUtterance(ctx), lastSent: text },
        effects: [{ type: "send", text }],
      };
    }

    case "REPLY_READY": {
      // Only speak in conversation mode, and only while we were awaiting a reply.
      // If the user has already barged back to listening (or this is a PTT/typed
      // turn) we do NOT talk over them.
      if (ctx.mode !== "conversation" || ctx.state !== "sending") return { ctx, effects: [] };
      const text = (ev.text || "").trim();
      if (!text) {
        // Empty reply — nothing to read; re-arm the mic.
        return { ctx: { ...ctx, state: "listening" }, effects: [] };
      }
      return { ctx: { ...ctx, state: "speaking", ttsActive: true }, effects: [{ type: "start-tts", text }] };
    }

    case "TTS_FIRST_AUDIO":
      // Latency instrumentation observes this in the host; no state change.
      return { ctx, effects: [] };

    case "TTS_DONE": {
      if (ctx.state !== "speaking") return { ctx: { ...ctx, ttsActive: false }, effects: [] };
      // Conversation: re-arm and keep listening. (Capture never closed.)
      return { ctx: { ...ctx, state: "listening", ttsActive: false }, effects: [] };
    }

    case "STOP":
    case "ERROR": {
      if (ctx.state === "idle") return { ctx, effects: [] };
      const effects: VoiceEffect[] = [];
      if (ctx.ttsActive) effects.push({ type: "stop-tts" });
      effects.push({ type: "close-capture" });
      return { ctx: initialCtx(), effects };
    }

    default:
      return { ctx, effects: [] };
  }
}
