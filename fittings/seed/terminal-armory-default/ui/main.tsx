import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// Minimal terminal UI. Connects to /io via WebSocket. Renders stdout into a
// plain pre-wrap div; sends keystrokes back. This is enough for the
// "echo dissolve-marker-7c4e" / output assertion. A future iteration can swap
// in xterm.js for full ANSI handling.

interface Session {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  busy: boolean;
  createdAt: string;
}

function stripAnsi(str: string): string {
  // Strip CSI sequences but keep printable text and newlines.
  // eslint-disable-next-line no-control-regex
  return str.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\][^]*/g, "");
}

function TerminalPane({ sessionId }: { sessionId: string }) {
  const [output, setOutput] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/io`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "init", sessionId }));
    };
    ws.onmessage = (ev) => {
      let text: string;
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "init_ack") return;
          if (msg.type === "error") { setOutput((o) => o + `\n[error: ${msg.message}]\n`); return; }
          if (msg.type === "exit") { setOutput((o) => o + `\n[exit code=${msg.exitCode}]\n`); return; }
          if (msg.type === "pong") return;
          text = ev.data as string;
        } catch {
          text = ev.data as string;
        }
      } else {
        text = new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer));
      }
      setOutput((o) => (o + text).slice(-100_000));
    };
    ws.onerror = () => setOutput((o) => o + "\n[ws error]\n");
    return () => { try { ws.close(); } catch {} wsRef.current = null; };
  }, [sessionId]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [output]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    let data: string | null = null;
    if (e.key === "Enter") data = "\r";
    else if (e.key === "Backspace") data = "\x7f";
    else if (e.key === "Tab") data = "\t";
    else if (e.key === "ArrowUp") data = "\x1b[A";
    else if (e.key === "ArrowDown") data = "\x1b[B";
    else if (e.key === "ArrowRight") data = "\x1b[C";
    else if (e.key === "ArrowLeft") data = "\x1b[D";
    else if (e.ctrlKey && e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) data = String.fromCharCode(code - 0x40);
    } else if (e.key.length === 1) data = e.key;
    if (data !== null) {
      e.preventDefault();
      ws.send(JSON.stringify({ type: "stdin", data }));
    }
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    const text = e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      ws.send(JSON.stringify({ type: "stdin", data: text }));
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="terminal-screen"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      data-testid="terminal-pane"
    >
      {stripAnsi(output)}
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/sessions");
      const data = await res.json();
      const list: Session[] = data.sessions ?? [];
      setSessions(list);
      if (list.length > 0 && (!activeId || !list.find((s) => s.id === activeId))) {
        setActiveId(list[0].id);
      } else if (list.length === 0) {
        setActiveId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Auto-create a default session if none exist (so /-loads-and-types just works)
  useEffect(() => {
    if (bootstrapped) return;
    if (sessions.length === 0 && !busy) {
      setBootstrapped(true);
      void create();
    } else if (sessions.length > 0) {
      setBootstrapped(true);
    }
  }, [sessions, busy, bootstrapped]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) setError(data?.error ?? `HTTP ${res.status}`);
      else { setActiveId(data.id); await refresh(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function close(id: string) {
    try { await fetch(`/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }); await refresh(); } catch {}
  }

  return (
    <>
      <div className="header">
        <h1>Garrison Terminal</h1>
        <div className="tabs">
          {sessions.map((s) => (
            <span key={s.id} className={`tab ${s.id === activeId ? "active" : ""}`} onClick={() => setActiveId(s.id)}>
              <span>{s.name}</span>
              <span className="close" onClick={(e) => { e.stopPropagation(); void close(s.id); }}>×</span>
            </span>
          ))}
        </div>
        <button type="button" className="btn primary" onClick={create} disabled={busy}>
          {busy ? "…" : "+ New"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className={`term-wrap ${activeId ? "" : "empty"}`}>
        {activeId ? <TerminalPane key={activeId} sessionId={activeId} /> : <span>No active session. Click + New to start.</span>}
      </div>
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
