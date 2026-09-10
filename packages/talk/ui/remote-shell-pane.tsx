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
import { shellFetch } from "./shell-origin";

export interface RemoteShellMeta {
  agentState: "running" | "idle" | null;
  status: string | null;
}

export function RemoteShellPane({
  sessionId,
  hideBar = false,
  reconnectNonce = 0,
  onMetaChange,
  ioUrl,
  httpBase,
}: {
  sessionId: string;
  hideBar?: boolean;
  reconnectNonce?: number;
  onMetaChange?: (m: RemoteShellMeta) => void;
  /** Override the socket URL - a Shells-fitting session on ANOTHER node's
   *  origin (the direct-origin client, shell-origin.ts) rather than the
   *  same-origin /remote-shell/io relay. Must already be a full ws(s):// URL. */
  ioUrl?: string;
  /** Same-origin control path also keeps the terminal usable when a phone
   * cannot open a direct WebSocket to the owner. */
  httpBase?: string;
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
    setAgentState(null);
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
    const socket = new WebSocket(ioUrl ?? `${proto}//${window.location.host}/remote-shell/io`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let socketReady = false;
    let fallback = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScreen = "";
    const control = (action: string, body: object) => shellFetch(httpBase!, `/sessions/${encodeURIComponent(sessionId)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const pollScreen = async () => {
      if (cancelled || !fallback || !httpBase) return;
      try {
        const screen = await shellFetch<{text: string; state: string}>(httpBase, `/sessions/${encodeURIComponent(sessionId)}/screen?terminal=1`, {}, { timeoutMs: 8000 });
        if (cancelled || !fallback) return;
        if (typeof screen.text !== "string") throw new Error("The terminal did not return its screen.");
        if (screen.text !== lastScreen) {
          term.write("\x1b[H\x1b[2J" + screen.text.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r\n"));
          lastScreen = screen.text;
        }
        setAgentState(screen.state === "running" ? "running" : "idle");
        setStatus(null);
      } catch (err) { if (!cancelled) setStatus(err instanceof Error ? err.message : "Terminal unavailable"); }
      if (!cancelled && fallback) pollTimer = setTimeout(() => { void pollScreen(); }, 1000);
    };
    const beginFallback = () => {
      if (cancelled || fallback || socketReady || !httpBase) return;
      fallback = true;
      tmuxModeRef.current = false;
      void control("resize", { cols: term.cols, rows: term.rows }).catch(() => {});
      void pollScreen();
    };
    const fallbackTimer = setTimeout(beginFallback, 3000);
    const handshakeTimer = setTimeout(() => {
      if (cancelled) return;
      if (!fallback) setStatus("Shell connection timed out. Reattach to retry.");
      beginFallback();
      socket.close();
    }, 8000);

    socket.addEventListener("open", () => {
      if (cancelled) return;
      setStatus(null);
      socket.send(JSON.stringify({ type: "init", sessionId, cols: term.cols, rows: term.rows }));
    });
    socket.addEventListener("message", (ev) => {
      if (cancelled) return;
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("{")) {
          try {
            const msg = JSON.parse(ev.data);
            if (msg && typeof msg.type === "string") {
              if (msg.type === "init_ack") {
                socketReady = true;
                fallback = false;
                if (pollTimer) clearTimeout(pollTimer);
                clearTimeout(fallbackTimer);
                setStatus(null);
                clearTimeout(handshakeTimer);
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
    const disconnected = () => {
      clearTimeout(handshakeTimer);
      socketReady = false;
      if (httpBase) beginFallback();
      else if (!cancelled) setStatus(s => s ?? "connection closed");
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);

    let inputQueue = Promise.resolve();
    term.onData((d) => {
      if (socketReady && socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(d));
      else if (httpBase) inputQueue = inputQueue.then(async () => {
        if (!cancelled) await control("bytes", { data: d });
      }).catch(err => { if (!cancelled) setStatus(err instanceof Error ? err.message : "Input was not accepted"); });
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
          } else if (httpBase) void control("resize", { cols: term.cols, rows: term.rows }).catch(() => {});
        } catch {}
      }, 200);
    };
    const resizeObs = new ResizeObserver(refit);
    resizeObs.observe(containerRef.current);
    window.addEventListener("resize", refit);

    return () => {
      cancelled = true;
      clearTimeout(handshakeTimer);
      clearTimeout(fallbackTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (refitTimer) clearTimeout(refitTimer);
      detachScrolling();
      window.removeEventListener("resize", refit);
      resizeObs.disconnect();
      try { socket.close(); } catch {}
      try { term.dispose(); } catch {}
      socketRef.current = null;
    };
  }, [sessionId, generation, reconnectNonce, ioUrl, httpBase]);

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
