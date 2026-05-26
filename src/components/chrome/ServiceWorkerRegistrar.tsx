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
        .register("/sw.js", { scope: "/" })
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
