import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";

// ── types (mirror the server's /api/state payload) ──────────────────────────

type Signal = {
  id: string;
  label: string;
  blocking: boolean;
  value: unknown;
  detail?: Record<string, unknown>;
  error?: string;
};

type PowerState = {
  now: string;
  busy: boolean;
  suspending: boolean;
  state: "idle" | "busy" | "suspending";
  countdown: {
    remainingMs: number;
    remainingSeconds: number;
    idleMinutes: number;
    clearSince: string | null;
  };
  signals: Signal[];
  keepAwake: { until: string; hours?: number } | null;
  lastSuspend: { at: string; kind: string; message?: string; error?: string } | null;
  awakeHours: { today: number; last7d: number };
  config: {
    idle_minutes: number;
    load_threshold: number;
    bind_host: string;
    port: number;
    power_page_url: string;
  };
};

// ── formatting helpers ──────────────────────────────────────────────────────

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "none";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "none";
  const delta = Math.max(0, Date.now() - then);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function signalValueText(s: Signal): string {
  switch (s.id) {
    case "sessions": {
      const n = Number(s.value) || 0;
      return `${n} working`;
    }
    case "kanban": {
      const n = Number(s.value) || 0;
      return `${n} in flight`;
    }
    case "presence":
      return typeof s.value === "string" ? fmtRelative(s.value as string) : "none";
    case "ssh": {
      const active = Number(s.value) || 0;
      const attached = Number((s.detail as { attached?: number })?.attached ?? 0);
      return `${active} active / ${attached} attached`;
    }
    case "load": {
      const l = typeof s.value === "number" ? (s.value as number).toFixed(2) : "-";
      const th = Number((s.detail as { threshold?: number })?.threshold ?? 0);
      return `${l} (limit ${th.toFixed(2)})`;
    }
    case "keepAwake":
      return typeof s.value === "string" ? `until ${fmtTime(s.value as string)}` : "off";
    default:
      return s.value == null ? "-" : String(s.value);
  }
}

// ── small building blocks ───────────────────────────────────────────────────

function StateBadge({ state }: { state: PowerState["state"] }) {
  const label = state === "suspending" ? "SUSPENDING" : state === "busy" ? "BUSY" : "IDLE";
  return <span className={`badge badge-${state}`}>{label}</span>;
}

function SignalRow({ signal }: { signal: Signal }) {
  return (
    <li className={"signal-row" + (signal.blocking ? " signal-blocking" : "")}>
      <span className="signal-dot" aria-hidden="true" />
      <span className="signal-label">{signal.label}</span>
      <span className="signal-value mono">
        {signal.error ? <span className="signal-error">error: {signal.error}</span> : signalValueText(signal)}
      </span>
    </li>
  );
}

