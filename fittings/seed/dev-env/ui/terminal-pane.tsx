// Verbatim port of terminal-armory-default ui/main.tsx TerminalPane — an
// xterm.js pane bridged to a server PTY over the /io WebSocket. The only
// change: the prop is `ptyId` (dev-env PTY ids are <sessionId>-<role>).

import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export function TerminalPane({
  ptyId,
  isActive,
  onPtyData
}: {
  ptyId: string;
  isActive: boolean;
  onPtyData?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onPtyDataRef = useRef(onPtyData);
  onPtyDataRef.current = onPtyData;
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      convertEol: false,
      theme: {
        background: "#0e0e0e",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        cursorAccent: "#0e0e0e",
        selectionBackground: "#3b3b3b"
      },
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    // Alt-screen TUIs (Claude Code, vim, less, ...) replace xterm's scrollback
    // with their own buffer, so xterm has nothing to scroll. Translate vertical
    // wheel motion into arrow-key escape sequences so the embedded TUI can
    // scroll its own contents.
    type WheelHandlerHost = {
      attachCustomWheelEventHandler?: (handler: (ev: WheelEvent) => boolean) => void;
    };
    const wheelHost = term as unknown as WheelHandlerHost;
    if (typeof wheelHost.attachCustomWheelEventHandler === "function") {
      wheelHost.attachCustomWheelEventHandler((ev: WheelEvent) => {
        if (term.buffer.active.type !== "alternate") return true;
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return false;
        const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / 16));
        const seq = (ev.deltaY < 0 ? "\x1b[A" : "\x1b[B").repeat(lines);
        sock.send(new TextEncoder().encode(seq));
        return false;
      });
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/io`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "init", sessionId: ptyId, cols: term.cols, rows: term.rows }));
    });

    socket.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("{")) {
          try {
            const msg = JSON.parse(ev.data);
            if (msg && typeof msg.type === "string") {
              if (msg.type === "init_ack") return;
              if (msg.type === "pong") return;
              if (msg.type === "error") { term.writeln(`\r\n[error: ${msg.message}]`); return; }
              if (msg.type === "exit") { term.writeln(`\r\n[exit code=${msg.exitCode}]`); return; }
            }
          } catch {}
        }
        term.write(ev.data);
        onPtyDataRef.current?.(ptyId);
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
      term.write(buf);
      onPtyDataRef.current?.(ptyId);
    });

    socket.addEventListener("close", () => {
      if (!cancelled) setBridgeMsg("connection closed");
    });
    socket.addEventListener("error", () => {
      if (!cancelled) setBridgeMsg("connection error");
    });

    term.onData((d) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(d));
      }
    });

    const refit = () => {
      if (!containerRef.current) return;
      // Skip when not laid out — fit() would compute 0x0 and break the PTY size.
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };
    resizeObs = new ResizeObserver(refit);
    resizeObs.observe(containerRef.current);
    window.addEventListener("resize", refit);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", refit);
      resizeObs?.disconnect();
      try { socket.close(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [ptyId]);

  // When this pane becomes active again, the container went from display:none
  // (zero size) back to a real layout — re-fit, push the new cols/rows to the
  // PTY, and focus so the cursor is ready to type.
  useEffect(() => {
    if (!isActive) return;
    const t = termRef.current;
    const f = fitRef.current;
    const c = containerRef.current;
    if (!t || !f || !c) return;
    const rafId = requestAnimationFrame(() => {
      try {
        const rect = c.getBoundingClientRect();
        if (rect.width >= 10 && rect.height >= 10) {
          f.fit();
          const sock = socketRef.current;
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
          }
        }
        t.focus();
      } catch {}
    });
    return () => cancelAnimationFrame(rafId);
  }, [isActive]);

  return (
    <div className={`term-host ${isActive ? "" : "hidden"}`}>
      {bridgeMsg && <div className="bridge-banner">{bridgeMsg}</div>}
      <div ref={containerRef} className="xterm-mount" data-testid="terminal-pane" />
    </div>
  );
}
