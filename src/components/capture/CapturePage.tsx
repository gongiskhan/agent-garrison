"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  nativeCapture,
  nativeNode,
  nativePendant,
  nativePush,
  type AppInfo,
  type CaptureKind,
  type CaptureStatus,
  type ListenerHandle,
  type NodeInfo,
  type PendantStatus,
  type PushStatus
} from "@/lib/native-bridge";
import { BridgeGate } from "./BridgeGate";
import styles from "./CapturePage.module.css";

// The app's capture surface. Everything here is a thin control panel over the
// native plugins: the phone records (Swift owns microphone and broadcast
// permissions, the consent sheet, and the token), the webview only asks and
// shows. Audio never passes through this page - invariants I2 and I4.
//
// A browser sees one line. The route exists on every node so the sidebar entry
// (rendered only when the native bridge is present) always has a target.

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "the app did not answer";
}

export function CapturePage() {
  return (
    <main>
      <div className="crumbs">
        <b>Capture</b>
      </div>
      <div className="page narrow">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>App</span>
            <h1>Capture</h1>
          </div>
          <p>
            Record from this phone into the node. The phone streams audio straight to capture-service;
            this page only starts, stops, and shows what the app reports.
          </p>
        </header>
        <BridgeGate
          fallback={
            <p className={styles.fallback} data-testid="capture-fallback">
              Open this page in the Garrison app. In a browser there is nothing to capture from; use the
              record button in <Link href="/talk">Conversations</Link> instead.
            </p>
          }
        >
          <NativeCapture />
        </BridgeGate>
      </div>
    </main>
  );
}

