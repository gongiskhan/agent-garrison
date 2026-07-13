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
import { startCapture, isCaptureSupported, captureUnsupportedReason, type CaptureHandle } from "./voice-capture";
import { startTts, type TtsHandle } from "./voice-tts";
import { LatencyTracker, type BudgetVerdict } from "./voice-latency";

export interface VoiceConversationProps {
  /** Submit a transcribed utterance as a real chat turn (renders + streams). */
  send: (text: string) => void;
  /** True while a chat turn is in flight (mirrors ClaudeChat busy). */
  busy: boolean;
  /** Latest SETTLED assistant reply; changes id once per completed turn. */
  lastReply: { id: string; text: string } | null;
  // ── test overrides ──
  streamUrl?: string;
  ttsUrl?: string;
  workletUrl?: string;
  /** Skip the /api/voice/health probe and assume available (tests). */
  assumeAvailable?: boolean;
}

interface VoiceHealth { available: boolean; keyConfigured?: boolean }

// If a voice send produces no settled reply within this window, recover the
// state machine rather than deadlock in `sending` (codex S6b finding).
const SENDING_TIMEOUT_MS = 30000;

export function VoiceConversation(props: VoiceConversationProps) {
  const supported = useMemo(() => isCaptureSupported(), []);
  const [ctx, setCtx] = useState<VoiceCtx>(() => initialCtx());
  const [available, setAvailable] = useState<boolean>(Boolean(props.assumeAvailable));
  const [level, setLevel] = useState(0);
  const [latency, setLatency] = useState<BudgetVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const captureRef = useRef<CaptureHandle | null>(null);
  const ttsRef = useRef<TtsHandle | null>(null);
  const latencyRef = useRef(new LatencyTracker());
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const awaitingReplyRef = useRef(false);
  const sendTimeoutRef = useRef<number | null>(null);
  const consumedReplyIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const runEffectRef = useRef<(eff: VoiceEffect) => void>(() => {});

  const dispatch = useCallback((ev: VoiceEvent) => {
    const { ctx: next, effects } = voiceReduce(ctxRef.current, ev);
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
      { streamUrl: props.ttsUrl, audioContext: playbackCtxRef.current ?? undefined },
    );
  }, [stopPlayback, ensurePlaybackCtx, props.ttsUrl]);

  const closeCapture = useCallback(() => {
    if (captureRef.current) { captureRef.current.stop(); captureRef.current = null; }
    setLevel(0);
  }, []);

  const openCapture = useCallback(async () => {
    if (captureRef.current) return;
    if (!supported) { setError(captureUnsupportedReason()); dispatchRef.current({ type: "ERROR" }); return; }
    ensurePlaybackCtx();
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
        { streamUrl: props.streamUrl, workletUrl: props.workletUrl },
      );
      if (!mountedRef.current || ctxRef.current.state === "idle") { handle.stop(); return; }
      captureRef.current = handle;
    } catch (e: any) {
      if (mountedRef.current) setError(e?.message || "microphone error");
      dispatchRef.current({ type: "ERROR" });
    }
  }, [supported, ensurePlaybackCtx, props.streamUrl, props.workletUrl]);

  // Effect interpreter - reassigned each render so it closes over current props.
  runEffectRef.current = (eff: VoiceEffect) => {
    switch (eff.type) {
      case "open-capture":
        void openCapture();
        break;
      case "close-capture":
        closeCapture();
        break;
      case "send":
        latencyRef.current.mark("send");
        awaitingReplyRef.current = true;
        setError(null);
        props.send(eff.text);
        // Deadlock guard (codex S6b finding): the chat only feeds a NEW settled
        // lastReply for non-empty assistant text, so a voice turn whose reply is
        // empty/missing would leave the machine stuck in `sending` forever. Arm a
        // timeout that, if no reply settles, dispatches an empty REPLY_READY —
        // which the machine handles by re-arming the mic (→ listening). Cleared
        // when a real reply lands or the machine leaves `sending`.
        if (sendTimeoutRef.current) window.clearTimeout(sendTimeoutRef.current);
        sendTimeoutRef.current = window.setTimeout(() => {
          if (awaitingReplyRef.current && ctxRef.current.state === "sending") {
            awaitingReplyRef.current = false;
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
    consumedReplyIdRef.current = r.id;
    if (!awaitingReplyRef.current) return;
    awaitingReplyRef.current = false;
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
    if (settled && awaitingReplyRef.current && ctxRef.current.state === "sending") {
      awaitingReplyRef.current = false;
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
    awaitingReplyRef.current = false;
    if (playbackCtxRef.current) {
      try { void playbackCtxRef.current.close(); } catch {}
      playbackCtxRef.current = null;
    }
  }, [ctx.state]);

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

  const onToggleConversation = useCallback(() => {
    if (!usable) return;
    if (ctxRef.current.mode === "conversation") {
      dispatch({ type: "STOP" });
    } else if (ctxRef.current.state === "idle") {
      setError(null);
      setLatency(null);
      latencyRef.current.reset();
      dispatch({ type: "START_CONVERSATION" });
    }
  }, [usable, dispatch]);

  const onPttDown = useCallback(() => {
    if (!usable) return;
    if (ctxRef.current.state === "idle") { setError(null); dispatch({ type: "START_PTT" }); }
  }, [usable, dispatch]);
  const onPttUp = useCallback(() => {
    if (ctxRef.current.mode === "ptt") dispatch({ type: "RELEASE_PTT" });
  }, [dispatch]);

  const conversationOn = ctx.mode === "conversation";
  const pttActive = ctx.mode === "ptt";
  const showPanel = ctx.state !== "idle" || Boolean(error);
  const finalText = ctx.finals.map((s) => s.trim()).filter(Boolean).join(" ");
  const stateLabel =
    ctx.state === "listening" ? "Listening"
      : ctx.state === "sending" ? "Sending"
        : ctx.state === "speaking" ? "Speaking"
          : "";

  return (
    <span className="wcv" data-testid="wcv">
      <button
        type="button"
        className={`wcv-convo${conversationOn ? " wcv-on" : ""}`}
        data-testid="wcv-convo"
        aria-pressed={conversationOn}
        disabled={!usable}
        title={usable ? (conversationOn ? "Stop conversation" : "Hands-free conversation: talk, pause to send, reply is read aloud") : disabledReason}
        onClick={onToggleConversation}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 3h10v7H6l-3 2.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6 6h4M6 8h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span className="wcv-convo-label">Talk</span>
      </button>
      <button
        type="button"
        className={`wcv-mic${pttActive ? " wcv-mic-rec" : ""}`}
        data-testid="wcv-mic"
        aria-pressed={pttActive}
        disabled={!usable || conversationOn}
        title={usable ? (conversationOn ? "Conversation active" : "Hold to talk (push-to-talk)") : disabledReason}
        onPointerDown={(e) => { e.preventDefault(); onPttDown(); }}
        onPointerUp={(e) => { e.preventDefault(); onPttUp(); }}
        onPointerLeave={onPttUp}
        onPointerCancel={onPttUp}
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
        <div className={`wcv-panel wcv-panel-${ctx.state}`} data-testid="wcv-panel" role="status" aria-live="polite">
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
