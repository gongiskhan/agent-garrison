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

export interface RecordButtonProps {
  bridge: CaptureBridge;
  /** The thread the digest lands in. */
  conversationId: string;
  /** How often the button re-reads status while a recording is starting or
   *  live (the broadcast extension reports through a heartbeat, not events). */
  pollMs?: number;
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

export function RecordButton({ bridge, conversationId, pollMs = 2500 }: RecordButtonProps) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
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

  const live = step === "live" || step === "stopping";
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
  // instruction stays on screen for as long as it does.
  const liveHint = step === "live"
    ? "Broadcasting. Say \"Zeca\" and then your request - the words after it plus the latest screen frames are sent into this conversation."
    : step === "starting"
      ? "Starting the broadcast. Once it runs, say \"Zeca\" and then your request."
      : null;

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
        {live && <span className="wc-rec-dot" aria-hidden="true" />}
        <span className="wc-rec-label">{face}</span>
      </button>
      {error ? (
        <span className="wc-rec-err" role="status">{error}</span>
      ) : liveHint ? (
        <span className="wc-rec-hint" role="status" data-testid="wc-rec-hint">{liveHint}</span>
      ) : null}
    </span>
  );
}
