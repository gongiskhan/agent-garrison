// Terminal pane for remote-shell threads — an xterm.js view over the
// same-origin /remote-shell/io relay (the web-channel server pipes it to the
// remote-shell fitting's WS, which is an `ssh -tt … tmux attach` PTY).
// Protocol and behaviours are the dev-env TerminalPane's, trimmed: the remote
// pane is ALWAYS tmux-backed, so the wheel is left to tmux's own mouse mode,
// and the terminal keeps its own dark palette regardless of the channel skin.

import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export function RemoteShellPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<"running" | "idle" | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      convertEol: false,
      allowProposedApi: true,
      theme: {
        background: "#0e0e0e",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        cursorAccent: "#0e0e0e",
        selectionBackground: "#3b3b3b"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch {}

    // Platform copy combo (plain Ctrl+C must still reach the remote TUI).
    const isMac = typeof navigator !== "undefined" &&
      /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      const isCopy = key === "c" && (isMac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && ev.shiftKey);
      if (isCopy) {
        const sel = term.getSelection();
        if (sel) {
          try { void navigator.clipboard?.writeText(sel); } catch {}
          ev.preventDefault();
          return false;
        }
      }
      return true;
    });

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/remote-shell/io`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setStatus(null);
      socket.send(JSON.stringify({ type: "init", sessionId, cols: term.cols, rows: term.rows }));
    });
    socket.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("{")) {
          try {
            const msg = JSON.parse(ev.data);
            if (msg && typeof msg.type === "string") {
              if (msg.type === "init_ack") {
                if (msg.state === "running" || msg.state === "idle") setAgentState(msg.state);
                return;
              }
              if (msg.type === "state") {
                if (msg.state === "running" || msg.state === "idle") setAgentState(msg.state);
                return;
              }
              if (msg.type === "pong") return;
              if (msg.type === "error") { setStatus(msg.message); return; }
              if (msg.type === "detached") { setStatus("detached — reconnect to reattach"); return; }
            }
          } catch {}
        }
        term.write(ev.data);
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
      term.write(buf);
    });
    socket.addEventListener("close", () => { if (!cancelled) setStatus("connection closed — tap Reconnect"); });
    socket.addEventListener("error", () => { if (!cancelled) setStatus("connection error — tap Reconnect"); });

    term.onData((d) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(d));
    });

    const refit = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };
    const resizeObs = new ResizeObserver(refit);
    resizeObs.observe(containerRef.current);
    window.addEventListener("resize", refit);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", refit);
      resizeObs.disconnect();
      try { socket.close(); } catch {}
      try { term.dispose(); } catch {}
      socketRef.current = null;
    };
  }, [sessionId, generation]);

  return (
    <div className="wc-rsh">
      <div className="wc-rsh-bar">
        <span className={`wc-rsh-dot${agentState === "running" ? " wc-rsh-dot--running" : ""}`} aria-hidden />
        <span className="wc-rsh-state">{agentState === "running" ? "Agent working" : agentState === "idle" ? "Agent idle" : "Connecting"}</span>
        {status && (
          <>
            <span className="wc-rsh-status">{status}</span>
            <button type="button" className="wc-rsh-reconnect" onClick={() => { setStatus(null); setGeneration((g) => g + 1); }}>
              Reconnect
            </button>
          </>
        )}
      </div>
      <div ref={containerRef} className="wc-rsh-term" data-testid="remote-shell-pane" />
    </div>
  );
}