function NativeCapture() {
  return (
    <div className={styles.sections} data-testid="capture-native">
      <NodeSection />
      <RecordingSection />
      <PushSection />
      <PendantSection />
      <AppFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node: which node this webview is loaded from, the others the app knows, and
// the add form. The token is typed here and handed to Swift once; it is never
// read back (`hasToken` is the only trace).

function NodeSection() {
  const [current, setCurrent] = useState<NodeInfo | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cur, list] = await Promise.all([nativeNode.current(), nativeNode.list()]);
      setCurrent(cur);
      setNodes(list);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchTo = async (name: string) => {
    setBusy(true);
    try {
      await nativeNode.select(name);
      await nativeNode.reload();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await nativeNode.remove(name);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const shellOrigin = String(data.get("shellOrigin") ?? "").trim();
    const token = String(data.get("token") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    const captureBaseURL = String(data.get("captureBaseURL") ?? "").trim();
    setBusy(true);
    try {
      await nativeNode.add({
        shellOrigin,
        token,
        ...(name ? { name } : {}),
        ...(captureBaseURL ? { captureBaseURL } : {})
      });
      form.reset();
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-testid="capture-node">
      <h2>Node</h2>
      {current ? (
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>Name</dt>
            <dd>{current.name}</dd>
          </div>
          <div className={styles.row}>
            <dt>Shell</dt>
            <dd>{current.shellOrigin}</dd>
          </div>
          <div className={styles.row}>
            <dt>Capture</dt>
            <dd>{current.captureBaseURL}</dd>
          </div>
          <div className={styles.row}>
            <dt>Token</dt>
            <dd>
              <span className={clsx(styles.pill, current.hasToken ? styles.pillLive : styles.pillAlarm)}>
                {current.hasToken ? "stored in the app" : "missing"}
              </span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className={styles.fallback}>The app has not selected a node yet.</p>
      )}

      {nodes.length > 1 ? (
        <ul className={styles.nodes} data-testid="capture-node-list">
          {nodes
            .filter((node) => node.name !== current?.name)
            .map((node) => (
              <li key={node.name} className={styles.node}>
                <b>{node.name}</b>
                <span>{node.shellOrigin}</span>
                <span className={styles.spacer} />
                <button type="button" className="btn small" disabled={busy} onClick={() => void switchTo(node.name)}>
                  Switch
                </button>
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => void remove(node.name)}>
                  Remove
                </button>
              </li>
            ))}
        </ul>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className="btn small" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add a node"}
        </button>
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {adding ? (
        <form className={styles.form} onSubmit={(e) => void onAdd(e)} data-testid="capture-node-add">
          <label>
            Shell origin
            <input name="shellOrigin" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off"
              placeholder="https://node.tailnet.ts.net" required />
          </label>
          <label>
            Capture token
            <input name="token" type="password" autoCapitalize="none" autoCorrect="off" required />
          </label>
          <label>
            Name (optional)
            <input name="name" type="text" autoCapitalize="none" autoCorrect="off" />
          </label>
          <label>
            Capture URL (optional, defaults to the node&apos;s capture port)
            <input name="captureBaseURL" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" />
          </label>
          <div className={styles.actions}>
            <button type="submit" className="btn small primary" disabled={busy}>
              Save node
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recording: microphone and screen audio, one live session at a time. The
// status comes from the plugin's `captureState` event; the buttons only ask.

const PHASE_LABEL: Record<CaptureStatus["phase"], string> = {
  idle: "idle",
  connecting: "connecting",
  live: "live",
  interrupted: "interrupted",
  failed: "failed"
};

function RecordingSection() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let handle: { remove: () => Promise<void> | void } | null = null;
    let cancelled = false;
    nativeCapture
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => setError(describeError(err)));
    nativeCapture
      .onState((s) => setStatus(s))
      .then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch((err) => setError(describeError(err)));
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, []);

  const run = async (action: () => Promise<CaptureStatus | { suppressed: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if ("phase" in result) setStatus(result);
      else setStatus((prev) => (prev ? { ...prev, consentSuppressed: result.suppressed } : prev));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // A broadcast that is still opening reports broadcasting=true before the
  // phase turns live; Stop has to be there for it too.
  const live = status?.phase === "live" || status?.phase === "connecting" || Boolean(status?.broadcasting);
  const start = (kind: CaptureKind) => run(() => nativeCapture.start(kind));
  const stop = (kind: CaptureKind) => run(() => nativeCapture.stop(kind));

  return (
    <section className={styles.section} data-testid="capture-recording">
      <h2>Recording</h2>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>Phase</dt>
          <dd>
            <span
              className={clsx(
                styles.pill,
                status?.phase === "live" && styles.pillLive,
                (status?.phase === "failed" || status?.phase === "interrupted") && styles.pillAlarm
              )}
              data-testid="capture-phase"
            >
              {status ? PHASE_LABEL[status.phase] : "reading"}
            </span>
          </dd>
        </div>
        <div className={styles.row}>
          <dt>Microphone</dt>
          <dd>{status?.microphone ?? "-"}</dd>
        </div>
        <div className={styles.row}>
          <dt>Screen audio</dt>
          <dd>{status ? (status.broadcasting ? "broadcasting" : "off") : "-"}</dd>
        </div>
        <div className={styles.row}>
          <dt>Frames acked</dt>
          <dd>{status?.ackedFrames ?? 0}</dd>
        </div>
        {status?.sessionId ? (
          <div className={styles.row}>
            <dt>Recording id</dt>
            <dd className="font-mono">{status.sessionId}</dd>
          </div>
        ) : null}
        <div className={styles.row}>
          <dt>Consent sheet</dt>
          <dd>{status ? (status.consentSuppressed ? "suppressed" : "shown before every start") : "-"}</dd>
        </div>
      </dl>
      <div className={styles.actions}>
        {live ? (
          <button type="button" className="btn small danger" disabled={busy}
            onClick={() => void stop(status?.broadcasting ? "screen_audio" : "microphone")}>
            Stop
          </button>
        ) : (
          <>
            <button type="button" className="btn small primary" disabled={busy || !status}
              onClick={() => void start("microphone")}>
              Record microphone
            </button>
            <button type="button" className="btn small" disabled={busy || !status}
              onClick={() => void start("screen_audio")}>
              Record screen audio
            </button>
          </>
        )}
        <button type="button" className="btn small ghost" disabled={busy || !status}
          onClick={() => void run(() => nativeCapture.setConsentSuppressed(!status?.consentSuppressed))}>
          {status?.consentSuppressed ? "Ask for consent again" : "Skip the consent sheet"}
        </button>
      </div>
      {live && status?.broadcasting ? (
        <p className={styles.hint} data-testid="capture-wake-hint">
          Broadcasting. Say &quot;Zeca&quot; and then your request - the words after it plus the latest screen frames are sent into the conversation the broadcast was started from.
        </p>
      ) : null}
      {status?.error ? <p className={styles.error}>{status.error}</p> : null}
      {status?.broadcastError ? <p className={styles.error}>{status.broadcastError}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Push: APNs registration. Capture-service holds the APNs key; the phone only
// hands its device token to the node.

function PushSection() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let handle: { remove: () => Promise<void> | void } | null = null;
    let cancelled = false;
    nativePush
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => setError(describeError(err)));
    nativePush
      .onStatus((s) => setStatus(s))
      .then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, []);

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await nativePush.register());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section} data-testid="capture-push">
      <h2>Notifications</h2>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>Permission</dt>
          <dd>{status?.authorization ?? "-"}</dd>
        </div>
        <div className={styles.row}>
          <dt>Registered</dt>
          <dd>
            <span className={clsx(styles.pill, status?.registered && styles.pillLive)}>
              {status ? (status.registered ? "with this node" : "no") : "reading"}
            </span>
          </dd>
        </div>
        {status?.detail ? (
          <div className={styles.row}>
            <dt>Detail</dt>
            <dd>{status.detail}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.actions}>
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void register()}>
          {status?.registered ? "Register again" : "Enable notifications"}
        </button>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pendant: the BLE companion, reached only through GarrisonPendant (D44). The
// plugin owns nothing: it observes the app-lifetime PendantController and
// pushes pendantState / pendantBattery; the page shows what it is told and
// asks for connect / disconnect / forget. The audio never comes near this
// page (I2): the phone streams it to capture-service, and the words come back
// here through the shell's /api/voice/sessions/<id>/events relay.

interface TranscriptLine {
  text: string;
  final: boolean;
}

const PENDANT_LIVE_STATES = new Set(["connected", "reconnecting"]);
const PENDANT_ALARM_STATES = new Set(["pairingLost", "bluetoothOff"]);

function pendantStateLabel(state: string | undefined): string {
  switch (state) {
    case undefined:
      return "reading";
    case "pairingLost":
      return "pairing lost";
    case "bluetoothOff":
      return "bluetooth off";
    default:
      return state;
  }
}

// The live words of one capture session, as capture-service streams them:
// interims replace the open line, finals settle into the list, {done:true}
// closes the stream. Session-keyed so a new session starts a clean panel.
function useLiveTranscript(sessionId: string | undefined) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "live" | "done" | "error">("idle");

  useEffect(() => {
    setLines([]);
    if (!sessionId || typeof EventSource === "undefined") {
      setStreamState("idle");
      return;
    }
    setStreamState("live");
    const source = new EventSource(`/api/voice/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onmessage = (event) => {
      let payload: { text?: unknown; final?: unknown; done?: unknown };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      if (payload.done === true) {
        setStreamState("done");
        source.close();
        return;
      }
      if (typeof payload.text !== "string" || !payload.text) return;
      const line = { text: payload.text, final: payload.final === true };
      // Finals accumulate; the one open interim is always the last line and
      // is replaced by whatever comes next.
      setLines((prev) => [...prev.filter((l) => l.final), line]);
    };
    source.addEventListener("error", () => {
      // A relay-side error frame (provider down, session unknown) and a
      // dropped connection both land here; the panel says so once and stops
      // rather than reconnecting into the same wall.
      setStreamState("error");
      source.close();
    });
    return () => source.close();
  }, [sessionId]);

  return { lines, streamState };
}

function PendantSection() {
  const [status, setStatus] = useState<PendantStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { lines, streamState } = useLiveTranscript(status?.sessionId);

  useEffect(() => {
    let stateHandle: ListenerHandle | null = null;
    let batteryHandle: ListenerHandle | null = null;
    let cancelled = false;
    nativePendant
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => setError(describeError(err)));
    nativePendant
      .onState((s) => setStatus(s))
      .then((h) => {
        if (cancelled) void h.remove();
        else stateHandle = h;
      })
      .catch(() => undefined);
    nativePendant
      .onBattery(({ battery }) => setStatus((prev) => (prev ? { ...prev, battery } : prev)))
      .then((h) => {
        if (cancelled) void h.remove();
        else batteryHandle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (stateHandle) void stateHandle.remove();
      if (batteryHandle) void batteryHandle.remove();
    };
  }, []);

  const run = async (action: () => Promise<PendantStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const state = status?.connectionState;
  const live = state !== undefined && PENDANT_LIVE_STATES.has(state);
  const alarm = state !== undefined && PENDANT_ALARM_STATES.has(state);
  const inFlight = state === "scanning" || state === "connecting";
  const showTranscript = Boolean(status?.sessionId);

  return (
    <section className={styles.section} data-testid="capture-pendant">
      <h2>Pendant</h2>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>State</dt>
          <dd>
            <span className={clsx(styles.pill, live && styles.pillLive, alarm && styles.pillAlarm)} data-testid="capture-pendant-state">
              {pendantStateLabel(state)}
            </span>
          </dd>
        </div>
        {status ? (
          <div className={styles.row}>
            <dt>Pairing</dt>
            <dd>{status.paired ? "remembered" : "none"}</dd>
          </div>
        ) : null}
        {typeof status?.battery === "number" ? (
          <div className={styles.row}>
            <dt>Battery</dt>
            <dd>{status.battery}%</dd>
          </div>
        ) : null}
        {status?.uploaderState ? (
          <div className={styles.row}>
            <dt>Capture</dt>
            <dd>{status.uploaderState}</dd>
          </div>
        ) : null}
        {status && status.lostFrames > 0 ? (
          <div className={styles.row}>
            <dt>Lost frames</dt>
            <dd>{status.lostFrames}</dd>
          </div>
        ) : null}
        {status?.capturePolicy ? (
          <div className={styles.row}>
            <dt>Policy</dt>
            <dd>{status.capturePolicy}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.actions}>
        {live || inFlight ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => void run(nativePendant.disconnect)}>
            Disconnect
          </button>
        ) : (
          <button type="button" className="btn small primary" disabled={busy || !status} onClick={() => void run(nativePendant.connect)}>
            {status?.paired ? "Connect" : "Pair"}
          </button>
        )}
        {status?.paired ? (
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(nativePendant.forget)}>
            Forget
          </button>
        ) : null}
      </div>
      {showTranscript ? (
        <div className={styles.transcript} data-testid="capture-pendant-transcript" aria-live="polite">
          <p className={styles.transcriptHead}>
            <span>Hearing</span>
            <span className={clsx(styles.pill, streamState === "live" && styles.pillLive, streamState === "error" && styles.pillAlarm)}>
              {streamState}
            </span>
          </p>
          {lines.length === 0 ? (
            <p className={styles.transcriptEmpty}>{streamState === "live" ? "Listening for words" : "Nothing heard"}</p>
          ) : (
            <ol className={styles.transcriptLines}>
              {lines.map((line, i) => (
                <li key={`${i}-${line.final ? "f" : "i"}`} className={clsx(!line.final && styles.transcriptInterim)}>
                  {line.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
      {status?.uploaderError ? <p className={styles.error}>{status.uploaderError}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}

function AppFooter() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    nativeNode
      .info()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  if (!info) return null;
  return (
    <p className={styles.footer} data-testid="capture-app-info">
      Garrison {info.appVersion} ({info.build}) on {info.platform}
    </p>
  );
}
