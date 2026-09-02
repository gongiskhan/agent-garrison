"use client";

import { useEffect, useState, type ReactNode } from "react";
import { isNativeApp } from "@/lib/native-bridge";

// Whether this page is running inside the Garrison iOS app. Resolved after
// mount: the server renders the same markup for every client, and Capacitor's
// global exists only once the webview has injected it. `null` is "not yet
// known" and lets a gate render nothing instead of flashing the browser copy.
export function useNativeBridge(): boolean | null {
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => {
    setNative(isNativeApp());
  }, []);
  return native;
}

// Renders its children only inside the app; a browser sees `fallback`. The
// capture page and the app-only menu entries hang off this, which keeps a
// "native or not" decision in exactly one place.
export function BridgeGate({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const native = useNativeBridge();
  if (native === null) return null;
  return <>{native ? children : fallback}</>;
}
