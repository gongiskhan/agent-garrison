// The composer microphone (S6b, D20, D49). Rendered into ClaudeChat's
// composerAdornment slot - it does NOT rebuild the chat, it drives it.
//
// Two ways to use the mic:
//   • TAP: dictation. The mic opens at once and every utterance lands in the
//     message box as text (props.setDraft); the user edits and presses the
//     normal Send. Stop keeps what was heard, Discard removes it. Never gated
//     by a running turn or by text already in the box - the mic is a keyboard.
//   • HOLD: the voice sheet, where the hands-free conversation lives: talk,
//     pause to send, the reply is read aloud. That mode's gating logic lives in
//     the pure voice-machine reducer; this component only wires browser side
//     effects (capture, TTS, latency, DOM) to it.
// Dictation transcribes per utterance over the REST /stt lane (a segment is
// cut at each pause and posted), not as a live word stream: the capture token
// never reaches the page (D9), so there is no browser WebSocket to Deepgram.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  voiceReduce, initialCtx, transcriptOf,
  type VoiceCtx, type VoiceEvent, type VoiceEffect,
} from "./voice-machine";
import { startCapture, startTts, isCaptureSupported, captureUnsupportedReason, type CaptureHandle, type TtsHandle } from "./voice-clip";
import { LatencyTracker, type BudgetVerdict } from "./voice-latency";

// Which language the browser's clips are transcribed in (D52). The server pins
// the wake lane to Portuguese so "Zeca" is heard as a name; the typed lane is
// where the user works, and they work in English, so a Portuguese pin turned
// English dictation into near-random Portuguese words. English by default,
// switchable per browser; `multi` lets Deepgram code-switch.
export type SttLanguage = "en" | "pt" | "multi";
export const STT_LANGUAGE_KEY = "talk.stt.language";
export const STT_LANGUAGES: ReadonlyArray<{ value: SttLanguage; label: string; title: string }> = [
  { value: "en", label: "EN", title: "Transcribe as English" },
  { value: "pt", label: "PT", title: "Transcrever como Português" },
  { value: "multi", label: "Auto", title: "Let the transcriber pick the language per sentence" }
];
export function readSttLanguage(): SttLanguage {
  try {
    const v = window.localStorage.getItem(STT_LANGUAGE_KEY);
    if (v === "en" || v === "pt" || v === "multi") return v;
  } catch {}
  return "en";
}
function writeSttLanguage(v: SttLanguage) {
  try { window.localStorage.setItem(STT_LANGUAGE_KEY, v); } catch {}
}

export interface VoiceConversationProps {
  /** Submit a transcribed utterance as a real chat turn (renders + streams). */
  send: (text: string) => string | null;
  /** True while a chat turn is in flight (mirrors ClaudeChat busy). */
  busy: boolean;
  /** Prevent a new voice turn while generated text work is active or queued. */
  queueLocked: boolean;
  /** Latest SETTLED assistant reply; changes id once per completed turn. */
  lastReply: { id: string; text: string; clientRequestId?: string } | null;
  /** The composer text, for dictation to append to. Absent = no dictation
   *  (the mic then only opens the voice sheet). */
  draft?: string;
  setDraft?: (next: string | ((prev: string) => string)) => void;
  focusComposer?: () => void;
  // ── test overrides ──
  sttUrl?: string;
  ttsUrl?: string;
  /** Skip the /api/voice/health probe and assume available (tests). */
  assumeAvailable?: boolean;
}

interface VoiceHealth { available: boolean; keyConfigured?: boolean; tts?: boolean; maxTextChars?: number | null; reason?: string }

// The operator-facing line for a mic that is off. The router's reasons
// (VOICE_* in packages/talk/src/router.mjs) are short lower-case phrases meant
// to be shown verbatim; this maps the ones with an obvious next step to that
// step and passes the rest through.
function unavailableReason(reason: string | undefined): string {
  switch (reason) {
    case "no voice provider": return "Voice unavailable: no voice fitting in this composition";
    case "voice provider not running": return "Voice provider not running";
    case "voice locked": return "Voice unavailable: unlock the vault";
    case "capture token not sealed": return "Voice unavailable: seal CAPTURE_TOKEN in the vault";
    case "capture token not granted to this node": return "Voice unavailable: grant CAPTURE_TOKEN to this node";
    case "secret authority unreachable": return "Voice unavailable: the node's secret authority is unreachable";
    case "voice rest disabled": return "Voice unavailable: the voice provider's capture ingress is off";
    case "voice unreachable": return "Voice provider unreachable";
    default: return reason ? `Voice unavailable: ${reason}` : "Voice unavailable: the provider has no transcriber";
  }
}

