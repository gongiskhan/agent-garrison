// Port of terminal-armory-default ui/main.tsx browser-split (resolveAppUrl /
// ensureBrowserTab / sticky iframe + postMessage attach handshake / 4s
// app-port re-poll), reshaped as a per-session component with a fixed cwd.
// The iframe `src` is sticky — set once on first wire, refreshed only on
// explicit user Refresh. Port changes navigate the Browser-Fitting tab via
// postMessage/nav, never by changing src (which would full-reload the canvas
// page). Desktop only — the parent does not render this at mobile widths.

import React, { useEffect, useRef, useState } from "react";

export interface WiredInfo {
  cwd: string;
  appUrl: string;
  canvasUrl: string;
}

// Browser-Fitting tab ids per cwd, module-scoped so they survive pane
// unmount/remount (close + reopen, app.port flapping). Without this, every
// remount would open a brand-new tab in the shared headless browser and the
// old ones would accumulate forever.
const tabIdByCwd = new Map<string, string>();

// Device-viewport tester: render the embedded app at a FIXED device width
// (mobile/tablet) inside a centered frame, or fluid (desktop). Global pref so
// it carries across sessions; try/catch matches the garrison.devenv.* siblings.
const LS_DEVICE = "garrison.devenv.deviceViewport";
type DeviceViewport = "desktop" | "tablet" | "mobile";
function readDevice(): DeviceViewport {
  try {
    const v = localStorage.getItem(LS_DEVICE);
    if (v === "desktop" || v === "tablet" || v === "mobile") return v;
  } catch {}
  return "desktop";
}

