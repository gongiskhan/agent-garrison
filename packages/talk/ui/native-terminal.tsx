import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachTerminalScrolling } from "./terminal-scroll";
import { nativeTerminalEventText } from "./native-terminal-text";

/** A terminal observer for a session owned by an existing native client. No
 * input is sent to that client and no duplicate agent is spawned on open. */
export function NativeTerminal({ streamUrl }: { streamUrl: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("Connecting…");
  useEffect(() => {
    if (!mount.current) return;
    const term = new Terminal({
      disableStdin: true, cursorBlink: false, fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000, convertEol: true,
      theme: { background: "#10140f", foreground: "#e2ddd0", selectionBackground: "#3d4a3e" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(mount.current);
    const detachScrolling = attachTerminalScrolling(term, mount.current, { isTmux: () => false });
    const resize = new ResizeObserver(() => { try { fit.fit(); } catch { /* detached */ } });
    resize.observe(mount.current);
    try { fit.fit(); } catch { /* first layout pending */ }
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closedRetries = 0;
    let stopped = false;
    const clearRetry = () => { if (retryTimer !== null) clearTimeout(retryTimer); retryTimer = null; };
    const rendered = new Map<string, string>();
    let sequence = 0;
    const onMessage = (event: MessageEvent) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === "init") {
        closedRetries = 0;
        term.reset();
        rendered.clear();
        setState(frame.available ? "Live output · read only" : "No session output yet");
      }
      if (frame.type === "init" || frame.type === "events") {
        let changed = false;
        let revised = false;
        let appended = "";
        for (const entry of frame.events ?? []) {
          const text = nativeTerminalEventText(entry);
          const id = String(entry.id ?? `event-${sequence++}`);
          const previous = rendered.get(id);
          if (previous === text) continue;
          if (previous !== undefined) revised = true;
          rendered.set(id, text);
          changed = true;
          appended += text;
        }
        // Keep the in-memory observer bounded as well as the terminal itself.
        while (rendered.size > 500) { rendered.delete(rendered.keys().next().value!); revised = true; }
        if (changed && revised) {
          const viewport = term.buffer.active.viewportY;
          const atBottom = viewport >= term.buffer.active.baseY;
          term.reset();
          term.write([...rendered.values()].join(""), () => { if (!atBottom) term.scrollToLine(viewport); });
        } else if (changed) term.write(appended);
      }
      if (frame.type === "end") {
        stopped = true; clearRetry(); source?.close();
        setState("Session output · read only");
      }
    };
    const connect = () => {
      if (stopped) return;
      const current = new EventSource(streamUrl);
      source = current;
      current.onmessage = (event) => { if (!stopped && source === current) onMessage(event); };
      current.onerror = () => {
        if (stopped || source !== current) return;
        // A dropped healthy SSE stays CONNECTING and retries itself. HTTP502
        // can instead leave it permanently CLOSED: replace only that source.
        if (current.readyState !== EventSource.CLOSED) {
          setState("Reconnecting to session output…");
          return;
        }
        current.onmessage = null; current.onerror = null; current.close();
        if (retryTimer !== null) return;
        if (closedRetries >= 5) {
          setState("Session output unavailable. Reopen to retry.");
          return;
        }
        setState("Reconnecting to session output…");
        const delay = Math.min(1000 * 2 ** closedRetries++, 10_000);
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
      };
    };
    setState("Connecting…");
    connect();
    return () => {
      stopped = true; clearRetry();
      if (source) { source.onmessage = null; source.onerror = null; source.close(); }
      resize.disconnect(); detachScrolling(); term.dispose();
    };
  }, [streamUrl]);
  return <div className="wc-native-terminal" data-testid="native-shell-view" aria-label="Shell session output">
    <div className="wc-native-terminal-mount" ref={mount} />
    <span className="wc-native-terminal-state" role="status">{state}</span>
  </div>;
}
