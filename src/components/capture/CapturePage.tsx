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

  const live = status?.phase === "live" || status?.phase === "connecting";
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
// Pendant: the BLE companion. Status only until G7 lands the mock harness; the
// plugin already exposes connect/disconnect/forget so the buttons are wired.

function PendantSection() {
  const [status, setStatus] = useState<PendantStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let handle: { remove: () => Promise<void> | void } | null = null;
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
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
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

  const connected = status?.state === "connected" || status?.state === "streaming";

  return (
    <section className={styles.section} data-testid="capture-pendant">
      <h2>Pendant</h2>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>State</dt>
          <dd>
            <span className={clsx(styles.pill, connected && styles.pillLive)}>{status?.state ?? "reading"}</span>
          </dd>
        </div>
        {typeof status?.battery === "number" ? (
          <div className={styles.row}>
            <dt>Battery</dt>
            <dd>{status.battery}%</dd>
          </div>
        ) : null}
        {status?.uploaderState ? (
          <div className={styles.row}>
            <dt>Uploader</dt>
            <dd>{status.uploaderState}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.actions}>
        {connected ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => void run(nativePendant.disconnect)}>
            Disconnect
          </button>
        ) : (
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(nativePendant.connect)}>
            Connect
          </button>
        )}
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(nativePendant.forget)}>
          Forget
        </button>
      </div>
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