export function BrowserPane({
  cwd,
  active,
  onWired,
  onManualNav,
  onClose
}: {
  cwd: string;
  active: boolean;
  onWired?: (info: WiredInfo) => void;
  onManualNav?: () => void;
  onClose?: () => void;
}) {
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [canvasUrl, setCanvasUrl] = useState<string | null>(null);
  const [browserTabId, setBrowserTabId] = useState<string | null>(() => tabIdByCwd.get(cwd) ?? null);
  const [browserBase, setBrowserBase] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [iframeBaseUrl, setIframeBaseUrl] = useState<string | null>(null);
  // The URL bar is editable: Enter navigates the Browser-Fitting tab to the
  // typed URL and switches to manual mode, which suspends the app.port
  // auto-repoint until Refresh hands control back.
  const [urlInput, setUrlInput] = useState("");
  const [manual, setManual] = useState(false);
  const [device, setDeviceState] = useState<DeviceViewport>(() => readDevice());
  const chooseDevice = (d: DeviceViewport) => {
    setDeviceState(d);
    try { localStorage.setItem(LS_DEVICE, d); } catch {}
  };
  const urlEditedRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onWiredRef = useRef(onWired);
  onWiredRef.current = onWired;
  const tabIdRef = useRef<string | null>(null);
  tabIdRef.current = browserTabId;
  const appUrlRef = useRef<string | null>(null);
  appUrlRef.current = appUrl;
  const manualRef = useRef(false);
  manualRef.current = manual;

  async function resolveAppUrl(opts: { silent?: boolean } = {}): Promise<string | null> {
    const setErr = opts.silent ? () => {} : setSplitError;
    setErr(null);
    try {
      const [ipRes, portRes] = await Promise.all([
        fetch("/tailscale-ip"),
        fetch(`/app-port?cwd=${encodeURIComponent(cwd)}`)
      ]);
      if (!ipRes.ok) {
        setErr("No Tailscale interface found on this machine.");
        return null;
      }
      if (!portRes.ok) {
        const body = await portRes.json().catch(() => ({}));
        setErr(`app.port: ${body?.error || `HTTP ${portRes.status}`}`);
        return null;
      }
      const { ip } = await ipRes.json();
      const { port } = await portRes.json();
      return `http://${ip}:${port}`;
    } catch (err) {
      setErr(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  // Ensure a Browser-Fitting tab exists pointing at `appUrl`. If
  // `existingTabId` is given, navigate it; otherwise open a fresh tab.
  // Returns the URL of the Browser Fitting's canvas page for `tabId` —
  // that's what we iframe.
  async function ensureBrowserTab(
    appUrlValue: string,
    existingTabId: string | null
  ): Promise<{ tabId: string; canvasUrl: string; browserUrl: string } | null> {
    try {
      const targetRes = await fetch("/browser-target");
      if (!targetRes.ok) {
        const body = await targetRes.json().catch(() => ({}));
        setSplitError(`browser fitting: ${body?.error || `HTTP ${targetRes.status}`}`);
        return null;
      }
      const target = await targetRes.json();
      // Re-host the canvas URL on whatever host the Dev Env page itself is
      // served from so iPad-over-Tailscale links don't collapse to localhost.
      const browserUrl = String(target.url || "").replace(
        /\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/,
        `//${window.location.hostname}:${target.port}`
      );

      let tabId = existingTabId;
      if (tabId) {
        const navRes = await fetch(`${browserUrl}/tabs/${encodeURIComponent(tabId)}/nav`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: appUrlValue })
        });
        if (navRes.status === 404) tabId = null; // tab gone, reopen
        else if (!navRes.ok) {
          const body = await navRes.json().catch(() => ({}));
          setSplitError(`browser nav: ${body?.error || `HTTP ${navRes.status}`}`);
          return null;
        }
      }
      if (!tabId) {
        const openRes = await fetch(`${browserUrl}/tabs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: appUrlValue })
        });
        if (!openRes.ok) {
          const body = await openRes.json().catch(() => ({}));
          setSplitError(`browser open tab: ${body?.error || `HTTP ${openRes.status}`}`);
          return null;
        }
        const data = await openRes.json();
        tabId = String(data.tabId);
      }
      return {
        tabId: tabId!,
        browserUrl,
        canvasUrl: `${browserUrl}/canvas/${encodeURIComponent(tabId!)}`
      };
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  function applyWired(
    wired: { tabId: string; canvasUrl: string; browserUrl: string },
    url: string
  ) {
    tabIdByCwd.set(cwd, wired.tabId);
    setBrowserBase((prev) => prev ?? wired.browserUrl);
    setBrowserTabId(wired.tabId);
    setAppUrl(url);
    if (!urlEditedRef.current) setUrlInput(url);
    setCanvasUrl(wired.canvasUrl);
    onWiredRef.current?.({ cwd, appUrl: url, canvasUrl: wired.canvasUrl });
  }

  // Initial wire (and re-wire whenever the pane becomes active again with no
  // canvas yet). Skipped in manual mode — the typed URL owns the tab.
  useEffect(() => {
    if (!active || canvasUrl || manual) return;
    let cancelled = false;
    void (async () => {
      const url = await resolveAppUrl({ silent: true });
      if (cancelled || !url) return;
      const wired = await ensureBrowserTab(url, tabIdRef.current);
      if (cancelled || !wired) return;
      applyWired(wired, url);
    })();
    return () => { cancelled = true; };
  }, [active, canvasUrl, cwd, manual]);

  // Initialize the sticky iframe src once we know our first tab — after that
  // the src never changes outside of explicit Refresh.
  useEffect(() => {
    if (canvasUrl && !iframeBaseUrl) setIframeBaseUrl(canvasUrl);
  }, [canvasUrl, iframeBaseUrl]);

  // Whenever the active browser tab changes, postMessage the canvas iframe to
  // swap to it — no document reload, no WS re-handshake from scratch.
  useEffect(() => {
    if (!browserTabId || !browserBase) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try { win.postMessage({ type: "attach", tabId: browserTabId }, browserBase); } catch {}
  }, [browserTabId, browserBase]);

  // Ready handshake: the canvas posts {type:"ready"} on mount. If our attach
  // raced ahead of its listener, replay it now.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!browserBase || !browserTabId) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data;
      if (!data || typeof data !== "object" || data.type !== "ready") return;
      try {
        (e.source as Window).postMessage(
          { type: "attach", tabId: browserTabId },
          browserBase
        );
      } catch {}
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [browserBase, browserTabId]);

  // Auto-poll app.port for this cwd while active. When the dev server
  // restarts on a different port, navigate this cwd's tab silently — no UI
  // churn. Suspended in manual mode; manualRef is re-checked after every
  // await so a mid-tick Enter on the URL bar cannot be clobbered by an
  // in-flight tick, and `cancelled` covers unmount.
  useEffect(() => {
    if (!active || manual) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled || manualRef.current) return;
      const url = await resolveAppUrl({ silent: true });
      if (cancelled || manualRef.current || !url) return;
      if (url === appUrlRef.current) return;
      const wired = await ensureBrowserTab(url, tabIdRef.current);
      if (cancelled || manualRef.current || !wired) return;
      applyWired(wired, url);
    }, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, cwd, manual]);

  async function navigateToInput() {
    let target = urlInput.trim();
    if (!target) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = `http://${target}`;
    setManual(true);
    urlEditedRef.current = false;
    // Pin the pane open: manual browsing must not be unmounted by the
    // app.port visibility poll.
    onManualNav?.();
    const wired = await ensureBrowserTab(target, tabIdRef.current);
    if (!wired) return;
    applyWired(wired, target);
  }

  async function refreshIframe() {
    // Refresh hands control back to app.port auto-resolution.
    setManual(false);
    urlEditedRef.current = false;
    const url = await resolveAppUrl();
    if (url) {
      const wired = await ensureBrowserTab(url, tabIdRef.current);
      if (!wired) return;
      applyWired(wired, url);
      setIframeBaseUrl(wired.canvasUrl);
      setIframeNonce((n) => n + 1);
      return;
    }
    // No app.port: just remount the canvas for the current tab, if any.
    if (canvasUrl) {
      setIframeBaseUrl(canvasUrl);
      setIframeNonce((n) => n + 1);
    }
  }

  function openDevTools() {
    if (!browserBase || !browserTabId) return;
    // The Browser Fitting's DevTools shell: interactive canvas (page reflows
    // to fill it) + DevTools opened on Network with the Console drawer.
    window.open(
      `${browserBase}/devtools-shell/${encodeURIComponent(browserTabId)}`,
      "_blank",
      "noopener"
    );
  }

  return (
    <div className="app-pane">
      <div className="app-pane-header">
        <input
          type="text"
          className="app-pane-url-input"
          value={urlInput}
          placeholder={appUrl ?? "no app.port — enter a URL"}
          title={appUrl ?? ""}
          onChange={(e) => {
            urlEditedRef.current = true;
            setUrlInput(e.target.value);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") void navigateToInput(); }}
        />
        <div className="segmented device-selector" role="group" aria-label="Viewport">
          <button
            type="button"
            className={device === "desktop" ? "on" : ""}
            aria-pressed={device === "desktop"}
            onClick={() => chooseDevice("desktop")}
            title="Desktop — fluid, fills the pane"
          >
            Desktop
          </button>
          <button
            type="button"
            className={device === "tablet" ? "on" : ""}
            aria-pressed={device === "tablet"}
            onClick={() => chooseDevice("tablet")}
            title="Tablet — fixed 820px wide"
          >
            Tablet
          </button>
          <button
            type="button"
            className={device === "mobile" ? "on" : ""}
            aria-pressed={device === "mobile"}
            onClick={() => chooseDevice("mobile")}
            title="Mobile — fixed 390px wide"
          >
            Mobile
          </button>
        </div>
        <button
          type="button"
          className="btn"
          onClick={openDevTools}
          disabled={!browserTabId || !browserBase}
          title="Open Chrome DevTools for this tab"
        >
          DevTools
        </button>
        <button type="button" className="btn" onClick={() => void refreshIframe()} title="Re-resolve app.port and reload the canvas">
          Refresh
        </button>
        {onClose && (
          <button type="button" className="btn pane-close" onClick={onClose} title="Close browser pane">
            ×
          </button>
        )}
      </div>
      {splitError && <div className="alert">{splitError}</div>}
      <div className={`app-pane-viewport device-${device}`}>
        {iframeBaseUrl ? (
          <iframe
            ref={iframeRef}
            key={iframeNonce}
            className="app-iframe"
            src={iframeBaseUrl}
            title="app"
            onLoad={() => {
              if (!browserTabId || !browserBase) return;
              const win = iframeRef.current?.contentWindow;
              if (!win) return;
              try { win.postMessage({ type: "attach", tabId: browserTabId }, browserBase); } catch {}
            }}
          />
        ) : (
          <div className="app-pane-empty">
            No <code>app.port</code> in {cwd} — type a URL above to browse.
          </div>
        )}
      </div>
    </div>
  );
}
