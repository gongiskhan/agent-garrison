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

export function describeRecordError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? "");
  const text = raw.trim();
  if (!text) return "Recording did not start.";
  if (/CONSENT_DECLINED|consent declined/i.test(text)) return "Recording cancelled.";
  if (/NO_NODE|no node selected/i.test(text)) return "No node selected: add one on the Capture page.";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function RecordButton({ bridge, conversationId, pollMs = 2500, speech = null, push = null, heardMs = 8000, afterStopMs = 5 * 60_000 }: RecordButtonProps) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  // What the broadcast heard after the wake word, shown briefly; `captured`
  // stays true for the rest of the broadcast so the instructions go away once
  // they have been followed; `awaiting` counts heard turns Zeca has not yet
  // answered, so the line under the button says the answer is on its way.
  const [heard, setHeard] = useState<CaptureHeard | null>(null);
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
    if (status.broadcasting) {
      setStepBoth("live");
      setError(null);
      return;
    }
    if (stepRef.current === "live" || stepRef.current === "stopping") setStepBoth("idle");
  }, [setStepBoth]);

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
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (live) { setWatching(true); return; }
    if (!watching) return;
    const timer = window.setTimeout(() => setWatching(false), afterStopMs);
    return () => window.clearTimeout(timer);
  }, [live, watching, afterStopMs]);
  useEffect(() => {
    if (!live) setCaptured(false);
  }, [live]);
  useEffect(() => {
    if (!watching) setAwaiting(0);
  }, [watching]);
  const speechRef = useRef<SpeechBridge | null>(speech);
  speechRef.current = speech;
  useEffect(() => {
    if (!watching) return;
    const stop = watchCaptureFeedback(conversationId, {
      onHeard: (h) => {
        setCaptured(true);
        setHeard(h);
      },
      onAwaiting: setAwaiting,
      onReply: (reply) => {
        const bridgeNow = speechRef.current;
        if (!bridgeNow || typeof document === "undefined" || document.visibilityState !== "visible") return;
        void speakReply(bridgeNow, reply.text);
      }
    });
    return stop;
  }, [watching, conversationId]);
  useEffect(() => {
    if (!heard) return;
    const timer = window.setTimeout(() => setHeard(null), heardMs);
    return () => window.clearTimeout(timer);
  }, [heard, heardMs]);

  const onRecord = useCallback(async () => {
    if (stepRef.current !== "idle") return;
    setError(null);
    setStepBoth("starting");
    try {
      absorb(await bridge.start("screen_audio", { conversationId }));
      // The plugin resolves once the broadcast is up; anything else (the user
      // dismissed the system sheet without a status the bridge reports) is idle.
      if ((stepRef.current as Step) === "starting") setStepBoth("idle");
    } catch (err) {
      setError(describeRecordError(err));
      setStepBoth("idle");
    }
  }, [bridge, conversationId, absorb, setStepBoth]);

  const onStop = useCallback(async () => {
    if (stepRef.current !== "live") return;
    setStepBoth("stopping");
    try {
      absorb(await bridge.stop("screen_audio"));
    } catch (err) {
      setError(describeRecordError(err));
      setStepBoth("live");
    }
  }, [bridge, absorb, setStepBoth]);

  const label =
    step === "starting" ? "Starting" :
    step === "stopping" ? "Stopping" :
    step === "live" ? "Stop recording" :
    "Record screen";
  // The button's face: short, so the controls row keeps every label on a phone.
  const face = step === "live" ? "Stop" : step === "idle" ? "Record" : label;
  const title =
    step === "live" ? "Broadcasting into this conversation. Say \"Zeca\" and then your request. Tap to stop." :
    step === "idle" ? "Broadcast the screen and microphone into this conversation. Say \"Zeca\" and then your request; the words after it plus the latest screen frames are sent as your message." :
    label;
  // The wake word is the whole interface once the broadcast runs, so the
  // instruction stays on screen until it has been followed once; after that
  // the button's dot says enough and the space shows what was heard.
  const liveHint = step === "live" && !captured
    ? "Broadcasting. Say \"Zeca\" and then your request - the words after it plus the latest screen frames are sent into this conversation."
    : step === "starting"
      ? "Starting the broadcast. Once it runs, say \"Zeca\" and then your request."
      : null;
  const heardLine = heard
    ? `Heard: ${heard.text.length > 90 ? `${heard.text.slice(0, 87)}...` : heard.text || "(nothing after the wake word)"}`
    : awaiting > 0
      ? "Zeca is answering. The answer is read aloud here and pushed to the phone."
      : null;
  const pushLine = describePushStatus(pushStatus);

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
      {error || heardLine || liveHint || pushLine ? (
        <span className="wc-rec-notes">
          {error ? (
            <span className="wc-rec-err" role="status">{error}</span>
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
