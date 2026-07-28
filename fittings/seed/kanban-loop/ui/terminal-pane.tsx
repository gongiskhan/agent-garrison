// Copied verbatim from dev-env/ui/terminal-pane.tsx (no logic change): an
// xterm.js pane bridged to a server PTY over the /io WebSocket. The prop is
// `ptyId` (the kanban terminal modal uses `card-<cardId>-shell`).

import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { currentTheme, subscribe as subscribeTheme } from "./terminal-theme";

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
  const tmuxModeRef = useRef(false);
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
      theme: currentTheme(),
      allowProposedApi: true
    });
    // Re-theme in place when the user switches light/dark/system (or the OS
    // changes while following system) — never remount the live PTY.
    const unsubscribeTheme = subscribeTheme(() => {
      try { term.options.theme = currentTheme(); } catch {}
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    // xterm.js renders its selection in its own layer (not the DOM), and its
    // hidden helper textarea is empty, so the browser's native Cmd/Ctrl+C copies
    // nothing — the host app must wire copy itself. Bind the platform copy combo
    // (Cmd+C on macOS, Ctrl+Shift+C elsewhere) to write the current selection to
    // the clipboard. Plain Ctrl+C is left alone so it still sends SIGINT to the
    // PTY, and native right-click / paste are untouched.
    const isMac = typeof navigator !== "undefined" &&
      /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || "");
    const copyToClipboard = (text: string) => {
      if (!text) return;
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {}
      };
      // navigator.clipboard.writeText returns a promise that REJECTS when the
      // page lacks clipboard-write permission (e.g. when this view is embedded
      // in Garrison's cross-origin iframe). Await the rejection and fall back to
      // execCommand so copy still works either way.
      try {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(fallback);
          return;
        }
      } catch {}
      fallback();
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Shift+Enter inserts a soft newline in the Claude Code prompt instead of
      // submitting it. xterm sends CR (\r) for Enter, which Claude treats as
      // submit; a bare line feed (\n — the byte Ctrl+J emits) is Claude's
      // universal "insert newline" and needs no terminal keyboard-protocol
      // negotiation (unlike a CSI-u sequence, which xterm.js does not enable).
      if (ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const sock = socketRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(new TextEncoder().encode("\n"));
        }
        ev.preventDefault();
        return false;
      }
      const key = ev.key.toLowerCase();
      const isCopy = key === "c" && (isMac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && ev.shiftKey);
      if (isCopy) {
        const sel = term.getSelection();
        if (sel) { copyToClipboard(sel); ev.preventDefault(); return false; }
      }
      return true;
    });

    // Alt-screen TUIs (Claude Code, vim, less, ...) replace xterm's scrollback
    // with their own buffer, so xterm has nothing to scroll. Translate vertical
    // wheel motion into arrow-key escape sequences so the embedded TUI can
    // scroll its own contents.
    //
    // Under tmux (tmuxModeRef, set from init_ack) this is skipped entirely: the
    // outer xterm is ALWAYS in the alternate screen, so the heuristic would
    // hijack every scroll. tmux's own mouse mode handles wheel→history instead
    // (and Shift+drag still does native text selection).
    type WheelHandlerHost = {
      attachCustomWheelEventHandler?: (handler: (ev: WheelEvent) => boolean) => void;
    };
    const wheelHost = term as unknown as WheelHandlerHost;
    if (typeof wheelHost.attachCustomWheelEventHandler === "function") {
      wheelHost.attachCustomWheelEventHandler((ev: WheelEvent) => {
        if (tmuxModeRef.current) return true; // tmux owns scrolling
        if (term.buffer.active.type !== "alternate") return true;
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return false;
        const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / 16));
        const seq = (ev.deltaY < 0 ? "\x1b[A" : "\x1b[B").repeat(lines);
        sock.send(new TextEncoder().encode(seq));
        return false;
      });
    }

    // Continuous edge auto-scroll while drag-selecting under tmux. tmux's
    // copy-mode only advances the scroll on each fresh mouse-motion event, so
    // holding the pointer still at the top/bottom edge stops scrolling — the
    // user has to "hammer" the mouse. A normal terminal scrolls continuously
    // while held at the edge. We restore that by feeding tmux synthetic SGR
    // drag-motion events at the edge row on a timer — automating the jiggle the
    // user would otherwise do by hand. The column is alternated by 1 each tick
    // so tmux registers genuine movement (it ignores motion to the same cell).
    const mountEl = containerRef.current;
    let dragging = false;
    let edgeRow = 0; // 0 = pointer not in an edge zone
    let lastCol = 1;
    let tick = 0;
    let edgeTimer: ReturnType<typeof setInterval> | null = null;
    const EDGE_PX = 20;
    const stopEdgeScroll = () => {
      if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
    };
    const onTermMouseDown = (e: MouseEvent) => {
      if (e.button === 0 && tmuxModeRef.current) dragging = true;
    };
    const onWinMouseUp = () => { dragging = false; stopEdgeScroll(); };
    const onWinMouseMove = (e: MouseEvent) => {
      if (!dragging || !tmuxModeRef.current || !mountEl) return;
      const rect = mountEl.getBoundingClientRect();
      const cellW = rect.width / Math.max(1, term.cols);
      lastCol = Math.max(1, Math.min(term.cols, Math.floor((e.clientX - rect.left) / cellW) + 1));
      if (e.clientY - rect.top < EDGE_PX) edgeRow = 1;
      else if (rect.bottom - e.clientY < EDGE_PX) edgeRow = term.rows;
      else edgeRow = 0;
      if (edgeRow) {
        if (!edgeTimer) {
          edgeTimer = setInterval(() => {
            if (!edgeRow) return;
            const sock = socketRef.current;
            if (!sock || sock.readyState !== WebSocket.OPEN) return;
            // tmux only scrolls when the drag RE-reaches the edge, not while it
            // is held there — and its edge-scroll zone is a few rows deep, so a
            // 1-2 row wiggle never leaves it. Alternate between the edge row and
            // ~3 rows inside so every other tick re-enters the edge and triggers
            // one more line of scroll → continuous auto-scroll while held.
            const inside = edgeRow === 1 ? 4 : Math.max(1, edgeRow - 3);
            const row = (tick++ & 1) ? edgeRow : inside;
            // SGR mouse: button 32 = motion with the left button held.
            sock.send(new TextEncoder().encode(`\x1b[<32;${lastCol};${row}M`));
          }, 30);
        }
      } else {
        stopEdgeScroll();
      }
    };
    mountEl?.addEventListener("mousedown", onTermMouseDown);
    window.addEventListener("mousemove", onWinMouseMove);
    window.addEventListener("mouseup", onWinMouseUp);

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
              if (msg.type === "init_ack") { tmuxModeRef.current = msg.tmux === true; return; }
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
      unsubscribeTheme();
      stopEdgeScroll();
      mountEl?.removeEventListener("mousedown", onTermMouseDown);
      window.removeEventListener("mousemove", onWinMouseMove);
      window.removeEventListener("mouseup", onWinMouseUp);
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
