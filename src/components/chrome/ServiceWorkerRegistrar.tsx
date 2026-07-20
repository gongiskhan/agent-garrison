"use client";

import { useEffect } from "react";

// Registers /sw.js once on mount. Required so Chrome / Edge surface the
// "Install Garrison" option that drops a dock icon on macOS. No-op in
// browsers that don't support service workers.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer to idle so the first paint isn't blocked.
    const register = () => {
      navigator.serviceWorker
        // updateViaCache:"none" keeps the browser's HTTP cache from serving a
        // stale sw.js back to the registration check — without it a broken
        // worker can survive deploys until a hard reload, and a service worker
        // is exactly the thing you cannot afford to be stuck on a bad version of
        // (a bad fetch handler breaks every embedded Fitting view).
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          // Force an update check on every mount so a fixed worker reaches
          // already-installed clients on their next visit, not eventually.
          registration.update().catch(() => {
            // Offline or transient — the next mount retries.
          });
        })
        .catch((err) => {
          // Non-fatal: SW failure shouldn't break the app.
          console.warn("[pwa] sw register failed:", err);
        });
    };
    const ric = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout?: number }) => void)
      | undefined;
    if (typeof ric === "function") {
      ric(register, { timeout: 2000 });
    } else {
      window.setTimeout(register, 500);
    }
  }, []);
  return null;
}
