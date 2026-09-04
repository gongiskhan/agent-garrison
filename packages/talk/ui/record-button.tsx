// The record button (plan G5): one control in the composer of every
// conversation that starts a screen recording on the phone and ends with a
// digest message in this same thread. The webview never touches audio: the
// button calls the native capture bridge the host hands in, the phone streams
// to capture-service, and capture-service posts the digest back through the
// thread engine with the conversation id the button passed along.
//
// Rendered only when a host supplies a bridge (the Garrison iOS app); a plain
// browser or the legacy own-port host shows nothing here.

import { useCallback, useEffect, useRef, useState } from "react";
import { speakReply, watchCaptureFeedback, type CaptureHeard, type SpeechBridge } from "./capture-feedback";

export type RecordKind = "screen_audio" | "microphone";

export interface CaptureBridgeStatus {
  phase: string;
  broadcasting: boolean;
  broadcastError?: string;
  error?: string;
}

export interface CaptureBridge {
  status(): Promise<CaptureBridgeStatus>;
  start(kind: RecordKind, extra?: Record<string, unknown>): Promise<CaptureBridgeStatus>;
  stop(kind: RecordKind): Promise<CaptureBridgeStatus>;
  onState(cb: (status: CaptureBridgeStatus) => void): Promise<{ remove(): void | Promise<void> }>;
}

// The phone's push registration as GarrisonPushPlugin reports it:
// `authorization` is the UNAuthorizationStatus case name, `registered` means
// the APNs token reached this node, `detail` is the human line behind it.
export interface PushBridgeStatus {
  authorization: string;
  registered: boolean;
  detail: string;
}

export interface PushBridge {
  /** Prompt when the system has not asked yet, then register with this node. */
  register(): Promise<PushBridgeStatus>;
  status(): Promise<PushBridgeStatus>;
  onStatus?(cb: (status: PushBridgeStatus) => void): Promise<{ remove(): void | Promise<void> }>;
}

/**
 * What the notifications line under the button says, or null when push is
 * set up and nothing needs the user. Pure, so the copy is testable: the answer
 * to a spoken turn reaches the phone as a push once the user leaves the app,
 * so a broadcast without push is a broadcast that answers into the void.
 */
export function describePushStatus(status: PushBridgeStatus | null | undefined): { text: string; action: "enable" | "retry" | null } | null {
  if (!status) return null;
  if (status.registered) return null;
  if (status.authorization === "denied") {
    return { text: "Notifications are off for Garrison, so Zeca's answers cannot reach you outside the app. Turn them on in Settings > Garrison > Notifications.", action: null };
  }
  if (status.authorization === "notDetermined") {
    return { text: "Turn on notifications to get Zeca's answers when you leave the app.", action: "enable" };
  }
  const detail = status.detail && status.detail !== "registered" ? status.detail : "not registered with this node";
  if (/requesting token/i.test(detail)) return { text: "Registering this phone for notifications...", action: null };
  return { text: `Notifications: ${detail}.`, action: "retry" };
}

export interface RecordButtonProps {
  bridge: CaptureBridge;
  /** The thread the digest lands in. */
  conversationId: string;
  /** What the button captures (D60). `screen` broadcasts the screen only - the
   *  frames ride along with the next spoken "Zeca" turn; `listen` opens the
   *  phone's microphone as a wake-word ear for when no pendant is worn. */
  mode?: RecordMode;
  /** Whether the notes under the button carry the conversation's voice
   *  feedback (what was heard, the answer, push state). One button per
   *  conversation should, or two buttons repeat every line. */
  feedback?: boolean;
  /** Keep watching the conversation for spoken turns even while the button is
   *  idle: the Zeca conversation hears the pendant with no button pressed. */
  alwaysWatch?: boolean;
  /** How often the button re-reads status while a recording is starting or
   *  live (the broadcast extension reports through a heartbeat, not events). */
  pollMs?: number;
  /** The phone's speech synthesizer (D56): with it, the operative's answer to
   *  a spoken turn is read aloud while the page is visible. Absent, the answer
   *  is only pushed. */
  speech?: SpeechBridge | null;
  /** The phone's push registration (D57): the button asks for permission the
   *  moment a broadcast starts, since that is when the answer will need a way
   *  back, and shows what stands in the way until the phone is registered. */
  push?: PushBridge | null;
  /** How long "Heard: ..." stays under the button. */
  heardMs?: number;
  /** How long after the broadcast ends the page still watches for an answer. */
  afterStopMs?: number;
}

