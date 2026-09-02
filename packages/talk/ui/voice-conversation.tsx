// Conversation-mode voice controls (S6b, D20). Rendered into ClaudeChat's
// composerAdornment slot - it does NOT rebuild the chat, it drives it:
//   • sends a transcribed utterance as a real chat turn (props.send)
//   • reads each reply aloud by watching props.lastReply settle
// The gating logic lives in the pure voice-machine reducer; this component only
// wires browser side effects (capture, TTS, latency, DOM) to it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  voiceReduce, initialCtx, transcriptOf,
  type VoiceCtx, type VoiceEvent, type VoiceEffect,
} from "./voice-machine";
import { startCapture, startTts, isCaptureSupported, captureUnsupportedReason, type CaptureHandle, type TtsHandle } from "./voice-clip";
import { LatencyTracker, type BudgetVerdict } from "./voice-latency";

export interface VoiceConversationProps {
  /** Submit a transcribed utterance as a real chat turn (renders + streams). */
  send: (text: string) => string | null;
  /** True while a chat turn is in flight (mirrors ClaudeChat busy). */
  busy: boolean;
  /** Prevent a new voice turn while generated text work is active or queued. */
  queueLocked: boolean;
  /** Latest SETTLED assistant reply; changes id once per completed turn. */
  lastReply: { id: string; text: string; clientRequestId?: string } | null;
  // ── test overrides ──
  sttUrl?: string;
  ttsUrl?: string;
  /** Skip the /api/voice/health probe and assume available (tests). */
  assumeAvailable?: boolean;
}

interface VoiceHealth { available: boolean; keyConfigured?: boolean }

// If a voice send produces no settled reply within this window, recover the
// state machine rather than deadlock in `sending` (codex S6b finding).
const SENDING_TIMEOUT_MS = 30000;

/** How long the mic must be held before it becomes push-to-talk. Below this a
 *  press is a TAP and opens the voice sheet instead. Comfortably shorter than
 *  any deliberate hold, long enough that a tap never trips the capture. */
const HOLD_MS = 220;

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
        <p className="cc-sheet-sub">Hold the mic to talk once. Or hand the conversation over:</p>
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
  const [level, setLevel] = useState(0);
  const [latency, setLatency] = useState<BudgetVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (props.assumeAvailable) { setAvailable(true); return; }
    let cancelled = false;
    const probe = () => {
      fetch("/api/voice/health")
        .then((r) => (r.ok ? r.json() : { available: false }))
        .then((h: VoiceHealth) => { if (!cancelled) setAvailable(Boolean(h.available) && h.keyConfigured !== false); })
        .catch(() => { if (!cancelled) setAvailable(false); });
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
      { ttsUrl: props.ttsUrl, audioContext: playbackCtxRef.current ?? undefined },
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
        { sttUrl: props.sttUrl, mode },
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
  const disabledReason = !supported
    ? captureUnsupportedReason()
    : !available
      ? "Voice fitting not running"
      : "";
  const queueLockedReason = "Wait for pending messages to finish before starting voice";

  const onToggleConversation = useCallback(() => {
    if (!usable) return;
    if (ctxRef.current.mode === "conversation") {
      dispatch({ type: "STOP" });
    } else if (!props.queueLocked && ctxRef.current.state === "idle") {
      setError(null);
      setLatency(null);
      latencyRef.current.reset();
      dispatch({ type: "START_CONVERSATION" });
    }
  }, [usable, props.queueLocked, dispatch]);

  const onPttDown = useCallback(() => {
    if (!usable || props.queueLocked) return;
    if (ctxRef.current.state === "idle") { setError(null); dispatch({ type: "START_PTT" }); }
  }, [usable, props.queueLocked, dispatch]);
  const onPttUp = useCallback(() => {
    if (ctxRef.current.mode === "ptt") dispatch({ type: "RELEASE_PTT" });
  }, [dispatch]);

  const conversationOn = ctx.mode === "conversation";
  const pttActive = ctx.mode === "ptt";
  const showPanel = ctx.state !== "idle" || Boolean(error);
  const finalText = ctx.finals.map((s) => s.trim()).filter(Boolean).join(" ");
  const transcribing = ctx.mode === "ptt" && !ctx.pttHeld && ctx.state === "listening";
  const stateLabel =
    ctx.state === "listening" ? (transcribing ? "Transcribing" : "Listening")
      : ctx.state === "sending" ? "Sending"
        : ctx.state === "speaking" ? "Speaking"
          : "";

  return (
    <span className="wcv" data-testid="wcv">
      {/* Hands-free lives in a sheet the mic opens on a TAP; the standing Talk
          button was a second permanent control for a mode that is entered
          occasionally. Holding the mic is still push-to-talk. */}
      {voiceSheetOpen && (
        <VoiceSheet
          conversationOn={conversationOn}
          disabled={!usable || (props.queueLocked && !conversationOn)}
          reason={usable ? (props.queueLocked ? queueLockedReason : "") : disabledReason}
          onToggleConversation={() => { setVoiceSheetOpen(false); onToggleConversation(); }}
          onClose={() => setVoiceSheetOpen(false)}
        />
      )}
      <button
        type="button"
        className={`wcv-mic${pttActive ? " wcv-mic-rec" : ""}`}
        data-testid="wcv-mic"
        aria-pressed={pttActive}
        aria-label={pttActive ? "Release push-to-talk" : "Hold to talk"}
        // Stays tappable while the queue is locked: the mic is now the ONLY way
        // into the voice sheet, and a disabled button would strand the user with
        // no way to read why. Push-to-talk itself still refuses (onPttDown).
        disabled={!usable || conversationOn}
        title={usable
          ? conversationOn
            ? "Conversation active"
            : props.queueLocked && !pttActive
              ? queueLockedReason
              : "Hold to talk (push-to-talk)"
          : disabledReason}
        // HOLD is push-to-talk, TAP opens the voice sheet. The capture only starts
        // once the hold passes the threshold, so a tap never opens the mic for a
        // few milliseconds and never posts an empty utterance.
        onPointerDown={(e) => {
          e.preventDefault();
          if (holdTimer.current) window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => { holdTimer.current = null; onPttDown(); }, HOLD_MS);
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          const tapped = holdTimer.current !== null;
          if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
          if (tapped) { if (!conversationOn) setVoiceSheetOpen(true); return; }
          onPttUp();
        }}
        onPointerLeave={() => {
          if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; return; }
          onPttUp();
        }}
        onPointerCancel={() => {
          if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; return; }
          onPttUp();
        }}
        onKeyDown={(e) => {
          if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
          e.preventDefault();
          onPttDown();
        }}
        onKeyUp={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          onPttUp();
        }}
        onBlur={onPttUp}
      >
        {pttActive ? (
          <span className="wcv-mic-dot" aria-hidden="true" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" />
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        )}
      </button>

      {showPanel && (
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
                <span className="wcv-hint">{transcribing ? "…" : ctx.state === "listening" ? "Listening… speak now" : ctx.state === "sending" ? "…" : "Reply is playing"}</span>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