// ── the app ─────────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<PowerState | null>(null);
  const [connected, setConnected] = useState(false);
  const [warning, setWarning] = useState<{ seconds: number; reason: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  const warnTimer = useRef<number | null>(null);

  // Live state over SSE.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "suspend-warning") {
          setWarning({ seconds: data.seconds, reason: data.reason });
        } else if (data.state) {
          setState(data.state as PowerState);
          setConnected(true);
        }
      } catch {
        // ignore a torn frame
      }
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  // Local per-second countdown so the display ticks smoothly between server
  // pushes; the server remains the source of truth (each tick resyncs it).
  const [localRemaining, setLocalRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!state) return;
    setLocalRemaining(state.busy ? null : state.countdown.remainingSeconds);
  }, [state]);
  useEffect(() => {
    if (localRemaining == null) return;
    const h = window.setInterval(() => {
      setLocalRemaining((r) => (r == null ? r : Math.max(0, r - 1)));
    }, 1000);
    return () => window.clearInterval(h);
  }, [localRemaining == null]);

  // Count the suspend warning banner down to zero.
  useEffect(() => {
    if (!warning) return;
    if (warnTimer.current) window.clearInterval(warnTimer.current);
    warnTimer.current = window.setInterval(() => {
      setWarning((w) => {
        if (!w) return w;
        if (w.seconds <= 1) return null;
        return { ...w, seconds: w.seconds - 1 };
      });
    }, 1000) as unknown as number;
    return () => {
      if (warnTimer.current) window.clearInterval(warnTimer.current);
    };
  }, [warning?.reason]);

  const post = useCallback(async (path: string, body?: unknown, method = "POST") => {
    try {
      await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      // best-effort; the next SSE tick reflects reality
    }
  }, []);

  const onSuspendClick = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 5000) as unknown as number;
      return;
    }
    setConfirming(false);
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    post("/api/suspend", { confirm: true });
  }, [confirming, post]);

  const keepAwake = useCallback((hours: number) => post("/api/keep-awake", { hours }), [post]);
  const cancelKeepAwake = useCallback(() => post("/api/keep-awake", undefined, "DELETE"), [post]);

  // Debounced settings autosave (no Save button — Garrison convention).
  const settingsTimer = useRef<number | null>(null);
  const putConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
      settingsTimer.current = window.setTimeout(() => post("/api/config", patch, "PUT"), 500) as unknown as number;
    },
    [post]
  );

  if (!state) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Power</h1>
        </header>
        <div className="loading">Connecting to the idle watcher…</div>
      </div>
    );
  }

  const remaining = localRemaining ?? state.countdown.remainingSeconds;
  const keepAwakeActive = Boolean(state.keepAwake);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Power</h1>
        <StateBadge state={state.state} />
        {!connected && <span className="conn-lost">reconnecting…</span>}
      </header>

      {warning && (
        <div className="warning-banner" role="alert">
          Suspending in {warning.seconds}s ({warning.reason})
        </div>
      )}

      <section className="hero">
        {state.busy ? (
          <>
            <div className="hero-label">Box is busy</div>
            <div className="hero-sub muted">a signal is holding it awake</div>
          </>
        ) : state.suspending ? (
          <>
            <div className="hero-label">Suspending</div>
            <div className="hero-sub muted">flushing + requesting suspend</div>
          </>
        ) : (
          <>
            <div className="hero-count mono">{fmtClock(remaining)}</div>
            <div className="hero-sub muted">until self-suspend</div>
          </>
        )}
      </section>

      <section className="actions">
        <button className={"btn btn-suspend" + (confirming ? " btn-confirm" : "")} onClick={onSuspendClick}>
          {confirming ? "Tap again to confirm" : "Suspend Now"}
        </button>
      </section>

      <section className="panel">
        <div className="panel-title">Keep Awake</div>
        {keepAwakeActive ? (
          <div className="keep-active">
            <span className="mono">until {fmtTime(state.keepAwake!.until)}</span>
            <button className="btn btn-ghost" onClick={cancelKeepAwake}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="keep-buttons">
            {[1, 4, 8].map((h) => (
              <button key={h} className="btn btn-pill" onClick={() => keepAwake(h)}>
                {h}h
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">Busy signals</div>
        <ul className="signal-list">
          {state.signals.map((s) => (
            <SignalRow key={s.id} signal={s} />
          ))}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-title">Awake hours</div>
        <div className="awake-grid">
          <div className="awake-cell">
            <div className="awake-num mono">{state.awakeHours.today.toFixed(1)}h</div>
            <div className="awake-cap muted">today</div>
          </div>
          <div className="awake-cell">
            <div className="awake-num mono">{state.awakeHours.last7d.toFixed(1)}h</div>
            <div className="awake-cap muted">last 7 days</div>
          </div>
        </div>
      </section>

      {state.lastSuspend && (
        <section className={"panel" + (state.lastSuspend.kind === "suspend-failed" ? " panel-warn" : "")}>
          <div className="panel-title">Last suspend</div>
          <div className="last-suspend">
            <span className="mono">{fmtTime(state.lastSuspend.at)}</span>
            <span>{state.lastSuspend.message ?? state.lastSuspend.kind}</span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-title">Settings</div>
        <label className="setting">
          <span>Idle minutes</span>
          <input
            type="number"
            min={1}
            defaultValue={state.config.idle_minutes}
            onChange={(e) => putConfig({ idle_minutes: Number(e.target.value) })}
          />
        </label>
        <label className="setting">
          <span>Load threshold</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            defaultValue={state.config.load_threshold}
            onChange={(e) => putConfig({ load_threshold: Number(e.target.value) })}
          />
        </label>
      </section>

      {state.config.power_page_url && (
        <section className="panel">
          <div className="panel-title">Wake this box from outside</div>
          <input className="copy-field mono" readOnly value={state.config.power_page_url} onFocus={(e) => e.currentTarget.select()} />
        </section>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