type Step = "idle" | "starting" | "live" | "stopping";
export type RecordMode = "screen" | "listen";

const MODE_KIND: Record<RecordMode, RecordKind> = { screen: "screen_audio", listen: "microphone" };
const MIC_LIVE_PHASES = new Set(["connecting", "live", "interrupted"]);

// What each button says. The screen button never mentions the microphone:
// since D60 a broadcast carries pixels only, and the voice comes from the
// pendant or the Listen button.
const SCREEN_COPY = {
  idleLabel: "Record screen",
  stopLabel: "Stop recording",
  face: "Record",
  idleTitle: "Broadcast the screen into this conversation. While it runs, the latest screen frames ride along with your next spoken \"Zeca\" request.",
  liveTitle: "Broadcasting the screen into this conversation. Say \"Zeca\" and then your request; the frames ride along. Tap to stop.",
  liveHint: "Broadcasting the screen. Say \"Zeca\" and then your request - the words after it plus the latest screen frames are sent into this conversation.",
  startingHint: "Starting the broadcast. Once it runs, your next \"Zeca\" request carries the screen."
};
const LISTEN_COPY = {
  idleLabel: "Listen",
  stopLabel: "Stop listening",
  face: "Listen",
  idleTitle: "Open the phone's microphone as Zeca's ear. Only what follows \"Zeca\" is sent; tap again to stop listening.",
  liveTitle: "Listening. Say \"Zeca\" and then your request. Tap to stop.",
  liveHint: "Listening. Say \"Zeca\" and then your request - only the words after it are sent into this conversation.",
  startingHint: "Opening the microphone. Once it runs, say \"Zeca\" and then your request."
};

