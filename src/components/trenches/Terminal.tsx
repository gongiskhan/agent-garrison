"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string;
  wsUrl: string;
  onClose?: () => void;
}

export function TerminalView({ sessionId, wsUrl, onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fitAddon: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function boot() {
      if (!containerRef.current) return;
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (cancelled || !containerRef.current) return;

      term = new Terminal({
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
          selectionBackground: "#3b3b3b",
        },
        allowProposedApi: true,
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch {
        // initial layout may not be ready; resize handler retries
      }

      const cols = term.cols || 80;
      const rows = term.rows || 24;

      socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";

      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "init", sessionId, cols, rows }));
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "init_ack") {
              return;
            }
          } catch {
            // ignore
          }
          return;
        }
        const buf = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data;
        term?.write(buf as Uint8Array);
      });

      socket.addEventListener("close", () => {
        if (term && !cancelled) {
          term.writeln("\r\n[trenches] connection closed.");
        }
      });

      socket.addEventListener("error", () => {
        if (term && !cancelled) {
          term.writeln("\r\n[trenches] connection error.");
        }
      });

      term.onData((data) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });

      const refit = () => {
        if (!fitAddon || !term || !socket || socket.readyState !== WebSocket.OPEN) return;
        try {
          fitAddon.fit();
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch {
          // ignore
        }
      };

      resizeObserver = new ResizeObserver(refit);
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
      window.addEventListener("resize", refit);

      cleanupRef.current = () => {
        window.removeEventListener("resize", refit);
        resizeObserver?.disconnect();
        socket?.close(1000, "unmount");
        term?.dispose();
      };
    }

    void boot();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [sessionId, wsUrl]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        background: "#0e0e0e",
        padding: 6,
        height: "100%",
        minHeight: 0,
      }}
      onClick={() => {
        // xterm.js focuses on click via its own logic; nothing extra needed.
        if (onClose) {
          // suppress unused-onClose warning while leaving the API open for T2 cleanup wiring
        }
      }}
    />
  );
}
