// Minimal Garrison service worker.
// Purpose: satisfy Chrome's PWA install criteria (manifest + SW with a
// fetch handler). Garrison is local-only — no offline caching, no network
// rewrites; the handler passes everything straight through.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Network-only passthrough. Garrison hits localhost; offline doesn't apply.
  // Required so Chrome counts this as an installable PWA.
  event.respondWith(fetch(event.request));
});
