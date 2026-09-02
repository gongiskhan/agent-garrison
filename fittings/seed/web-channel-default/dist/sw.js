// Web Channel service worker — the minimal SW that makes the surface an
// installable PWA (Add to Home Screen on iOS, install prompt on Android/desktop)
// and keeps the app shell available offline.
//
// DELIBERATELY conservative so it can never break the live app:
//   - It only ever touches same-origin GET requests for the static shell.
//   - It NEVER intercepts /api/* — the chat SSE stream, the /api/voice/stream and
//     /api/voice/tts-stream WebSockets (WS upgrades don't hit `fetch` anyway), and
//     the voice binary proxies all go straight to the network untouched.
//   - It NEVER intercepts cross-origin requests (e.g. Google Fonts).
//   - Shell assets use network-first with a cache fallback, so a rebuilt bundle is
//     always picked up when online and the app still opens when offline.
//
// Bump CACHE_VERSION to retire the previous cache on the next activation.
const CACHE_VERSION = "garrison-web-channel-v1";

// The app shell precached on install so the PWA opens offline after installation.
const APP_SHELL = [
  "/",
  "/index.html",
  "/web-channel.bundle.js",
  "/web-channel.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon-180.png",
  "/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Best-effort: a missing asset must not abort the whole install.
      await Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// True for requests the SW must leave entirely alone (let them hit the network):
// anything non-GET, cross-origin, or under the live API surface.
function bypass(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname === "/power-heartbeat") return true;
  // Belt and suspenders: never buffer an event-stream even if one is same-origin.
  if ((request.headers.get("accept") || "").includes("text/event-stream")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(request, url)) return; // default browser handling — no respondWith

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const fresh = await fetch(request);
        // Only cache complete, same-origin 200s (skip opaque/partial responses).
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          cache.put(request, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch (err) {
        // Offline: serve the cached asset, or fall back to the app shell for a
        // navigation so the installed PWA still opens.
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await cache.match("/index.html");
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});

// ---- Web Push ---------------------------------------------------------------
// The only route to a background notification on a phone without an App Store /
// Play build. On iOS this fires ONLY for a PWA added to the Home Screen.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push service can wake us with no payload at all (or a non-JSON one).
    // Showing something generic beats swallowing it: on iOS a push that
    // resolves without showNotification() can cost the site its permission.
    data = { title: "Garrison", body: event.data ? event.data.text() : "You have a new notification." };
  }
  const title = data.title || "Garrison";
  const actions = Array.isArray(data.actions)
    ? data.actions.slice(0, 2).map((a) => ({ action: a.action, title: a.title }))
    : [];
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // tag collapses repeats of the same subject instead of stacking them.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: data.link || "/", actions: data.actions || [] },
    actions
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Tell any open page, so the UI can render an in-app toast rather than
      // relying on a system banner the OS often suppresses while focused.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: "garrison-notification", payload: data });
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // An action button carries its own url when it has one; otherwise fall back
  // to the notification's link so a plain body tap still lands somewhere useful.
  const chosen = (data.actions || []).find((a) => a.action === event.action);
  const target = (chosen && chosen.url) || data.link || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing window rather than opening a duplicate PWA instance.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "garrison-notification-click", action: event.action || null, url: target });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

// Chrome/Safari can rotate a subscription without the page being open; without
// this the server keeps pushing to an endpoint the browser has abandoned.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/key");
        const { publicKey } = await res.json();
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), label: "resubscribed" })
        });
      } catch {}
    })()
  );
});
