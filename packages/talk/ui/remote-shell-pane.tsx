// Terminal pane for remote-shell threads — an xterm.js view over the
// same-origin /remote-shell/io relay (the web-channel server pipes it to the
// remote-shell fitting's WS, which is an `ssh -tt … tmux attach` PTY).
//
// Inside the workbench (`hideBar`), the pane is chrome-free: the command deck
// above it owns state/identity/reconnect, fed through `onMetaChange`, and
// `reconnectNonce` re-runs the attach effect. Standalone (the fitting's own
// UI), the built-in bar remains.

import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachTerminalScrolling } from "./terminal-scroll";

export interface RemoteShellMeta {
  agentState: "running" | "idle" | null;
  status: string | null;
}

export function RemoteShellPane({
  sessionId,
  hideBar = false,
  reconnectNonce = 0,
  onMetaChange,
}: {
  sessionId: string;
  hideBar?: boolean;
  reconnectNonce?: number;
  onMetaChange?: (m: RemoteShellMeta) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // The stream is a tmux attach (init_ack), which decides how scrolling works —
  // see terminal-scroll.ts.
  const tmuxModeRef = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<"running" | "idle" | null>(null);
  const [generation, setGeneration] = useState(0);
  const onMetaRef = useRef(onMetaChange);
  onMetaRef.current = onMetaChange;

  useEffect(() => {
    onMetaRef.current?.({ agentState, status });
  }, [agentState, status]);

  useEffect(() => {
    if (!containerRef.current) return;
    const mountEl = containerRef.current;
    let cancelled = false;
    tmuxModeRef.current = false;
    setStatus(null);
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      convertEol: false,
      allowProposedApi: true,
      // The Fortress terminal ground (same-family darkening of olive-950).
      // No ANSI palette override — the remote TUI brings its own colors.
      theme: {
        background: "#10140f",
        foreground: "#e2ddd0",  /* 13.9:1 on term-bg */
        cursor: "#c8ae66",
        cursorAccent: "#10140f",
        selectionBackground: "#3d4a3e"
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

    const detachScrolling = attachTerminalScrolling(term, mountEl, {
      isTmux: () => tmuxModeRef.current
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
                tmuxModeRef.current = msg.tmux === true;
                if (msg.state === "running" || msg.state === "idle") setAgentState(msg.state);
                return;
              }
              if (msg.type === "state") {
                if (msg.state === "running" || msg.state === "idle") setAgentState(msg.state);
                return;
              }
              if (msg.type === "pong") return;
              if (msg.type === "error") { setStatus(msg.message); return; }
              if (msg.type === "detached") { setStatus("detached"); return; }
            }
          } catch {}
        }
        term.write(ev.data);
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
      term.write(buf);
    });
    socket.addEventListener("close", () => { if (!cancelled) setStatus((s) => s ?? "connection closed"); });
    socket.addEventListener("error", () => { if (!cancelled) setStatus((s) => s ?? "connection error"); });

    term.onData((d) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(d));
    });

    // Trailing-debounced refit: a seam drag emits a handful of resize frames,
    // not one per animation frame — every resize redraws the remote TUI over
    // the tunnel.
    let refitTimer: ReturnType<typeof setTimeout> | null = null;
    const refit = () => {
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        try {
          fit.fit();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {}
      }, 200);
    };
    const resizeObs = new ResizeObserver(refit);
    resizeObs.observe(containerRef.current);
    window.addEventListener("resize", refit);

    return () => {
      cancelled = true;
      if (refitTimer) clearTimeout(refitTimer);
      detachScrolling();
      window.removeEventListener("resize", refit);
      resizeObs.disconnect();
      try { socket.close(); } catch {}
      try { term.dispose(); } catch {}
      socketRef.current = null;
    };
  }, [sessionId, generation, reconnectNonce]);

  return (
    <div className="wc-rsh">
      {!hideBar && (
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
      )}
      <div ref={containerRef} className="wc-rsh-term" data-testid="remote-shell-pane" />
    </div>
  );
}
