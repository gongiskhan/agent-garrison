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

export function BrowserPane({
  cwd,
  active,
  onWired
}: {
  cwd: string;
  active: boolean;
  onWired?: (info: WiredInfo) => void;
}) {
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [canvasUrl, setCanvasUrl] = useState<string | null>(null);
  const [browserTabId, setBrowserTabId] = useState<string | null>(null);
  const [browserBase, setBrowserBase] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [iframeBaseUrl, setIframeBaseUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onWiredRef = useRef(onWired);
  onWiredRef.current = onWired;
  const tabIdRef = useRef<string | null>(null);
  tabIdRef.current = browserTabId;
  const appUrlRef = useRef<string | null>(null);
  appUrlRef.current = appUrl;

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
    setBrowserBase((prev) => prev ?? wired.browserUrl);
    setBrowserTabId(wired.tabId);
    setAppUrl(url);
    setCanvasUrl(wired.canvasUrl);
    onWiredRef.current?.({ cwd, appUrl: url, canvasUrl: wired.canvasUrl });
  }

  // Initial wire (and re-wire whenever the pane becomes active again with no
  // canvas yet).
  useEffect(() => {
    if (!active || canvasUrl) return;
    let cancelled = false;
    void (async () => {
      const url = await resolveAppUrl({ silent: true });
      if (cancelled || !url) return;
      const wired = await ensureBrowserTab(url, tabIdRef.current);
      if (cancelled || !wired) return;
      applyWired(wired, url);
    })();
    return () => { cancelled = true; };
  }, [active, canvasUrl, cwd]);

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
  // churn.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(async () => {
      const url = await resolveAppUrl({ silent: true });
      if (!url) return;
      if (url === appUrlRef.current) return;
      const wired = await ensureBrowserTab(url, tabIdRef.current);
      if (!wired) return;
      applyWired(wired, url);
    }, 4000);
    return () => window.clearInterval(id);
  }, [active, cwd]);

  async function refreshIframe() {
    // Re-resolve in case app.port changed, then navigate the existing tab.
    const url = await resolveAppUrl();
    if (!url) return;
    const wired = await ensureBrowserTab(url, tabIdRef.current);
    if (!wired) return;
    applyWired(wired, url);
    // Explicit Refresh: bump the sticky src and the iframe key so the
    // canvas page remounts cleanly.
    setIframeBaseUrl(wired.canvasUrl);
    setIframeNonce((n) => n + 1);
  }

  return (
    <div className="app-pane">
      <div className="app-pane-header">
        <span className="app-pane-url" title={appUrl ?? ""}>{appUrl ?? "no app.port detected"}</span>
        <button type="button" className="btn" onClick={() => void refreshIframe()} title="Re-resolve app.port and reload the canvas">
          Refresh
        </button>
      </div>
      {splitError && <div className="alert">{splitError}</div>}
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
          Waiting for an <code>app.port</code> file in {cwd}…
        </div>
      )}
    </div>
  );
}
