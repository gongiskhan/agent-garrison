"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp, isShellPath, nativePush } from "@/lib/native-bridge";

// Push deep links inside the app. The native side receives the APNs payload,
// validates `path`, and either emits `pushRoute` (page listening) or parks it
// behind `pendingRoute` (cold start, page not up yet). This mounts once in the
// shell, drains the parked route, and follows live ones. Browsers get nothing
// from it: web push routes through the service worker's notificationclick.
export function PushRouteListener() {
  const router = useRouter();
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> | void } | null = null;
    const follow = (path: unknown) => {
      if (!cancelled && isShellPath(path)) router.push(path);
    };
    nativePush
      .onRoute((route) => follow(route?.path))
      .then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch(() => {});
    nativePush.pendingRoute().then(follow).catch(() => {});
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [router]);
  return null;
}
