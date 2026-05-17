import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface State {
  running: boolean;
  permissionGranted: boolean;
  lastError: string | null;
  lastCaptureAt: number | null;
  intervalMs?: number;
}

function App() {
  const [state, setState] = useState<State>({ running: false, permissionGranted: true, lastError: null, lastCaptureAt: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch("/state");
      const data = (await res.json()) as State;
      setState(data);
    } catch {}
  }, []);

  useEffect(() => {
    void refreshState();
    const id = setInterval(refreshState, 2000);
    return () => clearInterval(id);
  }, [refreshState]);

  useEffect(() => {
    if (state.running) {
      tickRef.current = setInterval(() => setFrameKey((k) => k + 1), state.intervalMs ?? 1000);
    } else if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };
  }, [state.running, state.intervalMs]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/start", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError((body && (body.error as string)) || `HTTP ${res.status}`);
      }
      await refreshState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await fetch("/stop", { method: "POST" });
      await refreshState();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div>
        <h1>Garrison Screen Share</h1>
        <p className="subtitle">macOS screencapture loop. Requires Screen Recording permission.</p>
      </div>

      <div className="strip">
        {!state.running ? (
          <button type="button" className="btn primary" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start"}
          </button>
        ) : (
          <button type="button" className="btn danger" onClick={stop} disabled={busy}>
            Stop
          </button>
        )}
        <span className="meta">
          <span className={`dot ${state.running ? "sage" : "mute"}`} />
          {state.running ? "capturing" : "stopped"}
          {state.lastCaptureAt && ` · last frame ${Math.max(0, Math.floor((Date.now() - state.lastCaptureAt) / 1000))}s ago`}
        </span>
      </div>

      {error && <div className="alert">{error}</div>}
      {!error && state.lastError && <div className="alert">{state.lastError}</div>}

      <div className="frame-wrap">
        {state.running && state.lastCaptureAt ? (
          <img src={`/frame?t=${frameKey}`} alt="screen frame" />
        ) : (
          <div className="frame-empty">
            {state.running ? "Waiting for first frame…" : "Not capturing. Click Start to begin."}
          </div>
        )}
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