// If a voice send produces no settled reply within this window, recover the
// state machine rather than deadlock in `sending` (codex S6b finding).
const SENDING_TIMEOUT_MS = 30000;

/** How long the mic must be held before the press counts as a HOLD (the voice
 *  sheet). Below this a press is a TAP and starts dictation. Comfortably shorter
 *  than any deliberate hold, long enough that a tap never opens the sheet. */
const HOLD_MS = 320;

/** After Stop, the last cut segment is still being transcribed; the capture is
 *  torn down this long after its transcript lands, or after DICTATION_FINISH_GUARD_MS
 *  if it never does. */
const DICTATION_SETTLE_MS = 350;
const DICTATION_FINISH_GUARD_MS = 8000;

/** Append a dictated utterance to the draft: one space between words, nothing
 *  else invented. */
export function joinDictation(prev: string, text: string): string {
  const t = text.trim();
  if (!t) return prev;
  if (!prev) return t;
  return /\s$/.test(prev) ? prev + t : `${prev} ${t}`;
}

/** Remove what a dictation put into the draft. The common case is the exact
 *  base plus the segments, restored to the base; when the user edited around
 *  the dictated text meanwhile, each segment still present is taken out. */
export function stripDictation(current: string, base: string, segments: string[]): string {
  if (segments.length === 0) return current;
  const expected = segments.reduce((acc, seg) => joinDictation(acc, seg), base);
  if (current === expected) return base;
  let out = current;
  for (const seg of segments) {
    const at = out.indexOf(seg);
    if (at < 0) continue;
    const before = out.slice(0, at);
    const after = out.slice(at + seg.length);
    out = /\s$/.test(before) && /^\s/.test(after) ? before + after.replace(/^\s/, "") : before + after;
  }
  return out;
}

/** The voice modes, on demand. Mirrors the shared chat's route sheet: one group
 *  of controls, opened by the control it belongs to, instead of a second button
 *  parked in the composer forever. */
function VoiceSheet({
  conversationOn,
  disabled,
  reason,
  onToggleConversation,
  onClose,
}: {
  conversationOn: boolean;
  disabled: boolean;
  reason: string;
  onToggleConversation: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const onCancel = (event: Event) => { event.preventDefault(); onClose(); };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      className="cc-sheet"
      aria-label="Voice"
      data-testid="wcv-sheet"
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <div className="cc-sheet-card">
        <div className="cc-sheet-head">
          <h2 className="cc-sheet-title">Voice</h2>
          <button type="button" className="cc-sheet-close" onClick={onClose} aria-label="Close voice sheet">×</button>
        </div>
        <p className="cc-sheet-sub">Tap the mic to dictate into the message box. Or hand the conversation over:</p>
        <div className="cc-sheet-body">
          <button
            type="button"
            className={`wcv-convo${conversationOn ? " wcv-on" : ""}`}
            data-testid="wcv-convo"
            aria-pressed={conversationOn}
            disabled={disabled}
            title={reason || (conversationOn ? "Stop conversation" : "Hands-free conversation: talk, pause to send, reply is read aloud")}
            onClick={onToggleConversation}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3h10v7H6l-3 2.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M6 6h4M6 8h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span className="wcv-convo-label">{conversationOn ? "Stop hands-free conversation" : "Start hands-free conversation"}</span>
          </button>
          {reason && <p className="cc-sheet-sub">{reason}</p>}
        </div>
      </div>
    </dialog>
  );
}

