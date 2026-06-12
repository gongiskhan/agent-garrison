import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface TabSummary {
  tabId: string;
  url: string;
  title: string;
  requestedUrl?: string;
}

function useRoute():
  | { kind: "list" }
  | { kind: "canvas"; initialTabId: string }
  | { kind: "devtools-shell"; initialTabId: string } {
  const [path] = useState(() => window.location.pathname);
  const canvasMatch = path.match(/^\/canvas\/([^/?#]+)/);
  if (canvasMatch) return { kind: "canvas", initialTabId: decodeURIComponent(canvasMatch[1]) };
  const shellMatch = path.match(/^\/devtools-shell\/([^/?#]+)/);
  if (shellMatch) return { kind: "devtools-shell", initialTabId: decodeURIComponent(shellMatch[1]) };
  return { kind: "list" };
}

type QualityLevel = "low" | "med" | "high";
const QUALITY_LS_KEY = "garrison-browser-quality";

function loadQuality(): QualityLevel {
  try {
    const v = window.localStorage.getItem(QUALITY_LS_KEY);
    if (v === "low" || v === "med" || v === "high") return v;
  } catch {}
  return "low";
}

// ─── Tabs list ─────────────────────────────────────────────────

function TabsList() {
  const [tabs, setTabs] = useState<TabSummary[]>([]);
  const [newUrl, setNewUrl] = useState("https://example.com");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/tabs");
      const json = await res.json();
      setTabs(Array.isArray(json.tabs) ? json.tabs : []);
    } catch { /* swallow */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl })
      });
      const json = await res.json();
      if (json.tabId) window.location.assign(`/canvas/${encodeURIComponent(json.tabId)}`);
    } finally {
      setBusy(false);
    }
  };

  const onClose = async (tabId: string) => {
    await fetch(`/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
    void refresh();
  };

  return (
    <div className="tabs-list">
      <h1>Garrison Browser</h1>
      <form className="new-tab-form" onSubmit={onCreate}>
        <input
          type="url"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="https://..."
          disabled={busy}
        />
        <button type="submit" disabled={busy}>+ Open tab</button>
      </form>
      {tabs.length === 0 ? (
        <div className="empty">No tabs open.</div>
      ) : (
        tabs.map((tab) => (
          <div key={tab.tabId} className="tab-row">
            <div className="meta">
              <div className="title">{tab.title || "(untitled)"}</div>
              <div className="url">{tab.url}</div>
            </div>
            <a href={`/canvas/${encodeURIComponent(tab.tabId)}`}>View</a>
            <a href={`/devtools-shell/${encodeURIComponent(tab.tabId)}`} target="_blank" rel="noreferrer">DevTools</a>
            <button onClick={() => void onClose(tab.tabId)}>Close</button>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Canvas page ──────────────────────────────────────────────

const SPECIAL_KEYS = new Set([
  "Backspace", "Tab", "Enter", "Escape", "Delete",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown"
]);

function CanvasPage({ initialTabId, inShell = false }: { initialTabId: string; inShell?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hiddenInputRef = useRef<HTMLInputElement | null>(null);
  const viewportWsRef = useRef<WebSocket | null>(null);
  const inputWsRef = useRef<WebSocket | null>(null);
  const lastSentViewportRef = useRef<{ width: number; height: number; dpr: number } | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const pendingAckRef = useRef(false);
  const ackRafRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const qualitySentRef = useRef<QualityLevel | null>(null);
  // TEMP: tab-swap timing instrumentation. swapStartRef marks the moment a
  // tab-swap (or initial mount) began; firstFrameSeenRef gates the
  // first-frame-after-connect log so we only print once per connect.
  const swapStartRef = useRef<number>(performance.now());
  const firstFrameSeenRef = useRef<boolean>(false);

  // tabId lives in state so the parent (terminal Fitting) can swap us to a
  // different browser tab via postMessage without an iframe reload.
  const [tabId, setTabId] = useState(initialTabId);
  const [urlValue, setUrlValue] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [quality, setQuality] = useState<QualityLevel>(() => loadQuality());
  // Set when the server reports the tab is gone (e.g. the Fitting restarted
  // and this id no longer exists). Suppresses the reconnect loop — retrying
  // a dead id can never succeed.
  const [fatalError, setFatalError] = useState<string | null>(null);
  const fatalRef = useRef<string | null>(null);

  const sendInput = useCallback((msg: object) => {
    const ws = inputWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  // Push the canvas wrapper's display size to the server so Chromium resizes
  // its viewport to match. The next screencast frame comes at the new size.
  // Only the client that holds the screencast may steer the shared Chromium
  // viewport: a stolen-from pane keeps a live input WS (input allows many
  // clients) and would otherwise reflow the page under the live viewer.
  const pushViewport = useCallback((force = false) => {
    if (viewportWsRef.current?.readyState !== WebSocket.OPEN) return;
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (!width || !height) return;
    const dpr = Math.max(1, Math.min(2, Math.round(window.devicePixelRatio || 1)));
    const last = lastSentViewportRef.current;
    if (!force && last && last.width === width && last.height === height && last.dpr === dpr) return;
    lastSentViewportRef.current = { width, height, dpr };
    sendInput({ type: "viewport", width, height, devicePixelRatio: dpr });
  }, [sendInput]);

  const queueResize = useCallback(() => {
    if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      pushViewport();
    }, 120);
  }, [pushViewport]);

  // RAF-throttled ACK: one ack per refresh tick regardless of how many frames
  // arrived. If the input WS isn't OPEN yet, retry on the next RAF — that
  // avoids the first-frame deadlock when the input WS opens slightly after
  // the viewport WS.
  const flushAck = useCallback(() => {
    ackRafRef.current = null;
    if (!pendingAckRef.current) return;
    const ws = inputWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ackRafRef.current = window.requestAnimationFrame(flushAck);
      return;
    }
    ws.send(JSON.stringify({ type: "ack" }));
    pendingAckRef.current = false;
  }, []);

  const scheduleAck = useCallback(() => {
    pendingAckRef.current = true;
    if (ackRafRef.current != null) return;
    ackRafRef.current = window.requestAnimationFrame(flushAck);
  }, [flushAck]);

  const drawBitmap = useCallback((bitmap: ImageBitmap) => {
    const canvas = canvasRef.current;
    if (!canvas) { bitmap.close(); return; }
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    cancelReconnect();
    // Detach handlers before closing: a discarded socket's close event can
    // land AFTER the replacement's onopen, and its stale onclose would flip
    // connState to "closed" over a live stream (where the reconnect overlay
    // would then intercept all canvas input).
    for (const ref of [viewportWsRef, inputWsRef]) {
      const old = ref.current;
      if (!old) continue;
      old.onopen = null; old.onclose = null; old.onerror = null; old.onmessage = null;
      try { old.close(); } catch { /* noop */ }
    }

    fatalRef.current = null;
    setFatalError(null);
    setConnState("connecting");
    lastSentViewportRef.current = null;
    qualitySentRef.current = null;
    firstFrameSeenRef.current = false;
    // TEMP: tab-swap timing instrumentation.
    const connectStart = performance.now();
    const sinceSwap = (connectStart - swapStartRef.current).toFixed(1);
    console.log(`[swap-timing] connect() tabId=${tabId} +${sinceSwap}ms since swap`);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";

    // Initial sync needs BOTH sockets open (viewport ownership gates the
    // push; the input WS carries it) — run from whichever onopen fires last.
    const syncOnOpen = () => {
      if (viewportWsRef.current?.readyState !== WebSocket.OPEN) return;
      const iw = inputWsRef.current;
      if (!iw || iw.readyState !== WebSocket.OPEN) return;
      pushViewport(true);
      iw.send(JSON.stringify({ type: "quality", level: quality }));
      qualitySentRef.current = quality;
      // Unblock any frame that arrived before the input WS was ready.
      if (pendingAckRef.current) flushAck();
    };

    const vws = new WebSocket(`${proto}//${window.location.host}/viewport/${encodeURIComponent(tabId)}`);
    vws.binaryType = "arraybuffer";
    vws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setConnState("open");
      syncOnOpen();
      // TEMP: tab-swap timing instrumentation.
      const sinceConnect = (performance.now() - connectStart).toFixed(1);
      const sinceSwap2 = (performance.now() - swapStartRef.current).toFixed(1);
      console.log(`[swap-timing] viewport WS open tabId=${tabId} +${sinceConnect}ms since connect, +${sinceSwap2}ms since swap`);
    };
    vws.onclose = (e) => {
      // TEMP: tab-swap timing instrumentation — capture disconnect reasons.
      console.log(`[swap-timing] viewport WS close tabId=${tabId} code=${e.code} reason=${e.reason || "(none)"} wasClean=${e.wasClean}`);
      setConnState("closed");
      scheduleReconnect();
    };
    vws.onerror = () => setConnState("closed");
    vws.onmessage = (e) => {
      const data = e.data;
      if (data instanceof ArrayBuffer) {
        const blob = new Blob([data], { type: "image/jpeg" });
        // createImageBitmap is async + off-main-thread decode where available.
        createImageBitmap(blob)
          .then((bm) => {
            drawBitmap(bm);
            scheduleAck();
            // TEMP: tab-swap timing — first frame after connect only.
            if (!firstFrameSeenRef.current) {
              firstFrameSeenRef.current = true;
              const sinceConnect = (performance.now() - connectStart).toFixed(1);
              const sinceSwap3 = (performance.now() - swapStartRef.current).toFixed(1);
              console.log(`[swap-timing] first frame drawn tabId=${tabId} +${sinceConnect}ms since connect, +${sinceSwap3}ms since swap (${data.byteLength} bytes)`);
            }
          })
          .catch(() => {});
        return;
      }
      // Fallback: legacy JSON+base64 frames. Drop after the binary path proves out.
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data) as { type: string; b64?: string; message?: string };
          if (msg.type === "error") {
            // Server-side hard failure ("tab not found" after a Fitting
            // restart) — retrying this id can never succeed.
            fatalRef.current = msg.message || "connection refused";
            setFatalError(fatalRef.current);
            return;
          }
          if (msg.type === "frame" && msg.b64) {
            const img = new Image();
            img.onload = () => { const c = canvasRef.current; if (c) {
              if (c.width !== img.width) c.width = img.width;
              if (c.height !== img.height) c.height = img.height;
              c.getContext("2d")?.drawImage(img, 0, 0);
            }};
            img.src = `data:image/jpeg;base64,${msg.b64}`;
            scheduleAck();
          }
        } catch { /* noop */ }
      }
    };
    viewportWsRef.current = vws;

    const iws = new WebSocket(`${proto}//${window.location.host}/input/${encodeURIComponent(tabId)}`);
    iws.onopen = () => {
      reconnectAttemptRef.current = 0;
      syncOnOpen();
    };
    iws.onclose = (e) => {
      // TEMP: tab-swap timing instrumentation — capture disconnect reasons.
      console.log(`[swap-timing] input WS close tabId=${tabId} code=${e.code} reason=${e.reason || "(none)"} wasClean=${e.wasClean}`);
      scheduleReconnect();
    };
    iws.onmessage = (e) => {
      let msg: { type: string; editable?: boolean; message?: string };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "error") {
        fatalRef.current = msg.message || "connection refused";
        setFatalError(fatalRef.current);
        return;
      }
      if (msg.type === "focusedField") {
        const el = hiddenInputRef.current;
        if (!el) return;
        if (msg.editable) {
          // Don't yank keyboard focus when we don't hold the screencast, or
          // while the user is working in an embedded iframe (the DevTools
          // pane in the shell) — the page autofocusing a field after e.g. an
          // HMR reload must not steal the console mid-typing.
          if (viewportWsRef.current?.readyState !== WebSocket.OPEN) return;
          if (document.activeElement?.tagName === "IFRAME") return;
          el.focus();
        } else el.blur();
      }
    };
    inputWsRef.current = iws;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, pushViewport, scheduleAck, drawBitmap, flushAck, cancelReconnect, quality]);

  // Exponential backoff: 500ms → 1s → 2s → 3.5s → 5s (cap). Reset on onopen.
  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    if (fatalRef.current) return; // dead tab id — retrying can't succeed
    if (reconnectTimerRef.current != null) return;
    // Both viewport AND input must be down before we schedule — otherwise
    // we'd churn the live one.
    const vClosed = !viewportWsRef.current || viewportWsRef.current.readyState >= WebSocket.CLOSING;
    const iClosed = !inputWsRef.current || inputWsRef.current.readyState >= WebSocket.CLOSING;
    if (!vClosed || !iClosed) return;
    const delays = [500, 1000, 2000, 3500, 5000];
    const attempt = reconnectAttemptRef.current;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    reconnectAttemptRef.current = Math.min(attempt + 1, delays.length - 1);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }, [connect]);

  // Connect on mount. Cleanup on unmount.
  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      cancelReconnect();
      if (ackRafRef.current != null) {
        window.cancelAnimationFrame(ackRafRef.current);
        ackRafRef.current = null;
      }
      try { viewportWsRef.current?.close(); } catch { /* noop */ }
      try { inputWsRef.current?.close(); } catch { /* noop */ }
    };
  }, [connect, cancelReconnect]);

  // visibilitychange: on hidden, do nothing — keep WS alive. On visible,
  // only reconnect if WS is actually dead. iOS Safari's silent-WS-death is
  // caught by the server-side heartbeat, which fires onclose → backoff.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const v = viewportWsRef.current;
      const i = inputWsRef.current;
      const vOpen = v && v.readyState === WebSocket.OPEN;
      const iOpen = i && i.readyState === WebSocket.OPEN;
      if (!vOpen || !iOpen) connect();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [connect]);

  // Listen for parent attach messages — swap to a different browser tab
  // without an iframe reload. Announce ready on mount so the parent can
  // replay its current attach if its earlier message lost the race.
  useEffect(() => {
    const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
    if (!inIframe) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "attach" && typeof data.tabId === "string" && data.tabId !== tabId) {
        const nextId = data.tabId;
        // TEMP: tab-swap timing instrumentation — anchor for downstream marks.
        swapStartRef.current = performance.now();
        console.log(`[swap-timing] attach received from=${tabId} to=${nextId}`);
        setTabId(nextId);
        // Clear stale URL state so the polling effect repopulates for the new
        // tab. Without this the URL bar keeps showing the previous tab's URL.
        setUrlValue("");
        setCurrentUrl("");
        setLoadError(null);
        const nextPath = `/canvas/${encodeURIComponent(nextId)}`;
        if (window.location.pathname !== nextPath) {
          window.history.replaceState({}, "", nextPath);
        }
      }
    };
    window.addEventListener("message", onMsg);
    try { window.parent.postMessage({ type: "ready" }, "*"); } catch { /* noop */ }
    return () => window.removeEventListener("message", onMsg);
  }, [tabId]);

  // Persist quality + push to server when it changes mid-session. Same
  // ownership rule as pushViewport: only the screencast holder may restart
  // the stream at a new preset.
  useEffect(() => {
    try { window.localStorage.setItem(QUALITY_LS_KEY, quality); } catch {}
    if (qualitySentRef.current === quality) return;
    if (viewportWsRef.current?.readyState !== WebSocket.OPEN) return;
    const ws = inputWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "quality", level: quality }));
      qualitySentRef.current = quality;
    }
  }, [quality]);

  // Observe wrapper size changes and push them to the server (debounced).
  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => queueResize());
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    };
  }, [queueResize]);

  // Poll URL from /tabs. Prefer requestedUrl for display when Chromium hit a
  // load error (so the URL bar shows what we asked for, not chrome-error://).
  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch("/tabs");
        const json = await res.json();
        const tab = (json.tabs || []).find((t: TabSummary) => t.tabId === tabId);
        if (!tab) return;
        const isError = tab.url.startsWith("chrome-error://");
        const display = isError && tab.requestedUrl ? tab.requestedUrl : tab.url;
        setCurrentUrl(display);
        setUrlValue((prev) => (prev ? prev : display));
        setLoadError(isError ? `Can't reach ${tab.requestedUrl || "the page"}` : null);
      } catch { /* swallow */ }
    };
    void refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [tabId]);

  // Coordinate mapping: client → CDP viewport (CSS) coords.
  // Chromium's Input.dispatchMouseEvent expects CSS pixels, not device pixels —
  // so the divisor is the wrapper's display rect (which equals the viewport CSS
  // size we asked the server to set), regardless of devicePixelRatio.
  const toViewportCoords = useCallback((clientX: number, clientY: number) => {
    const wrap = wrapperRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    const sent = lastSentViewportRef.current;
    const vw = sent?.width || rect.width;
    const vh = sent?.height || rect.height;
    const scaleX = vw / rect.width;
    const scaleY = vh / rect.height;
    return {
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY)
    };
  }, []);

  // ─── Pointer / touch handlers ───────────────────────────────

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const { x, y } = toViewportCoords(e.clientX, e.clientY);
    sendInput({
      type: "mouse",
      event: "mousePressed",
      x, y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toViewportCoords(e.clientX, e.clientY);
    sendInput({
      type: "mouse",
      event: "mouseMoved",
      x, y,
      button: e.buttons & 1 ? "left" : "none",
      buttons: e.buttons,
      clickCount: 0
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toViewportCoords(e.clientX, e.clientY);
    sendInput({
      type: "mouse",
      event: "mouseReleased",
      x, y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = toViewportCoords(e.clientX, e.clientY);
    sendInput({
      type: "mouse",
      event: "mouseWheel",
      x, y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      deltaX: -e.deltaX,
      deltaY: -e.deltaY
    });
  };

  // ─── Keyboard handlers (via hidden input) ────────────────────

  const onHiddenKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      sendInput({
        type: "key",
        event: "rawKeyDown",
        key: e.key,
        code: e.code,
        modifiers: modifierMask(e)
      });
      sendInput({
        type: "key",
        event: "keyUp",
        key: e.key,
        code: e.code,
        modifiers: modifierMask(e)
      });
    } else if (e.key.length === 1 && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendInput({
        type: "key",
        event: "rawKeyDown",
        key: e.key,
        code: e.code,
        text: e.key,
        modifiers: modifierMask(e)
      });
      sendInput({ type: "key", event: "keyUp", key: e.key, code: e.code, modifiers: modifierMask(e) });
    }
    // Printable keys are handled by the input event for IME safety.
  };

  const onHiddenInput = (e: React.FormEvent<HTMLInputElement>) => {
    const data = (e.nativeEvent as InputEvent).data;
    if (data) sendInput({ type: "insertText", text: data });
    // Clear so the input element stays empty (it's invisible / off-screen).
    if (hiddenInputRef.current) hiddenInputRef.current.value = "";
  };

  // ─── URL bar ────────────────────────────────────────────────

  const onSubmitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlValue.trim()) return;
    void fetch(`/tabs/${encodeURIComponent(tabId)}/nav`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlValue })
    });
  };

  const navAction = (action: "back" | "forward" | "reload") => {
    void fetch(`/tabs/${encodeURIComponent(tabId)}/${action}`, { method: "POST" });
  };

  const openDevTools = () => {
    window.open(`/devtools-shell/${encodeURIComponent(tabId)}`, "_blank", "noopener");
  };

  const inIframe = useMemo(() => {
    try { return window.self !== window.top; } catch { return true; }
  }, []);

  // Anchor target for "Open native": the URL the user actually asked for
  // (preferring requestedUrl over chrome-error://chromewebdata).
  const nativeUrl = useMemo(() => {
    const u = currentUrl || "";
    if (!u || u.startsWith("chrome-error://") || u.startsWith("about:")) return null;
    if (!/^https?:\/\//i.test(u)) return null;
    return u;
  }, [currentUrl]);

  return (
    <div className="canvas-page">
      <div className="urlbar">
        <button className="opt" onClick={() => navAction("back")} title="Back">‹</button>
        <button className="opt" onClick={() => navAction("forward")} title="Forward">›</button>
        <button onClick={() => navAction("reload")} title="Reload">↻</button>
        <form onSubmit={onSubmitUrl}>
          <input
            type="text"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={currentUrl}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </form>
        <div className="quality-toggle" role="group" aria-label="Stream quality">
          {(["low", "med", "high"] as QualityLevel[]).map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`opt quality-btn ${quality === lvl ? "active" : ""}`}
              onClick={() => setQuality(lvl)}
              title={`Stream quality: ${lvl.toUpperCase()}`}
            >{lvl.toUpperCase()}</button>
          ))}
        </div>
        {!inShell && <button onClick={openDevTools} title="Chrome DevTools">DevTools</button>}
        {nativeUrl && (
          <a
            className="opt native-link"
            href={nativeUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${nativeUrl} in a new tab. Session state (cookies, localStorage) is not shared with the canvas.`}
          >Open native</a>
        )}
        {inIframe && (
          <button
            className="opt"
            onClick={() => window.open(window.location.href, "_blank", "noopener")}
            title="Open in new tab"
          >Detach</button>
        )}
      </div>
      <div className="canvas-wrapper" ref={wrapperRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <input
          ref={hiddenInputRef}
          className="hidden-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onHiddenKeyDown}
          onInput={onHiddenInput}
        />
        {connState !== "open" && fatalError && (
          <div className="conn-overlay error">
            <div>
              <div className="title">
                {fatalError === "tab not found" ? "This browser tab no longer exists" : fatalError}
              </div>
              <div className="subtitle">
                The Browser Fitting may have restarted. Reopen DevTools from the Dev Env pane.
              </div>
            </div>
          </div>
        )}
        {connState !== "open" && !fatalError && (
          <div
            className={`conn-overlay ${connState === "closed" ? "reconnect" : ""}`}
            onClick={connState === "closed" ? () => connect() : undefined}
          >
            {connState === "connecting" ? "Connecting…" : "Disconnected — tap to reconnect"}
          </div>
        )}
        {connState === "open" && loadError && (
          <div className="conn-overlay error">
            <div>
              <div className="title">{loadError}</div>
              <div className="subtitle">The page failed to load. Check it's running, then press Reload.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function modifierMask(e: React.KeyboardEvent): number {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}

// ─── DevTools shell (/devtools-shell/:tabId) ──────────────────
//
// Side-by-side surface: the interactive canvas on the left (the page reflows
// to fill the pane — no letterboxed screencast), the official Chrome DevTools
// frontend on the right. DevTools' own screencast is redundant here, so it's
// seeded off.

// DevTools (same origin as this app — it's reverse-proxied at /devtools/*)
// persists its settings in localStorage with JSON-encoded values. Each key
// is read once at frontend boot, so seeding must happen before the iframe
// mounts. Seeded on every shell open: the shell's contract is "opens on
// Network with the Console drawer at half height", not "remembers last time".
function seedDevtoolsDefaults() {
  try {
    const halfHeight = Math.max(200, Math.round(window.innerHeight / 2));
    window.localStorage.setItem("screencast-enabled", JSON.stringify(false));
    window.localStorage.setItem("panel-selected-tab", JSON.stringify("network"));
    // "console-view" is the drawer Console's view id ("console" is the
    // main-panel Console — a drawer location never has that tab).
    window.localStorage.setItem("drawer-view-selected-tab", JSON.stringify("console-view"));
    // Seed BOTH orientation slots: the drawer SplitWidget reads `horizontal`
    // when the drawer is horizontal (the default) and `vertical` after the
    // user toggles drawer orientation (Shift+Esc) — a missing slot falls
    // back to the pre-restore "OnlyMain" showMode and the drawer never
    // auto-opens. showMode "Both" = drawer visible.
    window.localStorage.setItem(
      "inspector.drawer-split-view-state",
      JSON.stringify({
        horizontal: { size: halfHeight, showMode: "Both" },
        vertical: { size: 400, showMode: "Both" }
      })
    );
  } catch { /* localStorage unavailable — DevTools falls back to its defaults */ }
}

function DevtoolsShell({ initialTabId }: { initialTabId: string }) {
  // useState initializer = synchronous, once, before the iframe ever renders.
  useState(() => { seedDevtoolsDefaults(); return true; });
  const [leftPct, setLeftPct] = useState(55);
  const [dragging, setDragging] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const devtoolsSrc = useMemo(() => {
    const wsTarget = `${window.location.host}/cdp/${initialTabId}`;
    // ?panel= overrides the persisted tab selection at boot.
    return `/devtools/inspector.html?ws=${encodeURIComponent(wsTarget)}&panel=network`;
  }, [initialTabId]);

  useEffect(() => { document.title = "Garrison DevTools"; }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = shellRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging]);

  return (
    <div className={`devtools-shell ${dragging ? "dragging" : ""}`} ref={shellRef}>
      <div className="shell-left" style={{ width: `${leftPct}%` }}>
        <CanvasPage initialTabId={initialTabId} inShell />
      </div>
      <div
        className="shell-divider"
        onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
        title="Drag to resize"
      />
      <div className="shell-right">
        <iframe className="devtools-frame" src={devtoolsSrc} title="Chrome DevTools" />
      </div>
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────

function App() {
  const route = useRoute();
  if (route.kind === "canvas") return <CanvasPage initialTabId={route.initialTabId} />;
  if (route.kind === "devtools-shell") return <DevtoolsShell initialTabId={route.initialTabId} />;
  return <TabsList />;
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