export function describeRecordError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? "");
  const text = raw.trim();
  if (!text) return "Recording did not start.";
  if (/CONSENT_DECLINED|consent declined/i.test(text)) return "Recording cancelled.";
  if (/NO_NODE|no node selected/i.test(text)) return "No node selected: add one on the Capture page.";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function RecordButton({ bridge, conversationId, mode = "screen", feedback = true, alwaysWatch = false, pollMs = 2500, speech = null, push = null, heardMs = 8000, afterStopMs = 5 * 60_000 }: RecordButtonProps) {
  const kind = MODE_KIND[mode];
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  // What the broadcast heard after the wake word, shown briefly; `captured`
  // stays true for the rest of the broadcast so the instructions go away once
  // they have been followed; `awaiting` counts heard turns Zeca has not yet
  // answered, so the line under the button says the answer is on its way.
  const [heard, setHeard] = useState<CaptureHeard | null>(null);
  // Why the last answer came out in the phone's own voice instead of the voice
  // layer's (D58). Null while clips play; the line clears itself.
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [captured, setCaptured] = useState(false);
  const [awaiting, setAwaiting] = useState(0);
  const [pushStatus, setPushStatus] = useState<PushBridgeStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const stepRef = useRef<Step>("idle");
  const setStepBoth = useCallback((next: Step) => {
    stepRef.current = next;
    setStep(next);
  }, []);

  // Fold a native status into the button's state. A live broadcast wins over
  // whatever the button believed; an ended one returns it to idle unless a
  // start is still in flight (the picker is up).
  const absorb = useCallback((status: CaptureBridgeStatus) => {
    // The broadcast reports its own flag; the microphone IS the capture
    // controller, whose phase is the native status's `phase`.
    const running = mode === "screen" ? status.broadcasting : MIC_LIVE_PHASES.has(status.phase);
    if (running) {
      setStepBoth("live");
      setError(null);
      return;
    }
    if (stepRef.current === "live" || stepRef.current === "stopping") setStepBoth("idle");
  }, [setStepBoth, mode]);

  useEffect(() => {
    let cancelled = false;
    let handle: { remove(): void | Promise<void> } | null = null;
    void bridge.status().then((s) => { if (!cancelled) absorb(s); }).catch(() => {});
    void bridge.onState((s) => { if (!cancelled) absorb(s); }).then((h) => {
      if (cancelled) void h.remove();
      else handle = h;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [bridge, absorb]);

  useEffect(() => {
    if (step === "idle") return;
    const timer = window.setInterval(() => {
      void bridge.status().then(absorb).catch(() => {});
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [bridge, step, pollMs, absorb]);

  // Push (D57): read where the registration stands, follow its changes, and
  // ask in context - the first broadcast is the moment the phone needs a way
  // to be answered. A phone that already said no is told where to fix it,
  // never re-prompted (iOS would not show the sheet again anyway).
  useEffect(() => {
    if (!push) return;
    let cancelled = false;
    let handle: { remove(): void | Promise<void> } | null = null;
    void push.status().then((s) => { if (!cancelled) setPushStatus(s); }).catch(() => {});
    if (push.onStatus) {
      void push.onStatus(() => {
        void push.status().then((s) => { if (!cancelled) setPushStatus(s); }).catch(() => {});
      }).then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [push]);
  const registerPush = useCallback(async () => {
    if (!push || pushBusy) return;
    setPushBusy(true);
    try {
      setPushStatus(await push.register());
    } catch {
      // The status line keeps showing whatever the last status() said.
    } finally {
      setPushBusy(false);
    }
  }, [push, pushBusy]);
  const askedRef = useRef(false);
  useEffect(() => {
    if (step !== "live" || !push || !pushStatus || askedRef.current) return;
    if (pushStatus.authorization !== "notDetermined") return;
    askedRef.current = true;
    void registerPush();
  }, [step, push, pushStatus, registerPush]);

  // Feedback (D56): while the broadcast runs - and for a while after it stops,
  // since the answer takes its time - watch the conversation for the turns the
  // broadcast heard and for the operative's answer to them; speak the answer
  // when the page is on screen (off screen, capture-service's push carries it).
  const live = step === "live" || step === "stopping";
  const [watching, setWatching] = useState(alwaysWatch);
  useEffect(() => {
    if (live || alwaysWatch) { setWatching(true); return; }
    if (!watching) return;
    const timer = window.setTimeout(() => setWatching(false), afterStopMs);
    return () => window.clearTimeout(timer);
  }, [live, watching, afterStopMs, alwaysWatch]);
  useEffect(() => {
    if (!live) setCaptured(false);
  }, [live]);
  useEffect(() => {
    if (!watching) setAwaiting(0);
  }, [watching]);
  const speechRef = useRef<SpeechBridge | null>(speech);
  speechRef.current = speech;
  useEffect(() => {
    if (!watching || !feedback) return;
    const stop = watchCaptureFeedback(conversationId, {
      onHeard: (h) => {
        setCaptured(true);
        setHeard(h);
      },
      onAwaiting: setAwaiting,
      onReply: (reply) => {
        const bridgeNow = speechRef.current;
        if (!bridgeNow || typeof document === "undefined" || document.visibilityState !== "visible") return;
        void speakReply(bridgeNow, reply.text, { onFallback: (reason) => setVoiceNote(`Phone voice used: ${reason}.`) });
      }
    });
    return stop;
  }, [watching, feedback, conversationId]);
  useEffect(() => {
    if (!heard) return;
    const timer = window.setTimeout(() => setHeard(null), heardMs);
    return () => window.clearTimeout(timer);
  }, [heard, heardMs]);
  useEffect(() => {
    if (!voiceNote) return;
    const timer = window.setTimeout(() => setVoiceNote(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [voiceNote]);

  const onRecord = useCallback(async () => {
    if (stepRef.current !== "idle") return;
    setError(null);
    setStepBoth("starting");
    try {
      absorb(await bridge.start(kind, { conversationId }));
      // The plugin resolves once the broadcast is up; anything else (the user
      // dismissed the system sheet without a status the bridge reports) is idle.
      if ((stepRef.current as Step) === "starting") setStepBoth("idle");
    } catch (err) {
      setError(describeRecordError(err));
      setStepBoth("idle");
    }
  }, [bridge, kind, conversationId, absorb, setStepBoth]);

  const onStop = useCallback(async () => {
    if (stepRef.current !== "live") return;
    setStepBoth("stopping");
    try {
      absorb(await bridge.stop(kind));
    } catch (err) {
      setError(describeRecordError(err));
      setStepBoth("live");
    }
  }, [bridge, kind, absorb, setStepBoth]);

  const copy = mode === "screen" ? SCREEN_COPY : LISTEN_COPY;
  const label =
    step === "starting" ? "Starting" :
    step === "stopping" ? "Stopping" :
    step === "live" ? copy.stopLabel :
    copy.idleLabel;
  // The button's face: short, so the controls row keeps every label on a phone.
  const face = step === "live" ? "Stop" : step === "idle" ? copy.face : label;
  const title =
    step === "live" ? copy.liveTitle :
    step === "idle" ? copy.idleTitle :
    label;
  // The wake word is the whole interface once the capture runs, so the
  // instruction stays on screen until it has been followed once; after that
  // the button's dot says enough and the space shows what was heard.
  const liveHint = step === "live" && !captured
    ? copy.liveHint
    : step === "starting"
      ? copy.startingHint
      : null;
  const heardLine = !feedback ? null : heard
    ? `Heard: ${heard.text.length > 90 ? `${heard.text.slice(0, 87)}...` : heard.text || "(nothing after the wake word)"}`
    : awaiting > 0
      ? "Zeca is answering. The answer is read aloud here and pushed to the phone."
      : null;
  const pushLine = feedback ? describePushStatus(pushStatus) : null;

  return (
    <span className="wc-rec" data-testid="wc-rec" data-step={step}>
      <button
        type="button"
        className={`wc-rec-btn${live ? " wc-rec-live" : ""}`}
        data-testid="wc-rec-btn"
        aria-pressed={live}
        aria-label={label}
        title={error ?? title}
        disabled={step === "starting" || step === "stopping"}
        onClick={() => { void (live ? onStop() : onRecord()); }}
      >
        {live ? (
          <span className="wc-rec-dot" aria-hidden="true" />
        ) : (
          <svg className="wc-rec-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="8" r="3.2" fill="currentColor" />
          </svg>
        )}
        <span className="wc-rec-label">{face}</span>
      </button>
      {error || voiceNote || heardLine || liveHint || pushLine ? (
        <span className="wc-rec-notes">
          {error ? (
            <span className="wc-rec-err" role="status">{error}</span>
          ) : voiceNote && feedback ? (
            <span className="wc-rec-heard" role="status" data-testid="wc-rec-voice">{voiceNote}</span>
          ) : heardLine ? (
            <span className="wc-rec-heard" role="status" data-testid="wc-rec-heard">{heardLine}</span>
          ) : liveHint ? (
            <span className="wc-rec-hint" role="status" data-testid="wc-rec-hint">{liveHint}</span>
          ) : null}
          {pushLine ? (
            <span className="wc-rec-push" role="status" data-testid="wc-rec-push">
              {pushLine.text}
              {pushLine.action ? (
                <button type="button" className="wc-rec-push-btn" data-testid="wc-rec-push-btn" disabled={pushBusy} onClick={() => { void registerPush(); }}>
                  {pushLine.action === "enable" ? "Turn on notifications" : "Retry"}
                </button>
              ) : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