export function VoiceConversation(props: VoiceConversationProps) {
  const supported = useMemo(() => isCaptureSupported(), []);
  const [ctx, setCtx] = useState<VoiceCtx>(() => initialCtx());
  const [available, setAvailable] = useState<boolean>(Boolean(props.assumeAvailable));
  // Read-aloud is a second gate: the mic needs a transcriber (`available`), the
  // hands-free conversation also needs a synthesiser (`tts` on the health
  // block). Push-to-talk stays usable when only the transcriber is there.
  const [ttsAvailable, setTtsAvailable] = useState<boolean>(Boolean(props.assumeAvailable));
  // Why the mic is off, in the router's words (see unavailableReason).
  const [healthReason, setHealthReason] = useState<string | undefined>(undefined);
  // The /tts per-request budget the provider advertised; startTts falls back
  // to its own default when the probe named none.
  const chunkCharsRef = useRef<number | undefined>(undefined);
  const [level, setLevel] = useState(0);
  const [latency, setLatency] = useState<BudgetVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sttLanguage, setSttLanguageState] = useState<SttLanguage>(() =>
    typeof window === "undefined" ? "en" : readSttLanguage()
  );
  // Consulted per clip by startCapture, so a switch mid-dictation reaches the
  // next segment without reopening the microphone.
  const sttLanguageRef = useRef<SttLanguage>(sttLanguage);
  sttLanguageRef.current = sttLanguage;
  const setSttLanguage = useCallback((v: SttLanguage) => {
    setSttLanguageState(v);
    writeSttLanguage(v);
  }, []);
  /** Hands-free is reached by TAPPING the mic; holding it is push-to-talk. */
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  const holdTimer = useRef<number | null>(null);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const queueLockedRef = useRef(props.queueLocked);
  queueLockedRef.current = props.queueLocked;
  const captureRef = useRef<CaptureHandle | null>(null);
  const ttsRef = useRef<TtsHandle | null>(null);
  const latencyRef = useRef(new LatencyTracker());
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const awaitingReplyRef = useRef<string | true | null>(null);
  const sendTimeoutRef = useRef<number | null>(null);
  const consumedReplyIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const runEffectRef = useRef<(eff: VoiceEffect) => void>(() => {});

  const dispatch = useCallback((ev: VoiceEvent) => {
    const current = ctxRef.current;
    let { ctx: next, effects } = voiceReduce(current, ev);
    // A voice reply may finish while a typed turn is already running behind it.
    // Conversation mode normally re-arms the microphone after TTS (or an empty
    // reply), but that would create a second identity-free voice turn and let the
    // typed reply be mistaken for its answer. Finish the current read/await cycle,
    // then close capture until the durable text queue is empty.
    if (
      queueLockedRef.current &&
      current.mode === "conversation" &&
      current.state !== "listening" &&
      next.state === "listening"
    ) {
      const stopped = voiceReduce(next, { type: "STOP" });
      next = stopped.ctx;
      effects = [...effects, ...stopped.effects];
    }
    ctxRef.current = next;
    setCtx(next);
    for (const eff of effects) runEffectRef.current(eff);
  }, []);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // ── /api/voice/health probe (unless a test forces availability) ──
  useEffect(() => {
    if (props.assumeAvailable) { setAvailable(true); setTtsAvailable(true); return; }
    let cancelled = false;
    const probe = () => {
      fetch("/api/voice/health")
        .then((r) => (r.ok ? r.json() : { available: false }))
        .then((h: VoiceHealth) => {
          if (cancelled) return;
          const mic = Boolean(h.available) && h.keyConfigured !== false;
          setAvailable(mic);
          setTtsAvailable(mic && h.tts === true);
          setHealthReason(mic ? undefined : h.reason);
          chunkCharsRef.current = typeof h.maxTextChars === "number" && h.maxTextChars > 0 ? h.maxTextChars : undefined;
        })
        .catch(() => { if (!cancelled) { setAvailable(false); setTtsAvailable(false); setHealthReason("voice unreachable"); } });
    };
    probe();
    const id = window.setInterval(probe, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [props.assumeAvailable]);

  // Unlock a playback AudioContext inside the START gesture so read-aloud can
  // auto-play the reply later on mobile (autoplay policy).
  const ensurePlaybackCtx = useCallback(() => {
    if (playbackCtxRef.current) { try { void playbackCtxRef.current.resume(); } catch {} return; }
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (typeof AC !== "function") return;
    try {
      const c: AudioContext = new AC();
      void c.resume();
      playbackCtxRef.current = c;
    } catch {}
  }, []);

  const stopPlayback = useCallback(() => {
    if (ttsRef.current) { ttsRef.current.stop(); ttsRef.current = null; }
  }, []);

  const startPlayback = useCallback((text: string) => {
    stopPlayback();
    ensurePlaybackCtx();
    ttsRef.current = startTts(
      text,
      {
        onFirstAudio: () => {
          latencyRef.current.mark("tts_first_audio");
          if (mountedRef.current) setLatency(latencyRef.current.budget());
        },
        onDone: () => dispatchRef.current({ type: "TTS_DONE" }),
        onError: (e) => { if (mountedRef.current) setError(e); dispatchRef.current({ type: "TTS_DONE" }); },
      },
      { ttsUrl: props.ttsUrl, audioContext: playbackCtxRef.current ?? undefined, chunkChars: chunkCharsRef.current },
    );
  }, [stopPlayback, ensurePlaybackCtx, props.ttsUrl]);

  const closeCapture = useCallback(() => {
    if (captureRef.current) { captureRef.current.stop(); captureRef.current = null; }
    setLevel(0);
  }, []);

  const finishCapture = useCallback(() => {
    captureRef.current?.finish();
    setLevel(0);
  }, []);

  const openCapture = useCallback(async () => {
    if (captureRef.current) return;
    if (!supported) { setError(captureUnsupportedReason()); dispatchRef.current({ type: "ERROR" }); return; }
    ensurePlaybackCtx();
    const mode = ctxRef.current.mode ?? "conversation";
    try {
      const handle = await startCapture(
        {
          onReady: () => dispatchRef.current({ type: "STREAM_READY" }),
          onSpeechStarted: () => dispatchRef.current({ type: "SPEECH_STARTED" }),
          onInterim: (t) => dispatchRef.current({ type: "INTERIM", text: t }),
          onFinal: (t) => dispatchRef.current({ type: "FINAL", text: t }),
          onUtteranceEnd: (t) => {
            // Start a fresh latency cycle at end-of-speech.
            latencyRef.current.reset();
            latencyRef.current.mark("utterance_end");
            dispatchRef.current({ type: "UTTERANCE_END", transcript: t });
          },
          onLevel: (l) => { if (mountedRef.current) setLevel(l); },
          onError: (e) => { if (mountedRef.current) setError(e); dispatchRef.current({ type: "ERROR", error: e }); },
        },
        { sttUrl: props.sttUrl, mode, language: () => sttLanguageRef.current },
      );
      if (!mountedRef.current || ctxRef.current.state === "idle") { handle.stop(); return; }
      captureRef.current = handle;
      // Push-to-talk released before the mic even opened: finish at once so
      // the (empty) clip still produces the UTTERANCE_END the machine awaits.
      if (mode === "ptt" && !ctxRef.current.pttHeld) handle.finish();
    } catch (e: any) {
      if (mountedRef.current) setError(e?.message || "microphone error");
      dispatchRef.current({ type: "ERROR" });
    }
  }, [supported, ensurePlaybackCtx, props.sttUrl]);

  // Effect interpreter - reassigned each render so it closes over current props.
  runEffectRef.current = (eff: VoiceEffect) => {
    switch (eff.type) {
      case "open-capture":
        void openCapture();
        break;
      case "close-capture":
        closeCapture();
        break;
      case "finish-capture":
        finishCapture();
        break;
      case "send":
        latencyRef.current.mark("send");
        setError(null);
        awaitingReplyRef.current = props.send(eff.text) ?? true;
        // Deadlock guard (codex S6b finding): the chat only feeds a NEW settled
        // lastReply for non-empty assistant text, so a voice turn whose reply is
        // empty/missing would leave the machine stuck in `sending` forever. Arm a
        // timeout that, if no reply settles, dispatches an empty REPLY_READY —
        // which the machine handles by re-arming the mic (→ listening). Cleared
        // when a real reply lands or the machine leaves `sending`.
        if (sendTimeoutRef.current) window.clearTimeout(sendTimeoutRef.current);
        sendTimeoutRef.current = window.setTimeout(() => {
          if (awaitingReplyRef.current !== null && ctxRef.current.state === "sending") {
            awaitingReplyRef.current = null;
            dispatchRef.current({ type: "REPLY_READY", text: "" });
          }
        }, SENDING_TIMEOUT_MS);
        break;
      case "start-tts":
        startPlayback(eff.text);
        break;
      case "stop-tts":
        stopPlayback();
        break;
    }
  };

  // Reply correlation: when a NEW reply settles and we're awaiting one from a
  // voice send, feed it to the machine (→ read aloud). The first run consumes the
  // pre-existing reply id without speaking (awaiting is false), so opening the
  // controls never re-reads an old message.
  useEffect(() => {
    const r = props.lastReply;
    if (!r) return;
    if (r.id === consumedReplyIdRef.current) return;
    const awaiting = awaitingReplyRef.current;
    if (awaiting === null) {
      consumedReplyIdRef.current = r.id;
      return;
    }
    if (typeof awaiting === "string" && r.clientRequestId !== awaiting) return;
    consumedReplyIdRef.current = r.id;
    awaitingReplyRef.current = null;
    if (sendTimeoutRef.current) { window.clearTimeout(sendTimeoutRef.current); sendTimeoutRef.current = null; }
    latencyRef.current.mark("reply_ready");
    dispatchRef.current({ type: "REPLY_READY", text: r.text });
  }, [props.lastReply?.id, props.lastReply?.text]);

  // Primary deadlock recovery (s6b-review): the chat's `busy` flag goes false
  // when a turn settles. If it settles while we're still awaiting a reply that
  // never produced non-empty assistant text (a tool-only/errored/empty turn),
  // re-arm IMMEDIATELY rather than waiting out the 30s backstop timeout — feed
  // the machine an empty REPLY_READY (→ listening). A turn that DID produce text
  // clears awaitingReplyRef via the lastReply correlation before busy falls.
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const settled = prevBusyRef.current && !props.busy;
    prevBusyRef.current = props.busy;
    if (settled && awaitingReplyRef.current !== null && ctxRef.current.state === "sending") {
      awaitingReplyRef.current = null;
      if (sendTimeoutRef.current) { window.clearTimeout(sendTimeoutRef.current); sendTimeoutRef.current = null; }
      dispatchRef.current({ type: "REPLY_READY", text: "" });
    }
  }, [props.busy]);

  // Release the playback AudioContext when the machine returns to idle (STOP) —
  // not only on unmount (codex S6b finding: STOP left the context open, holding
  // the mobile audio session across a start→stop→start cycle). ensurePlaybackCtx
  // recreates it on the next start.
  useEffect(() => {
    if (ctx.state !== "idle") return;
    if (sendTimeoutRef.current) { window.clearTimeout(sendTimeoutRef.current); sendTimeoutRef.current = null; }
    awaitingReplyRef.current = null;
    if (playbackCtxRef.current) {
      try { void playbackCtxRef.current.close(); } catch {}
      playbackCtxRef.current = null;
    }
  }, [ctx.state]);

  // If text work is admitted while hands-free capture is merely listening,
  // close it immediately. Sending/speaking states are deliberately allowed to
  // finish so the already-submitted voice turn can still be awaited and read.
  useEffect(() => {
    if (!props.queueLocked) return;
    if (ctxRef.current.mode === "conversation" && ctxRef.current.state === "listening") {
      dispatch({ type: "STOP" });
    }
  }, [props.queueLocked, ctx.state, ctx.mode, dispatch]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (sendTimeoutRef.current) { try { window.clearTimeout(sendTimeoutRef.current); } catch {} }
      try { captureRef.current?.stop(); } catch {}
      try { ttsRef.current?.stop(); } catch {}
      if (playbackCtxRef.current) { try { void playbackCtxRef.current.close(); } catch {} }
    };
  }, []);

  // ── Controls ──
  const usable = supported && available;
  // Hands-free reads every reply aloud, so it needs the synthesiser too.
  const conversationUsable = usable && ttsAvailable;
  const disabledReason = !supported
    ? captureUnsupportedReason()
    : !available
      ? unavailableReason(healthReason)
      : "";
  const noTtsReason = "Read-aloud unavailable: the voice provider has no speech backend";
  const queueLockedReason = "Wait for pending messages to finish before starting voice";

  const onToggleConversation = useCallback(() => {
    if (!conversationUsable) return;
    if (ctxRef.current.mode === "conversation") {
      dispatch({ type: "STOP" });
    } else if (!props.queueLocked && ctxRef.current.state === "idle") {
      setError(null);
      setLatency(null);
      latencyRef.current.reset();
      dispatch({ type: "START_CONVERSATION" });
    }
  }, [conversationUsable, props.queueLocked, dispatch]);

  // ── Dictation ──
  // Its own small state, apart from the hands-free machine: nothing here is
  // sent or read aloud, the transcript goes straight into the composer.
  type DictationPhase = "idle" | "opening" | "live" | "finishing";
  const [dictPhase, setDictPhase] = useState<DictationPhase>("idle");
  const [dictLevel, setDictLevel] = useState(0);
  const [dictError, setDictError] = useState<string | null>(null);
  const [dictHeard, setDictHeard] = useState(0);
  const dictRef = useRef<CaptureHandle | null>(null);
  const dictGenRef = useRef(0);
  const dictBaseRef = useRef("");
  const dictSegmentsRef = useRef<string[]>([]);
  const dictStoppingRef = useRef(false);
  const dictSettleTimer = useRef<number | null>(null);
  const dictGuardTimer = useRef<number | null>(null);
  const setDraftRef = useRef(props.setDraft);
  setDraftRef.current = props.setDraft;
  const draftRef = useRef(props.draft ?? "");
  draftRef.current = props.draft ?? "";
  const focusComposerRef = useRef(props.focusComposer);
  focusComposerRef.current = props.focusComposer;
  const dictationAvailable = usable && typeof props.setDraft === "function";

  const clearDictTimers = () => {
    if (dictSettleTimer.current) { window.clearTimeout(dictSettleTimer.current); dictSettleTimer.current = null; }
    if (dictGuardTimer.current) { window.clearTimeout(dictGuardTimer.current); dictGuardTimer.current = null; }
  };

  const teardownDictation = useCallback(() => {
    clearDictTimers();
    dictGenRef.current += 1;
    dictStoppingRef.current = false;
    if (dictRef.current) { try { dictRef.current.stop(); } catch {} dictRef.current = null; }
    if (!mountedRef.current) return;
    setDictPhase("idle");
    setDictLevel(0);
    focusComposerRef.current?.();
  }, []);

  const startDictation = useCallback(async () => {
    if (!dictationAvailable) return;
    if (dictRef.current || dictPhase !== "idle") return;
    if (!supported) { setDictError(captureUnsupportedReason()); return; }
    // The microphone is one device: hands-free lets go of it first.
    if (ctxRef.current.mode) dispatch({ type: "STOP" });
    const gen = ++dictGenRef.current;
    dictBaseRef.current = draftRef.current;
    dictSegmentsRef.current = [];
    dictStoppingRef.current = false;
    setDictError(null);
    setDictHeard(0);
    setDictPhase("opening");
    try {
      const handle = await startCapture(
        {
          onReady: () => { if (mountedRef.current && dictGenRef.current === gen) setDictPhase((p) => (p === "opening" ? "live" : p)); },
          onFinal: (t) => {
            if (dictGenRef.current !== gen) return;
            const text = t.trim();
            if (!text) return;
            dictSegmentsRef.current.push(text);
            setDraftRef.current?.((prev) => joinDictation(prev, text));
            if (mountedRef.current) setDictHeard((n) => n + 1);
          },
          onUtteranceEnd: () => {
            if (dictGenRef.current !== gen || !dictStoppingRef.current) return;
            // The segment cut by Stop has landed; give a sibling still in
            // flight a moment, then release the device.
            if (dictSettleTimer.current) window.clearTimeout(dictSettleTimer.current);
            dictSettleTimer.current = window.setTimeout(() => teardownDictation(), DICTATION_SETTLE_MS);
          },
          onLevel: (l) => { if (mountedRef.current && dictGenRef.current === gen) setDictLevel(l); },
          onError: (e) => { if (mountedRef.current && dictGenRef.current === gen) setDictError(e); },
        },
        { sttUrl: props.sttUrl, mode: "conversation", language: () => sttLanguageRef.current },
      );
      if (!mountedRef.current || dictGenRef.current !== gen) { handle.stop(); return; }
      dictRef.current = handle;
    } catch (e: any) {
      if (!mountedRef.current || dictGenRef.current !== gen) return;
      setDictError(e?.message || "microphone error");
      setDictPhase("idle");
    }
  }, [dictationAvailable, dictPhase, supported, dispatch, props.sttUrl, teardownDictation]);

  const stopDictation = useCallback(() => {
    const handle = dictRef.current;
    if (!handle) { teardownDictation(); return; }
    if (dictStoppingRef.current) return;
    dictStoppingRef.current = true;
    setDictPhase("finishing");
    setDictLevel(0);
    handle.finish();
    dictGuardTimer.current = window.setTimeout(() => teardownDictation(), DICTATION_FINISH_GUARD_MS);
  }, [teardownDictation]);

  const discardDictation = useCallback(() => {
    const base = dictBaseRef.current;
    const segments = dictSegmentsRef.current.slice();
    teardownDictation();
    if (segments.length) setDraftRef.current?.((prev) => stripDictation(prev, base, segments));
    dictSegmentsRef.current = [];
  }, [teardownDictation]);

  const dictating = dictPhase !== "idle";
  const dictErrorShown = Boolean(dictError) && !dictating;
  const conversationOn = ctx.mode === "conversation";
  const showPanel = ctx.state !== "idle" || Boolean(error);
  const finalText = ctx.finals.map((s) => s.trim()).filter(Boolean).join(" ");
  const stateLabel =
    ctx.state === "listening" ? "Listening"
      : ctx.state === "sending" ? "Sending"
        : ctx.state === "speaking" ? "Speaking"
          : "";
  const dictLabel = dictPhase === "opening" ? "Opening mic" : dictPhase === "finishing" ? "Finishing" : "Dictating";

  // TAP: dictation (or stop it, or stop the hands-free conversation when that
  // is what holds the mic). HOLD: the voice sheet.
  const onTap = useCallback(() => {
    if (dictating) { stopDictation(); return; }
    if (conversationOn) { dispatch({ type: "STOP" }); return; }
    if (dictationAvailable) { void startDictation(); return; }
    setVoiceSheetOpen(true);
  }, [dictating, conversationOn, dictationAvailable, stopDictation, startDictation, dispatch]);

  const micTitle = !usable
    ? disabledReason
    : dictating
      ? "Stop dictating (keeps the text)"
      : conversationOn
        ? "Stop the hands-free conversation"
        : dictationAvailable
          ? "Tap to dictate into the message box. Hold for hands-free conversation."
          : "Voice";

  return (
    <span className="wcv" data-testid="wcv">
      {voiceSheetOpen && (
        <VoiceSheet
          conversationOn={conversationOn}
          disabled={!conversationUsable || (props.queueLocked && !conversationOn)}
          reason={!usable ? disabledReason : !ttsAvailable ? noTtsReason : props.queueLocked ? queueLockedReason : ""}
          onToggleConversation={() => { setVoiceSheetOpen(false); if (dictating) teardownDictation(); onToggleConversation(); }}
          onClose={() => setVoiceSheetOpen(false)}
        />
      )}
      <button
        type="button"
        className={`wcv-mic${dictating ? " wcv-mic-rec" : ""}`}
        data-testid="wcv-mic"
        aria-pressed={dictating}
        aria-label={dictating ? "Stop dictating" : conversationOn ? "Stop conversation" : "Dictate"}
        // Only an unusable microphone disables the button: a running turn, a
        // locked queue or text already in the box never stop dictation.
        disabled={!usable}
        title={micTitle}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.pointerType === "mouse") return;
          e.preventDefault();
          if (holdTimer.current) window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => {
            holdTimer.current = null;
            if (!dictating) setVoiceSheetOpen(true);
          }, HOLD_MS);
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          const tapped = holdTimer.current !== null;
          if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
          if (tapped) onTap();
        }}
        onPointerLeave={() => { if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; } }}
        onPointerCancel={() => { if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; } }}
        onKeyDown={(e) => {
          if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
          e.preventDefault();
          onTap();
        }}
      >
        {dictating ? (
          <span className="wcv-mic-dot" aria-hidden="true" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" />
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        )}
        <span className="wcv-mic-label">{dictating ? "Stop" : conversationOn ? "Stop" : "Dictate"}</span>
      </button>

      {(dictating || dictErrorShown) && (
        <div className={`wcv-panel wcv-panel-dictation wcv-panel-${dictPhase}`} data-testid="wcv-dictation" role="group" aria-label="Dictation">
          <div className="wcv-panel-head">
            <span className={`wcv-dot${dictPhase === "live" ? " wcv-dot-listening" : ""}`} aria-hidden="true" />
            <span className="wcv-state" data-testid="wcv-dict-state" data-state={dictPhase}>{dictating ? dictLabel : "Dictation"}</span>
            {dictating && (
              <span className="wcv-level" aria-hidden="true"><i style={{ transform: `scaleX(${0.12 + dictLevel * 0.88})` }} /></span>
            )}
            <span className="wcv-dict-actions">
              {dictating ? (
                <>
                  <span className="wcv-dict-lang" role="radiogroup" aria-label="Transcription language" data-testid="wcv-dict-lang">
                    {STT_LANGUAGES.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={sttLanguage === opt.value}
                        className={`wcv-dict-lang-opt${sttLanguage === opt.value ? " wcv-dict-lang-on" : ""}`}
                        data-testid={`wcv-dict-lang-${opt.value}`}
                        onClick={() => setSttLanguage(opt.value)}
                        title={opt.title}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="wcv-dict-btn wcv-dict-stop"
                    data-testid="wcv-dict-stop"
                    onClick={stopDictation}
                    disabled={dictPhase === "finishing"}
                    title="Stop dictating and keep the text"
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
                    <span>Stop</span>
                  </button>
                  <button
                    type="button"
                    className="wcv-dict-btn wcv-dict-trash"
                    data-testid="wcv-dict-trash"
                    onClick={discardDictation}
                    title="Stop and remove everything dictated"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>Discard</span>
                  </button>
                </>
              ) : (
                <button type="button" className="wcv-dict-btn" onClick={() => setDictError(null)} title="Dismiss">
                  <span>Dismiss</span>
                </button>
              )}
            </span>
          </div>
          {dictError ? (
            <div className="wcv-err" data-testid="wcv-dict-error">{dictError}</div>
          ) : (
            <div className="wcv-transcript">
              <span className="wcv-hint">
                {dictPhase === "opening"
                  ? "Opening the microphone…"
                  : dictPhase === "finishing"
                    ? "Writing the last words…"
                    : dictHeard === 0
                      ? "Speak; each pause lands in the message box. Send when you are happy with it."
                      : `${dictHeard} utterance${dictHeard === 1 ? "" : "s"} in the message box. Keep talking, or Stop.`}
              </span>
            </div>
          )}
        </div>
      )}

      {showPanel && !dictating && (
        <div className={`wcv-panel wcv-panel-${ctx.state}`} data-testid="wcv-panel" role="group" aria-label="Voice conversation">
          <div className="wcv-panel-head">
            <span className={`wcv-dot wcv-dot-${ctx.state}`} aria-hidden="true" />
            <span className="wcv-state" data-testid="wcv-state" data-state={ctx.state}>{stateLabel}</span>
            {ctx.state === "listening" && (
              <span className="wcv-level" aria-hidden="true"><i style={{ transform: `scaleX(${0.12 + level * 0.88})` }} /></span>
            )}
            {latency?.ms != null && (
              <span
                className={`wcv-latency${latency.ok === false ? " wcv-latency-over" : ""}`}
                data-testid="wcv-latency"
                data-ms={latency.ms}
                data-ok={String(latency.ok)}
                title={`End-of-speech → first audio: ${latency.ms}ms (budget ${latency.budgetMs}ms)`}
              >
                {latency.ms}ms{latency.ok === false ? " ⚠" : ""}
              </span>
            )}
            <button type="button" className="wcv-stop" title="Stop" aria-label="Stop voice" onClick={() => dispatch({ type: "STOP" })}>×</button>
          </div>
          {error ? (
            <div className="wcv-err" data-testid="wcv-error">{error}</div>
          ) : (
            <div className="wcv-transcript" data-testid="wcv-transcript">
              {finalText && <span className="wcv-final" data-testid="wcv-final">{finalText}</span>}
              {finalText && ctx.interim ? " " : ""}
              {ctx.interim && <span className="wcv-interim" data-testid="wcv-interim">{ctx.interim}</span>}
              {!finalText && !ctx.interim && (
                <span className="wcv-hint">{ctx.state === "listening" ? "Listening… speak now" : ctx.state === "sending" ? "…" : "Reply is playing"}</span>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
