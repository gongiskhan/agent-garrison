// Browser side of Web Push: register the service worker, ask for permission at
// the right moment, and hand the subscription to the server.
//
// The iOS rules drive the whole shape of this file:
//  - Push works ONLY for a web app added to the Home Screen (iOS 16.4+). In a
//    plain Safari tab `Notification.requestPermission` either does not exist or
//    permanently denies, so we must detect standalone mode and prompt to
//    install FIRST rather than burning the request.
//  - The permission request must come from a user gesture. Calling it on load
//    is silently rejected, which looks exactly like "the user said no".
// Neither rule applies on desktop Chrome, hence the capability checks rather
// than user-agent sniffing.

export type PushState =
  | "unsupported"
  | "needs-install"
  | "prompt"
  | "granted"
  | "denied"
  | "unconfigured";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// An installed PWA reports standalone; iOS uses a non-standard navigator flag.
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // On iOS this is what a plain Safari tab looks like - installable, not broken.
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (!("Notification" in window)) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  if (isIos() && !isStandalone()) return "needs-install";
  try {
    const res = await fetch("/api/push/key");
    if (!res.ok) return "unconfigured";
  } catch {
    return "unconfigured";
  }
  return "prompt";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/**
 * Subscribe this device. MUST be called from a click handler - a permission
 * request outside a user gesture is auto-denied and cannot be retried.
 */
export async function enablePush(label?: string): Promise<{ ok: boolean; reason?: string }> {
  const state = await pushState();
  if (state === "needs-install") return { ok: false, reason: "Add to Home Screen first (iOS requires it for notifications)." };
  if (state === "unsupported") return { ok: false, reason: "This browser cannot receive push notifications." };
  if (state === "unconfigured") return { ok: false, reason: "Server has no VAPID keys configured." };

  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "Notification permission was not granted." };

  const registration = (await navigator.serviceWorker.ready) ?? (await registerServiceWorker());
  if (!registration) return { ok: false, reason: "Service worker unavailable." };

  const keyRes = await fetch("/api/push/key");
  if (!keyRes.ok) return { ok: false, reason: "Server has no VAPID keys configured." };
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  // Reuse an existing subscription when present: re-subscribing with the same
  // key returns the same endpoint anyway, and a mismatch throws.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true, // required; browsers reject silent push
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    }));

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: label ?? navigator.userAgent.slice(0, 60) })
  });
  if (!res.ok) return { ok: false, reason: `Server rejected the subscription (${res.status}).` };
  return { ok: true };
}

export async function disablePush(): Promise<boolean> {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  await subscription.unsubscribe();
  return true;
}

/**
 * In-app presentation. The service worker forwards every push to open pages,
 * because a system banner is usually suppressed while the app is focused - so
 * without this a notification arriving while you are looking at the app is
 * invisible.
 */
export function onNotification(
  handler: (payload: { title?: string; body?: string; link?: string }) => void
): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.data?.type === "garrison-notification") handler(event.data.payload ?? {});
    if (event.data?.type === "garrison-notification-click" && event.data.url) {
      window.location.href = event.data.url;
    }
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
