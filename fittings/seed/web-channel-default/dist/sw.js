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
  "/pcm-worklet.js",
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
